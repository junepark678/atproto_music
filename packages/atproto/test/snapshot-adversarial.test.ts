// W3-05: the snapshot walker and its block sources against hostile or broken
// repositories (ADR 0004 §5.7, §7 step 4). Every malformed tree here is
// signed by a real commit that verifies, so only the MST invariant (or the
// block transport) is wrong. Missing blocks must surface as `missing_block`
// and never as absence; malformed trees as `mst_invalid`; bad bytes as
// `cid_mismatch`; oversize streams as `car_too_large`.

import { encode, toBytes } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { NodeStore } from '@atcute/mst';
import { createSafeFetch, type SafeFetch } from '@atmusic/atproto/net/safe-fetch';
import { type BlockSource, MemoryBlockCache, verifyBlock } from '@atmusic/atproto/snapshot/block-source';
import { getBlocksSource } from '@atmusic/atproto/snapshot/getblocks-source';
import { GET_REPO_MAX_BYTES, getRepoSource, streamRepoIntoCache } from '@atmusic/atproto/snapshot/getrepo-source';
import { inRange, prefixRange } from '@atmusic/atproto/snapshot/range';
import {
  initialState,
  type StepOptions,
  type StepResult,
  step,
  type WalkState,
} from '@atmusic/atproto/snapshot/walker';
import { fakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { KEY_FILLS, type TestKey, testKey } from '@atmusic/atproto/test-support/keys';
import { carResponse, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import {
  cborCid,
  corruptBlockByte,
  dropBlock,
  encodeCar,
  encodeVarint,
  parseCar,
  SignedRepo,
  tidFromMicros,
  type WriteOp,
} from '@atmusic/atproto/test-support/signed-repo';
import { verifyCommit } from '@atmusic/atproto/verify/commit';
import { type VerifiedCommit, VerifyError } from '@atmusic/atproto/verify/types';
import { collectionsFor, FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';

const HOST = 'pds-adversarial.test';
const PDS = `https://${HOST}`;
const DID = 'did:plc:xxxxxxxxxxxxxxxxxxxxxxxx';
const COLL = collectionsFor(FIXTURE_PREFIX);
const RANGE = prefixRange(FIXTURE_PREFIX);
const GET_BLOCKS = 'com.atproto.sync.getBlocks';
const GET_REPO = 'com.atproto.sync.getRepo';
const MiB = 1024 * 1024;
const REV = tidFromMicros(Date.UTC(2026, 0, 15, 12) * 1000);

const signer = (): Promise<TestKey> => testKey('secp256k1', KEY_FILLS.oracleSecp256k1, 'adversarial-secp256k1');

async function failure(p: Promise<unknown>): Promise<VerifyError> {
  const result = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(result).toBeInstanceOf(VerifyError);
  return result as VerifyError;
}

function recording(inner: BlockSource) {
  const calls: string[][] = [];
  return {
    calls,
    requested: () => calls.flat(),
    async get(cids: string[]) {
      calls.push([...cids]);
      return inner.get(cids);
    },
  };
}

/** Walk until done; returns the completed steps, or the steps before the error and the error. */
async function walk(state: WalkState, source: BlockSource, cache: MemoryBlockCache, opts: StepOptions) {
  const steps: StepResult[] = [];
  let s = state;
  for (let i = 0; i < 100_000; i++) {
    try {
      const r = await step(JSON.parse(JSON.stringify(s)) as WalkState, source, cache, opts);
      steps.push(r);
      s = r.state;
      if (r.done) return { steps, error: null };
    } catch (e) {
      return { steps, error: e };
    }
  }
  throw new Error('walk did not finish');
}

const ALL: StepOptions = { maxFetches: 1_000, maxEntries: 100_000, knownCid: () => null };

// ---------------------------------------------------------------------------
// Real repositories on the fake PDS
// ---------------------------------------------------------------------------

function put(collection: string, rkey: string, record: unknown): WriteOp {
  return { action: 'put', collection, rkey, record };
}

interface Hosted {
  key: TestKey;
  repo: SignedRepo;
  pds: FakePds;
  safeFetch: SafeFetch;
}

async function hostedRepo(): Promise<Hosted> {
  const key = await signer();
  const repo = new SignedRepo(DID, key);
  const ops: WriteOp[] = [];
  for (let i = 0; i < 300; i++) {
    ops.push(
      put(COLL.scrobble, tidFromMicros(Date.UTC(2025, 0, 1) * 1000 + i * 1_000_000), { $type: COLL.scrobble, i }),
    );
  }
  for (let i = 0; i < 300; i++) ops.push(put('app.bsky.feed.like', `l${i.toString().padStart(4, '0')}`, { i }));
  for (let i = 0; i < 300; i++) ops.push(put('zz.example.other', `o${i.toString().padStart(4, '0')}`, { i }));
  await repo.writes(ops);
  const pds = new FakePds(HOST);
  await pds.addAccount(repo);
  const transport = routerTransport({ pds: [pds], doh: fakeDoh() });
  return { key, repo, pds, safeFetch: createSafeFetch({ transport, clock: fixedClock(), fixture: true }) };
}

async function headOf(h: Hosted): Promise<VerifiedCommit> {
  const head = h.repo.head!;
  return verifyCommit(new Map([[head.cid, head.bytes]]), head.cid, { did: DID, signingKey: h.key.didKey });
}

interface NodeInfo {
  cid: string;
  depth: number;
  keys: string[];
  lo: string | null;
  hi: string | null;
}

async function nodesOf(repo: SignedRepo): Promise<NodeInfo[]> {
  const ns = new NodeStore(repo.store);
  const out: NodeInfo[] = [];
  const visit = async (cid: string, depth: number, lo: string | null, hi: string | null) => {
    const node = await ns.get(cid);
    out.push({ cid, depth, keys: [...node.keys], lo, hi });
    const bounds = [lo, ...node.keys, hi];
    for (let i = 0; i < node.subtrees.length; i++) {
      const t = node.subtrees[i];
      if (t) await visit(t.$link, depth + 1, bounds[i] ?? null, bounds[i + 1] ?? null);
    }
  };
  await visit(repo.head!.data, 0, null, null);
  return out;
}

/** A getBlocks responder that silently leaves `omit` out of an otherwise 200 CAR. */
function omittingGetBlocks(repo: SignedRepo, omit: string) {
  return {
    kind: 'respond' as const,
    async respond(req: Request) {
      const cids = new URL(req.url).searchParams.getAll('cids').filter((c) => c !== omit);
      const { blocks } = await repo.getBlocks(cids);
      return carResponse(encodeCar([], blocks));
    },
  };
}

const blocksOf = (h: Hosted) => getBlocksSource({ safeFetch: h.safeFetch, pds: PDS, did: DID });

it('missing subtree block → missing_block, never silent absence', async () => {
  const h = await hostedRepo();
  const commit = await headOf(h);
  const nodes = await nodesOf(h.repo);
  const inRangeEntries = (await h.repo.entries()).filter((e) => inRange(RANGE, e.key));
  expect(inRangeEntries.length).toBe(300);
  // A non-root node holding in-range keys: had its absence been read as "no records", they would vanish.
  const victim = nodes.find((n) => n.depth > 0 && n.keys.some((k) => inRange(RANGE, k)))!;
  expect(victim).toBeDefined();
  const victimMin = victim.keys[0]!;
  const victimBytes = (await h.repo.store.get(victim.cid))!;
  const opts: StepOptions = { maxFetches: 3, maxEntries: 25, knownCid: () => null };
  /** No chunk interval may reach the lost subtree's keys. */
  const coveredBelow = (steps: StepResult[]) =>
    steps.every((s) => !s.done && (s.interval === null || (s.interval[1] !== null && s.interval[1] < victimMin)));

  // (a) The PDS lost the node: getBlocks answers 400 BlockNotFound.
  await h.repo.store.delete(victim.cid);
  const cacheA = new MemoryBlockCache();
  const a = await walk(initialState(commit, RANGE), blocksOf(h), cacheA, opts);
  expect((a.error as VerifyError).code).toBe('missing_block');
  expect(coveredBelow(a.steps)).toBe(true);
  expect(a.steps.flatMap((s) => s.entries).every((e) => e.key < victimMin)).toBe(true);
  const refused = h.pds.calls.filter({ nsid: GET_BLOCKS, status: 400 });
  expect(refused.length).toBe(1);
  expect(refused[0]!.params.cids).toContain(victim.cid);
  expect(cacheA.get(victim.cid)).toBeNull();
  await h.repo.store.put(victim.cid, victimBytes);

  // (b) The PDS answers 200 but silently leaves the node out of the CAR.
  h.pds.faults.add({ nsid: GET_BLOCKS }, omittingGetBlocks(h.repo, victim.cid), Number.POSITIVE_INFINITY);
  const b = await walk(initialState(commit, RANGE), blocksOf(h), new MemoryBlockCache(), opts);
  expect((b.error as VerifyError).code).toBe('missing_block');
  expect((b.error as VerifyError).message).toMatch(/MST node .* is missing/);
  expect(coveredBelow(b.steps)).toBe(true);
  h.pds.faults.clear();

  // (c) getRepo fallback: the repository CAR lacks the node; the cache-only walk reports it.
  const car = await h.repo.fullCar();
  const lacking = dropBlock(car, victim.cid);
  h.pds.faults.add({ nsid: GET_REPO }, { kind: 'respond', respond: () => carResponse(lacking) });
  const cacheC = new MemoryBlockCache();
  const repoSource = getRepoSource({ safeFetch: h.safeFetch, pds: PDS, did: DID, cache: cacheC });
  const c = await walk(initialState(commit, RANGE), repoSource, cacheC, opts);
  expect((c.error as VerifyError).code).toBe('missing_block');
  expect(coveredBelow(c.steps)).toBe(true);
  expect(cacheC.size).toBe(parseCar(lacking).sections.length);
  expect(cacheC.get(victim.cid)).toBeNull();
  expect(h.pds.count(GET_REPO)).toBe(1);

  // (d) A changed in-range record whose block is missing is missing_block too ...
  const record = inRangeEntries[150]!;
  const recordBytes = (await h.repo.store.get(record.cid))!;
  await h.repo.store.delete(record.cid);
  const d = await walk(initialState(commit, RANGE), blocksOf(h), new MemoryBlockCache(), opts);
  expect((d.error as VerifyError).code).toBe('missing_block');
  expect(d.steps.flatMap((s) => s.entries).every((e) => e.key < record.key)).toBe(true);
  // ... while an unchanged one (knownCid equal) is never fetched, so the walk completes.
  const known = new Map(inRangeEntries.map((e) => [e.key, e.cid]));
  const d2 = await walk(initialState(commit, RANGE), blocksOf(h), new MemoryBlockCache(), {
    ...opts,
    knownCid: (key) => known.get(key) ?? null,
  });
  expect(d2.error).toBeNull();
  expect(d2.steps.flatMap((s) => s.entries).map((e) => [e.key, e.cid, e.recordBytes])).toEqual(
    inRangeEntries.map((e) => [e.key, e.cid, undefined]),
  );
  await h.repo.store.put(record.cid, recordBytes);

  // (e) Control: a lost node entirely outside [p., p/) is never requested and does not matter.
  const outside = nodes.find(
    (n) => n.depth > 0 && ((n.lo !== null && n.lo >= RANGE[1]) || (n.hi !== null && n.hi <= RANGE[0])),
  )!;
  expect(outside).toBeDefined();
  await h.repo.store.delete(outside.cid);
  const source = recording(blocksOf(h));
  const e = await walk(initialState(commit, RANGE), source, new MemoryBlockCache(), opts);
  expect(e.error).toBeNull();
  expect(e.steps.flatMap((s) => s.entries).map((x) => [x.key, x.cid])).toEqual(
    inRangeEntries.map((x) => [x.key, x.cid]),
  );
  expect(source.requested()).not.toContain(outside.cid);
});

// ---------------------------------------------------------------------------
// Hand-built MSTs under real signed commits
// ---------------------------------------------------------------------------

const utf8 = (s: string) => new TextEncoder().encode(s);
const link = (cid: string) => CID.toCidLink(CID.fromString(cid));

/** MST layer of a key, computed independently of the walker: leading zero bit-pairs of sha256. */
async function heightOf(key: string): Promise<number> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(key)));
  let zeros = 0;
  for (const b of hash) {
    if (b === 0) {
      zeros += 8;
      continue;
    }
    zeros += Math.clz32(b) - 24;
    break;
  }
  return Math.floor(zeros / 2);
}

/** `n` ascending in-range keys of exactly layer `h`. */
async function keysAt(h: number, n: number, tag: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; out.length < n; i++) {
    const key = `${COLL.scrobble}/${tag}${i.toString().padStart(6, '0')}`;
    if ((await heightOf(key)) === h) out.push(key);
  }
  return out;
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

interface RawEntry {
  key: string;
  t?: string | null;
  /** Override the (canonical) prefix length. */
  p?: number;
}

const recordFor = (key: string) => encode({ $type: COLL.scrobble, key });

class Crafted {
  readonly blocks = new Map<string, Uint8Array>();

  add(bytes: Uint8Array): string {
    const cid = cborCid(bytes);
    this.blocks.set(cid, bytes);
    return cid;
  }

  /** An MST node `{l, e}` with canonical prefix compression unless an entry overrides `p`. */
  node(left: string | null, entries: RawEntry[]): string {
    let prev = '';
    const e = entries.map((x) => {
      const p = x.p ?? sharedPrefix(prev, x.key);
      prev = x.key;
      return {
        k: toBytes(utf8(x.key.slice(p))),
        p,
        t: x.t ? link(x.t) : null,
        v: link(this.add(recordFor(x.key))),
      };
    });
    return this.add(encode({ l: left === null ? null : link(left), e }));
  }

  /** Sign a v3 commit over `root` with the fixture key and verify it like the snapshot job does. */
  async commit(root: string): Promise<VerifiedCommit> {
    const key = await signer();
    const unsigned = { did: DID, version: 3, data: link(root), rev: REV, prev: null };
    const sig = await key.sign(encode(unsigned));
    const cid = this.add(encode({ ...unsigned, sig: toBytes(sig) }));
    return verifyCommit(this.blocks, cid, { did: DID, signingKey: key.didKey });
  }

  source() {
    return recording({
      get: async (cids) => {
        const out = new Map<string, Uint8Array>();
        for (const c of cids) {
          const b = this.blocks.get(c);
          if (b) out.set(c, b);
        }
        return out;
      },
    });
  }
}

/** A knownCid under which every record is unchanged, so no record block is ever fetched. */
const knownAll = (key: string) => cborCid(recordFor(key));

async function rejection(t: Crafted, root: string, opts: StepOptions = ALL, edit?: (s: WalkState) => WalkState) {
  const commit = await t.commit(root);
  const source = t.source();
  const init = initialState(commit, RANGE);
  const result = await walk(edit ? edit(init) : init, source, new MemoryBlockCache(), opts);
  expect(result.error).toBeInstanceOf(VerifyError);
  expect(result.steps.some((s) => s.done)).toBe(false);
  return { error: result.error as VerifyError, steps: result.steps, source };
}

it('out-of-order keys, repeated node CID, depth >256, layer mismatch rejected', async () => {
  const [x0, x1, x2] = await keysAt(0, 3, 'a');
  const [k1, k2] = await keysAt(1, 2, 'b');
  const [r2] = await keysAt(2, 1, 'c');
  const [y1] = await keysAt(1, 1, 'a'); // layer 1, sorts below k1 ('a…' < 'b…')
  const [z0] = await keysAt(0, 1, 'z'); // sorts above every 'b…' key
  const expectInvalid = async (pending: ReturnType<typeof rejection>, message: RegExp) => {
    const { error } = await pending;
    expect(error.code).toBe('mst_invalid');
    expect(error.message).toMatch(message);
  };

  // Control: the same shape built correctly walks cleanly, so each rejection below is the defect alone.
  {
    const t = new Crafted();
    const root = t.node(t.node(null, [{ key: x0! }]), [{ key: k1! }, { key: k2! }]);
    const ok = await walk(initialState(await t.commit(root), RANGE), t.source(), new MemoryBlockCache(), ALL);
    expect(ok.error).toBeNull();
    expect(ok.steps.flatMap((s) => s.entries).map((e) => e.key)).toEqual([x0, k1, k2]);
  }

  // Out-of-order keys inside one node.
  {
    const t = new Crafted();
    const [lo, hi] = [x0!, x1!].sort();
    await expectInvalid(rejection(t, t.node(null, [{ key: hi! }, { key: lo! }])), /keys out of order/);
  }
  // Out-of-order across nodes: a left subtree holding a key above its parent's key.
  {
    const t = new Crafted();
    expect(z0! > k1!).toBe(true);
    const root = t.node(t.node(null, [{ key: z0! }]), [{ key: k1! }]);
    await expectInvalid(rejection(t, root), /outside its subtree's bounds/);
  }

  // Repeated node CID: one leaf linked from two subtree positions.
  {
    const t = new Crafted();
    const shared = t.node(null, [{ key: x0! }]);
    const root = t.node(shared, [{ key: k1!, t: shared }, { key: k2! }]);
    // In one step the second expansion is caught as a repeat.
    await expectInvalid(rejection(t, root, { ...ALL, knownCid: knownAll }), /repeated node CID/);
    // Split across steps (each with a fresh repeat set), its keys fall outside the second bounds.
    const split = await rejection(t, root, { maxFetches: 1, maxEntries: 1, knownCid: knownAll });
    expect(split.error.code).toBe('mst_invalid');
    expect(split.steps.flatMap((s) => s.entries).map((e) => e.key)).toEqual([x0, k1]);
  }

  // Depth: a 300-node chain of keyless intermediate nodes under a layer-2 root is refused at the
  // first impossible layer, after a handful of fetches; it is never walked to depth 300.
  {
    const t = new Crafted();
    let chain = t.node(null, [{ key: x0! }]);
    for (let i = 0; i < 300; i++) chain = t.node(chain, []);
    const { error, source } = await rejection(t, t.node(chain, [{ key: r2! }]));
    expect(error.code).toBe('mst_invalid');
    expect(error.message).toMatch(/layer 0 but has a subtree/);
    expect(source.requested().length).toBeLessThanOrEqual(6);
  }
  // Depth: a node at depth 256 may not link further (a frontier claiming that depth).
  {
    const t = new Crafted();
    const node = t.node(t.node(null, [{ key: x0! }]), [{ key: k1! }]);
    const at =
      (depth: number) =>
      (s: WalkState): WalkState => ({ ...s, stack: [{ t: 'n', cid: node, lo: null, hi: null, layer: 1, depth }] });
    await expectInvalid(rejection(t, node, ALL, at(256)), /subtree deeper than 256/);
    await expectInvalid(rejection(t, node, ALL, at(257)), /deeper than 256/);
    const ok = await walk(at(255)(initialState(await t.commit(node), RANGE)), t.source(), new MemoryBlockCache(), ALL);
    expect(ok.error).toBeNull();
    expect(ok.steps.flatMap((s) => s.entries).map((e) => e.key)).toEqual([x0, k1]);
  }

  // Layer mismatch: keys of two layers in one node.
  {
    const t = new Crafted();
    const keys = [x0!, k1!].sort();
    await expectInvalid(
      rejection(
        t,
        t.node(
          null,
          keys.map((key) => ({ key })),
        ),
      ),
      /keys of layers/,
    );
  }
  // Layer mismatch: a child one layer too high.
  {
    const t = new Crafted();
    const root = t.node(t.node(null, [{ key: y1! }]), [{ key: k1! }]);
    await expectInvalid(rejection(t, root), /has layer 1, expected 0/);
  }
  // Layer mismatch: a keyless root with a subtree (indeterminate height, non-canonical).
  {
    const t = new Crafted();
    await expectInvalid(rejection(t, t.node(t.node(null, [{ key: x0! }]), [])), /no keys but a subtree/);
  }
  // Prefix sanity: a prefix length past the previous key, and a non-canonical (too short) prefix.
  {
    const t = new Crafted();
    await expectInvalid(rejection(t, t.node(null, [{ key: x0!, p: 1 }])), /not a prefix length/);
    const shared = sharedPrefix(x0!, x2!);
    expect(shared).toBeGreaterThan(1);
    await expectInvalid(rejection(t, t.node(null, [{ key: x0! }, { key: x2!, p: shared - 1 }])), /non-canonical/);
  }
});

// ---------------------------------------------------------------------------
// getRepo stream bounds and corrupted blocks
// ---------------------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A lazily generated, well-formed CAR of `count` distinct raw blocks, one section per pull. */
function hugeCar(root: string, blockBytes: number, count: number) {
  const stats = { pulled: 0, sections: 0, cancelled: false };
  const header = encode({ version: 1, roots: [link(root)] });
  let i = -1;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i === -1) {
        i = 0;
        const head = concat(encodeVarint(header.length), header);
        stats.pulled += head.length;
        controller.enqueue(head);
        return;
      }
      if (i >= count) {
        controller.close();
        return;
      }
      const data = new Uint8Array(blockBytes).fill((i % 250) + 1);
      data[0] = i & 0xff;
      data[1] = i >> 8;
      const cidBytes = CID.createSync(CID.CODEC_RAW, data).bytes;
      const section = concat(encodeVarint(cidBytes.length + data.length), cidBytes, data);
      i++;
      stats.pulled += section.length;
      stats.sections++;
      controller.enqueue(section);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stats, body };
}

it('getRepo stream over 32 MiB aborts; corrupted block rejected', async () => {
  const h = await hostedRepo();
  const commit = await headOf(h);

  // (a) A well-formed CAR stream of 40 × ~1 MiB blocks, no Content-Length: cut off at the 32 MiB cap.
  const huge = hugeCar(commit.cid, MiB - 64, 40);
  h.pds.faults.add(
    { nsid: GET_REPO },
    {
      kind: 'respond',
      respond: () => new Response(huge.body, { status: 200, headers: { 'content-type': 'application/vnd.ipld.car' } }),
    },
  );
  const cacheA = new MemoryBlockCache();
  const a = await failure(streamRepoIntoCache({ safeFetch: h.safeFetch, pds: PDS, did: DID, cache: cacheA }));
  expect(a.code).toBe('car_too_large');
  expect(GET_REPO_MAX_BYTES).toBe(32 * MiB);
  expect(huge.stats.cancelled).toBe(true);
  expect(huge.stats.sections).toBeLessThan(40);
  expect(huge.stats.pulled).toBeLessThanOrEqual(GET_REPO_MAX_BYTES + 4 * MiB);
  // Only whole, verified blocks from below the cap reached the cache.
  expect(cacheA.size).toBeGreaterThan(0);
  expect(cacheA.size).toBeLessThanOrEqual(32);
  for (const [cid, bytes] of cacheA.blocks) expect(() => verifyBlock(cid, bytes)).not.toThrow();

  // (b) A declared Content-Length over the cap is refused before the body is read.
  const declared = hugeCar(commit.cid, MiB - 64, 40);
  h.pds.faults.add(
    { nsid: GET_REPO },
    {
      kind: 'respond',
      respond: () =>
        new Response(declared.body, {
          status: 200,
          headers: { 'content-type': 'application/vnd.ipld.car', 'content-length': String(40 * MiB) },
        }),
    },
  );
  const cacheB = new MemoryBlockCache();
  const b = await failure(streamRepoIntoCache({ safeFetch: h.safeFetch, pds: PDS, did: DID, cache: cacheB }));
  expect(b.code).toBe('car_too_large');
  expect(declared.stats.sections).toBe(0);
  expect(cacheB.size).toBe(0);

  // (c) One in-range record block corrupted in the getRepo CAR: cid_mismatch at that section; it and
  // everything after it never reach the cache.
  const car = await h.repo.fullCar();
  const sections = parseCar(car).sections;
  const inRangeRecord = (await h.repo.entries()).find((e) => inRange(RANGE, e.key))!;
  const at = sections.findIndex((s) => s.cid === inRangeRecord.cid);
  expect(at).toBeGreaterThan(0);
  const corrupted = corruptBlockByte(car, inRangeRecord.cid);
  h.pds.faults.add({ nsid: GET_REPO }, { kind: 'respond', respond: () => carResponse(corrupted) });
  const cacheC = new MemoryBlockCache();
  const c = await failure(getRepoSource({ safeFetch: h.safeFetch, pds: PDS, did: DID, cache: cacheC }).load());
  expect(c.code).toBe('cid_mismatch');
  expect(c.message).toContain(inRangeRecord.cid);
  expect(cacheC.get(inRangeRecord.cid)).toBeNull();
  const before = new Set(sections.slice(0, at).map((s) => s.cid));
  for (const cid of before) expect(cacheC.get(cid)).not.toBeNull();
  for (const s of sections.slice(at + 1)) if (!before.has(s.cid)) expect(cacheC.get(s.cid)).toBeNull();
  expect(cacheC.size).toBe(before.size);

  // (d) The same via getBlocks: the MST root served with a flipped byte is cid_mismatch, never cached.
  const root = commit.dataCid;
  h.pds.faults.add(
    { nsid: GET_BLOCKS },
    {
      kind: 'respond',
      async respond(req: Request) {
        const { blocks } = await h.repo.getBlocks(new URL(req.url).searchParams.getAll('cids'));
        const bytes = new Uint8Array(blocks.get(root)!);
        bytes[bytes.length - 1]! ^= 0x01;
        blocks.set(root, bytes);
        return carResponse(encodeCar([], blocks));
      },
    },
  );
  const cacheD = new MemoryBlockCache();
  const d = await walk(initialState(commit, RANGE), blocksOf(h), cacheD, ALL);
  expect((d.error as VerifyError).code).toBe('cid_mismatch');
  expect(d.steps).toEqual([]);
  expect(cacheD.size).toBe(0);
  // A cache row that rotted is caught the same way when it is read back.
  const rotten = new MemoryBlockCache();
  const flipped = new Uint8Array((await h.repo.store.get(root))!);
  flipped[0]! ^= 0x01;
  rotten.put(root, flipped);
  const e = await walk(initialState(commit, RANGE), blocksOf(h), rotten, ALL);
  expect((e.error as VerifyError).code).toBe('cid_mismatch');
  expect(e.steps).toEqual([]);
});

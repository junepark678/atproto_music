// W3-05: the range-bounded, resumable MST snapshot walker (ADR 0004 §5.7)
// over real signed repositories served by the fake PDS through production
// SafeFetch and the getBlocks source. Expected key sets come from the
// fixture repository's own MST enumeration (SignedRepo.entries), never from
// the walker; call counts come from the fake PDS's request log.

import { decode } from '@atcute/cbor';
import { NodeStore } from '@atcute/mst';
import { createSafeFetch, type SafeFetch } from '@atmusic/atproto/net/safe-fetch';
import { type BlockCache, type BlockSource, MemoryBlockCache } from '@atmusic/atproto/snapshot/block-source';
import { GET_BLOCKS_BATCH, getBlocksSource } from '@atmusic/atproto/snapshot/getblocks-source';
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
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { cborCid, SignedRepo, tidFromMicros, type WriteOp } from '@atmusic/atproto/test-support/signed-repo';
import { verifyCommit } from '@atmusic/atproto/verify/commit';
import type { VerifiedCommit } from '@atmusic/atproto/verify/types';
import { collectionsFor, FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';

const HOST = 'pds-walker.test';
const PDS = `https://${HOST}`;
const DID = 'did:plc:wwwwwwwwwwwwwwwwwwwwwwww';
const COLL = collectionsFor(FIXTURE_PREFIX);
const RANGE = prefixRange(FIXTURE_PREFIX);
const GET_BLOCKS = 'com.atproto.sync.getBlocks';
/** The Rust oracle's per-commit/snapshot operation cap (crates/atproto/src/sync/frames.rs MAX_OPERATIONS). */
const RUST_MAX_OPERATIONS = 10_000;

const isMusic = (key: string) => key.startsWith(`${COLL.scrobble}/`) || key.startsWith(`${COLL.follow}/`);
const BASE_MICROS = Date.UTC(2025, 0, 1) * 1000;

function scrobbleRkey(i: number): string {
  return tidFromMicros(BASE_MICROS + i * 1_000_000);
}

function scrobble(i: number, extra: Record<string, unknown> = {}) {
  return {
    $type: COLL.scrobble,
    artist: `Artist ${i % 37}`,
    track: `Track ${i}`,
    listenedAt: new Date(Date.UTC(2025, 0, 1) + i * 1000).toISOString(),
    createdAt: '2026-01-15T12:00:00.000Z',
    ...extra,
  };
}

function put(collection: string, rkey: string, record: unknown): WriteOp {
  return { action: 'put', collection, rkey, record };
}

const scrobbles = (n: number, from = 0): WriteOp[] =>
  Array.from({ length: n }, (_, k) => put(COLL.scrobble, scrobbleRkey(from + k), scrobble(from + k)));
const follows = (n: number): WriteOp[] =>
  Array.from({ length: n }, (_, k) =>
    put(COLL.follow, `f${k.toString(16).padStart(8, '0')}`, {
      $type: COLL.follow,
      subject: `did:plc:${'b'.repeat(16)}${k.toString(32).padStart(8, 'a')}`,
      createdAt: '2026-01-15T12:00:00.000Z',
    }),
  );
const others = (collection: string, n: number, tag: string): WriteOp[] =>
  Array.from({ length: n }, (_, k) =>
    put(collection, `${tag}${k.toString().padStart(5, '0')}`, { $type: collection, n: k }),
  );

interface Env {
  key: TestKey;
  repo: SignedRepo;
  pds: FakePds;
  safeFetch: SafeFetch;
}

async function setup(ops: WriteOp[]): Promise<Env> {
  const key = await testKey('secp256k1', KEY_FILLS.oracleSecp256k1, 'walker-secp256k1');
  const repo = new SignedRepo(DID, key);
  await repo.writes(ops);
  const pds = new FakePds(HOST);
  await pds.addAccount(repo);
  const transport = routerTransport({ pds: [pds], doh: fakeDoh() });
  const safeFetch = createSafeFetch({ transport, clock: fixedClock(), fixture: true });
  return { key, repo, pds, safeFetch };
}

function blocksOf(env: Env) {
  return getBlocksSource({ safeFetch: env.safeFetch, pds: PDS, did: DID });
}

/** What the snapshot job does first: fetch the head commit through getBlocks and verify it. */
async function verifiedHead(env: Env): Promise<VerifiedCommit> {
  const head = env.repo.head!;
  const blocks = await blocksOf(env).get([head.cid]);
  return verifyCommit(blocks, head.cid, { did: DID, signingKey: env.key.didKey });
}

/** A BlockSource wrapper that records every CID requested and every call. */
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

/** Walk to completion, round-tripping the frontier through JSON between steps (as frontier_json does). */
async function walkAll(
  commit: VerifiedCommit,
  source: BlockSource,
  cache: BlockCache,
  opts: StepOptions,
): Promise<StepResult[]> {
  let state: WalkState = initialState(commit, RANGE);
  const steps: StepResult[] = [];
  for (let i = 0; i < 100_000; i++) {
    const result = await step(JSON.parse(JSON.stringify(state)) as WalkState, source, cache, opts);
    steps.push(result);
    state = result.state;
    if (result.done) return steps;
  }
  throw new Error('walk did not finish');
}

/** The chunk invariants every walk must satisfy: contiguous intervals, ordered keys inside them, budgets. */
function assertChunks(steps: StepResult[], opts: StepOptions): void {
  let prevHi: string | null = null;
  let first = true;
  let prevKey: string | null = null;
  for (const [i, s] of steps.entries()) {
    expect(s.fetches).toBeLessThanOrEqual(opts.maxFetches);
    expect(s.entries.length).toBeLessThanOrEqual(opts.maxEntries);
    expect(s.done).toBe(i === steps.length - 1);
    if (s.interval === null) {
      expect(s.entries).toEqual([]);
      continue;
    }
    const [lo, hi] = s.interval;
    expect(lo).toBe(first ? null : prevHi);
    first = false;
    if (s.done) expect(hi).toBeNull();
    for (const e of s.entries) {
      expect(inRange(RANGE, e.key)).toBe(true);
      if (lo !== null) expect(e.key > lo).toBe(true);
      if (hi !== null) expect(e.key <= hi).toBe(true);
      if (prevKey !== null) expect(e.key > prevKey).toBe(true);
      prevKey = e.key;
    }
    prevHi = hi;
  }
  expect(steps.at(-1)!.state.stack).toEqual([]);
}

function getBlocksRequests(pds: FakePds): string[][] {
  return pds.calls.filter({ nsid: GET_BLOCKS }).map((c) => c.params.cids ?? []);
}

it('repo with 5,000 music records and 2,000 non-music records enumerates exactly the music set across resumable steps', async () => {
  const ops = [
    ...scrobbles(4_000),
    ...follows(1_000),
    // 300 non-music records inside [p., p/): look-alike sibling collections and the settings record.
    put(COLL.settings, 'self', { $type: COLL.settings, enabled: true }),
    ...others(`${COLL.scrobble}-x`, 100, 'x'),
    ...others(`${COLL.scrobble}s`, 100, 's'),
    ...others(`${COLL.follow}x`, 99, 'y'),
    // 1,700 outside it, below and above the prefix.
    ...others('app.bsky.feed.like', 1_000, 'l'),
    ...others('app.bsky.feed.post', 500, 'p'),
    ...others('com.example.atmusia.post', 100, 'a'),
    ...others('com.example.atmusic-x.post', 50, 'h'),
    ...others('com.example.atmusicz.post', 50, 'z'),
  ];
  expect(ops.length).toBe(7_000);
  const env = await setup(ops);
  const all = await env.repo.entries();
  expect(all.length).toBe(7_000);
  const music = all.filter((e) => isMusic(e.key));
  expect(music.length).toBe(5_000);
  const nonMusicCids = new Set(all.filter((e) => !isMusic(e.key)).map((e) => e.cid));
  expect(all.filter((e) => !isMusic(e.key) && inRange(RANGE, e.key)).length).toBe(300);

  const commit = await verifiedHead(env);
  expect(commit).toMatchObject({ cid: env.repo.head!.cid, rev: env.repo.head!.rev, dataCid: env.repo.head!.data });
  env.pds.calls.reset();

  const source = getBlocksSource({ safeFetch: env.safeFetch, pds: PDS, did: DID });
  const cache = new MemoryBlockCache();
  const opts: StepOptions = { maxFetches: 6, maxEntries: 300, knownCid: () => null, include: isMusic };
  const steps = await walkAll(commit, source, cache, opts);

  // Exactly the music set, in MST order, across many resumable steps.
  const entries = steps.flatMap((s) => s.entries);
  expect(steps.length).toBeGreaterThan(5_000 / 300);
  expect(entries.map((e) => [e.key, e.cid])).toEqual(music.map((e) => [e.key, e.cid]));
  assertChunks(steps, opts);

  // Every record arrived (knownCid null) as the exact signed block.
  const byKey = new Map(ops.map((o) => [`${o.collection}/${o.rkey}`, o]));
  for (const e of entries) {
    expect(e.recordBytes).toBeDefined();
    expect(cborCid(e.recordBytes!)).toBe(e.cid);
    expect(JSON.parse(JSON.stringify(decode(e.recordBytes!)))).toEqual(
      (byKey.get(e.key) as { record: unknown }).record,
    );
  }

  // HTTP: one getBlocks request per fetch, each ≤ 100 CIDs, and no non-music record block was ever requested.
  const requests = getBlocksRequests(env.pds);
  expect(requests.length).toBe(steps.reduce((n, s) => n + s.fetches, 0));
  expect(Math.max(...requests.map((r) => r.length))).toBeLessThanOrEqual(GET_BLOCKS_BATCH);
  expect(env.pds.calls.filter({ nsid: GET_BLOCKS }).every((c) => c.status === 200)).toBe(true);
  const requested = new Set(requests.flat());
  expect([...requested].filter((c) => nonMusicCids.has(c))).toEqual([]);
  for (const m of music) expect(requested.has(m.cid)).toBe(true);
  // MST nodes went to the cache; record blocks did not.
  const musicCids = new Set(music.map((m) => m.cid));
  expect(cache.size).toBeGreaterThan(0);
  expect([...cache.blocks.keys()].filter((c) => musicCids.has(c))).toEqual([]);
}, 120_000);

it('25,000-record repo completes with bounded per-step fetches (no MAX_OPERATIONS ceiling)', async () => {
  const env = await setup([...scrobbles(25_000), ...others('app.bsky.feed.like', 500, 'l')]);
  const expected = (await env.repo.entries()).filter((e) => isMusic(e.key));
  expect(expected.length).toBe(25_000);
  expect(expected.length).toBeGreaterThan(RUST_MAX_OPERATIONS);

  const commit = await verifiedHead(env);
  env.pds.calls.reset();
  const source = getBlocksSource({ safeFetch: env.safeFetch, pds: PDS, did: DID });
  const cache = new MemoryBlockCache();
  const opts: StepOptions = { maxFetches: 20, maxEntries: 1_000, knownCid: () => null, include: isMusic };
  const steps = await walkAll(commit, source, cache, opts);

  const entries = steps.flatMap((s) => s.entries);
  expect(entries.length).toBe(25_000);
  expect(entries.map((e) => e.key)).toEqual(expected.map((e) => e.key));
  expect(entries.every((e, i) => e.cid === expected[i]!.cid && cborCid(e.recordBytes!) === e.cid)).toBe(true);
  assertChunks(steps, opts);
  expect(steps.length).toBeGreaterThanOrEqual(25);
  // Per-step HTTP is bounded by maxFetches, whatever the repository size.
  const perStep = steps.map((s) => s.fetches);
  expect(Math.max(...perStep)).toBeLessThanOrEqual(20);
  const requests = getBlocksRequests(env.pds);
  expect(requests.length).toBe(perStep.reduce((a, b) => a + b, 0));
  expect(requests.every((r) => r.length >= 1 && r.length <= GET_BLOCKS_BATCH)).toBe(true);
  // The frontier stays small: it is bounded by tree depth × node width, not by the record count.
  const frontier = Math.max(...steps.map((s) => JSON.stringify(s.state).length));
  expect(frontier).toBeLessThan(64 * 1024);
}, 300_000);

/** Every MST node with the open key bounds its parent gives it, computed straight from the fixture store. */
async function nodesWithBounds(repo: SignedRepo) {
  const ns = new NodeStore(repo.store);
  const out: Array<{
    cid: string;
    lo: string | null;
    hi: string | null;
    inRangeKeys: number;
    subtreeInRange: boolean;
  }> = [];
  const visit = async (cid: string, lo: string | null, hi: string | null): Promise<boolean> => {
    const node = await ns.get(cid);
    const record = { cid, lo, hi, inRangeKeys: 0, subtreeInRange: false };
    out.push(record);
    let any = false;
    const bounds = [lo, ...node.keys, hi];
    for (let i = 0; i < node.subtrees.length; i++) {
      const t = node.subtrees[i];
      if (t && (await visit(t.$link, bounds[i] ?? null, bounds[i + 1] ?? null))) any = true;
    }
    record.inRangeKeys = node.keys.filter((k) => k >= RANGE[0] && k < RANGE[1]).length;
    record.subtreeInRange = any || record.inRangeKeys > 0;
    return record.subtreeInRange;
  };
  await visit(repo.head!.data, null, null);
  return out;
}

it('only subtrees overlapping the prefix range are fetched (call count bound)', async () => {
  const env = await setup([
    ...scrobbles(150),
    ...others('app.bsky.feed.like', 1_500, 'l'),
    ...others('app.bsky.graph.follow', 700, 'g'),
    ...others('zz.example.other', 800, 'o'),
  ]);
  const all = await env.repo.entries();
  const inRangeEntries = all.filter((e) => inRange(RANGE, e.key));
  expect(inRangeEntries.length).toBe(150);
  const nodes = await nodesWithBounds(env.repo);
  const nodeCids = new Set(nodes.map((n) => n.cid));
  // Necessary: every node that holds an in-range key or lies above one.
  const necessary = new Set(nodes.filter((n) => n.subtreeInRange).map((n) => n.cid));
  // Allowed: nodes whose bound interval (lo, hi) intersects [p., p/).
  const allowed = new Set(
    nodes.filter((n) => (n.lo === null || n.lo < RANGE[1]) && (n.hi === null || n.hi > RANGE[0])).map((n) => n.cid),
  );
  const height = await rootHeight(env.repo);

  const commit = await verifiedHead(env);
  env.pds.calls.reset();
  const source = recording(getBlocksSource({ safeFetch: env.safeFetch, pds: PDS, did: DID }));
  const cache = new MemoryBlockCache();
  const opts: StepOptions = { maxFetches: 50, maxEntries: 10_000, knownCid: () => null };
  const steps = await walkAll(commit, source, cache, opts);
  expect(steps.length).toBe(1);
  expect(steps[0]!.entries.map((e) => e.key)).toEqual(inRangeEntries.map((e) => e.key));

  const requested = source.requested();
  const fetchedNodes = new Set(requested.filter((c) => nodeCids.has(c)));
  const fetchedRecords = requested.filter((c) => !nodeCids.has(c));
  // Each CID at most once; records: exactly the in-range ones.
  expect(new Set(requested).size).toBe(requested.length);
  expect(fetchedRecords.sort()).toEqual(inRangeEntries.map((e) => e.cid).sort());
  // Nodes: every necessary node, nothing whose bounds lie outside the range, and beyond the
  // necessary ones only the nodes on the two boundary paths (≤ 2 per layer).
  for (const c of necessary) expect(fetchedNodes.has(c)).toBe(true);
  for (const c of fetchedNodes) expect(allowed.has(c)).toBe(true);
  expect(fetchedNodes.size - necessary.size).toBeLessThanOrEqual(2 * (height + 1));
  expect(nodes.length).toBeGreaterThan(10 * fetchedNodes.size);
  // Call count: one getBlocks request per walker fetch, and few of them.
  const requests = getBlocksRequests(env.pds);
  expect(requests.length).toBe(source.calls.length);
  expect(requests.length).toBe(steps[0]!.fetches);
  expect(requests.length).toBeLessThanOrEqual(height + 1 + Math.ceil((fetchedNodes.size + 150) / GET_BLOCKS_BATCH));
}, 120_000);

/** The MST layer of the root, i.e. the tree height minus one. */
async function rootHeight(repo: SignedRepo): Promise<number> {
  return (await (await new NodeStore(repo.store).get(repo.head!.data)).height()) ?? 0;
}

it('unchanged record CIDs are not fetched on re-snapshot', async () => {
  const env = await setup([...scrobbles(400), ...follows(100), ...others('app.bsky.feed.like', 300, 'l')]);
  const cache = new MemoryBlockCache();
  const opts = (stored: Map<string, string>): StepOptions => ({
    maxFetches: 10,
    maxEntries: 120,
    knownCid: (key) => stored.get(key) ?? null,
    include: isMusic,
  });

  // First snapshot: nothing stored, every music record fetched.
  const stored = new Map<string, string>();
  const first = await walkAll(await verifiedHead(env), blocksOf(env), cache, opts(stored));
  const firstEntries = first.flatMap((s) => s.entries);
  expect(firstEntries.length).toBe(500);
  expect(firstEntries.every((e) => e.recordBytes !== undefined)).toBe(true);
  for (const e of firstEntries) stored.set(e.key, e.cid);
  const firstNodes = new Set(cache.blocks.keys());

  // Change 6 records: update 3 scrobbles, create 2, delete 1 follow.
  const updated = [scrobbleRkey(10), scrobbleRkey(200), scrobbleRkey(399)];
  const created = [scrobbleRkey(1_000), scrobbleRkey(1_001)];
  const deleted = `${COLL.follow}/f${(7).toString(16).padStart(8, '0')}`;
  await env.repo.writes([
    ...updated.map((rkey, i) => put(COLL.scrobble, rkey, scrobble(10_000 + i, { track: `Changed ${i}` }))),
    ...created.map((rkey, i) => put(COLL.scrobble, rkey, scrobble(1_000 + i))),
    { action: 'delete', collection: COLL.follow, rkey: deleted.split('/')[1]! },
  ]);
  const newMusic = (await env.repo.entries()).filter((e) => isMusic(e.key));
  expect(newMusic.length).toBe(501);
  const changedKeys = new Set([...updated, ...created].map((r) => `${COLL.scrobble}/${r}`));
  const changedCids = newMusic.filter((e) => changedKeys.has(e.key)).map((e) => e.cid);
  expect(changedCids.length).toBe(5);

  // Re-snapshot with the stored CIDs and the node cache from the first walk.
  const commit2 = await verifiedHead(env);
  env.pds.calls.reset();
  const second = await walkAll(commit2, blocksOf(env), cache, opts(stored));
  const secondEntries = second.flatMap((s) => s.entries);
  expect(secondEntries.map((e) => [e.key, e.cid])).toEqual(newMusic.map((e) => [e.key, e.cid]));
  expect(secondEntries.some((e) => e.key === deleted)).toBe(false);
  expect(
    secondEntries
      .filter((e) => e.recordBytes !== undefined)
      .map((e) => e.key)
      .sort(),
  ).toEqual([...changedKeys].sort());
  for (const e of secondEntries.filter((x) => x.recordBytes)) expect(cborCid(e.recordBytes!)).toBe(e.cid);

  // Over HTTP: exactly the 5 changed record blocks, plus only the MST nodes the first walk had not cached.
  const requested = getBlocksRequests(env.pds).flat();
  const allNodes = new Set((await nodesWithBounds(env.repo)).map((n) => n.cid));
  const recordRequests = requested.filter((c) => !allNodes.has(c));
  const nodeRequests = requested.filter((c) => allNodes.has(c));
  expect(recordRequests.sort()).toEqual([...changedCids].sort());
  expect(nodeRequests.every((c) => !firstNodes.has(c))).toBe(true);
  expect(nodeRequests.length).toBeGreaterThan(0);
  expect(nodeRequests.length).toBeLessThan(firstNodes.size / 4);

  // A third snapshot with nothing changed: zero getBlocks requests (all nodes cached, all CIDs known).
  for (const e of secondEntries) stored.set(e.key, e.cid);
  stored.delete(deleted);
  env.pds.calls.reset();
  const third = await walkAll(commit2, blocksOf(env), cache, opts(stored));
  expect(third.flatMap((s) => s.entries).map((e) => [e.key, e.cid])).toEqual(newMusic.map((e) => [e.key, e.cid]));
  expect(third.flatMap((s) => s.entries).every((e) => e.recordBytes === undefined)).toBe(true);
  expect(third.reduce((n, s) => n + s.fetches, 0)).toBe(0);
  expect(env.pds.count(GET_BLOCKS)).toBe(0);
}, 120_000);

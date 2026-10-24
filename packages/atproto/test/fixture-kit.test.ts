// W1-05: the signed-repo kit and the fake network are themselves tested here,
// against independent verifiers (@atcute/car + @atcute/mst + @atcute/crypto as
// in production, @atproto/crypto as the cross-check) and the Rust oracle
// goldens. Every assertion goes through HTTP responses of the fakes, decoded
// CAR contents, or the fakes' call logs.

import { fromUint8Array } from '@atcute/car';
import { decode } from '@atcute/cbor';
import * as CID from '@atcute/cid';
import { verifySigWithDidKey } from '@atcute/crypto';
import { findRpathAndBuildProof, MemoryBlockStore, MissingBlockError, NodeStore } from '@atcute/mst';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { FakeJetstream, type JetstreamEvent } from '@atmusic/atproto/test-support/fake-jetstream';
import { FakePds, fixtureToken } from '@atmusic/atproto/test-support/fake-pds';
import { FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { FakeRelay } from '@atmusic/atproto/test-support/fake-relay';
import { fixtureKeys, type TestKey } from '@atmusic/atproto/test-support/keys';
import {
  createFixtureKit,
  FIXTURE_PDS_HOSTS,
  type FixtureKit,
  followRkey,
  seedReadModels,
} from '@atmusic/atproto/test-support/read-models';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import {
  carCommit,
  cidOf,
  corruptBlockByte,
  corruptDid,
  corruptMstNodeByte,
  corruptMstStructure,
  corruptOversize,
  corruptRecordCidSwap,
  corruptRev,
  corruptRoot,
  corruptSignature,
  corruptSignatureHighS,
  corruptTruncate,
  corruptVersion,
  dropBlock,
  OVERSIZE_CAR_BYTES,
  parseCar,
  SignedRepo,
  TID_RE,
  unsignedCommitBytes,
} from '@atmusic/atproto/test-support/signed-repo';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { verifySignature as atprotoVerify } from '@atproto/crypto';
import { expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import followRkeyGoldens from '../../../tests/goldens/follow_rkeys.json' with { type: 'json' };
import manifest from '../../../tests/goldens/signed_cars/manifest.json' with { type: 'json' };
import enumeration from '../../../tests/goldens/snapshot_enumeration.json' with { type: 'json' };

const P = 'com.example.atmusic';
const SCROBBLE = `${P}.scrobble`;
const FOLLOW = `${P}.follow`;
const ALICE = fixture.users.Alice.did;
const BOB = fixture.users.Bob.did;
const CAROL = fixture.users.Carol.did;
const HOST = 'pds-test.example.test';
const MAX_CAR = 8 * 1024 * 1024;

const aliceScrobbles = fixture.scrobbles.filter((s) => s.owner === ALICE);
const recordOf = (rkey: string) => fixture.scrobbles.find((s) => s.rkey === rkey)!.record;

type WorkerdSocket = WebSocket & { accept(): void };

function xrpc(host: string, nsid: string, params: Record<string, string | string[]>): Request {
  const url = new URL(`https://${host}/xrpc/${nsid}`);
  for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) url.searchParams.append(k, x);
  return new Request(url);
}

function post(host: string, nsid: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`https://${host}/xrpc/${nsid}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function bytesOf(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await res.arrayBuffer());
}

/** Both independent signature verifiers, strict low-S. */
async function sigChecks(didKey: string, commit: Record<string, unknown>) {
  const data = unsignedCommitBytes(commit);
  const sig = (commit.sig as { buf: Uint8Array<ArrayBuffer> }).buf;
  return {
    atcute: await verifySigWithDidKey(didKey, sig, data, { allowMalleableSig: false }),
    atproto: await atprotoVerify(didKey, data, sig, { allowMalleableSig: false }),
  };
}

/**
 * An independent getRecord-CAR verifier built from the production libraries:
 * @atcute/car (hash-checked read), commit checks, both signature libraries,
 * @atcute/mst proof walk over the CID-verified blocks only.
 */
async function verifyProofCar(car: Uint8Array, o: { did: string; didKey: string; collection: string; rkey: string }) {
  const reader = fromUint8Array(car);
  const blocks = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const entry of reader) blocks.set(CID.toString(entry.cid), new Uint8Array(entry.bytes));
  const root = reader.roots[0]!.$link;
  const commit = decode(blocks.get(root)!) as Record<string, unknown> & { data: { $link: string }; rev: string };
  const sig = await sigChecks(o.didKey, commit);
  const [value, proof] = await findRpathAndBuildProof(
    new NodeStore(new MemoryBlockStore(blocks)),
    commit.data.$link,
    `${o.collection}/${o.rkey}`,
  );
  const recordBytes = value ? blocks.get(value.$link) : undefined;
  return {
    commitCid: root,
    did: commit.did,
    version: commit.version,
    rev: commit.rev,
    revIsTid: TID_RE.test(commit.rev),
    signature: sig,
    state: value ? 'present' : 'absent',
    cid: value?.$link ?? null,
    record: recordBytes ? (decode(recordBytes) as unknown) : null,
    proofNodes: proof,
    blockCids: [...blocks.keys()],
  };
}

// ---------------------------------------------------------------------------
// The invariant checker for the corruption matrix
// ---------------------------------------------------------------------------

type Invariant =
  | 'size'
  | 'well_formed'
  | 'block_hashes'
  | 'root_block'
  | 'did'
  | 'version'
  | 'rev'
  | 'signature'
  | 'mst'
  | 'path_complete'
  | 'record_block';

/**
 * Evaluates every verification invariant it can, in ADR 0004 §7 order, and
 * returns the ones that fail. A block whose bytes do not hash to its CID is
 * reported once (`block_hashes`) and never trusted; a later check that needs
 * that block is skipped rather than counted again. A truncated final section
 * is reported as `well_formed`, and the sections before it are still checked.
 */
async function invariantFailures(car: Uint8Array, o: { did: string; key: TestKey; path: string }) {
  const failed: Invariant[] = [];
  if (car.length > MAX_CAR) failed.push('size');
  let roots: string[];
  const sections: Array<{ cid: string; bytes: Uint8Array<ArrayBuffer> }> = [];
  try {
    const parsed = parseCar(car);
    roots = parsed.roots;
    sections.push(...parsed.sections);
  } catch {
    failed.push('well_formed');
    // Re-read leniently: every complete section before the break.
    const prefix = await lenientSections(car);
    if (!prefix) return failed;
    roots = prefix.roots;
    sections.push(...prefix.sections);
  }
  const trusted = new Map<string, Uint8Array<ArrayBuffer>>();
  const tainted = new Set<string>();
  for (const s of sections) {
    const codec = CID.fromString(s.cid).codec as 0x55 | 0x71;
    if (CID.toString(CID.createSync(codec, s.bytes)) === s.cid) trusted.set(s.cid, s.bytes);
    else tainted.add(s.cid);
  }
  if (tainted.size > 0) failed.push('block_hashes');
  const root = roots[0]!;
  const commitBytes = trusted.get(root);
  if (!commitBytes) {
    if (!tainted.has(root)) failed.push('root_block');
    return failed;
  }
  const commit = decode(commitBytes) as Record<string, unknown> & { data: { $link: string }; rev: unknown };
  if (commit.did !== o.did) failed.push('did');
  if (commit.version !== 3) failed.push('version');
  if (typeof commit.rev !== 'string' || !TID_RE.test(commit.rev)) failed.push('rev');
  const sig = await sigChecks(o.key.didKey, commit);
  expect(sig.atcute).toBe(sig.atproto); // the two libraries never disagree
  if (!sig.atcute) failed.push('signature');
  let value: { $link: string } | null = null;
  try {
    [value] = await findRpathAndBuildProof(new NodeStore(new MemoryBlockStore(trusted)), commit.data.$link, o.path);
  } catch (e) {
    if (e instanceof MissingBlockError) {
      if (!tainted.has(e.cid)) failed.push('path_complete');
    } else {
      failed.push('mst');
    }
    return failed;
  }
  if (value && !trusted.has(value.$link) && !tainted.has(value.$link)) failed.push('record_block');
  return failed;
}

async function lenientSections(car: Uint8Array) {
  // Cut back to the last complete section boundary, then parse strictly.
  for (let end = car.length - 1; end > 0; end--) {
    try {
      const parsed = parseCar(car.subarray(0, end));
      if (parsed.sections.length > 0) return parsed;
    } catch {
      // keep shrinking
    }
  }
  return null;
}

function blockMap(car: Uint8Array) {
  return new Map(parseCar(car).sections.map((s) => [s.cid, s.bytes] as const));
}

/** Which blocks and roots differ between two CARs. */
function carDiff(base: Uint8Array, other: Uint8Array) {
  const a = blockMap(base);
  const b = blockMap(other);
  const removed = [...a.keys()].filter((c) => !b.has(c));
  const added = [...b.keys()].filter((c) => !a.has(c));
  const changed = [...a.keys()].filter((c) => b.has(c) && encodeHex(a.get(c)!) !== encodeHex(b.get(c)!));
  return {
    removed,
    added,
    changed,
    rootChanged: parseCar(base).roots[0] !== parseCar(other).roots[0],
  };
}

function encodeHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Alice's fixture scrobbles r01–r07 (plus r08 unless `withoutR08`) in one repo per key. */
async function aliceRepo(key: TestKey, o: { withR08?: boolean } = {}) {
  const repo = new SignedRepo(ALICE, key, { clock: fixedClock() });
  const cids = new Map<string, string>();
  for (const s of aliceScrobbles) {
    if (s.rkey === 'r08' && !o.withR08) continue;
    const c = await repo.put(SCROBBLE, s.rkey, s.record);
    cids.set(s.rkey, c.ops[0]!.cid!);
  }
  return { repo, cids };
}

function wsOf(res: Response): WorkerdSocket {
  const ws = (res as Response & { webSocket: WorkerdSocket | null }).webSocket;
  if (!ws) throw new Error('response carries no webSocket');
  return ws;
}

/** Collects a client socket's events; `until` resolves once the predicate holds (no timers). */
function collect(ws: WorkerdSocket) {
  const frames: string[] = [];
  const state = { closeCode: null as number | null, errors: 0 };
  const waiters: Array<{ pred: () => boolean; resolve: () => void }> = [];
  const check = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred()) {
        waiters[i]!.resolve();
        waiters.splice(i, 1);
      }
    }
  };
  ws.accept();
  ws.addEventListener('message', (e) => {
    frames.push(String(e.data));
    check();
  });
  ws.addEventListener('close', (e) => {
    state.closeCode = e.code;
    check();
  });
  ws.addEventListener('error', () => {
    state.errors += 1;
    check();
  });
  return {
    frames,
    state,
    seqs: () => frames.filter((f) => f.startsWith('{')).map((f) => (JSON.parse(f) as { seq: number }).seq),
    until: (pred: () => boolean) =>
      new Promise<void>((resolve) => {
        if (pred()) resolve();
        else waiters.push({ pred, resolve });
      }),
  };
}

// ---------------------------------------------------------------------------

it('inclusion proof CAR verifies with @atproto/crypto cross-check for both curves', async () => {
  const keys = await fixtureKeys();
  for (const key of [keys.alice, keys.bob]) {
    const { repo, cids } = await aliceRepo(key);
    const pds = new FakePds(HOST);
    await pds.addAccount(repo);
    const transport = routerTransport({ pds: [pds] });

    const res = await transport(
      xrpc(HOST, 'com.atproto.sync.getRecord', { did: ALICE, collection: SCROBBLE, rkey: 'r01' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.ipld.car');
    const car = await bytesOf(res);
    expect(car).toEqual(await repo.getRecordCar(SCROBBLE, 'r01'));

    const v = await verifyProofCar(car, { did: ALICE, didKey: key.didKey, collection: SCROBBLE, rkey: 'r01' });
    expect(v).toMatchObject({
      commitCid: repo.head!.cid,
      did: ALICE,
      version: 3,
      rev: repo.head!.rev,
      revIsTid: true,
      signature: { atcute: true, atproto: true },
      state: 'present',
      cid: cids.get('r01'),
      record: recordOf('r01'),
    });
    // The record CID is the hash of the canonical dag-cbor record, not a stored value.
    expect(v.cid).toBe(cidOf(recordOf('r01')));
    // Exactly commit + MST path + record, nothing else.
    expect(new Set(v.blockCids)).toEqual(new Set([v.commitCid, ...v.proofNodes, v.cid!]));
    expect(pds.count('com.atproto.sync.getRecord')).toBe(1);
    expect(transport.calls.count({ host: HOST, status: 200 })).toBe(1);

    // The production-library signer on this curve also cross-verifies.
    const unsigned = unsignedCommitBytes(carCommit(car));
    if (key.curve === 'p256') {
      const webSig = await key.signWebCrypto!(unsigned);
      expect(await atprotoVerify(key.didKey, unsigned, webSig)).toBe(true);
      expect(await verifySigWithDidKey(key.didKey, webSig, unsigned)).toBe(true);
    }
    // Deterministic signing: rebuilding gives the identical head.
    const again = await aliceRepo(key);
    expect(again.repo.head!.cid).toBe(repo.head!.cid);
  }
  expect(keys.alice.curve).toBe('secp256k1');
  expect(keys.bob.curve).toBe('p256');
});

it('SignedRepo reproduces the Rust-signed golden commits for both curves', async () => {
  const keys = await fixtureKeys();
  // tests/goldens/signed_cars/manifest.json: the [0x07; 32] keys of the Rust oracle.
  expect(keys.alice.didKey).toBe(manifest.keys.secp256k1.didKey);
  expect(keys.bob.didKey).toBe(manifest.keys.p256.didKey);

  // crates/atproto/examples/export_signed_cars.rs repo_records(), rebuilt.
  const records: Array<[string, unknown]> = fixture.scrobbles
    .filter((s) => s.owner === ALICE && s.state === 'confirmed')
    .map((s) => [`${SCROBBLE}/${s.rkey}`, s.record]);
  records.push([
    `${FOLLOW}/${await followRkey(BOB)}`,
    { $type: FOLLOW, subject: BOB, createdAt: '2025-01-01T00:00:00Z' },
  ]);
  records.push([
    `${SCROBBLE}/r99`,
    {
      $type: SCROBBLE,
      artist: '　',
      track: 'Untitled',
      listenedAt: '2026-01-15T10:00:00Z',
      createdAt: '2026-01-15T10:00:00Z',
    },
  ]);
  const groups: Array<[string, string, number]> = [
    ['app.bsky.feed.post', 'p', 15],
    ['app.bsky.feed.like', 'l', 8],
    ['com.example.atmusia.post', 'a', 3],
    ['com.example.atmusic-x.post', 'h', 3],
    ['com.example.atmusicz.post', 'z', 3],
    ['zz.example.other', 'o', 3],
    [`${P}.aaa`, 'a', 2],
    [`${P}.scrobble-x`, 'a', 2],
    [`${P}.scrobbles`, 'a', 2],
    [`${P}.followx`, 'a', 2],
    [`${P}.other`, 'a', 2],
    [`${P}.zzz`, 'z', 2],
    [`${P}.settings`, '', 1],
    [P, 'x', 2],
  ];
  for (const [collection, prefix, count] of groups) {
    for (let i = 0; i < count; i++) {
      const rkey = prefix === '' ? 'self' : `${prefix}${String(i).padStart(2, '0')}`;
      records.push([
        `${collection}/${rkey}`,
        { $type: collection, text: `non-music ${collection} ${i}`, createdAt: '2026-01-01T00:00:00Z' },
      ]);
    }
  }
  expect(records).toHaveLength(59);

  for (const [key, curve] of [
    [keys.alice, 'secp256k1'],
    [keys.bob, 'p256'],
  ] as const) {
    const golden = manifest.entries.find((e) => e.curve === curve && e.kind === 'full_repo')!;
    const repo = new SignedRepo(ALICE, key);
    const head = await repo.writes(
      records.map(([path, record]) => {
        const i = path.lastIndexOf('/');
        return { action: 'put' as const, collection: path.slice(0, i), rkey: path.slice(i + 1), record };
      }),
      { rev: golden.rev },
    );
    expect(head.cid).toBe(golden.carRoot);
    const snapshot = enumeration.snapshots.find((s) => s.curve === curve)!;
    expect(snapshot.commitCid).toBe(head.cid);
    const lower = `${P}.`;
    const upper = `${P}/`;
    const inRange = (await repo.entries()).filter((e) => e.key >= lower && e.key < upper);
    expect(inRange).toEqual(snapshot.rangeEntries.map((e) => ({ key: e.key, cid: e.cid })));
  }
});

it('exclusion proof for deleted r08 contains a complete path', async () => {
  const keys = await fixtureKeys();
  const { repo } = await aliceRepo(keys.alice, { withR08: true });
  const created = await repo.getRecordCar(SCROBBLE, 'r08');
  const before = await verifyProofCar(created, {
    did: ALICE,
    didKey: keys.alice.didKey,
    collection: SCROBBLE,
    rkey: 'r08',
  });
  expect(before.state).toBe('present');

  const deletion = await repo.delete(SCROBBLE, 'r08');
  expect(deletion.ops).toEqual([
    expect.objectContaining({ action: 'delete', rkey: 'r08', cid: null, prev: before.cid }),
  ]);
  const pds = new FakePds(HOST);
  await pds.addAccount(repo);
  const transport = routerTransport({ pds: [pds] });
  const res = await transport(
    xrpc(HOST, 'com.atproto.sync.getRecord', { did: ALICE, collection: SCROBBLE, rkey: 'r08' }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/vnd.ipld.car');
  const car = await bytesOf(res);

  const v = await verifyProofCar(car, { did: ALICE, didKey: keys.alice.didKey, collection: SCROBBLE, rkey: 'r08' });
  expect(v).toMatchObject({
    commitCid: deletion.cid,
    rev: deletion.rev,
    signature: { atcute: true, atproto: true },
    state: 'absent',
    cid: null,
    record: null,
  });
  // The CAR is exactly the commit plus the MST path the walk needs: no record block.
  const nodes = v.blockCids.filter((c) => c !== v.commitCid);
  expect(nodes.length).toBeGreaterThan(0);
  expect(new Set(nodes)).toEqual(v.proofNodes);
  expect(nodes).not.toContain(before.cid);
  // Complete: every node is necessary; dropping any one makes the walk fail
  // with a typed missing block, never a (false) absence.
  for (const node of nodes) {
    const partial = dropBlock(car, node);
    await expect(
      verifyProofCar(partial, { did: ALICE, didKey: keys.alice.didKey, collection: SCROBBLE, rkey: 'r08' }),
    ).rejects.toBeInstanceOf(MissingBlockError);
  }
  // The deleted key is gone from the signed tree, the rest is intact.
  expect((await repo.entries()).map((e) => e.key)).toEqual(
    ['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07'].map((r) => `${SCROBBLE}/${r}`),
  );
  expect(pds.count('com.atproto.sync.getRecord', ALICE)).toBe(1);
});

it('each corruption helper changes exactly one invariant', async () => {
  const keys = await fixtureKeys();
  for (const key of [keys.alice, keys.bob]) {
    const { repo, cids } = await aliceRepo(key);
    await repo.put(FOLLOW, await followRkey(BOB), { $type: FOLLOW, subject: BOB, createdAt: '2025-01-01T00:00:00Z' });
    const ctx = { did: ALICE, key, path: `${SCROBBLE}/r01` };
    const r01 = cids.get('r01')!;
    const swapped = { ...recordOf('r01'), track: 'Jóga (swapped)' };
    const bases = { inclusion: await repo.getRecordCar(SCROBBLE, 'r01'), full: await repo.fullCar() };

    for (const [baseName, base] of Object.entries(bases)) {
      expect(await invariantFailures(base, ctx), `${key.curve} ${baseName} clean`).toEqual([]);
      const cases: Array<[string, Uint8Array, Invariant, (d: ReturnType<typeof carDiff>) => void]> = [
        [
          'signature',
          await corruptSignature(base),
          'signature',
          (d) => expect(d).toMatchObject({ removed: [repo.head!.cid], changed: [], rootChanged: true }),
        ],
        [
          'signature_high_s',
          await corruptSignatureHighS(base, key.curve),
          'signature',
          (d) => expect(d).toMatchObject({ removed: [repo.head!.cid], changed: [], rootChanged: true }),
        ],
        [
          'block_byte',
          corruptBlockByte(base, r01),
          'block_hashes',
          (d) => expect(d).toEqual({ removed: [], added: [], changed: [r01], rootChanged: false }),
        ],
        [
          'mst_node_byte',
          corruptMstNodeByte(base),
          'block_hashes',
          (d) => expect(d).toEqual({ removed: [], added: [], changed: [repo.head!.data], rootChanged: false }),
        ],
        [
          'mst_structure',
          await corruptMstStructure(base, key),
          'mst',
          (d) => {
            expect(new Set(d.removed)).toEqual(new Set([repo.head!.cid, repo.head!.data]));
            expect(d.added).toHaveLength(2);
            expect(d.changed).toEqual([]);
          },
        ],
        [
          'did',
          await corruptDid(base, key),
          'did',
          (d) => expect(d).toMatchObject({ removed: [repo.head!.cid], changed: [], rootChanged: true }),
        ],
        [
          'version',
          await corruptVersion(base, key),
          'version',
          (d) => expect(d).toMatchObject({ removed: [repo.head!.cid], changed: [], rootChanged: true }),
        ],
        [
          'rev',
          await corruptRev(base, key),
          'rev',
          (d) => expect(d).toMatchObject({ removed: [repo.head!.cid], changed: [], rootChanged: true }),
        ],
        [
          'root',
          corruptRoot(base),
          'root_block',
          (d) => expect(d).toEqual({ removed: [], added: [], changed: [], rootChanged: true }),
        ],
        [
          'oversize',
          await corruptOversize(base),
          'size',
          (d) => expect(d).toMatchObject({ removed: [], changed: [], rootChanged: false }),
        ],
        [
          'record_cid_swap',
          corruptRecordCidSwap(base, r01, swapped),
          'record_block',
          (d) => expect(d).toEqual({ removed: [r01], added: [cidOf(swapped)], changed: [], rootChanged: false }),
        ],
      ];
      if (baseName === 'full') {
        // The final section of a full CAR is the greatest-key record (r07), off r01's path.
        const cut = corruptTruncate(base);
        expect(base.subarray(0, cut.length)).toEqual(cut);
        cases.push(['truncate', cut, 'well_formed', () => {}]);
      }
      for (const [name, bad, expected, diff] of cases) {
        expect(await invariantFailures(bad, ctx), `${key.curve} ${baseName} ${name}`).toEqual([expected]);
        if (name !== 'truncate') diff(carDiff(base, bad));
      }
      const oversize = cases.find((c) => c[0] === 'oversize')![1];
      expect(oversize.length).toBe(OVERSIZE_CAR_BYTES);
      expect(oversize.subarray(0, base.length)).toEqual(base);
    }
    // The same corruptions on a proof CAR are what a record-proof verifier sees:
    // a removed deepest path node is a missing block, never an absence.
    const inclusion = bases.inclusion;
    const pathNodes = (
      await verifyProofCar(inclusion, { ...ctx, didKey: key.didKey, collection: SCROBBLE, rkey: 'r01' })
    ).proofNodes;
    const deepest = [...pathNodes].at(-1)!;
    expect(await invariantFailures(dropBlock(inclusion, deepest), ctx)).toEqual(['path_complete']);
  }
});

it('fake PDS createRecord with existing rkey returns RecordAlreadyExists; deleteRecord with stale swap returns InvalidSwap', async () => {
  const keys = await fixtureKeys();
  const clock = fixedClock();
  const repo = new SignedRepo(ALICE, keys.alice, { clock });
  const pds = new FakePds(HOST, { clock });
  await pds.addAccount(repo, { handle: 'alice.test' });
  const t = routerTransport({ pds: { [HOST]: pds } });
  const token = fixtureToken(ALICE);
  const r01 = recordOf('r01');
  const json = async (res: Response) => (await res.json()) as Record<string, unknown>;
  const head = async () =>
    json(await t(xrpc(HOST, 'com.atproto.sync.getLatestCommit', { did: ALICE }))) as Promise<{
      cid: string;
      rev: string;
    }>;

  // createRecord → 200 with the signer's CID and commit.
  let res = await t(
    post(HOST, 'com.atproto.repo.createRecord', { repo: ALICE, collection: SCROBBLE, rkey: 'r01', record: r01 }, token),
  );
  expect(res.status).toBe(200);
  const created = await json(res);
  expect(created).toEqual({
    uri: `at://${ALICE}/${SCROBBLE}/r01`,
    cid: cidOf(r01),
    commit: { cid: repo.head!.cid, rev: repo.head!.rev },
    validationStatus: 'unknown',
  });
  const afterCreate = await head();
  expect(afterCreate).toEqual(created.commit);

  // Same rkey again → RecordAlreadyExists; no new commit.
  res = await t(
    post(
      HOST,
      'com.atproto.repo.createRecord',
      { repo: ALICE, collection: SCROBBLE, rkey: 'r01', record: recordOf('r02') },
      token,
    ),
  );
  expect(res.status).toBe(400);
  expect(await json(res)).toMatchObject({ error: 'RecordAlreadyExists' });
  expect(await head()).toEqual(afterCreate);

  // putRecord with swapRecord null (must not exist) → InvalidSwap.
  res = await t(
    post(
      HOST,
      'com.atproto.repo.putRecord',
      { repo: ALICE, collection: SCROBBLE, rkey: 'r01', record: r01, swapRecord: null },
      token,
    ),
  );
  expect(res.status).toBe(400);
  expect(await json(res)).toMatchObject({ error: 'InvalidSwap' });

  // deleteRecord with a stale swap → InvalidSwap; the record is untouched.
  const stale = cidOf(recordOf('r02'));
  res = await t(
    post(
      HOST,
      'com.atproto.repo.deleteRecord',
      { repo: ALICE, collection: SCROBBLE, rkey: 'r01', swapRecord: stale },
      token,
    ),
  );
  expect(res.status).toBe(400);
  expect(await json(res)).toMatchObject({ error: 'InvalidSwap' });
  expect(await head()).toEqual(afterCreate);
  res = await t(xrpc(HOST, 'com.atproto.repo.getRecord', { repo: 'alice.test', collection: SCROBBLE, rkey: 'r01' }));
  expect(res.status).toBe(200);
  expect(await json(res)).toEqual({ uri: `at://${ALICE}/${SCROBBLE}/r01`, cid: cidOf(r01), value: r01 });

  // Stale swapCommit → InvalidSwap.
  res = await t(
    post(
      HOST,
      'com.atproto.repo.deleteRecord',
      { repo: ALICE, collection: SCROBBLE, rkey: 'r01', swapCommit: repo.history[0]!.cid },
      token,
    ),
  );
  expect(res.status).toBe(400);
  expect(await json(res)).toMatchObject({ error: 'InvalidSwap' });

  // Authentication: missing, wrong and foreign tokens.
  res = await t(post(HOST, 'com.atproto.repo.deleteRecord', { repo: ALICE, collection: SCROBBLE, rkey: 'r01' }));
  expect([res.status, (await json(res)).error]).toEqual([401, 'AuthenticationRequired']);
  res = await t(
    post(HOST, 'com.atproto.repo.deleteRecord', { repo: ALICE, collection: SCROBBLE, rkey: 'r01' }, 'nope'),
  );
  expect([res.status, (await json(res)).error]).toEqual([401, 'InvalidToken']);
  expect(await head()).toEqual(afterCreate);

  // The matching swap deletes; the PDS now serves a signed exclusion proof.
  res = await t(
    post(
      HOST,
      'com.atproto.repo.deleteRecord',
      { repo: ALICE, collection: SCROBBLE, rkey: 'r01', swapRecord: cidOf(r01) },
      token,
    ),
  );
  expect(res.status).toBe(200);
  const deleted = await json(res);
  expect(deleted).toEqual({ commit: { cid: repo.head!.cid, rev: repo.head!.rev } });
  expect(repo.head!.rev > afterCreate.rev).toBe(true);
  res = await t(xrpc(HOST, 'com.atproto.sync.getRecord', { did: ALICE, collection: SCROBBLE, rkey: 'r01' }));
  const exclusion = await verifyProofCar(await bytesOf(res), {
    did: ALICE,
    didKey: keys.alice.didKey,
    collection: SCROBBLE,
    rkey: 'r01',
  });
  expect(exclusion).toMatchObject({ state: 'absent', commitCid: repo.head!.cid });

  // Ambiguous create: committed, then the response is lost as a 500.
  pds.faultsAfter.add({ nsid: 'com.atproto.repo.createRecord' }, { kind: 'status', status: 500 });
  res = await t(
    post(
      HOST,
      'com.atproto.repo.createRecord',
      { repo: ALICE, collection: SCROBBLE, rkey: 'r02', record: recordOf('r02') },
      token,
    ),
  );
  expect(res.status).toBe(500);
  expect((await repo.getRecord(SCROBBLE, 'r02'))?.cid).toBe(cidOf(recordOf('r02')));

  // ---- fault controls -------------------------------------------------
  const GR = 'com.atproto.sync.getRecord';
  const grReq = (rkey = 'r02') => xrpc(HOST, GR, { did: ALICE, collection: SCROBBLE, rkey });

  pds.rateLimit(GR, 20, 1, 1768478420);
  res = await t(grReq());
  expect(res.status).toBe(429);
  expect(res.headers.get('retry-after')).toBe('20');
  expect(res.headers.get('ratelimit-reset')).toBe('1768478420');
  expect(await json(res)).toMatchObject({ error: 'RateLimitExceeded' });
  expect((await t(grReq())).status).toBe(200); // consumed once

  pds.serverError(GR, 503, 2);
  expect((await t(grReq())).status).toBe(503);
  expect((await t(grReq())).status).toBe(503);
  expect((await t(grReq())).status).toBe(200);

  pds.redirect(GR, 'https://elsewhere.example.test/xrpc/x');
  res = await t(grReq());
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('https://elsewhere.example.test/xrpc/x');
  expect(t.calls.count({ host: 'elsewhere.example.test' })).toBe(0); // never followed

  const big = pds.oversize('com.atproto.sync.getRepo', 40 * 1024 * 1024);
  res = await t(xrpc(HOST, 'com.atproto.sync.getRepo', { did: ALICE }));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const first = await reader.read();
  await reader.cancel();
  expect(first.value!.length).toBeGreaterThan(0);
  expect(big.kind === 'oversize' && big.emitted! < 40 * 1024 * 1024).toBe(true); // streamed lazily

  const controller = new AbortController();
  pds.fail({ nsid: GR }, { kind: 'hang' });
  const hung = t(new Request(grReq().url, { signal: controller.signal }));
  controller.abort(new Error('deadline'));
  await expect(hung).rejects.toThrow('deadline');

  // Stale head: an older commit is served as the head.
  const oldHead = repo.history[1]!; // after the r01 create
  pds.serveStaleHead(ALICE, oldHead.cid);
  expect(await head()).toEqual({ cid: oldHead.cid, rev: oldHead.rev });
  const staleProof = await verifyProofCar(await bytesOf(await t(grReq('r01'))), {
    did: ALICE,
    didKey: keys.alice.didKey,
    collection: SCROBBLE,
    rkey: 'r01',
  });
  expect(staleProof).toMatchObject({ state: 'present', commitCid: oldHead.cid, rev: oldHead.rev });
  pds.clearStaleHead(ALICE);
  expect((await head()).cid).toBe(repo.head!.cid);

  // RecordNotFound instead of an exclusion proof.
  pds.noExclusionProof = true;
  res = await t(grReq('r01'));
  expect([res.status, (await json(res)).error]).toEqual([400, 'RecordNotFound']);
  expect((await t(grReq('r02'))).status).toBe(200);
  pds.noExclusionProof = false;

  // getBlocks: served, then BlockNotFound after GC, then unsupported (501).
  const GB = 'com.atproto.sync.getBlocks';
  res = await t(xrpc(HOST, GB, { did: ALICE, cids: [repo.head!.cid, oldHead.data] }));
  expect(res.status).toBe(200);
  const served = fromUint8Array(await bytesOf(res));
  expect(served.roots).toEqual([]);
  expect([...served].map((e) => CID.toString(e.cid))).toEqual([repo.head!.cid, oldHead.data]);
  const dropped = await pds.gc(ALICE);
  expect(dropped).toContain(oldHead.data);
  res = await t(xrpc(HOST, GB, { did: ALICE, cids: [repo.head!.cid, oldHead.data] }));
  expect(res.status).toBe(400);
  expect(await json(res)).toMatchObject({ error: 'BlockNotFound' });
  pds.getBlocksSupported = false;
  res = await t(xrpc(HOST, GB, { did: ALICE, cids: [repo.head!.cid] }));
  expect([res.status, (await json(res)).error]).toEqual([501, 'MethodNotImplemented']);

  // Account status: deactivated / takendown / unknown.
  pds.deactivate(ALICE);
  res = await t(xrpc(HOST, 'com.atproto.sync.getRepoStatus', { did: ALICE }));
  expect(await json(res)).toEqual({ did: ALICE, active: false, status: 'deactivated' });
  res = await t(grReq());
  expect([res.status, (await json(res)).error]).toEqual([400, 'RepoDeactivated']);
  pds.takedown(ALICE);
  res = await t(grReq());
  expect([res.status, (await json(res)).error]).toEqual([400, 'RepoTakendown']);
  pds.reactivate(ALICE);
  res = await t(xrpc(HOST, 'com.atproto.sync.getRepoStatus', { did: ALICE }));
  expect(await json(res)).toEqual({ did: ALICE, active: true, rev: repo.head!.rev });
  res = await t(xrpc(HOST, 'com.atproto.sync.getLatestCommit', { did: BOB }));
  expect([res.status, (await json(res)).error]).toEqual([400, 'RepoNotFound']);

  // Key rotation: the PDS re-signs its head with the new key.
  const rotated = await pds.rotateKey(ALICE, keys.aliceRotated);
  expect(rotated!.ops).toEqual([]);
  const rotatedCommit = carCommit(await repo.getRecordCar(SCROBBLE, 'r02'));
  expect(await sigChecks(keys.aliceRotated.didKey, rotatedCommit)).toEqual({ atcute: true, atproto: true });
  expect(await sigChecks(keys.alice.didKey, rotatedCommit)).toEqual({ atcute: false, atproto: false });

  // Every call was logged with its outcome.
  expect(pds.count('com.atproto.repo.createRecord')).toBe(3);
  expect(pds.count('com.atproto.repo.deleteRecord')).toBe(5);
  expect(pds.calls.count({ nsid: GR, status: 429 })).toBe(1);
  expect(pds.calls.count({ nsid: GR, status: 503 })).toBe(2);
  expect(pds.calls.filter({ nsid: GR, status: 302 }).map((c) => c.fault)).toEqual(['redirect']);
  expect(pds.calls.count({ nsid: GB })).toBe(3);
  // The aborted hang is logged too (status 0) by both the PDS and the router.
  expect(pds.calls.filter({ status: 0 }).map((c) => c.fault)).toEqual(['hang']);
  expect(pds.calls.count()).toBe(t.calls.count({ host: HOST }));
});

it('fake Jetstream replays inclusively from cursor and refuses cursors older than lookback', async () => {
  const clock = fixedClock();
  const js = new FakeJetstream({ clock, lookbackHours: 24 });
  const t = routerTransport({ jetstream: js });
  const ev = (rkey: string, collection = SCROBBLE): JetstreamEvent =>
    js.append({
      kind: 'commit',
      did: ALICE,
      commit: { rev: '3m4zm2ufr2222', operation: 'create', collection, rkey, record: { rkey }, cid: cidOf({ rkey }) },
    });
  for (const r of ['r01', 'r02', 'r03', 'r04', 'r05']) ev(r);
  expect(js.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  const base = `https://${js.host}/xrpc/network.bsky.jetstream.subscribeEvents?kinds=commit&collections=${SCROBBLE}`;
  const connect = (cursor?: number | string) =>
    t(new Request(cursor === undefined ? base : `${base}&cursor=${cursor}`, { headers: { upgrade: 'websocket' } }));

  // Inclusive replay from seq 3, then live events; foreign collections are filtered.
  let res = await connect(3);
  expect(res.status).toBe(101);
  const a = collect(wsOf(res));
  await a.until(() => a.frames.length === 3);
  expect(a.seqs()).toEqual([3, 4, 5]);
  expect(JSON.parse(a.frames[0]!)).toEqual({
    did: ALICE,
    seq: 3,
    time_us: js.events[2]!.timeUs,
    kind: 'commit',
    commit: {
      rev: '3m4zm2ufr2222',
      operation: 'create',
      collection: SCROBBLE,
      rkey: 'r03',
      record: { rkey: 'r03' },
      cid: cidOf({ rkey: 'r03' }),
    },
  });
  ev('r06');
  ev('f01', FOLLOW);
  ev('r07');
  await a.until(() => a.frames.length === 5);
  expect(a.seqs()).toEqual([3, 4, 5, 6, 8]);
  const conn = js.connections[0]!;
  expect(conn.cursor).toBe(3);
  conn.send('not json');
  await a.until(() => a.frames.length === 6);
  expect(a.frames[5]).toBe('not json');
  conn.close(4000, 'bye');
  await a.until(() => a.state.closeCode !== null);
  expect(a.state.closeCode).toBe(4000);
  expect(js.live()).toHaveLength(0);

  // A time_us cursor replays from the first event at or after it.
  res = await connect(js.events[1]!.timeUs);
  const b = collect(wsOf(res));
  await b.until(() => b.frames.length === 6);
  expect(b.seqs()).toEqual([2, 3, 4, 5, 6, 8]);
  js.connections[1]!.error('boom');
  await b.until(() => b.state.errors === 1 && b.state.closeCode !== null);
  expect(b.state).toEqual({ errors: 1, closeCode: 1011 });

  // No cursor: live tail only.
  res = await connect();
  const c = collect(wsOf(res));
  ev('r09');
  await c.until(() => c.frames.length === 1);
  expect(c.seqs()).toEqual([9]);
  js.connections[2]!.close();

  // Lookback: everything up to seq 9 ages out after 24 h; a cursor asking for
  // any of it is refused before upgrade, and no socket is opened.
  clock.advance(24 * 3_600_000 + 1);
  const fresh = ev('r10'); // seq 10, inside the window
  const sockets = js.connections.length;
  res = await connect(3);
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: 'OutdatedCursor' });
  res = await connect(9);
  expect(res.status).toBe(400);
  res = await connect(js.events[0]!.timeUs);
  expect(res.status).toBe(400);
  expect(js.connections).toHaveLength(sockets);
  // The boundary is inclusive: the oldest retained seq is accepted.
  res = await connect(fresh.seq);
  expect(res.status).toBe(101);
  const d = collect(wsOf(res));
  await d.until(() => d.frames.length === 1);
  expect(d.seqs()).toEqual([10]);

  // Malformed handshakes.
  expect((await t(new Request(base))).status).toBe(426);
  expect((await connect('abc')).status).toBe(400);
  expect(js.calls.count({ status: 101 })).toBe(4);
  expect(js.calls.count({ status: 400 })).toBe(4);
  expect(js.calls.count()).toBe(t.calls.count({ service: 'jetstream' }));
});

let seeded: { kit: FixtureKit; result: Awaited<ReturnType<typeof seedReadModels>> } | null = null;
const seed = async () => {
  if (!seeded) {
    const kit = await createFixtureKit();
    seeded = { kit, result: await seedReadModels(kit, { keepCalls: true }) };
  }
  return seeded;
};
const resolveKey = async (kit: FixtureKit, did: string) => {
  const res = await kit.transport(new Request(`https://plc.directory/${did}`));
  expect(res.status).toBe(200);
  const doc = (await res.json()) as {
    verificationMethod: Array<{ id: string; publicKeyMultibase: string }>;
    service: Array<{ id: string; serviceEndpoint: string }>;
  };
  return {
    didKey: `did:key:${doc.verificationMethod.find((m) => m.id === `${did}#atproto`)!.publicKeyMultibase}`,
    pds: doc.service.find((s) => s.id === '#atproto_pds')!.serviceEndpoint,
  };
};
const fetchProof = async (kit: FixtureKit, did: string, collection: string, rkey: string, didKey: string) => {
  const { pds } = await resolveKey(kit, did);
  const res = await kit.transport(
    new Request(`${pds}/xrpc/com.atproto.sync.getRecord?did=${did}&collection=${collection}&rkey=${rkey}`),
  );
  expect(res.status).toBe(200);
  return verifyProofCar(await bytesOf(res), { did, didKey, collection, rkey });
};

it('seedReadModels publishes r01–r10 with r08 deleted and the Alice→Bob follow', async () => {
  const { kit, result } = await seed();
  const bobFollowRkey = followRkeyGoldens.entries.find((e) => e.subject === BOB)!.rkey;
  const followUri = `at://${ALICE}/${FOLLOW}/${bobFollowRkey}`;

  // Exactly the fixture's URIs: ten scrobbles and one follow.
  expect([...result.records.keys()].sort()).toEqual([...fixture.scrobbles.map((s) => s.uri), followUri].sort());
  const present = [...result.records.values()].filter((r) => r.state === 'present').map((r) => r.rkey);
  expect(present).toEqual(['r01', 'r02', 'r03', 'r04', 'r05', 'r06', 'r07', 'r09', 'r10', bobFollowRkey]);
  expect(result.records.get(`at://${ALICE}/${SCROBBLE}/r08`)!.state).toBe('deleted');

  // Three accounts, three hosts, each PDS holding only its own repo.
  for (const name of ['Alice', 'Bob', 'Carol'] as const) {
    const u = fixture.users[name];
    const { pds } = await resolveKey(kit, u.did);
    expect(pds).toBe(`https://${FIXTURE_PDS_HOSTS[name]}`);
    expect(kit.pds[name].dids()).toEqual([u.did]);
  }

  // Every present record verifies over the fixture network: PLC key, PDS proof, exact JSON.
  for (const r of result.records.values()) {
    const { didKey } = await resolveKey(kit, r.did);
    const v = await fetchProof(kit, r.did, r.collection, r.rkey, didKey);
    expect(v.signature).toEqual({ atcute: true, atproto: true });
    if (r.state === 'deleted') {
      expect(v).toMatchObject({ state: 'absent', cid: null });
      continue;
    }
    expect(v.state).toBe('present');
    expect(v.cid).toBe(r.cid);
    expect(r.cid).toBe(cidOf(r.record)); // the signer's hash, not a made-up value
    expect(TID_RE.test(r.rev)).toBe(true);
    if (r.collection === SCROBBLE) {
      expect(v.record).toEqual(fixture.scrobbles.find((s) => s.uri === r.uri)!.record);
    } else {
      expect(v.record).toEqual({ $type: FOLLOW, subject: BOB, createdAt: '2025-01-01T00:00:00Z' });
    }
  }

  // Local records went through createRecord; Carol's r10 only as an external writer.
  expect(kit.pds.Alice.count('com.atproto.repo.createRecord')).toBe(9); // r01–r08 + follow
  expect(kit.pds.Alice.count('com.atproto.repo.deleteRecord')).toBe(1); // r08, with swapRecord
  expect(kit.pds.Bob.count('com.atproto.repo.createRecord')).toBe(1);
  expect(kit.pds.Carol.calls.filter({ method: 'POST' })).toHaveLength(0);
  expect(result.records.get(`at://${CAROL}/${SCROBBLE}/r10`)).toMatchObject({ source: 'external', state: 'present' });
  const deleteCall = kit.pds.Alice.calls.filter({ nsid: 'com.atproto.repo.deleteRecord' })[0]!;
  expect(deleteCall.status).toBe(200);

  // Jetstream got every commit in order: 10 creates, the follow, then the r08 delete.
  const ops = result.events.map((e) => (e.kind === 'commit' ? `${e.commit.operation}:${e.commit.rkey}` : e.kind));
  expect(ops).toEqual([...fixture.scrobbles.map((s) => `create:${s.rkey}`), `create:${bobFollowRkey}`, 'delete:r08']);
  expect(result.events.map((e) => e.seq)).toEqual(result.events.map((_, i) => result.events[0]!.seq + i));
  for (const e of result.events) {
    if (e.kind !== 'commit') throw new Error('only commit events expected');
    const r = result.records.get(`at://${e.did}/${e.commit.collection}/${e.commit.rkey}`)!;
    if (e.commit.operation === 'create') expect(e.commit.cid).toBe(r.cid);
    // A deleted record's seeded rev is the deleting commit's.
    if (e.commit.operation === 'delete' || r.state === 'present') expect(e.commit.rev).toBe(r.rev);
  }
  expect(result.events.find((e) => e.kind === 'commit' && e.commit.rkey === 'r10')!.did).toBe(CAROL);
  // Relay discovery sees all three scrobblers and the follower.
  expect(kit.relay.repos(SCROBBLE)).toEqual([ALICE, BOB, CAROL].sort());
  expect(kit.relay.repos(FOLLOW)).toEqual([ALICE]);

  // Deterministic: a fresh kit seeds identical CIDs, revs and heads.
  const again = await createFixtureKit();
  const second = await seedReadModels(again);
  expect([...second.records.entries()]).toEqual([...result.records.entries()]);
  expect(second.heads).toEqual(result.heads);
  expect(again.pds.Alice.calls.count()).toBe(0); // reset after seeding by default
});

it("a record signed by one fixture account fails verification under another account's key", async () => {
  const { kit } = await seed();
  const alice = await resolveKey(kit, ALICE);
  const bob = await resolveKey(kit, BOB);
  const carol = await resolveKey(kit, CAROL);
  expect(new Set([alice.didKey, bob.didKey, carol.didKey]).size).toBe(3);
  expect(alice.didKey).toBe(kit.keys.alice.didKey);

  // Alice's proof: valid under her key, the signature fails under Bob's (P-256) and Carol's (secp256k1).
  expect((await fetchProof(kit, ALICE, SCROBBLE, 'r01', alice.didKey)).signature).toEqual({
    atcute: true,
    atproto: true,
  });
  for (const other of [bob.didKey, carol.didKey]) {
    const v = await fetchProof(kit, ALICE, SCROBBLE, 'r01', other);
    expect(v.signature).toEqual({ atcute: false, atproto: false });
    expect(v).toMatchObject({ state: 'present', did: ALICE }); // only the key binding differs
  }
  // And the other way round.
  expect((await fetchProof(kit, BOB, SCROBBLE, 'r09', bob.didKey)).signature).toEqual({
    atcute: true,
    atproto: true,
  });
  expect((await fetchProof(kit, BOB, SCROBBLE, 'r09', alice.didKey)).signature).toEqual({
    atcute: false,
    atproto: false,
  });
  expect((await fetchProof(kit, CAROL, SCROBBLE, 'r10', alice.didKey)).signature).toEqual({
    atcute: false,
    atproto: false,
  });

  // After a key rotation the old key no longer verifies the new head, the PLC key does.
  const fresh = await createFixtureKit();
  await seedReadModels(fresh);
  const rotated = await fresh.rotateKey('Alice', fresh.keys.aliceRotated);
  const now = await resolveKey(fresh, ALICE);
  expect(now.didKey).toBe(fresh.keys.aliceRotated.didKey);
  expect(fresh.plc.history(ALICE)).toHaveLength(2);
  const v = await fetchProof(fresh, ALICE, SCROBBLE, 'r01', now.didKey);
  expect(v).toMatchObject({ commitCid: rotated!.cid, signature: { atcute: true, atproto: true } });
  const old = await fetchProof(fresh, ALICE, SCROBBLE, 'r01', fresh.keys.alice.didKey);
  expect(old.signature).toEqual({ atcute: false, atproto: false });
  expect(fresh.plc.calls.count({ did: ALICE, status: 200 })).toBe(3); // one resolution per check above
});

it('fake relay pages listReposByCollection; fake DoH and PLC answer like the real services; unrouted hosts fail', async () => {
  const relay = new FakeRelay();
  const doh = new FakeDoh();
  const plc = new FakePlc();
  const keys = await fixtureKeys();
  plc.register(ALICE, { signingKey: keys.alice, pds: 'https://pds-alice.example.test', handle: 'alice.test' });
  const t = routerTransport({ relay, doh, plc, handles: { 'alice.test': ALICE } });
  const dids = Array.from({ length: 5 }, (_, i) => `did:plc:${String.fromCharCode(97 + i).repeat(24)}`);
  relay.add(SCROBBLE, ...[...dids].reverse());

  // Paging: ascending DIDs, cursor = last DID, no cursor on the final page.
  const page = async (cursor?: string) => {
    const url = new URL(`https://${relay.host}/xrpc/com.atproto.sync.listReposByCollection`);
    url.searchParams.set('collection', SCROBBLE);
    url.searchParams.set('limit', '2');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await t(new Request(url));
    expect(res.status).toBe(200);
    return (await res.json()) as { repos: Array<{ did: string }>; cursor?: string };
  };
  const p1 = await page();
  const p2 = await page(p1.cursor);
  const p3 = await page(p2.cursor);
  expect([p1, p2, p3]).toEqual([
    { repos: [{ did: dids[0] }, { did: dids[1] }], cursor: dids[1] },
    { repos: [{ did: dids[2] }, { did: dids[3] }], cursor: dids[3] },
    { repos: [{ did: dids[4] }] },
  ]);
  expect(relay.count(SCROBBLE)).toBe(3);

  // DoH: public defaults, TXT records, injected private answers, NXDOMAIN.
  const dns = async (name: string, type: string) => {
    const res = await t(
      new Request(`https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`, {
        headers: { accept: 'application/dns-json' },
      }),
    );
    expect(res.headers.get('content-type')).toBe('application/dns-json');
    return (await res.json()) as {
      Status: number;
      Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
    };
  };
  const a = await dns('pds-alice.example.test', 'A');
  expect(a.Status).toBe(0);
  expect(a.Answer).toHaveLength(1);
  expect(a.Answer![0]!.data).toMatch(/^104\.(1[6-9]|2[0-3])\.\d{1,3}\.\d{1,3}$/);
  expect((await dns('pds-alice.example.test', 'AAAA')).Answer![0]!.data).toMatch(/^2606:4700:/);
  doh.setTxt('_atproto.alice.test', [`did=${ALICE}`]);
  expect((await dns('_atproto.alice.test', 'TXT')).Answer).toEqual([
    { name: '_atproto.alice.test.', type: 16, TTL: 300, data: `"did=${ALICE}"` },
  ]);
  doh.injectAddress('pds-alice.example.test', '10.0.0.1');
  expect((await dns('pds-alice.example.test', 'A')).Answer!.map((x) => x.data)).toEqual([
    a.Answer![0]!.data,
    '10.0.0.1',
  ]);
  doh.nxdomain('gone.example.test');
  const nx = await dns('gone.example.test', 'A');
  expect(nx.Status).toBe(3);
  expect(nx.Answer).toBeUndefined();
  expect(doh.count('pds-alice.example.test')).toBe(3);

  // PLC: the document, 404 for unknown, 410 after a tombstone; handles via well-known.
  let res = await t(new Request(`https://plc.directory/${ALICE}`));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(plc.document(ALICE));
  expect(plc.document(ALICE)).toMatchObject({
    id: ALICE,
    alsoKnownAs: ['at://alice.test'],
    verificationMethod: [{ id: `${ALICE}#atproto`, type: 'Multikey', publicKeyMultibase: keys.alice.multikey }],
    service: [
      { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds-alice.example.test' },
    ],
  });
  expect(`did:key:${keys.alice.multikey}`).toBe(keys.alice.didKey);
  expect((await t(new Request(`https://plc.directory/${BOB}`))).status).toBe(404);
  res = await t(new Request('https://alice.test/.well-known/atproto-did'));
  expect([res.status, await res.text()]).toEqual([200, ALICE]);
  plc.tombstone(ALICE);
  expect((await t(new Request(`https://plc.directory/${ALICE}`))).status).toBe(410);
  expect(plc.count(ALICE)).toBe(2);

  // Nothing reaches the real network.
  await expect(t(new Request('https://bsky.social/xrpc/com.atproto.sync.getRepo'))).rejects.toThrow(
    /no route to host bsky\.social/,
  );
  expect(t.calls.count({ service: 'router', status: 0 })).toBe(1);
});

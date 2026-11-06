/// <reference types="vite/client" />
// W3-05 / ADR 0004 §7.7 oracle parity: the TypeScript range walker against
// the frozen Rust verify_snapshot (tests/goldens/snapshot_enumeration.json)
// over the Rust-signed full-repository CARs (tests/goldens/signed_cars).
//
// Each CAR is served by a fixture PDS host (getRepo = the file's exact bytes,
// getBlocks = its blocks) and walked through production SafeFetch, once via
// the getRepo stream into a cache-only source and several times via getBlocks
// with different step budgets. The walker must yield exactly `rangeEntries`
// for the range [<p>., <p>/), and with the music filter exactly the Rust
// `entries`; skipped and outside keys must never appear. The full-repo
// corruptions that reach the walk or the stream must fail with the
// manifest's code.

import { createSafeFetch, type SafeFetch } from '@atmusic/atproto/net/safe-fetch';
import { type BlockCache, type BlockSource, MemoryBlockCache } from '@atmusic/atproto/snapshot/block-source';
import { getBlocksSource } from '@atmusic/atproto/snapshot/getblocks-source';
import { getRepoSource } from '@atmusic/atproto/snapshot/getrepo-source';
import { inRange, prefixRange } from '@atmusic/atproto/snapshot/range';
import {
  initialState,
  type StepOptions,
  type StepResult,
  step,
  type WalkState,
} from '@atmusic/atproto/snapshot/walker';
import { fakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { carResponse, routerTransport, xrpcError } from '@atmusic/atproto/test-support/router-transport';
import { cborCid, encodeCar } from '@atmusic/atproto/test-support/signed-repo';
import { readBoundedCar } from '@atmusic/atproto/verify/car-bounds';
import { verifyCommit } from '@atmusic/atproto/verify/commit';
import { type VerifiedCommit, VerifyError } from '@atmusic/atproto/verify/types';
import { collectionsFor } from '@atmusic/core/namespace';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { expect, it } from 'vitest';
import manifest from '../../../tests/goldens/signed_cars/manifest.json' with { type: 'json' };
import enumeration from '../../../tests/goldens/snapshot_enumeration.json' with { type: 'json' };

const carFiles = import.meta.glob<string>('../../../tests/goldens/signed_cars/*.car', {
  query: '?url&inline',
  import: 'default',
});
const DIR = '../../../tests/goldens/signed_cars/';
const HOST = 'pds-oracle.test';
const PDS = `https://${HOST}`;

async function loadCar(file: string): Promise<Uint8Array<ArrayBuffer>> {
  const load = carFiles[`${DIR}${file}`];
  if (!load) throw new Error(`no golden CAR ${file}`);
  const url = await load();
  const prefix = 'data:application/octet-stream;base64,';
  if (!url.startsWith(prefix)) throw new Error(`${file} did not load as a base64 data URL`);
  const bin = atob(url.slice(prefix.length));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fixture PDS host serving one CAR: getRepo = its bytes, getBlocks = its blocks (BlockNotFound otherwise). */
function carHost(car: Uint8Array<ArrayBuffer>, blocks: ReadonlyMap<string, Uint8Array>) {
  const calls: Array<{ nsid: string; cids: string[] }> = [];
  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    const nsid = url.pathname.slice('/xrpc/'.length);
    const cids = url.searchParams.getAll('cids');
    calls.push({ nsid, cids });
    if (nsid === 'com.atproto.sync.getRepo') return carResponse(car);
    if (nsid === 'com.atproto.sync.getBlocks') {
      const missing = cids.filter((c) => !blocks.has(c));
      if (missing.length > 0) return xrpcError(400, 'BlockNotFound', `Could not find cids: ${missing.join(',')}`);
      // Root-less, as the reference PDS writes getBlocks CARs.
      return carResponse(
        encodeCar(
          [],
          cids.map((c): [string, Uint8Array] => [c, blocks.get(c)!]),
        ),
      );
    }
    return xrpcError(501, 'MethodNotImplemented', 'Method Not Implemented');
  };
  const transport = routerTransport({ hosts: { [HOST]: handler }, doh: fakeDoh() });
  const safeFetch: SafeFetch = createSafeFetch({ transport, clock: fixedClock(), fixture: true });
  return { calls, safeFetch };
}

async function walkAll(commit: VerifiedCommit, source: BlockSource, cache: BlockCache, opts: StepOptions) {
  let state: WalkState = initialState(commit, prefixRange(enumeration.namespacePrefix));
  const steps: StepResult[] = [];
  for (let i = 0; i < 10_000; i++) {
    const r = await step(JSON.parse(JSON.stringify(state)) as WalkState, source, cache, opts);
    steps.push(r);
    state = r.state;
    if (r.done) return steps;
  }
  throw new Error('walk did not finish');
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const r = await p.then(
    () => 'ok',
    (e: unknown) => (e instanceof VerifyError ? e.code : `unexpected: ${String(e)}`),
  );
  return r;
}

type Entry = (typeof manifest.entries)[number];

it('walker output equals tests/goldens/snapshot_enumeration.json for every Rust full-repo CAR', async () => {
  const prefix = enumeration.namespacePrefix;
  expect(prefix).toBe(manifest.namespacePrefix);
  const range = prefixRange(prefix);
  const coll = collectionsFor(prefix);
  const isMusic = (key: string) => key.startsWith(`${coll.scrobble}/`) || key.startsWith(`${coll.follow}/`);
  const fullRepos = manifest.entries.filter((e) => e.kind === 'full_repo');
  // Every valid full-repo CAR has a golden enumeration, and nothing else does.
  expect(enumeration.snapshots.map((s) => s.car).sort()).toEqual(fullRepos.map((e) => `signed_cars/${e.file}`).sort());
  expect(enumeration.snapshots.length).toBe(2);

  let walks = 0;
  for (const golden of enumeration.snapshots) {
    const entry = fullRepos.find((e) => `signed_cars/${e.file}` === golden.car)! as Entry;
    const car = await loadCar(entry.file);
    expect([entry.name, await sha256Hex(car)]).toEqual([entry.name, entry.sha256]);
    const { root, blocks } = readBoundedCar(car, { maxBytes: manifest.maxCarBytesRust, maxBlocks: 10_000 });
    const commit = await verifyCommit(blocks, root, { did: golden.did, signingKey: entry.signingKey });
    expect([commit.cid, commit.rev]).toEqual([golden.commitCid, golden.rev]);

    const range_ = golden.rangeEntries.map((e) => [e.key, e.cid]);
    const music = golden.entries.map((e) => [e.key, e.cid]);
    // Golden self-consistency: the music entries are exactly the music-flagged range entries.
    expect(golden.rangeEntries.filter((e) => e.music).map((e) => [e.key, e.cid])).toEqual(music);
    expect(golden.rangeEntries.every((e) => inRange(range, e.key))).toBe(true);
    const never = new Set(golden.outsideRange);
    const skipped = new Set(golden.skippedInRange);
    expect(golden.skippedInRange.every((k) => inRange(range, k) && !isMusic(k))).toBe(true);

    const check = (steps: StepResult[], expected: (string | number)[][], label: string) => {
      const out = steps.flatMap((s) => s.entries);
      expect([label, out.map((e) => [e.key, e.cid])]).toEqual([label, expected]);
      expect(out.some((e) => never.has(e.key))).toBe(false);
      for (const e of out) {
        expect(e.recordBytes).toBeDefined();
        expect(cborCid(e.recordBytes!)).toBe(e.cid);
      }
      expect(steps.at(-1)!.interval?.[1]).toBeNull();
      walks++;
    };

    // getRepo stream → cache → cache-only walk: one getRepo request, no getBlocks.
    for (const include of [undefined, isMusic]) {
      const host = carHost(car, blocks);
      const cache = new MemoryBlockCache();
      const source = getRepoSource({ safeFetch: host.safeFetch, pds: PDS, did: golden.did, cache });
      const steps = await walkAll(commit, source, cache, {
        maxFetches: 1,
        maxEntries: 5,
        knownCid: () => null,
        include,
      });
      check(steps, include ? music : range_, `${entry.name} getRepo ${include ? 'music' : 'range'}`);
      if (include) expect(steps.flatMap((s) => s.entries).some((e) => skipped.has(e.key))).toBe(false);
      expect(host.calls.map((c) => c.nsid)).toEqual(['com.atproto.sync.getRepo']);
    }

    // getBlocks with several budgets: identical output, every request ≤ 100 CIDs and none for an outside key.
    for (const [maxFetches, maxEntries] of [
      [1, 1],
      [2, 3],
      [50, 1_000],
    ] as const) {
      for (const include of [undefined, isMusic]) {
        const host = carHost(car, blocks);
        const source = getBlocksSource({ safeFetch: host.safeFetch, pds: PDS, did: golden.did });
        const steps = await walkAll(commit, source, new MemoryBlockCache(), {
          maxFetches,
          maxEntries,
          knownCid: () => null,
          include,
        });
        check(steps, include ? music : range_, `${entry.name} getBlocks ${maxFetches}/${maxEntries}`);
        expect(steps.every((s) => s.fetches <= maxFetches && s.entries.length <= maxEntries)).toBe(true);
        expect(host.calls.every((c) => c.nsid === 'com.atproto.sync.getBlocks' && c.cids.length <= 100)).toBe(true);
        // Record blocks requested: exactly the emitted ones (skipped in-range records are not fetched).
        const requested = new Set(host.calls.flatMap((c) => c.cids));
        const wanted = new Set((include ? golden.entries : golden.rangeEntries).map((e) => e.cid));
        for (const e of golden.rangeEntries) expect(requested.has(e.cid)).toBe(wanted.has(e.cid));
      }
    }

    // The full-repo corruptions that reach the stream or the walk fail with the manifest's code.
    const corruptions = manifest.entries.filter(
      (e) =>
        e.base === entry.name &&
        ['record_block_byte', 'mst_node_byte', 'mst_structure', 'record_cid_swap', 'truncation'].includes(
          e.corruption ?? '',
        ),
    );
    expect(corruptions.length).toBe(5);
    for (const bad of corruptions) {
      const badCar = await loadCar(bad.file);
      const host = carHost(badCar, new Map());
      const cache = new MemoryBlockCache();
      const source = getRepoSource({ safeFetch: host.safeFetch, pds: PDS, did: golden.did, cache });
      const outcome = await codeOf(
        (async () => {
          const loaded = await source.load();
          const head = await verifyCommit(cache.blocks, loaded.root, { did: golden.did, signingKey: bad.signingKey });
          await walkAll(head, source, cache, {
            maxFetches: 10,
            maxEntries: 100,
            knownCid: () => null,
            include: isMusic,
          });
        })(),
      );
      expect([bad.name, outcome]).toEqual([bad.name, bad.expected.code]);
    }
  }
  expect(walks).toBe(2 * (2 + 6));
});

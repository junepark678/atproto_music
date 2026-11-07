// Same-CID reproof across an `after` cutoff invalidates statistics (Astra
// a176da7 F2; write/apply-record.ts revisionMayReveal). A removal whose
// requested state is reached and ordered `after` at J hides a recreation R
// proven below J until verified ingest proves the record at or above J. When
// R's bytes are unchanged, that re-proof carries only a newer revision, yet it
// changes visibility, so it must bump stats_version in the proof's own
// transaction. Here the real settlement hint is processed by the production
// drain (fixture identity resolver and DNS, sync.getRecord CAR fetch,
// signature and MST verification, applyRecordProof); the statistics cache is
// filled AFTER settlement and BEFORE that reproof.

import { expect, it } from 'vitest';
import { recordStatus } from '../../../src/do/ingest/notify';
import { drain } from '../../../src/do/ingest/verify-drain';
import { exportUser } from '../../../src/do/read/export';
import { statsWithCache } from '../../../src/do/read/stats';
import { visibleScrobblesFrom } from '../../../src/do/read/visibility';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { applySnapshotChunk } from '../../../src/do/write/apply-snapshot';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { proofAt, seedSnapshotJob } from '../../write/support';
import { DELETE, GET, type Harness, HEAD, remoteRecords, SCROBBLE, T0, withHarness } from './support';

/** The CID of a present proof (null for a proven absence). */
const cidOf = (p: { state: string; cid?: string }) => (p.state === 'present' ? (p.cid ?? null) : null);

const PREFIX = 'com.example.atmusic';
const BATCH = `${PREFIX}.scrobbleBatch`;
const RKEY = '3lb2reproofb2';
const SINGLE_RKEY = '3lb2reproofs2';
const X = '3lb2batchidab';
const Y = '3lb2batchidac';
const Z = '3lb2batchidad';
const OPTIONS = { receiptNs: BigInt(T0) * 1_000_000n, nowNs: BigInt(T0) * 1_000_000n, prefix: PREFIX };
const entry = (id: string, artist: string, hour: number) => ({
  id,
  artist,
  track: `${artist} track`,
  listenedAt: `2026-01-14T1${hour}:00:00Z`,
  createdAt: '2026-01-15T12:00:00Z',
});
const LX = entry(X, 'Artist X', 0);
const LY = entry(Y, 'Artist Y', 1);
const LZ = entry(Z, 'Artist Z', 2);
const ORIGINAL = { $type: BATCH, createdAt: '2026-01-15T12:00:00Z', listens: [LX, LY, LZ] };
const SINGLE = {
  $type: SCROBBLE,
  artist: 'Single Artist',
  track: 'Single Track',
  listenedAt: '2026-01-14T12:00:00Z',
  createdAt: '2026-01-15T12:00:00Z',
};
const UNRELATED = { ...SINGLE, artist: 'Unrelated', track: 'J' };
const head = (h: Harness) => ({ cid: h.kit.repos.Alice.head!.cid, rev: h.kit.repos.Alice.head!.rev });

type Kind = 'partial' | 'whole' | 'single';
type Proof = Awaited<ReturnType<typeof proofAt>>;
const collectionOf = (kind: Kind) => (kind === 'single' ? SCROBBLE : BATCH);
const rkeyOf = (kind: Kind) => (kind === 'single' ? SINGLE_RKEY : RKEY);
const proof = (h: Harness, kind: Kind) => proofAt(h.kit.repos.Alice, collectionOf(kind), rkeyOf(kind));
const apply = (h: Harness, p: Proof) => h.db.tx(() => applyRecordProof(h.db, p, OPTIONS)).outcome;
const visible = (h: Harness) =>
  h.db
    .all<{ listen_id: string | null }>(`SELECT s.listen_id FROM ${visibleScrobblesFrom()} ORDER BY s.listen_id`)
    .map((row) => row.listen_id ?? '*');
const stats = (h: Harness) => statsWithCache(h.db, { did: h.alice, window: 'all', limit: 10, asOfNs: OPTIONS.nowNs });
const statsVersion = (h: Harness) =>
  h.db.one<{ v: number }>('SELECT stats_version AS v FROM users WHERE did = ?', h.alice)!.v;
const status = (h: Harness, uri: string) => {
  const saved = h.db.all<Record<string, unknown>>('SELECT * FROM hints');
  h.db.run('DELETE FROM hints');
  const out = recordStatus(h.m, uri);
  for (const row of saved) {
    const keys = Object.keys(row);
    h.db.run(
      `INSERT INTO hints(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      ...(keys.map((k) => row[k]) as never[]),
    );
  }
  return out;
};

/** After the `nth` answered request for `nsid`, run `during` before the client sees the answer. */
function after(h: Harness, nsid: string, nth: number, during: () => Promise<void>): void {
  const writerFor = h.writers.writerFor.bind(h.writers);
  let seen = 0;
  h.writers.writerFor = async (did: string) => {
    const writer = await writerFor(did);
    if (writer === null) return null;
    return {
      ...writer,
      fetchHandler: async (path: string, init?: RequestInit) => {
        const response = await writer.fetchHandler(path, init);
        if (path.includes(`/xrpc/${nsid}`) && ++seen === nth) await during();
        return response;
      },
    };
  };
}

/**
 * The settled fixture: the removal is reached and ordered `after` at J; R
 * (unchanged bytes of J) is proven below J and hidden; the statistics cache
 * was filled after settlement. Returns what the tests compare.
 */
async function settledAtJ(h: Harness, kind: Kind) {
  h.seedUser(h.alice);
  const collection = collectionOf(kind);
  const rkey = rkeyOf(kind);
  const uri = `at://${h.alice}/${collection}/${rkey}`;
  await h.kit.externalPut('Alice', collection, rkey, kind === 'single' ? SINGLE : ORIGINAL);
  expect(apply(h, await proof(h, kind))).toBe('applied');
  const removal =
    kind === 'single'
      ? enqueueScrobbleDelete(h.m, { did: h.alice, uri, origin: 'web' })
      : enqueueBatchListenDelete(h.m, {
          did: h.alice,
          uri,
          listenIds: kind === 'whole' ? ['*'] : [X, Y],
          origin: 'web',
        });
  h.db.run('DELETE FROM hints');
  let b: Proof | undefined;
  let r: Proof | undefined;
  let j: Proof | undefined;
  const recreateThenUnrelated = async (recreated: object) => {
    await h.kit.externalPut('Alice', collection, rkey, recreated);
    r = await proof(h, kind);
    await h.kit.externalPut('Alice', SCROBBLE, '3lb2unrelatj2', UNRELATED);
    j = await proof(h, kind);
  };
  if (kind === 'single') {
    // A valid received metadata-free deletion success, then R and J
    // before the read-back.
    const writerFor = h.writers.writerFor.bind(h.writers);
    let once = false;
    h.writers.writerFor = async (did: string) => {
      const writer = await writerFor(did);
      if (writer === null) return null;
      return {
        ...writer,
        fetchHandler: async (path: string, init?: RequestInit) => {
          const response = await writer.fetchHandler(path, init);
          if (once || !path.includes(`/xrpc/${DELETE}`)) return response;
          once = true;
          await recreateThenUnrelated(SINGLE);
          const body = (await response.json()) as Record<string, unknown>;
          delete body.commit;
          return Response.json(body);
        },
      };
    };
  } else {
    // After H: B (an unrelated edit, X and Y present), then D removes
    // both (partial) or the container (whole), before the container read.
    after(h, HEAD, 1, async () => {
      await h.kit.externalPut('Alice', collection, rkey, { ...ORIGINAL, extra: 'B' });
      b = await proof(h, kind);
      if (kind === 'partial') await h.kit.externalPut('Alice', collection, rkey, { ...ORIGINAL, listens: [LZ] });
      else await h.kit.externalDelete('Alice', collection, rkey);
    });
    // The absent read, then R recreates X only and J (unrelated) moves
    // the closing head.
    after(h, GET, 1, async () => {
      await recreateThenUnrelated({ ...ORIGINAL, listens: kind === 'whole' ? [LX] : [LX, LZ] });
    });
  }
  await h.runUntilIdle(10);
  expect(h.op(removal.id)).toMatchObject({
    state: 'succeeded',
    removal_done_rev: j!.commit.rev,
    removal_done_basis: 'after',
  });
  expect(cidOf(r!)).toBe(cidOf(j!));
  expect(r!.commit.rev < j!.commit.rev).toBe(true);
  // Settlement queued the record's verify hint (source notify).
  expect(h.db.all('SELECT uri, source FROM hints')).toEqual([{ uri, source: 'notify' }]);

  // Delayed B, then R at its own revision: R < J is hidden (strict).
  if (b !== undefined) apply(h, b);
  expect(apply(h, r!)).toBe('applied');
  const id = kind === 'single' ? '*' : X;
  const projection = kind === 'single' ? uri : `${uri}#${X}`;
  const hiddenTotal = kind === 'partial' ? 1 : 0;
  expect(visible(h)).toEqual(kind === 'partial' ? [Z] : []);
  // The cache is filled now: after settlement, before the J reproof.
  expect(stats(h)).toMatchObject({ cache: 'miss', statistics: { totalScrobbles: hiddenTotal } });
  expect(stats(h)).toMatchObject({ cache: 'hit', statistics: { totalScrobbles: hiddenTotal } });
  const version = statsVersion(h);
  return { collection, rkey, uri, removal, b, r: r!, j: j!, id, projection, hiddenTotal, version };
}

it.each(['partial', 'whole', 'single'] as const)(
  '%s: the real hint re-proves unchanged R at J >= the after cutoff; statistics cached before it are invalidated',
  async (kind) => {
    await withHarness(async (h) => {
      const { rkey, uri, r, j, id, projection, hiddenTotal, version } = await settledAtJ(h, kind);

      // The production drain fetches and verifies sync.getRecord at J.
      const fetched: string[] = [];
      const transport = h.m.transport;
      h.m = {
        ...h.m,
        transport: Object.assign(
          async (req: Parameters<typeof transport>[0]) => {
            fetched.push(String(req.url));
            return transport(req);
          },
          { fixture: true as const },
        ),
      };
      const drained = await drain(h.m, h.kit.clock.nowMs());
      expect(drained.outcomes).toEqual([{ uri, outcome: 'applied' }]);
      expect(fetched.some((u) => u.includes('com.atproto.sync.getRecord'))).toBe(true);
      expect(h.db.all('SELECT uri FROM hints')).toEqual([]);
      expect(h.db.one('SELECT revision, cid FROM record_state WHERE uri = ?', uri)).toEqual({
        revision: j!.commit.rev,
        cid: cidOf(r!),
      });

      // Released at J: visible, indexed, exported; Y stays removed.
      expect(visible(h)).toEqual(kind === 'partial' ? [X, Z] : [id]);
      expect(status(h, projection)).toMatchObject({ state: 'indexed', revision: j!.commit.rev });
      expect((exportUser(h.m, h.alice)?.scrobbles ?? []).map((s) => s.uri)).toContain(projection);
      expect(statsVersion(h)).toBeGreaterThan(version);
      const released = stats(h);
      expect(released).toMatchObject({ cache: 'miss', statistics: { totalScrobbles: hiddenTotal + 1 } });
      const top = kind === 'single' ? 'Single Artist' : 'Artist X';
      expect(released.statistics?.topArtists).toContainEqual({ artist: top, scrobbleCount: 1 });
      expect(released.statistics?.topArtists.map((a) => a.artist)).not.toContain('Artist Y');
      if (kind !== 'single') {
        const remote = (await remoteRecords(h.kit, 'Alice', BATCH)).find((x) => x.rkey === rkey)!;
        expect((remote.value as { listens: Array<{ id: string }> }).listens.map((l) => l.id)).toEqual(
          kind === 'whole' ? [X] : [X, Z],
        );
      }

      // An inactive owner reveals nothing.
      h.db.run('UPDATE users SET active = 0 WHERE did = ?', h.alice);
      expect(visible(h)).toEqual([]);
      expect(exportUser(h.m, h.alice)).toBeNull();
      expect(stats(h).statistics).toBeNull();
      expect(status(h, projection)).toMatchObject({ state: 'unknown' });
    });
  },
);

it('an unchanged re-proof at a newer revision without any removal receipt keeps the cache', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    await h.kit.externalPut('Alice', SCROBBLE, SINGLE_RKEY, SINGLE);
    expect(apply(h, await proofAt(h.kit.repos.Alice, SCROBBLE, SINGLE_RKEY))).toBe('applied');
    expect(stats(h)).toMatchObject({ cache: 'miss' });
    await h.kit.externalPut('Alice', SCROBBLE, '3lb2unrelatj2', UNRELATED);
    const version = statsVersion(h);
    expect(apply(h, await proofAt(h.kit.repos.Alice, SCROBBLE, SINGLE_RKEY))).toBe('applied');
    expect(statsVersion(h)).toBe(version);
    expect(stats(h)).toMatchObject({ cache: 'hit', statistics: { totalScrobbles: 1 } });
  });
});

// ---------------------------------------------------------------------------
// The same re-proof through a range snapshot (Astra de5abe1 F2): a snapshot
// entry at J with the stored CID and no body (the walker fetched only changed
// records) must write what the live proof of those bytes writes, so the real
// hint at J afterwards is truly a no-op.

/** One bodyless, unchanged snapshot entry for the record at head `rev`. */
function snapshotUnchanged(h: Harness, kind: Kind, rev: string, cid: string) {
  const generation = h.db.one<{ generation: number }>(
    'SELECT generation FROM users WHERE did = ?',
    h.alice,
  )!.generation;
  if (h.db.one("SELECT 1 AS x FROM repo_jobs WHERE did = ? AND kind = 'snapshot'", h.alice) === null) {
    seedSnapshotJob(h.db, h.alice, generation);
  }
  const key = `${collectionOf(kind)}/${rkeyOf(kind)}`;
  return h.db.tx(() =>
    applySnapshotChunk(h.db, {
      did: h.alice,
      generation,
      headRev: rev,
      intervalLo: `${collectionOf(kind)}/`,
      intervalHi: key,
      entries: [{ key, cid }],
      receiptNs: OPTIONS.receiptNs,
      nowNs: OPTIONS.nowNs,
      prefix: PREFIX,
    }),
  );
}

const membership = (h: Harness, uri: string) =>
  h.db.all<{ listen_id: string; state: string; revision: string; last_absent_revision: string | null }>(
    'SELECT listen_id, state, revision, last_absent_revision FROM verified_membership WHERE record_uri = ? ORDER BY listen_id',
    uri,
  );

/** The projection rows of a record (a single, or a container's listens), without volatile columns. */
const rowsOf = (h: Harness, uri: string) =>
  h.db.all<{ uri: string; cid: string; revision: string; listen_id: string | null }>(
    'SELECT uri, cid, revision, listen_id FROM scrobbles WHERE uri = ? OR record_uri = ? ORDER BY uri',
    uri,
    uri,
  );

it.each(['partial', 'whole', 'single'] as const)(
  '%s: a bodyless same-CID snapshot at J after a reopen releases R like the live proof; the real hint at J is a true no-op',
  async (kind) => {
    // The live reference: the same fixture, released by the real hint.
    let live: { membership: ReturnType<typeof membership>; rows: ReturnType<typeof rowsOf> } | undefined;
    await withHarness(async (h) => {
      const { uri } = await settledAtJ(h, kind);
      expect((await drain(h.m, h.kit.clock.nowMs())).outcomes).toEqual([{ uri, outcome: 'applied' }]);
      live = { membership: membership(h, uri), rows: rowsOf(h, uri) };
    });
    await withHarness(async (h) => {
      const { uri, r, j, id, projection, hiddenTotal, version } = await settledAtJ(h, kind);
      // A process restart with the cache filled after settlement.
      h.restart();
      expect(stats(h)).toMatchObject({ cache: 'hit', statistics: { totalScrobbles: hiddenTotal } });
      expect(snapshotUnchanged(h, kind, j.commit.rev, cidOf(r)!)).toEqual({
        outcome: 'applied',
        written: 0,
        unchanged: 1,
        deleted: 0,
      });
      // Exactly what the live proof at J writes: record_state, projection
      // revisions, membership (Y stays absent, at J), statistics.
      expect(h.db.one('SELECT revision, cid, state FROM record_state WHERE uri = ?', uri)).toEqual({
        revision: j.commit.rev,
        cid: cidOf(r),
        state: 'present',
      });
      const rows = rowsOf(h, uri);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.revision === j.commit.rev)).toBe(true);
      // Identical to what the live proof of the same bytes at J writes
      // (the same fixture, settled the same way, re-proven by the drain).
      expect(membership(h, uri)).toEqual(live!.membership);
      expect(rowsOf(h, uri)).toEqual(live!.rows);
      if (kind !== 'single') {
        expect(membership(h, uri).find((row) => row.listen_id === Y)).toMatchObject({
          state: 'absent',
          last_absent_revision: j.commit.rev,
        });
      }
      expect(visible(h)).toEqual(kind === 'partial' ? [X, Z] : [id]);
      expect(statsVersion(h)).toBe(version + 1);
      const released = stats(h);
      expect(released).toMatchObject({ cache: 'miss', statistics: { totalScrobbles: hiddenTotal + 1 } });
      expect(released.statistics?.topArtists.map((a) => a.artist)).not.toContain('Artist Y');
      expect(status(h, projection)).toMatchObject({ state: 'indexed', revision: j.commit.rev });
      expect((exportUser(h.m, h.alice)?.scrobbles ?? []).map((s) => s.uri)).toContain(projection);
      const after = { membership: membership(h, uri), version: statsVersion(h) };

      // The settlement hint through the production drain: at J, a no-op that
      // is now true (nothing left to repair), and the hint is consumed.
      const drained = await drain(h.m, h.kit.clock.nowMs());
      expect(drained.outcomes).toEqual([{ uri, outcome: 'noop_older' }]);
      expect(h.db.all('SELECT uri FROM hints')).toEqual([]);
      expect(membership(h, uri)).toEqual(after.membership);
      expect(statsVersion(h)).toBe(after.version);
      expect(visible(h)).toEqual(kind === 'partial' ? [X, Z] : [id]);
      // A repeated snapshot at J changes nothing (the per-URI guard).
      expect(snapshotUnchanged(h, kind, j.commit.rev, cidOf(r)!)).toMatchObject({ unchanged: 1, written: 0 });
      expect(statsVersion(h)).toBe(after.version);

      // An inactive owner reveals nothing.
      h.db.run('UPDATE users SET active = 0 WHERE did = ?', h.alice);
      expect(visible(h)).toEqual([]);
      expect(exportUser(h.m, h.alice)).toBeNull();
      expect(stats(h).statistics).toBeNull();
    });
  },
);

it('a bodyless same-CID snapshot never invents container membership the index did not verify', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    await h.kit.externalPut('Alice', BATCH, RKEY, ORIGINAL);
    const a = await proofAt(h.kit.repos.Alice, BATCH, RKEY);
    expect(apply(h, a)).toBe('applied');
    const uri = `at://${h.alice}/${BATCH}/${RKEY}`;
    // As a projection older than verified membership left it.
    h.db.run('DELETE FROM verified_membership WHERE record_uri = ?', uri);
    await h.kit.externalPut('Alice', SCROBBLE, '3lb2unrelatj2', UNRELATED);
    const j = head(h);
    const version = statsVersion(h);
    expect(snapshotUnchanged(h, 'partial', j.rev, cidOf(a)!)).toMatchObject({ unchanged: 1 });
    expect(membership(h, uri)).toEqual([]);
    // The projection's revision follows the verified head; no receipt: no bump.
    expect(
      h.db.all<{ revision: string }>('SELECT revision FROM scrobbles WHERE record_uri = ?', uri).map((r) => r.revision),
    ).toEqual([j.rev, j.rev, j.rev]);
    expect(statsVersion(h)).toBe(version);
  });
});

it('a bodyless same-CID snapshot of an excluded container keeps the exclusion, its counter and no projection', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    // Every entry invalid: the container version is excluded.
    const invalid = { ...ORIGINAL, listens: ORIGINAL.listens.map((l) => ({ ...l, artist: '' })) };
    await h.kit.externalPut('Alice', BATCH, RKEY, invalid);
    const a = await proofAt(h.kit.repos.Alice, BATCH, RKEY);
    expect(apply(h, a)).toBe('excluded');
    const uri = `at://${h.alice}/${BATCH}/${RKEY}`;
    const counters = h.db.all('SELECT name, label, value FROM counters ORDER BY name, label');
    const before = membership(h, uri);
    await h.kit.externalPut('Alice', SCROBBLE, '3lb2unrelatj2', UNRELATED);
    const j = head(h);
    expect(snapshotUnchanged(h, 'partial', j.rev, cidOf(a)!)).toMatchObject({ unchanged: 1 });
    expect(h.db.one('SELECT state, revision FROM record_state WHERE uri = ?', uri)).toEqual({
      state: 'excluded',
      revision: j.rev,
    });
    expect(h.db.all('SELECT uri FROM scrobbles WHERE record_uri = ?', uri)).toEqual([]);
    expect(h.db.all('SELECT name, label, value FROM counters ORDER BY name, label')).toEqual(counters);
    expect(membership(h, uri)).toEqual(
      before.map((row) => (row.listen_id === '*' ? { ...row, revision: j.rev } : row)),
    );
  });
});

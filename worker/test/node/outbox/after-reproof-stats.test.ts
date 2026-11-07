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
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { proofAt } from '../../write/support';
import { DELETE, GET, type Harness, HEAD, remoteRecords, SCROBBLE, T0, withHarness } from './support';

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

it.each(['partial', 'whole', 'single'] as const)(
  '%s: the real hint re-proves unchanged R at J >= the after cutoff; statistics cached before it are invalidated',
  async (kind) => {
    await withHarness(async (h) => {
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
      expect(r!.cid).toBe(j!.cid);
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
        cid: r!.cid,
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

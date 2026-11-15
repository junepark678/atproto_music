// The shared listen ingress and the forward rows (ADR 0005 §7.7, §8.3, §12.2;
// N2-05; case M3.2.1/admission_atomic). acceptListens is the one transaction
// behind /2.0 track.scrobble, /1/submit-listens and web scrobbles.

import { listenKey } from '@atmusic/core/listen-key';
import { parseRfc3339 } from '@atmusic/core/timestamp';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../src/do/db';
import { upsertNowPlaying } from '../../../src/do/read/now-playing';
import { enqueueForwards, nowPlayingKey, rewriteNowPlayingForwardStart } from '../../../src/outbox/forward-enqueue';
import { storedForwardDedupeKey } from '../../../src/outbox/forward-key';
import { acceptListens } from '../../../src/outbox/ingress';
import { enqueueLove, enqueueUnlove } from '../../../src/outbox/love-ops';
import { CREATE, listenInput, remoteRecord, SCROBBLE, T0, withHarness } from './support';

function count(db: Db, table: string, where = '1', ...params: (string | number)[]): number {
  return db.one<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params)!.n;
}

async function keyOf(did: string, input: { artist: string; track: string; listenedAt: string }): Promise<string> {
  return listenKey({ did, listenedAtNs: parseRfc3339(input.listenedAt)!, artist: input.artist, track: input.track });
}

/** A Db whose tx calls are counted at the outermost level. */
function countingDb(db: Db): Db & { outer: number } {
  let depth = 0;
  const wrapped = {
    outer: 0,
    all: db.all.bind(db),
    one: db.one.bind(db),
    run: db.run.bind(db),
    tx<T>(fn: () => T): T {
      depth += 1;
      if (depth === 1) wrapped.outer += 1;
      try {
        return db.tx(fn as never) as T;
      } finally {
        depth -= 1;
      }
    },
  };
  return wrapped as unknown as Db & { outer: number };
}

describe('acceptListens', () => {
  it('moves the existing now-playing dedupe identity with a scrobble-corrected start so the refresh does not enqueue again', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      h.link(h.alice, 'lastfm');
      h.link(h.alice, 'listenbrainz');
      const { row } = upsertNowPlaying(h.m, { did: h.alice, artist: 'Radiohead', track: 'Reckoner', source: 'web' });
      const enqueue = (startedAtMs: number) =>
        enqueueForwards(h.db, {
          did: h.alice,
          items: [
            {
              kind: 'nowplaying',
              startedAtMs,
              artist: 'Radiohead',
              track: 'Reckoner',
              payload: { track: { artist: 'Radiohead', track: 'Reckoner' }, startedAtMs },
            },
          ],
          now: h.kit.clock.nowMs(),
          random: h.m.random,
        });
      enqueue(row.started_at_ms);
      await acceptListens(h.m, {
        did: h.alice,
        origin: 'lastfm',
        receiptMs: T0,
        listens: [
          { input: { artist: 'Radiohead', track: 'Reckoner', listenedAt: new Date(T0 - 120_000).toISOString() } },
        ],
      });
      const corrected = h.db.one<{ started_at_ms: number }>(
        'SELECT started_at_ms FROM now_playing WHERE did=?',
        h.alice,
      )!.started_at_ms;
      enqueue(corrected);
      expect(
        h.db.all<{ dedupe_key: string; payload_json: string }>(
          "SELECT dedupe_key,payload_json FROM forward_outbox WHERE kind='nowplaying' ORDER BY link_id",
        ),
      ).toHaveLength(2);
      const payload = JSON.parse(
        h.db.all<{ payload_json: string }>("SELECT payload_json FROM forward_outbox WHERE kind='nowplaying'")[0]!
          .payload_json,
      ) as { startedAtMs: number };
      expect(payload.startedAtMs).toBe(corrected);
    });
  });

  it.each(['queued', 'sent'] as const)(
    'rewrites a generation-2 %s now-playing identity without allowing a duplicate forward',
    async (state) => {
      await withHarness(async (h) => {
        h.account(h.alice);
        const linkId = h.link(h.alice, 'lastfm');
        h.db.run('UPDATE linked_accounts SET generation=2 WHERE id=?', linkId);
        const { row } = upsertNowPlaying(h.m, {
          did: h.alice,
          artist: 'Radiohead',
          track: 'Reckoner',
          source: 'web',
        });
        const enqueue = (startedAtMs: number) =>
          enqueueForwards(h.db, {
            did: h.alice,
            items: [
              {
                kind: 'nowplaying',
                startedAtMs,
                artist: 'Radiohead',
                track: 'Reckoner',
                payload: { track: { artist: 'Radiohead', track: 'Reckoner' }, startedAtMs },
              },
            ],
            now: h.kit.clock.nowMs(),
            random: h.m.random,
          });
        expect(enqueue(row.started_at_ms)).toBe(1);
        if (state === 'sent') h.db.run("UPDATE forward_outbox SET state='sent' WHERE kind='nowplaying'");

        await acceptListens(h.m, {
          did: h.alice,
          origin: 'lastfm',
          receiptMs: T0,
          listens: [
            {
              input: { artist: 'Radiohead', track: 'Reckoner', listenedAt: new Date(T0 - 120_000).toISOString() },
            },
          ],
        });
        const corrected = T0 - 120_000;

        expect(enqueue(corrected)).toBe(0);
        const rows = h.db.all<{ dedupe_key: string; payload_json: string; state: string }>(
          "SELECT dedupe_key,payload_json,state FROM forward_outbox WHERE kind='nowplaying'",
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          dedupe_key: storedForwardDedupeKey(2, nowPlayingKey(h.alice, corrected, 'Radiohead', 'Reckoner')),
          state,
        });
        expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({ startedAtMs: corrected });
      });
    },
  );

  it('reads forward_outbox only by link, kind and exact key when it rewrites a now-playing start', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      h.link(h.alice, 'lastfm');
      h.link(h.alice, 'listenbrainz');
      const { row } = upsertNowPlaying(h.m, { did: h.alice, artist: 'Radiohead', track: 'Reckoner', source: 'web' });
      enqueueForwards(h.db, {
        did: h.alice,
        items: [
          {
            kind: 'nowplaying',
            startedAtMs: row.started_at_ms,
            artist: 'Radiohead',
            track: 'Reckoner',
            payload: { track: { artist: 'Radiohead', track: 'Reckoner' }, startedAtMs: row.started_at_ms },
          },
        ],
        now: h.kit.clock.nowMs(),
        random: h.m.random,
      });
      const reads: string[] = [];
      const one = h.db.one.bind(h.db);
      const all = h.db.all.bind(h.db);
      const spyOne = vi.spyOn(h.db, 'one').mockImplementation(((sql: string, ...p: never[]) => {
        reads.push(sql);
        return one(sql, ...p);
      }) as typeof h.db.one);
      const spyAll = vi.spyOn(h.db, 'all').mockImplementation(((sql: string, ...p: never[]) => {
        reads.push(sql);
        return all(sql, ...p);
      }) as typeof h.db.all);
      rewriteNowPlayingForwardStart(
        h.db,
        h.alice,
        'Radiohead',
        'Reckoner',
        row.started_at_ms,
        row.started_at_ms - 60_000,
      );
      spyOne.mockRestore();
      spyAll.mockRestore();
      const outboxReads = reads.filter((sql) => /FROM forward_outbox/.test(sql));
      expect(outboxReads).toHaveLength(2);
      for (const sql of outboxReads) expect(sql).toMatch(/WHERE link_id=\? AND kind='nowplaying' AND dedupe_key=\?/);
      const payloads = h.db
        .all<{ payload_json: string }>("SELECT payload_json FROM forward_outbox WHERE kind='nowplaying'")
        .map((r) => (JSON.parse(r.payload_json) as { startedAtMs: number }).startedAtMs);
      expect(payloads).toEqual([row.started_at_ms - 60_000, row.started_at_ms - 60_000]);
    });
  });

  it('marks matching current tracks scrobbled and corrects start only inside duration or 600 second fallback bounds', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      upsertNowPlaying(h.m, {
        did: h.alice,
        artist: 'Radiohead',
        track: 'Reckoner',
        durationSeconds: 120,
        source: 'web',
      });
      const accepted = await acceptListens(h.m, {
        did: h.alice,
        origin: 'lastfm',
        receiptMs: T0,
        listens: [
          { input: { artist: ' RADIOHEAD ', track: 'reckoner', listenedAt: new Date(T0 - 120_000).toISOString() } },
        ],
      });
      expect(accepted.results[0]?.status).toBe('accepted');
      expect(
        h.db.one<{ started_at_ms: number; scrobbled_at_ms: number }>(
          'SELECT started_at_ms, scrobbled_at_ms FROM now_playing WHERE did=?',
          h.alice,
        ),
      ).toEqual({ started_at_ms: T0 - 120_000, scrobbled_at_ms: T0 });
    });
    await withHarness(async (h) => {
      h.account(h.alice);
      upsertNowPlaying(h.m, { did: h.alice, artist: 'Radiohead', track: 'Reckoner', source: 'web' });
      await acceptListens(h.m, {
        did: h.alice,
        origin: 'lastfm',
        receiptMs: T0,
        listens: [
          { input: { artist: 'Radiohead', track: 'Reckoner', listenedAt: new Date(T0 - 601_000).toISOString() } },
        ],
      });
      expect(
        h.db.one<{ started_at_ms: number; scrobbled_at_ms: number }>(
          'SELECT started_at_ms, scrobbled_at_ms FROM now_playing WHERE did=?',
          h.alice,
        ),
      ).toEqual({ started_at_ms: T0, scrobbled_at_ms: null });
    });
  });
  it('uses the 600 second duration fallback and records acceptance time for later listens', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      upsertNowPlaying(h.m, { did: h.alice, artist: 'Radiohead', track: 'Reckoner', source: 'web' });
      await acceptListens(h.m, {
        did: h.alice,
        origin: 'lastfm',
        receiptMs: T0,
        listens: [
          { input: { artist: 'Radiohead', track: 'Reckoner', listenedAt: new Date(T0 - 600_000).toISOString() } },
        ],
      });
      expect(
        h.db.one<{ started_at_ms: number }>('SELECT started_at_ms FROM now_playing WHERE did=?', h.alice)
          ?.started_at_ms,
      ).toBe(T0 - 600_000);
    });
    await withHarness(async (h) => {
      h.account(h.alice);
      upsertNowPlaying(h.m, { did: h.alice, artist: 'Radiohead', track: 'Reckoner', source: 'web' });
      await acceptListens(h.m, {
        did: h.alice,
        origin: 'lastfm',
        receiptMs: T0,
        listens: [
          { input: { artist: 'Radiohead', track: 'Other', listenedAt: new Date(T0 - 60_000).toISOString() } },
          { input: { artist: 'Radiohead', track: 'Reckoner', listenedAt: new Date(T0 + 10_000).toISOString() } },
        ],
      });
      expect(
        h.db.one<{ started_at_ms: number; scrobbled_at_ms: number | null }>(
          'SELECT started_at_ms, scrobbled_at_ms FROM now_playing WHERE did=?',
          h.alice,
        ),
      ).toEqual({ started_at_ms: T0, scrobbled_at_ms: T0 });
    });
  });
  it.each([120, null])('ignores an earlier repeat beyond the %s second play window', async (durationSeconds) => {
    await withHarness(async (h) => {
      h.account(h.alice);
      upsertNowPlaying(h.m, { did: h.alice, artist: 'Radiohead', track: 'Reckoner', durationSeconds, source: 'web' });
      const before = h.db.one('SELECT * FROM now_playing WHERE did=?', h.alice);
      h.kit.clock.advance(1_000);
      const accepted = await acceptListens(h.m, {
        did: h.alice,
        origin: 'lastfm',
        receiptMs: T0 + 1_000,
        listens: [
          {
            input: {
              artist: 'Radiohead',
              track: 'Reckoner',
              listenedAt: new Date(T0 - ((durationSeconds ?? 600) + 1) * 1000).toISOString(),
            },
          },
        ],
      });
      expect(accepted.results[0]?.status).toBe('accepted');
      expect(h.db.one('SELECT * FROM now_playing WHERE did=?', h.alice)).toEqual(before);
    });
  });
  it('marks a clock-skewed current play at acceptance time without moving its start', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      upsertNowPlaying(h.m, { did: h.alice, artist: 'Radiohead', track: 'Reckoner', source: 'web' });
      h.kit.clock.advance(30_000);
      const accepted = await acceptListens(h.m, {
        did: h.alice,
        origin: 'lastfm',
        receiptMs: T0 + 30_000,
        listens: [
          { input: { artist: 'Radiohead', track: 'Reckoner', listenedAt: new Date(T0 + 10_000).toISOString() } },
        ],
      });
      expect(accepted.results[0]?.status).toBe('accepted');
      expect(h.db.one('SELECT started_at_ms, scrobbled_at_ms FROM now_playing WHERE did=?', h.alice)).toEqual({
        started_at_ms: T0,
        scrobbled_at_ms: T0 + 30_000,
      });
    });
  });
  it('acceptListens writes listen keys, operations and forward rows for active links in one transaction; a repeated listen key creates nothing and is reported accepted', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      const lastfm = h.link(h.alice, 'lastfm');
      h.link(h.alice, 'listenbrainz', { status: 'revoked' });
      h.link(h.bob, 'lastfm');
      const db = countingDb(h.db);
      const m = { ...h.m, db };
      const inputs = [listenInput(0), listenInput(1), listenInput(2, { album: 'Debut' })];
      let kicks = 0;

      const first = await acceptListens(m, {
        did: h.alice,
        origin: 'lastfm',
        listens: inputs.map((input) => ({ input })),
        receiptMs: T0,
        kick: () => {
          kicks += 1;
        },
      });

      // One outermost transaction for the whole request.
      expect(db.outer).toBe(1);
      expect(kicks).toBe(1);
      const keys = await Promise.all(inputs.map((i) => keyOf(h.alice, i)));
      expect(first.created).toBe(3);
      expect(first.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'accepted']);
      const ops = h.ops();
      expect(ops.map((o) => [o.kind, o.origin, o.priority, o.state, o.attempts, o.due_at, o.collection])).toEqual(
        inputs.map(() => ['scrobble.create', 'lastfm', 0, 'queued', 0, T0, SCROBBLE]),
      );
      expect(first.results).toEqual(
        ops.map((o, i) => ({ status: 'accepted', operationId: o.id, listenKey: keys[i], duplicate: false })),
      );
      for (const [i, op] of ops.entries()) {
        const record = JSON.parse(op.record_json!) as Record<string, unknown>;
        expect(record).toMatchObject({ $type: SCROBBLE, artist: inputs[i]!.artist, createdAt: '2026-01-15T12:00:00Z' });
        expect(op.rkey).toMatch(/^[234567a-j][234567a-z]{12}$/);
      }
      expect(
        h.db.all('SELECT did, dedupe_key, operation_id, source, created_at_ms FROM listen_keys ORDER BY rowid'),
      ).toEqual(
        ops.map((o, i) => ({
          did: h.alice,
          dedupe_key: keys[i],
          operation_id: o.id,
          source: 'lastfm',
          created_at_ms: T0,
        })),
      );
      // Only the active Last.fm link of the same DID gets rows: one per listen, keyed by the listen key.
      expect(
        h.db.all('SELECT link_id, did, kind, dedupe_key, state, due_at FROM forward_outbox ORDER BY rowid'),
      ).toEqual(
        keys.map((k) => ({
          link_id: lastfm,
          did: h.alice,
          kind: 'scrobble',
          dedupe_key: k,
          state: 'queued',
          due_at: T0,
        })),
      );
      const payload = JSON.parse(h.db.one<{ p: string }>('SELECT payload_json AS p FROM forward_outbox LIMIT 1')!.p);
      expect(payload).toEqual({ listen: inputs[0], origin: 'lastfm' });
      // Nothing reached a PDS: acceptance means durably queued.
      expect(h.writers.sent).toEqual([]);

      // A client resend (same second, case and spacing variants of the names) creates nothing.
      const resend = await acceptListens(m, {
        did: h.alice,
        origin: 'lastfm',
        listens: [{ input: { ...inputs[0]!, artist: '  ARTIST 0 ' } }, { input: inputs[1]! }],
        receiptMs: T0 + 5_000,
        kick: () => {
          kicks += 1;
        },
      });
      expect(resend.created).toBe(0);
      expect(resend.results).toEqual([
        { status: 'accepted', operationId: ops[0]!.id, listenKey: keys[0], duplicate: true },
        { status: 'accepted', operationId: ops[1]!.id, listenKey: keys[1], duplicate: true },
      ]);
      expect(kicks).toBe(1);
      expect([count(h.db, 'operations'), count(h.db, 'listen_keys'), count(h.db, 'forward_outbox')]).toEqual([3, 3, 3]);
    });
  });

  it('the daily cap counts accepted listens per DID over a rolling 24 h and reports over-cap entries without creating operations', async () => {
    await withHarness(async (h) => {
      h.account(h.alice, { daily_listen_cap: 5 });
      const seed = (key: string, at: number, source: string, did = h.alice) =>
        h.db.run(
          `INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms) VALUES (?, ?, NULL, ?, ?)`,
          did,
          key,
          source,
          at,
        );
      // In the window: three live listens. Outside it, an import, and another DID: not counted.
      for (const i of [1, 2, 3]) seed(`old-${i}`, T0 - 23 * 3_600_000, 'listenbrainz');
      seed('older', T0 - 24 * 3_600_000, 'lastfm');
      seed('imported', T0 - 3_600_000, 'import');
      seed('bobs', T0 - 3_600_000, 'web', h.bob);

      const inputs = [0, 1, 2, 3].map((i) => listenInput(i));
      const first = await acceptListens(h.m, {
        did: h.alice,
        origin: 'listenbrainz',
        listens: inputs.map((input) => ({ input })),
        receiptMs: T0,
      });
      const keys = await Promise.all(inputs.map((i) => keyOf(h.alice, i)));
      expect(first.results.map((r) => r.status)).toEqual(['accepted', 'accepted', 'over_cap', 'over_cap']);
      expect(first.results.slice(2)).toEqual([
        { status: 'over_cap', listenKey: keys[2] },
        { status: 'over_cap', listenKey: keys[3] },
      ]);
      expect([first.created, first.cap, first.remaining]).toEqual([2, 5, 0]);
      expect(count(h.db, 'operations')).toBe(2);
      // Over-cap entries leave no listen key, so the client's later retry is a new listen.
      expect(count(h.db, 'listen_keys', 'dedupe_key IN (?, ?)', keys[2]!, keys[3]!)).toBe(0);

      // One hour later the three listens of 23 h ago have left the rolling window.
      h.kit.clock.advance(3_600_000);
      const later = await acceptListens(h.m, {
        did: h.alice,
        origin: 'listenbrainz',
        listens: [{ input: inputs[2]! }, { input: inputs[3]! }],
        receiptMs: h.kit.clock.nowMs(),
      });
      expect(later.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
      expect([later.created, later.remaining]).toEqual([2, 1]);
      expect(count(h.db, 'operations', 'did = ?', h.alice)).toBe(4);
    });
  });

  it('a throw after the operation insert rolls back the listen key and forward rows', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      h.link(h.alice, 'lastfm');
      h.link(h.alice, 'listenbrainz');
      // Fault injection through the injected Db: the second operation insert succeeds, then throws.
      let inserts = 0;
      const faulty: Db = {
        all: h.db.all.bind(h.db),
        one: h.db.one.bind(h.db),
        tx: h.db.tx.bind(h.db),
        run(sql, ...params) {
          const result = h.db.run(sql, ...params);
          if (/^\s*INSERT INTO operations\b/.test(sql) && ++inserts === 2)
            throw new Error('injected fault after insert');
          return result;
        },
      };
      let kicks = 0;
      const request = {
        did: h.alice,
        origin: 'lastfm' as const,
        listens: [{ input: listenInput(0) }, { input: listenInput(1) }],
        receiptMs: T0,
        kick: () => {
          kicks += 1;
        },
      };
      await expect(acceptListens({ ...h.m, db: faulty }, request)).rejects.toThrow('injected fault after insert');
      expect(inserts).toBe(2);
      // The first listen's key, operation and two forward rows, and the second's key and operation: all gone.
      expect(['listen_keys', 'operations', 'operation_deps', 'forward_outbox'].map((t) => count(h.db, t))).toEqual([
        0, 0, 0, 0,
      ]);
      expect(kicks).toBe(0);

      // Nothing half-committed is left behind: the same request is accepted as new.
      const again = await acceptListens(h.m, request);
      expect(again.results.map((r) => r.status === 'accepted' && r.duplicate)).toEqual([false, false]);
      expect(['listen_keys', 'operations', 'forward_outbox'].map((t) => count(h.db, t))).toEqual([2, 2, 4]);
      expect(kicks).toBe(1);
    });
  });

  it('a listen accepted with notBeforeMs = listened_at − 300 s gets an operation whose due_at and createdAt equal it, its listen key and forward rows at once, and is not sent to the fake PDS before due_at', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      const link = h.link(h.alice, 'listenbrainz');
      // ListenBrainz accepts up to now + 3,600 s; our lexicon bound is createdAt + 300 s.
      const listenedAtMs = T0 + 1_800_000;
      const notBeforeMs = listenedAtMs - 300_000;
      const input = { artist: 'Ahead', track: 'Of Time', listenedAt: new Date(listenedAtMs).toISOString() };
      const result = await acceptListens(h.m, {
        did: h.alice,
        origin: 'listenbrainz',
        listens: [{ input, notBeforeMs }],
        receiptMs: T0,
      });
      expect(result.results.map((r) => r.status)).toEqual(['accepted']);
      const [op] = h.ops();
      expect(op!.due_at).toBe(notBeforeMs);
      const record = JSON.parse(op!.record_json!) as { createdAt: string; listenedAt: string };
      expect(Date.parse(record.createdAt)).toBe(notBeforeMs);
      expect(Date.parse(record.listenedAt)).toBe(listenedAtMs);
      // Listen key and forward row now, at the receipt time.
      const key = await keyOf(h.alice, input);
      expect(h.db.all('SELECT dedupe_key, created_at_ms FROM listen_keys')).toEqual([
        { dedupe_key: key, created_at_ms: T0 },
      ]);
      expect(h.db.all('SELECT link_id, dedupe_key, due_at, created_at_ms, updated_at_ms FROM forward_outbox')).toEqual([
        { link_id: link, dedupe_key: key, due_at: notBeforeMs, created_at_ms: T0, updated_at_ms: T0 },
      ]);
      const duplicate = await acceptListens(h.m, {
        did: h.alice,
        origin: 'listenbrainz',
        listens: [{ input, notBeforeMs }],
        receiptMs: T0 + 1_000,
      });
      expect(duplicate.results).toMatchObject([{ status: 'accepted', duplicate: true }]);
      expect(h.db.all('SELECT due_at, created_at_ms, updated_at_ms FROM forward_outbox')).toEqual([
        { due_at: notBeforeMs, created_at_ms: T0, updated_at_ms: T0 },
      ]);

      // Not before due_at: nothing is sent, and the outbox asks to run exactly then.
      const early = await h.run();
      expect([early.attempted, early.nextDueMs]).toEqual([0, notBeforeMs]);
      h.kit.clock.set(new Date(notBeforeMs - 1).toISOString());
      expect((await h.run()).attempted).toBe(0);
      expect(h.writers.sent).toEqual([]);
      expect(h.kit.pds.Alice.count(CREATE)).toBe(0);

      h.kit.clock.advance(1);
      await h.runUntilIdle();
      expect(h.writers.order()).toEqual([CREATE]);
      expect(h.op(op!.id)).toMatchObject({ state: 'succeeded', attempts: 1 });
      const remote = await remoteRecord(h.kit, 'Alice', SCROBBLE, op!.rkey!);
      expect(remote?.value).toEqual(record);
    });
  });
});

describe('enqueueForwards', () => {
  it('enqueueForwards gives love, unlove, love three distinct rows; a resent scrobble and a same-track now-playing refresh give none; the same track playing again later gives a new nowplaying row', async () => {
    await withHarness(async (h) => {
      h.account(h.alice);
      const lastfm = h.link(h.alice, 'lastfm');
      const lb = h.link(h.alice, 'listenbrainz', { forward_now_playing: 0 });
      const love = { artist: 'Björk', track: 'Hyperballad' };

      const ops: string[] = [];
      for (const step of ['love', 'unlove', 'love'] as const) {
        const r =
          step === 'love'
            ? await enqueueLove(h.m, { did: h.alice, input: love, origin: 'lastfm' })
            : await enqueueUnlove(h.m, { did: h.alice, ...love, origin: 'lastfm' });
        if (!r.ok) throw new Error(JSON.stringify(r.reason));
        ops.push(r.operation.id);
      }
      expect(new Set(ops).size).toBe(3);
      const rows = (kinds: string[]) =>
        h.db.all<{ link_id: string; dedupe_key: string; kind: string }>(
          `SELECT link_id, kind, dedupe_key FROM forward_outbox WHERE kind IN (${kinds.map(() => '?').join(',')})
           ORDER BY rowid`,
          ...kinds,
        );
      // Per link: love, unlove, love, each keyed by its own operation id.
      expect(rows(['love', 'unlove'])).toEqual(
        ops.flatMap((id, i) =>
          [lastfm, lb].map((link) => ({ link_id: link, kind: i === 1 ? 'unlove' : 'love', dedupe_key: id })),
        ),
      );

      // A resent scrobble: one row per link, never two.
      const input = listenInput(0);
      await acceptListens(h.m, { did: h.alice, origin: 'lastfm', listens: [{ input }], receiptMs: T0 });
      await acceptListens(h.m, { did: h.alice, origin: 'lastfm', listens: [{ input }], receiptMs: T0 + 1_000 });
      const key = await keyOf(h.alice, input);
      expect(rows(['scrobble'])).toEqual([
        { link_id: lastfm, kind: 'scrobble', dedupe_key: key },
        { link_id: lb, kind: 'scrobble', dedupe_key: key },
      ]);
      // A resend directly through enqueueForwards creates nothing either.
      expect(
        enqueueForwards(h.db, {
          did: h.alice,
          items: [{ kind: 'scrobble', listenKey: key, payload: {} }],
          now: T0,
          random: h.m.random,
        }),
      ).toBe(0);

      // Now playing: only the link that forwards now playing; a refresh keeps started_at_ms.
      const np = (startedAtMs: number, artist = 'Portishead') =>
        enqueueForwards(h.db, {
          did: h.alice,
          items: [{ kind: 'nowplaying', startedAtMs, artist, track: 'Roads', payload: { artist, track: 'Roads' } }],
          now: h.kit.clock.nowMs(),
          random: h.m.random,
        });
      expect(np(T0)).toBe(1);
      expect(np(T0, ' portishead ')).toBe(0);
      expect(np(T0 + 600_000)).toBe(1);
      expect(rows(['nowplaying'])).toEqual([
        { link_id: lastfm, kind: 'nowplaying', dedupe_key: nowPlayingKey(h.alice, T0, 'Portishead', 'Roads') },
        {
          link_id: lastfm,
          kind: 'nowplaying',
          dedupe_key: nowPlayingKey(h.alice, T0 + 600_000, 'Portishead', 'Roads'),
        },
      ]);
      expect(nowPlayingKey(h.alice, T0, 'Portishead', 'Roads')).toMatch(/^[0-9a-f]{64}$/);
      expect(nowPlayingKey(h.alice, T0, 'Portishead', 'Roads')).not.toBe(
        nowPlayingKey(h.bob, T0, 'Portishead', 'Roads'),
      );
    });
  });
});

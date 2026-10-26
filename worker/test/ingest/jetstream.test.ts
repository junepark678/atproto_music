// W4-02 jetstream.ts (onMessage) through the real socket path: the fixture's
// signed commits reach the fake Jetstream, the production connector and
// socket deliver them to onMessage, hints and the checkpoint commit in one
// transaction, and the production drain verifies and applies them. Proves
// M4.1.3/duplicate_commit and M4.2.1/resume. Expectations are hardcoded or
// come from tests/fixtures/read_models.json and the fixture signer.

import { encodeEvent } from '@atmusic/atproto/test-support/fake-jetstream';
import { FIXTURE_USERS, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };
import type { Db, SqlParam } from '../../src/do/db';
import { JETSTREAM_INVALID_COUNTER, onMessage } from '../../src/do/ingest/jetstream';
import { closeSocket, connect, socketWatchdog } from '../../src/do/ingest/jetstream-socket';
import { drain } from '../../src/do/ingest/verify-drain';
import { recordEvent } from '../../src/do/status';
import { checkpointRow, flush, jetstreamServer, zeroJitter } from '../fixtures/jetstream-server';
import { seedUser } from '../write/support';
import { counterValue, depsFor, kit } from './drain-support';
import { withIngestIndex } from './node-index';

/** A Db whose writes throw while `fault()` matches the statement (fault injection through the interface). */
function faultyDb(db: Db, fault: () => RegExp | null): Db {
  const check = (sql: string) => {
    const f = fault();
    if (f?.test(sql)) throw new Error(`injected storage fault: ${sql.slice(0, 40)}`);
  };
  return {
    all(sql: string, ...p: SqlParam[]) {
      check(sql);
      return db.all(sql, ...p);
    },
    one(sql: string, ...p: SqlParam[]) {
      check(sql);
      return db.one(sql, ...p);
    },
    run(sql: string, ...p: SqlParam[]) {
      check(sql);
      return db.run(sql, ...p);
    },
    tx: (fn) => db.tx(fn),
  } as Db;
}

const hintUris = (db: Db) => db.all<{ uri: string }>('SELECT uri FROM hints ORDER BY uri').map((r) => r.uri);

function projection(db: Db) {
  return {
    scrobbles: db.all('SELECT * FROM scrobbles ORDER BY uri'),
    follows: db.all('SELECT * FROM follows ORDER BY uri'),
    record_state: db.all('SELECT * FROM record_state ORDER BY uri'),
  };
}

async function drainAll(m: Parameters<typeof drain>[0], now: number, db: Db): Promise<void> {
  for (let i = 0; i < 10 && hintUris(db).length > 0; i++) await drain(m, now);
  expect(hintUris(db)).toEqual([]);
}

it('hint durable before cursor advance; replay of inclusive cursor creates no duplicate rows', async () => {
  const k = await kit();
  const server = jetstreamServer({ clock: k.clock, fakes: [k.jetstream] });
  const S = k.collections.scrobble;
  const confirmed = fixture.scrobbles.filter((s) => s.state === 'confirmed').map((s) => s.uri);
  const r08 = fixture.scrobbles.find((s) => s.rkey === 'r08')!.uri;

  await withIngestIndex(async (i) => {
    let fault: RegExp | null = null;
    const db = faultyDb(i.db, () => fault);
    const base = depsFor(db, k);
    const m = { ...base, random: zeroJitter, config: { ...base.config, ingestMode: 'socket' as const } };
    for (const name of FIXTURE_USERS) seedUser(i.db, k.users[name].did);

    // First start: no cursor, so the live tail.
    expect(await connect(m, server.connect, k.clock.nowMs())).toMatchObject({ ok: true, gap: 'no_cursor' });
    expect(server.attempts.map((a) => [a.cursor, a.status])).toEqual([[null, 101]]);

    // The whole fixture is published; every commit reaches the socket live.
    const seed = await seedReadModels(k);
    await flush();
    const seqs = seed.events.map((e) => e.seq);
    const lastSeq = seqs.at(-1)!;
    expect(seqs.length).toBe(12); // 9 local scrobbles incl. r08, Carol's external r10, the follow, r08's delete
    // Each event's hint is durable and the cursor sits on the newest event.
    const eventUris = [
      ...new Set(
        seed.events.map((e) =>
          e.kind === 'commit' ? `at://${e.did}/${e.commit.collection}/${e.commit.rkey}` : 'unexpected',
        ),
      ),
    ].sort();
    expect(hintUris(i.db)).toEqual(eventUris);
    expect(eventUris).toEqual(
      [...confirmed, r08, ...[...seed.records.keys()].filter((u) => u.includes('.follow/'))].sort(),
    );
    expect(checkpointRow(i.db)).toMatchObject({
      cursor: lastSeq,
      last_event_time_us: seed.events.at(-1)!.timeUs,
      connected: 1,
    });

    // A hint write fails: the cursor stays on the previous event (nothing of the
    // failed event is written) and the link drops so the event is not skipped.
    const beforeFault = { hints: i.db.all('SELECT * FROM hints ORDER BY uri'), cp: checkpointRow(i.db) };
    fault = /INSERT INTO hints/;
    const r11 = await k.externalPut('Carol', S, 'r11', {
      $type: S,
      artist: 'Kate Bush',
      track: 'Cloudbusting',
      listenedAt: '2026-01-15T11:50:00Z',
      createdAt: '2026-01-15T11:50:00Z',
    });
    const r11Seq = k.jetstream.events.at(-1)!.seq;
    expect(r11Seq).toBe(lastSeq + 1);
    await flush();
    expect({ hints: i.db.all('SELECT * FROM hints ORDER BY uri'), cp: checkpointRow(i.db) }).toEqual({
      hints: beforeFault.hints,
      cp: { ...beforeFault.cp, connected: 0, updated_at_ms: k.clock.nowMs() },
    });
    expect(server.last().closeCode).toBe(1011);
    fault = null;

    // The watchdog reconnects after the 1 s backoff from the stored cursor; the
    // inclusive replay re-delivers the last applied event and then the failed one.
    k.clock.advance(1_000);
    expect(await socketWatchdog(m, server.connect, k.clock.nowMs())).toMatchObject({ action: 'connected' });
    await flush();
    expect(server.attempts.at(-1)).toMatchObject({ cursor: lastSeq, status: 101 });
    expect(server.last().sent.map((t) => (JSON.parse(t) as { seq: number }).seq)).toEqual([lastSeq, r11Seq]);
    const r11Uri = `at://${k.users.Carol.did}/${S}/r11`;
    expect(hintUris(i.db)).toEqual([...eventUris, r11Uri].sort());
    expect(checkpointRow(i.db)).toMatchObject({ cursor: r11Seq, connected: 1 });

    // The production drain verifies and applies every hint.
    await drainAll(m, k.clock.nowMs(), i.db);
    const applied = projection(i.db);
    expect(applied.scrobbles.map((r) => (r as { uri: string }).uri)).toEqual([...confirmed, r11Uri].sort());
    expect(applied.follows.length).toBe(1);
    expect(i.db.one('SELECT state, cid FROM record_state WHERE uri = ?', r11Uri)).toEqual({
      state: 'present',
      cid: r11.ops[0]!.cid,
    });
    expect(i.db.one('SELECT state FROM record_state WHERE uri = ?', r08)).toEqual({ state: 'absent' });

    // M4.1.3/duplicate_commit: the same event delivered twice is one hint and one cursor value.
    const lastEvent = k.jetstream.events.at(-1)!;
    const text = encodeEvent(lastEvent);
    expect(onMessage(m, text, k.clock.nowMs())).toEqual({
      kind: 'hint',
      uri: r11Uri,
      seq: r11Seq,
      timeUs: lastEvent.timeUs,
    });
    expect(onMessage(m, text, k.clock.nowMs())).toMatchObject({ kind: 'hint', uri: r11Uri });
    expect(hintUris(i.db)).toEqual([r11Uri]);
    // An ignored event (another collection) still advances the cursor, with no hint;
    // an invalid frame is counted and moves nothing.
    const other = JSON.stringify({
      did: k.users.Bob.did,
      seq: r11Seq + 5,
      time_us: lastEvent.timeUs + 5,
      kind: 'commit',
      commit: {
        rev: '3lbcdefghijkl',
        operation: 'create',
        collection: 'app.bsky.feed.post',
        rkey: 'x',
        cid: 'bafyreiaaaaaaaa',
      },
    });
    expect(onMessage(m, other, k.clock.nowMs())).toEqual({
      kind: 'ignored',
      seq: r11Seq + 5,
      timeUs: lastEvent.timeUs + 5,
    });
    expect(checkpointRow(i.db)).toMatchObject({ cursor: r11Seq + 5, last_event_time_us: lastEvent.timeUs + 5 });
    expect(onMessage(m, '{not json', k.clock.nowMs())).toEqual({ kind: 'invalid', reason: 'malformed_json' });
    expect(checkpointRow(i.db)).toMatchObject({ cursor: r11Seq + 5 });
    expect(counterValue(i.db, JETSTREAM_INVALID_COUNTER, 'malformed_json')).toBe(1);
    expect(hintUris(i.db)).toEqual([r11Uri]);
    await drainAll(m, k.clock.nowMs(), i.db);
    expect(projection(i.db)).toEqual(applied);

    // M4.2.1/resume: resume from an old inclusive cursor (seq 1): every event is
    // delivered again, the hints coalesce one per URI and the drain leaves the
    // projection byte-identical (no duplicate rows).
    closeSocket(m, k.clock.nowMs());
    i.db.tx(() => recordEvent(i.db, { cursor: seqs[0]!, timeUs: seed.events[0]!.timeUs }));
    expect(await socketWatchdog(m, server.connect, k.clock.nowMs())).toMatchObject({ action: 'connected' });
    await flush();
    expect(server.attempts.at(-1)).toMatchObject({ cursor: seqs[0], status: 101 });
    expect(server.last().sent.length).toBe(k.jetstream.events.length);
    expect(hintUris(i.db)).toEqual([...eventUris, r11Uri].sort());
    expect(checkpointRow(i.db)).toMatchObject({ cursor: r11Seq });
    await drainAll(m, k.clock.nowMs(), i.db);
    expect(projection(i.db)).toEqual(applied);
    expect(i.db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles')!.n).toBe(confirmed.length + 1);
    closeSocket(m, k.clock.nowMs());
  });
});

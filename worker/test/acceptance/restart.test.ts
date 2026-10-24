// W6-01 restart acceptance (ADR 0004 §10.2 "Restart", A18; TESTING.md "A
// restart is a Durable Object eviction that keeps its storage"). Proves
// M4.4.2/worker_restart, M5.4.3/durable_views, M5.4.3/durable_cursor,
// M6.4.2/packaged_recovery, M7.4.2/browser_restart and the acceptance half of
// M5.4.3/durable_delete.
//
// The seeded IndexDO holds a live Jetstream socket and a durable but not yet
// drained hint when its instance dies (DO eviction; the fixture's `sever()`
// stands in for the platform tearing the socket down with the instance). The
// restarted instance must reopen the same storage: every table byte-identical
// except the one write a restart is specified to make (the socket's 1→0
// `connected` transition), responses byte-identical, a cursor issued before
// the restart continuing, and the alarm resuming the socket from the stored
// cursor and draining the pending hint.

import { evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ALICE,
  AS_OF_MS,
  allTables,
  BOB,
  CAROL,
  GET_RECORD,
  inSocket,
  rkeyOf,
  SCROBBLE,
  seedAcceptance,
  uriOf,
} from './support/seed';

// biome-ignore lint/suspicious/noExplicitAny: bodies are validated against api/openapi.yaml before they reach a test.
type Json = any;

const enc = encodeURIComponent;
const rkeys = (body: Json): string[] => (body.items as Array<{ uri: string }>).map((s) => rkeyOf(s.uri));

describe('restart acceptance', () => {
  it('eviction preserves byte-identical tables, pre-restart cursor continues, alarm resumes', async () => {
    const a = await seedAcceptance('restart');
    const READS = [
      `/api/v1/users/${ALICE}/scrobbles?limit=100`,
      `/api/v1/users/${BOB}/scrobbles?limit=100`,
      '/api/v1/feed?scope=global&limit=100',
      `/api/v1/feed?scope=following&viewer=${enc(ALICE)}`,
      `/api/v1/users/${ALICE}/stats?window=all`,
      `/api/v1/users/${ALICE}/stats?window=7d`,
      `/api/v1/users/${ALICE}/profile`,
      `/api/v1/users/${BOB}/followers`,
      `/api/v1/users/${CAROL}/export`,
      `/api/v1/records/status?uri=${enc(uriOf(ALICE, 'r01'))}`,
    ];
    const read = async () => {
      const out: string[] = [];
      for (const path of READS) {
        const r = await a.request(path);
        expect([path, r.status]).toEqual([path, 200]);
        out.push(r.text);
      }
      return out;
    };

    const page1 = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2`);
    expect(rkeys(page1.body)).toEqual(['r07', 'r01']);
    const cursor = (page1.body as Json).nextCursor as string;

    // Work that is durable but not done when the instance dies: a commit whose
    // Jetstream event is a hint the drain has not yet verified.
    const r11 = await inSocket(a, () =>
      a.kit.createRecord('Alice', SCROBBLE, 'r11', {
        $type: SCROBBLE,
        artist: 'Björk',
        track: 'Hyperballad',
        listenedAt: '2026-01-15T11:59:00Z',
        createdAt: '2026-01-15T11:59:00Z',
      }),
    );
    const responses = await read();
    const before = await a.inDo((db, h) => ({
      tables: allTables(db),
      constructed: h.constructed,
      hints: db.all('SELECT uri, source FROM hints'),
    }));
    expect(before.hints).toEqual([{ uri: uriOf(ALICE, 'r11'), source: 'jetstream' }]);
    expect(before.constructed).toBe(1);
    const checkpoint = before.tables.ingest_checkpoint as Array<Record<string, unknown>>;
    expect(checkpoint[0]).toMatchObject({ connected: 1, mode: 'socket' });
    const storedCursor = checkpoint[0]?.cursor as number;
    expect(storedCursor).toBe(a.kit.jetstream.events.at(-1)?.seq);

    // The instance dies with its socket.
    a.kit.resetCalls();
    await a.inDo(() => a.js.sever());
    await evictDurableObject(a.stub);
    const attempts = a.js.attempts.length;

    // The new instance reopened the same storage.
    const after = await a.inDo((db, h, state) => ({
      tables: allTables(db),
      constructed: h.constructed,
      armed: h.armed.at(-1),
      realAlarm: state.storage.getAlarm(),
    }));
    expect(after.constructed).toBe(2);
    expect(a.kit.clock.nowMs()).toBe(AS_OF_MS);
    // Byte-identical (timers, queues, projection, caches, counters…), except
    // exactly the restart's recorded socket drop.
    const { ingest_checkpoint: ckAfter, ...restAfter } = after.tables;
    const { ingest_checkpoint: ckBefore, ...restBefore } = before.tables;
    expect(JSON.stringify(restAfter)).toBe(JSON.stringify(restBefore));
    expect(ckAfter).toEqual([
      { ...(ckBefore as Array<Record<string, unknown>>)[0], connected: 0, updated_at_ms: AS_OF_MS },
    ]);
    // The alarm is re-armed at min(due_at): the watchdog, already due, which reconnects.
    const timers = after.tables.timers as Array<{ name: string; due_at: number }>;
    const next = Math.min(...timers.map((t) => t.due_at));
    expect(timers.find((t) => t.due_at === next)?.name).toBe('jetstream-watchdog');
    expect(next).toBeLessThanOrEqual(AS_OF_MS);
    expect(after.armed).toBe(next);
    expect(await after.realAlarm).not.toBeNull();
    // Nothing reached the network on the way down or up.
    expect(a.kit.transport.calls.entries).toEqual([]);
    expect(a.js.attempts.length).toBe(attempts);

    // Responses are byte-identical except the one live flag that reports the
    // socket itself: `indexing.caughtUp` is true before and false while the
    // socket is down (state stays `current`: the drop is within the 5-minute
    // stale bound).
    const restarted = await read();
    const flags = (texts: string[]) => texts.map((t) => (JSON.parse(t) as Json).indexing?.caughtUp ?? null);
    const withoutFlag = (texts: string[]) => texts.map((t) => t.replace(/"caughtUp":(true|false)/g, '"caughtUp":"*"'));
    const PAGES = [true, true, true, true, null, null, true, true, true, true];
    expect(flags(responses)).toEqual(PAGES);
    expect(flags(restarted)).toEqual(PAGES.map((f) => (f === null ? null : false)));
    expect(withoutFlag(restarted)).toEqual(withoutFlag(responses));
    // A cursor issued before the restart continues below its anchor.
    const page2 = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc(cursor)}`);
    expect(page2.status).toBe(200);
    expect(rkeys(page2.body)).toEqual(['r02', 'r03']);

    // The alarm resumes: it reconnects from the stored cursor and drains the pending hint.
    expect(await a.alarm()).toBe(true);
    const reconnect = a.js.attempts.slice(attempts);
    expect(reconnect.map((x) => [x.cursor, x.status])).toEqual([[storedCursor, 101]]);
    // That same alarm verified r11 (the drain runs before the watchdog); the
    // reconnect then replayed the cursor's event inclusively, a duplicate hint
    // the next drain verifies as a no-op.
    expect(await a.inDo((db) => db.one('SELECT cid FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'r11')))).toEqual({
      cid: r11.cid,
    });
    await a.alarmsUntil((db) => db.one<{ n: number }>('SELECT count(*) AS n FROM hints')?.n === 0, { max: 3 });
    const resumed = await a.inDo((db, h) => ({
      row: db.one('SELECT cid FROM scrobbles WHERE uri = ?', uriOf(ALICE, 'r11')),
      hints: db.all('SELECT uri FROM hints'),
      checkpoint: db.one("SELECT connected FROM ingest_checkpoint WHERE stream = 'jetstream'"),
      constructed: h.constructed,
    }));
    expect(resumed).toEqual({ row: { cid: r11.cid }, hints: [], checkpoint: { connected: 1 }, constructed: 2 });
    expect(a.kit.pds.Alice.calls.count({ nsid: GET_RECORD })).toBe(2);
    expect(
      await a.inDo((db) => db.one<{ n: number }>('SELECT count(*) AS n FROM scrobbles WHERE did = ?', ALICE)?.n),
    ).toBe(8);
    // Reconnected, the index reports itself caught up again.
    const live = await a.request(`/api/v1/users/${BOB}/scrobbles?limit=100`);
    expect((live.body as Json).indexing).toMatchObject({ state: 'current', caughtUp: true });
    expect((live.body as Json).items).toEqual((JSON.parse(responses[1] as string) as Json).items);

    // The pre-restart cursor still pages below its anchor: r11 arrived above it and never appears.
    const page3 = await a.request(
      `/api/v1/users/${ALICE}/scrobbles?limit=2&cursor=${enc((page2.body as Json).nextCursor)}`,
    );
    expect(rkeys(page3.body)).toEqual(['r04', 'r05']);
    const fresh = await a.request(`/api/v1/users/${ALICE}/scrobbles?limit=100`);
    expect(rkeys(fresh.body)).toEqual(['r11', 'r07', 'r01', 'r02', 'r03', 'r04', 'r05', 'r06']);
    // The deleted r08 stayed deleted across the restart.
    expect((await a.request(`/api/v1/scrobbles/${enc(uriOf(ALICE, 'r08'))}`)).status).toBe(404);
  });
});

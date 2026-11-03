// Migration 4: the planner selects the partial target index without a hint;
// dropping it changes the plan while public bodies and state/CID rules agree.
import { fromMs } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import { computeStatistics } from '../../src/do/read/stats';
import { visibleScrobblesFrom } from '../../src/do/read/visibility';
import { ALICE, BOB, ctxFor, get, pageRkeys, readFixture, SCROBBLE, uriOf } from './scrobble-read-support';

it('delete visibility searches by did and rkey and has byte-equal bodies without the index for every state/CID case', async () => {
  const f = await readFixture('delete-target-plan');
  const ctx = await ctxFor(f.index);
  const now = Date.parse('2026-01-15T12:00:00Z');
  const uri = uriOf(ALICE, 'r01');
  const cid = await f.inDb((db) => db.one<{ cid: string }>('SELECT cid FROM scrobbles WHERE uri=?', uri)!.cid);
  const ddl = await f.inDb(
    (db) =>
      db.one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='operations_scrobble_delete_target'")!.sql,
  );
  await f.inDb((db) =>
    db.tx(() => {
      const insert = (id: string, did: string, kind: string, rkey: string, state: string) =>
        db.run(
          `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
       VALUES (?,?,?,'web',0,?,?,?,?,?,?)`,
          id,
          did,
          kind,
          SCROBBLE,
          rkey,
          state,
          now,
          now,
          now,
        );
      for (let i = 0; i < 250; i++) insert(`create-${i}`, ALICE, 'scrobble.create', `create-${i}`, 'succeeded');
      insert('target', ALICE, 'scrobble.delete', 'r01', 'queued');
      insert('other-owner', BOB, 'scrobble.delete', 'r01', 'queued');
      insert('other-target', ALICE, 'scrobble.delete', 'unrelated', 'queued');
      insert('other-kind', ALICE, 'scrobble.create', 'r02', 'queued');
    }),
  );
  const sql = `SELECT s.uri FROM ${visibleScrobblesFrom()} WHERE s.did=?`;
  const plan = (tag: string) =>
    f.inDb((db) => db.all<{ detail: string }>(`EXPLAIN QUERY PLAN /* ${tag} */ ${sql}`, ALICE).map((r) => r.detail));
  const bodies = async () => {
    const out = [];
    for (const path of [
      '/api/v1/feed?scope=global',
      `/api/v1/feed?scope=following&viewer=${encodeURIComponent(ALICE)}`,
      `/api/v1/users/${ALICE}/scrobbles`,
      `/api/v1/scrobbles/${encodeURIComponent(uri)}`,
    ]) {
      const r = await get(ctx, path);
      out.push({ status: r.status, text: await r.res.text() });
    }
    out.push({
      status: 200,
      text: JSON.stringify(await f.inDb((db) => computeStatistics(db, ALICE, 'all', 100, fromMs(now)))),
    });
    return out;
  };
  for (const [state, swapCid, hidden] of [
    ['queued', null, true],
    ['running', null, true],
    ['blocked', null, true],
    ['failed', null, true],
    ['succeeded', cid, true],
    ['succeeded', 'stale-cid', false],
    ['succeeded', null, false],
    ['cancelled', cid, false],
  ] as const) {
    await f.inDb((db) => db.run('UPDATE operations SET state=?,swap_cid=? WHERE id=?', state, swapCid, 'target'));
    expect(await plan(`${state}-${swapCid}-indexed`)).toContain(
      'SEARCH d USING INDEX operations_scrobble_delete_target (did=? AND rkey=?)',
    );
    const history = pageRkeys(await get(ctx, `/api/v1/users/${ALICE}/scrobbles`));
    expect(history.includes('r01')).toBe(!hidden);
    expect(history).toContain('r02');
    const indexed = await bodies();
    await f.inDb((db) => db.run('DROP INDEX operations_scrobble_delete_target'));
    try {
      expect(await plan(`${state}-${swapCid}-unindexed`)).toContain(
        'SEARCH d USING INDEX operations_did_state (did=?)',
      );
      expect(await bodies()).toEqual(indexed);
    } finally {
      await f.inDb((db) => db.run(ddl));
    }
    expect(await bodies()).toEqual(indexed);
  }
});

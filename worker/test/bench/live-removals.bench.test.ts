// A2 live-removal growth and query-bound evidence. Large rows are seeded with
// SQL here so worker-node keeps its default 5 s timeout (ADR 0005 §15.1).

import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../src/do/db';
import {
  AUTHORIZATION_EVENT_HEAD_SQL,
  AUTHORIZATION_EVENT_HEAD_URI_SQL,
  AUTHORIZATION_PAGE_SQL,
  authorizePendingRemovals,
  CONFLICT_RETENTION_SCAN_SQL,
} from '../../src/do/ingest/live-pending-removals';
import { executeListenRemovals } from '../../src/forward/live-removal-effects';
import { projectionListenKey } from '../../src/forward/projection';
import { enqueueForwards } from '../../src/outbox/forward-enqueue';
import { withMigratedDb } from '../node/support/node-db';
import { seedUser } from '../write/support';

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const URI = `at://${DID}/com.example.atmusic.scrobbleBatch/large`;
const NOW = Date.parse('2026-01-15T12:00:00Z');
const REV = '3333333333333';

it('authorizes one 10k-member group with one set update', async () => {
  await withMigratedDb((db) => {
    for (let i = 0; i < 10_000; i++)
      db.run(
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,artist_key,track_key,artist,track,created_at_ms,expires_at_ms)
         VALUES(?,?,'old','scrobble','1111111111111','3333333333333','','key','a','t','A','T',1,9999999999999)`,
        URI,
        `${URI}#${i}`,
      );
    let updates = 0;
    let updateCalls = 0;
    const traced: Db = {
      all: db.all.bind(db),
      one: db.one.bind(db),
      tx: db.tx.bind(db),
      run(sql, ...params) {
        const result = db.run(sql, ...params);
        if (sql.includes('UPDATE live_pending_removals SET authorized_rev=')) {
          updates += result.rowsWritten;
          updateCalls++;
        }
        return result;
      },
    };
    authorizePendingRemovals(traced, { uri: URI, rev: REV, action: 'delete' }, 2);
    expect({ updateCalls, updates }).toEqual({ updateCalls: 1, updates: 10_000 });
    // This exercises the same whole-group shape whose former 1k × 128 page
    // loop produced 128,000 member updates.
  });
});

it('keeps authorization, ready-event, and retained-conflict reads on indexed bounded frontiers', async () => {
  await withMigratedDb((db) => {
    const explain = (sql: string, ...params: SqlParam[]) =>
      db
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
        .map((row) => row.detail)
        .join(' ');
    const plans = [
      explain(AUTHORIZATION_PAGE_SQL, URI, REV, '', '', '', '', '', 128),
      explain(AUTHORIZATION_EVENT_HEAD_SQL),
      explain(AUTHORIZATION_EVENT_HEAD_URI_SQL, URI),
      explain(CONFLICT_RETENTION_SCAN_SQL, URI, '', '', '', '', '', '', 128),
      explain(
        `SELECT uri,kind,window_lo,window_hi,replaced_by_cid,authorized_rev FROM live_pending_removals INDEXED BY live_pending_removals_ready
         WHERE authorized_rev IS NOT NULL AND expires_at_ms>? ORDER BY authorized_rev,created_at_ms,uri,window_hi LIMIT 1`,
        NOW,
      ),
      explain(
        `SELECT uri,kind,window_lo,window_hi,replaced_by_cid,authorized_rev FROM live_pending_removals INDEXED BY live_pending_removals_uri_ready
         WHERE uri=? AND authorized_rev IS NOT NULL AND expires_at_ms>? ORDER BY authorized_rev,created_at_ms,uri,window_hi LIMIT 1`,
        URI,
        NOW,
      ),
      explain(
        `SELECT * FROM live_pending_removals INDEXED BY live_pending_removals_group
         WHERE uri=? AND kind=? AND window_lo=? AND window_hi=? AND replaced_by_cid=? AND authorized_rev=? AND expires_at_ms>?`,
        URI,
        'scrobble',
        '1111111111111',
        REV,
        '',
        REV,
        NOW,
      ),
      explain(
        `SELECT kind,window_lo,window_hi,replaced_by_cid,authorized_rev,expires_at_ms FROM live_pending_removals INDEXED BY live_pending_removals_authorize
         WHERE uri=? AND window_hi>=? ORDER BY window_hi,window_lo DESC LIMIT 1`,
        URI,
        REV,
      ),
    ];
    expect(plans[0]).toContain('live_pending_removals_page');
    expect(plans[1]).toContain('live_pending_removal_events_ready_v2');
    expect(plans[2]).toContain('live_pending_removal_events_uri_ready_order');
    expect(plans[3]).toContain('live_pending_removals_page');
    expect(plans[4]).toContain('live_pending_removals_ready');
    expect(plans[5]).toContain('live_pending_removals_uri_ready');
    expect(plans[6]).toContain('live_pending_removals_group');
    expect(plans[7]).toContain('live_pending_removals_authorize');
    expect(plans.join(' ')).not.toMatch(/SCAN (live_pending_removals|live_pending_removal_events)\b|TEMP B-TREE/);

    for (const size of [1_000, 10_000]) {
      const uri = `${URI}-${size}`;
      for (let i = 0; i < size; i++)
        db.run(
          `INSERT INTO live_pending_removals
           (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,artist_key,track_key,artist,track,created_at_ms,expires_at_ms)
           VALUES(?,?,'old','scrobble',?,'zzzzzzzzzzzzz','',?,'a','t','A','T',1,9999999999999)`,
          uri,
          `member-${String(i).padStart(5, '0')}`,
          String(i).padStart(13, '0'),
          `key-${i}`,
        );
      let visits = 0;
      const visitName = `a2_bench_frontier_visit_${size}`;
      db.raw.function(visitName, () => {
        visits++;
        return 1;
      });
      const instrumented = AUTHORIZATION_PAGE_SQL.replace('WHERE uri=?', `WHERE uri=? AND ${visitName}()=1`);
      const params = (cursor: string) => [uri, 'zzzzzzzzzzzzz', cursor, '', '', '', '', 128];
      const nearTail = String(size - 129).padStart(13, '0');
      expect(db.all(instrumented, ...params(nearTail))).toHaveLength(128);
      expect(visits).toBe(128);
      visits = 0;
      expect(db.all(instrumented, ...params('zzzzzzzzzzzzz'))).toHaveLength(0);
      expect(visits).toBe(0);
    }
  });
});

it('writes one tombstone per removed member and coalesces canonical delete work', async () => {
  await withMigratedDb((db) => {
    seedUser(db, DID);
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
       VALUES('bench-link',?,'listenbrainz','bench',X'00','fixture',?,?)`,
      DID,
      NOW,
      NOW,
    );
    const listenedAt = '2026-01-15T11:00:00Z';
    const identityKey = projectionListenKey(DID, listenedAt, 'artist-key', 'track-key');
    enqueueForwards(db, {
      did: DID,
      items: [{ kind: 'scrobble', listenKey: identityKey, payload: { listen: { artist: 'Artist', track: 'Track' } } }],
      now: NOW,
      random: seededRandom(99),
    });
    db.run("UPDATE forward_outbox SET state='sent'");
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      uri: `${URI}#${i}`,
      cid: 'same-cid',
      listened_at: listenedAt,
      artist_key: 'artist-key',
      track_key: 'track-key',
      artist: 'Artist',
      track: 'Track',
      recording_mbid: null,
    }));
    const storedListenedAt = toStorage(fromMs(Date.parse(listenedAt)));
    const storedNow = toStorage(fromMs(NOW));
    db.tx(() => {
      for (const row of rows)
        db.run(
          `INSERT INTO scrobbles
           (uri,cid,did,rkey,revision,artist,track,album,listened_at,created_at,indexed_at,artist_key,track_key,album_key)
           VALUES(?,?,?,?,'2222222222222','Artist','Track',NULL,?,?,?,'artist-key','track-key',NULL)`,
          row.uri,
          row.cid,
          DID,
          row.uri.slice(row.uri.lastIndexOf('/') + 1),
          storedListenedAt,
          storedListenedAt,
          storedNow,
        );
    });
    let survivorReads = 0;
    const traced: Db = {
      all<T>(sql: string, ...params: SqlParam[]) {
        if (sql.includes('SELECT s.uri FROM scrobbles s')) survivorReads++;
        return db.all<T>(sql, ...params);
      },
      one: db.one.bind(db),
      run: db.run.bind(db),
      tx: db.tx.bind(db),
    };
    expect(
      executeListenRemovals(traced, {
        did: DID,
        rows,
        authRev: REV,
        now: NOW,
        identity: (row) => projectionListenKey(DID, row.listened_at, row.artist_key, row.track_key),
        tombstoneIdentity: (row) => `live:${row.uri}:${row.cid}`,
      }),
    ).toBe(1);
    expect(survivorReads).toBe(1);
    expect(db.one("SELECT count(*) n FROM linked_pull_tombstones WHERE kind='listen'")).toEqual({ n: 10_000 });
    expect(db.one('SELECT count(*) n FROM listenbrainz_deletes')).toEqual({ n: 1 });
  });
});

// A2 live-removal growth and query-bound evidence. Large rows are seeded with
// SQL here so worker-node keeps its default 5 s timeout (ADR 0005 §15.1).

import { trackKey } from '@atmusic/core/music-key';
import { BATCH_MAX_LISTENS } from '@atmusic/core/scrobble-batch';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../src/credentials/accounts';
import { ensureAccount } from '../../src/credentials/accounts';
import type { Db, SqlParam } from '../../src/do/db';
import { LIVE_EVIDENCE_TTL_MS } from '../../src/do/ingest/live-evidence';
import {
  AUTHORIZATION_EVENT_HEAD_SQL,
  AUTHORIZATION_EVENT_HEAD_URI_SQL,
  AUTHORIZATION_PAGE_SQL,
  authorizePendingRemovals,
  CONFLICT_RETENTION_SCAN_SQL,
  executeAuthorizedRemovals,
} from '../../src/do/ingest/live-pending-removals';
import { enqueueListenDelete, hasCanonicalListenSurvivor } from '../../src/forward/delete-enqueue';
import { executeListenRemovals, type LiveRemovedListen } from '../../src/forward/live-removal-effects';
import { projectionListenKey } from '../../src/forward/projection';
import { enqueueForwards } from '../../src/outbox/forward-enqueue';
import { tombstoneListen } from '../../src/sync/tombstones';
import { withMigratedDb } from '../node/support/node-db';
import { ALICE as DID, scrobble, seedUser } from '../write/support';

const URI = `at://${DID}/com.example.atmusic.scrobbleBatch/large`;
const NOW = Date.parse('2026-01-15T12:00:00Z');
const NOW_MS = NOW;
const REV = '3333333333333';
const LISTENED_AT = '2026-01-15T11:00:00Z';
const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(DID, record.listenedAt as string, artistKey, musicTrackKey);
const random = seededRandom(4901);
const uri = (key: string) => `at://${DID}/com.example.atmusic.scrobble/${key}`;

function seedLink(db: Db): void {
  seedUser(db, DID);
  linkAccount(db);
}

function linkAccount(db: Db): void {
  const accountDeps: Pick<CredentialDeps, 'db' | 'clock'> = { db, clock: { nowMs: () => NOW } };
  ensureAccount(accountDeps, { did: DID, verifiedHandle: null });
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
     VALUES('replacement-link',?,'listenbrainz','bench',X'00','fixture',?,?)`,
    DID,
    NOW,
    NOW,
  );
}

function delivered(db: Db): void {
  enqueueForwards(db, {
    did: DID,
    items: [{ kind: 'scrobble', listenKey: identity, payload: { listen: record } }],
    now: NOW,
    random: seededRandom(
      620 +
        db.one<{ generation: number }>("SELECT generation FROM linked_accounts WHERE id='replacement-link'")!
          .generation,
    ),
  });
  db.run("UPDATE forward_outbox SET state='sent'");
}

function setup(db: Db): void {
  linkAccount(db);
  enqueueForwards(db, {
    did: DID,
    items: [
      {
        kind: 'scrobble',
        listenKey: projectionListenKey(DID, LISTENED_AT, 'artist-key', 'track-key'),
        payload: {},
      },
    ],
    now: NOW,
    random,
  });
  db.run("UPDATE forward_outbox SET state='sent' WHERE link_id='replacement-link' AND kind='scrobble'");
}

const deletion = {
  did: DID,
  identityKey: identity,
  eventKey: 'same-event',
  listenedAt: second,
  artistKey,
  trackKey: musicTrackKey,
  artist: 'Björk',
  track: 'Jóga',
  sourcePath: 'live',
  now: NOW,
};

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

it('fresh: production SQL bounds equal-hi tail seeks, event readiness, and retained-conflict cleanup', async () => {
  await withMigratedDb(async (db) => {
    const pendingUri = 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/a2-sql';
    const hi = 'zzzzzzzzzzzzz';
    for (let i = 0; i < 10_000; i++) {
      const lo = String(i).padStart(13, '0');
      db.run(
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
         VALUES(?,?,'old','scrobble',?,?, '',?,1,'a','t','A','T',NULL,1,?)`,
        pendingUri,
        `member-${lo}`,
        lo,
        hi,
        `key-${lo}`,
        NOW_MS + 10_000_000,
      );
    }
    let pageVisits = 0;
    db.raw.function('a2_page_visit', () => {
      pageVisits++;
      return 1;
    });
    const pageSql = AUTHORIZATION_PAGE_SQL.replace('WHERE uri=?', 'WHERE uri=? AND a2_page_visit()=1');
    const page = db.all(pageSql, pendingUri, hi, '0000000009871', '', 'scrobble', 'member-0000000009871', 'old', 128);
    expect(page).toHaveLength(128);
    expect(pageVisits).toBe(129);
    const pagePlan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${AUTHORIZATION_PAGE_SQL}`,
        pendingUri,
        hi,
        '0000000009871',
        '',
        'scrobble',
        'member-0000000009871',
        'old',
        128,
      )
      .map((row: { detail: string }) => row.detail)
      .join(' ');
    expect(pagePlan).toContain('live_pending_removals_page');
    expect(pagePlan).not.toContain('TEMP B-TREE');

    const uri1k = `${pendingUri}-1k`;
    for (let i = 0; i < 1_000; i++) {
      const lo = String(i).padStart(13, '0');
      db.run(
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
         VALUES(?,?,'old','scrobble',?,?, '',?,1,'a','t','A','T',NULL,1,?)`,
        uri1k,
        `member-${lo}`,
        lo,
        hi,
        `key-${lo}`,
        NOW_MS + 10_000_000,
      );
    }
    pageVisits = 0;
    const page1k = db.all(pageSql, uri1k, hi, '0000000000871', '', 'scrobble', 'member-0000000000871', 'old', 128);
    expect(page1k).toHaveLength(128);
    expect(pageVisits).toBe(129);

    for (let i = 0; i < 1_000; i++)
      db.run(
        `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,scan_complete,created_at_ms,expires_at_ms,cleanup_due_ms)
         VALUES(?,?,'update','wrong',?,?, ?,?,?)`,
        `at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/event-${i}`,
        String(i).padStart(13, '0'),
        i % 2,
        i % 2,
        i,
        NOW_MS + 10_000_000,
        NOW_MS + 10_000_000,
      );
    const eventPlan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${AUTHORIZATION_EVENT_HEAD_SQL}`)
      .map((row: { detail: string }) => row.detail)
      .join(' ');
    expect(eventPlan).toContain('live_pending_removal_events_ready_v2');
    expect(eventPlan).not.toContain('TEMP B-TREE');
    for (let i = 1_000; i < 10_000; i++)
      db.run(
        `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,scan_complete,created_at_ms,expires_at_ms,cleanup_due_ms)
         VALUES(?,?,'update','wrong',?,?, ?,?,?)`,
        `at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/event-${i}`,
        String(i).padStart(13, '0'),
        i % 2,
        i % 2,
        i,
        NOW_MS + 10_000_000,
        NOW_MS + 10_000_000,
      );
    let eventVisits = 0;
    db.raw.function('a2_event_visit', () => {
      eventVisits++;
      return 1;
    });
    const eventSql = AUTHORIZATION_EVENT_HEAD_SQL.replace(
      'WHERE scan_complete=0',
      'WHERE scan_complete=0 AND a2_event_visit()=1',
    );
    expect(db.all(eventSql)).toHaveLength(1);
    expect(eventVisits).toBe(1);

    const sameUriEvents = `${pendingUri}-same-uri-events`;
    for (let i = 0; i < 10_000; i++)
      db.run(
        `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,scan_complete,created_at_ms,expires_at_ms,cleanup_due_ms)
         VALUES(?,?,'update','x',0,0,?,?,?)`,
        sameUriEvents,
        String(i).padStart(13, '0'),
        10_000 - i,
        NOW_MS + (i % 2 ? 5_000 : 50_000),
        NOW_MS + 50_000,
      );
    eventVisits = 0;
    const uriEventSql = AUTHORIZATION_EVENT_HEAD_URI_SQL.replace(
      'WHERE uri=? AND scan_complete=0',
      'WHERE uri=? AND scan_complete=0 AND a2_event_visit()=1',
    );
    expect(db.all(uriEventSql, sameUriEvents)).toHaveLength(1);
    expect(eventVisits).toBe(1);
    const uriEventPlan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${AUTHORIZATION_EVENT_HEAD_URI_SQL}`, sameUriEvents)
      .map((row: { detail: string }) => row.detail)
      .join(' ');
    expect(uriEventPlan).toContain('live_pending_removal_events_uri_ready_order');
    expect(uriEventPlan).not.toContain('TEMP B-TREE');

    const retentionUri = `${pendingUri}-retention-page`;
    for (let i = 0; i < 10_000; i++) {
      const lo = String(i).padStart(13, '0');
      db.run(
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,artist_key,track_key,artist,track,created_at_ms,expires_at_ms)
         VALUES(?,?,'old','scrobble',?,'zzzzzzzzzzzzz','',?,'a','t','A','T',1,?)`,
        retentionUri,
        `retained-${lo}`,
        lo,
        `retained-key-${lo}`,
        NOW_MS + 10_000_000,
      );
    }
    let boundedRetentionVisits = 0;
    db.raw.function('a2_bounded_retention_visit', () => {
      boundedRetentionVisits++;
      return 1;
    });
    const boundedRetentionSql = CONFLICT_RETENTION_SCAN_SQL.replace(
      'WHERE uri=?',
      'WHERE uri=? AND a2_bounded_retention_visit()=1',
    );
    expect(db.all(boundedRetentionSql, retentionUri, '', '', '', '', '', '', 128)).toHaveLength(128);
    expect(boundedRetentionVisits).toBe(128);
    const boundedRetentionPlan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${CONFLICT_RETENTION_SCAN_SQL}`,
        retentionUri,
        '',
        '',
        '',
        '',
        '',
        '',
        128,
      )
      .map((row: { detail: string }) => row.detail)
      .join(' ');
    expect(boundedRetentionPlan).toContain('live_pending_removals_page');
    expect(boundedRetentionPlan).not.toContain('TEMP B-TREE');

    for (let i = 0; i < 10_000; i++) {
      const eventUri = `at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.scrobble/retained-${i}`;
      const rev = String(i).padStart(13, '0');
      db.run(
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
         VALUES(?,?,'old','scrobble','',?,?,?,1,'a','t','A','T',NULL,1,?)`,
        eventUri,
        eventUri,
        hi,
        '',
        `retained-${i}`,
        NOW_MS + 10_000_000,
      );
      db.run(
        `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,scan_complete,created_at_ms,expires_at_ms,cleanup_due_ms)
         VALUES(?,?,'update','wrong',1,1,?,?,?)`,
        eventUri,
        rev,
        NOW_MS - 1,
        NOW_MS - 1,
        NOW_MS - 1,
      );
    }
    let retentionVisits = 0;
    db.raw.function('a2_retention_visit', () => {
      retentionVisits++;
      return 1;
    });
    const traced: Db = {
      all(sql, ...params) {
        const instrumented =
          sql === CONFLICT_RETENTION_SCAN_SQL
            ? sql.replace('WHERE uri=?', 'WHERE uri=? AND a2_retention_visit()=1')
            : sql;
        return db.all(instrumented, ...params);
      },
      run: db.run.bind(db),
      tx: db.tx.bind(db),
      one(sql, ...params) {
        return db.one(sql, ...params);
      },
    };
    executeAuthorizedRemovals(traced, { nowMs: NOW_MS, random: seededRandom(12), limit: 1 });
    expect(retentionVisits).toBe(128);
    executeAuthorizedRemovals(traced, { nowMs: NOW_MS, random: seededRandom(12), limit: 1 });
    expect(retentionVisits).toBe(256);
    expect(
      db.one('SELECT count(*) AS n FROM live_pending_removal_events WHERE conflicted=1 AND cleanup_due_ms<=?', NOW_MS),
    ).toEqual({ n: 9_744 });
    const retentionPlan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${CONFLICT_RETENTION_SCAN_SQL}`, 'uri', '', '', '', '', '', '', 128)
      .map((row: { detail: string }) => row.detail)
      .join(' ');
    expect(retentionPlan).toContain('live_pending_removals_page');
    expect(retentionPlan).not.toContain('TEMP B-TREE');

    const queuedUri = uri('retained-effect');
    const queuedRev = '3mchjvhag2422';
    seedLink(db);
    delivered(db);
    enqueueListenDelete(db, {
      ...deletion,
      eventKey: 'retained-effect',
      authorizationUri: queuedUri,
      authorizationRev: queuedRev,
    });
    db.run('UPDATE live_pending_removal_events SET cleanup_due_ms=?', NOW_MS + 10);
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,scan_complete,created_at_ms,expires_at_ms,cleanup_due_ms)
       VALUES(?,?,'update','old',0,1,?,?,?)`,
      queuedUri,
      queuedRev,
      NOW_MS - 1,
      NOW_MS - 1,
      NOW_MS - 1,
    );
    executeAuthorizedRemovals(db, { nowMs: NOW_MS, random: seededRandom(13), limit: 1 });
    expect(
      db.one('SELECT cleanup_due_ms FROM live_pending_removal_events WHERE uri=? AND rev=?', queuedUri, queuedRev),
    ).toEqual({ cleanup_due_ms: NOW_MS + 60_000 });
    const queuedRetentionPlan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT 1 FROM listenbrainz_deletes INDEXED BY listenbrainz_deletes_authorization WHERE authorization_uri=? AND authorization_rev=? AND state='queued' LIMIT 1`,
        queuedUri,
        queuedRev,
      )
      .map((row: { detail: string }) => row.detail)
      .join(' ');
    expect(queuedRetentionPlan).toContain('listenbrainz_deletes_authorization');

    // Exercise the persisted frontier when the one intersecting window sorts after
    // a same-URI prefix. No due cleanup row may be deleted before the full scan.
    const frontierUri = uri('retention-frontier');
    db.run('UPDATE live_pending_removal_events SET cleanup_due_ms=?', NOW_MS + 10_000_000);
    for (let i = 0; i < 10_000; i++) {
      const member = String(i).padStart(13, '0');
      db.run(
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,artist_key,track_key,artist,track,created_at_ms,expires_at_ms)
         VALUES(?,?,'old','scrobble','0000000000000',?,'','frontier-'||?,'a','t','A','T',1,?)`,
        frontierUri,
        `member-${member}`,
        i === 9_999 ? 'zzzzzzzzzzzzz' : 'aaaaaaaaaaaaa',
        member,
        NOW_MS + 10_000_000,
      );
    }
    const frontierRev = 'mmmmmmmmmmmmm';
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,scan_complete,created_at_ms,expires_at_ms,cleanup_due_ms)
       VALUES(?,?,'update','conflict',1,1,?,?,?)`,
      frontierUri,
      frontierRev,
      NOW_MS - 1,
      NOW_MS - 1,
      NOW_MS,
    );
    let frontierNow = NOW_MS;
    const cleanup = () =>
      executeAuthorizedRemovals(db, { uri: frontierUri, nowMs: frontierNow, random: seededRandom(14), limit: 0 });
    cleanup();
    const firstFrontier = db.one<{ cleanup_frontier: string }>(
      'SELECT cleanup_frontier FROM live_pending_removal_events WHERE uri=? AND rev=?',
      frontierUri,
      frontierRev,
    );
    expect(JSON.parse(firstFrontier!.cleanup_frontier).cursor).toHaveLength(6);
    expect(db.one('SELECT count(*) AS n FROM live_pending_removals WHERE uri=?', frontierUri)).toEqual({ n: 10_000 });
    for (let page = 1; page < 79; page++) {
      frontierNow += 60_000;
      cleanup();
    }
    const completedPass = db.one<{ cleanup_frontier: string }>(
      'SELECT cleanup_frontier FROM live_pending_removal_events WHERE uri=? AND rev=?',
      frontierUri,
      frontierRev,
    );
    expect(JSON.parse(completedPass!.cleanup_frontier)).toMatchObject({
      cursor: ['', '', '', '', '', ''],
      hasMatch: false,
    });
    expect(
      db.one('SELECT count(*) AS n FROM live_pending_removal_events WHERE uri=? AND rev=?', frontierUri, frontierRev),
    ).toEqual({ n: 1 });
    db.run('DELETE FROM live_pending_removals WHERE uri=?', frontierUri);
    frontierNow += 60_000;
    cleanup();
    expect(
      db.one('SELECT count(*) AS n FROM live_pending_removal_events WHERE uri=? AND rev=?', frontierUri, frontierRev),
    ).toEqual({ n: 0 });
  });
});

it.each([1_000, 10_000])('bounds live-removal statements for %s duplicate canonical members', async (count) => {
  await withMigratedDb(async (db) => {
    seedUser(db, DID);
    setup(db);
    const rows: LiveRemovedListen[] = Array.from({ length: count }, (_, i) => ({
      uri: `${URI}-member-${i}`,
      cid: 'same-cid',
      listened_at: LISTENED_AT,
      artist_key: 'artist-key',
      track_key: 'track-key',
      artist: 'Artist',
      track: 'Track',
      recording_mbid: null,
    }));
    let statements = 0;
    let survivorReads = 0;
    let tombstoneWrites = 0;
    let eventWrites = 0;
    const traced: Db = {
      all<T>(sql: string, ...params: SqlParam[]) {
        statements++;
        if (sql.includes('SELECT s.uri FROM scrobbles s')) survivorReads++;
        return db.all<T>(sql, ...params);
      },
      one<T>(sql: string, ...params: SqlParam[]) {
        statements++;
        return db.one<T>(sql, ...params);
      },
      run(sql, ...params) {
        statements++;
        if (sql.includes('INSERT INTO linked_pull_tombstones')) tombstoneWrites++;
        if (sql.includes('listenbrainz_deletes')) eventWrites++;
        return db.run(sql, ...params);
      },
      tx: db.tx.bind(db),
    };
    const started = performance.now();
    expect(
      executeListenRemovals(traced, {
        did: DID,
        rows,
        authRev: '3333333333333',
        now: NOW,
        identity: (row) => projectionListenKey(DID, row.listened_at, row.artist_key, row.track_key),
        tombstoneIdentity: (row) => `live:${row.uri}:${row.cid}`,
      }),
    ).toBe(1);
    const elapsedMs = performance.now() - started;
    expect(statements).toBeLessThanOrEqual(count + 20);
    expect(survivorReads).toBe(1);
    expect(tombstoneWrites).toBe(count);
    expect(eventWrites).toBe(1);
    expect(db.one("SELECT count(*) n FROM linked_pull_tombstones WHERE kind='listen'")).toEqual({ n: count });
    expect(db.one("SELECT count(DISTINCT identity_key) n FROM linked_pull_tombstones WHERE kind='listen'")).toEqual({
      n: count,
    });
    expect(db.one('SELECT count(*) n FROM listenbrainz_deletes')).toEqual({ n: 1 });
    if (process.env.A2_PROFILE === '1')
      console.info(
        JSON.stringify({ removalMembers: count, elapsedMs, statements, survivorReads, tombstoneWrites, eventWrites }),
      );

    // Negative control: reproduce the prior per-member check → tombstone →
    // enqueue flow. The old path performs two survivor reads and three event
    // SQL statements per member even though its durable event key coalesces.
    await withMigratedDb((legacyDb) => {
      seedUser(legacyDb, DID);
      setup(legacyDb);
      let legacyStatements = 0;
      let legacySurvivorReads = 0;
      const legacyTracked: Db = {
        all<T>(sql: string, ...params: SqlParam[]) {
          legacyStatements++;
          if (sql.includes('SELECT s.uri FROM scrobbles s')) legacySurvivorReads++;
          return legacyDb.all<T>(sql, ...params);
        },
        one<T>(sql: string, ...params: SqlParam[]) {
          legacyStatements++;
          return legacyDb.one<T>(sql, ...params);
        },
        run(sql, ...params) {
          legacyStatements++;
          return legacyDb.run(sql, ...params);
        },
        tx: legacyDb.tx.bind(legacyDb),
      };
      const excluding = new Set(rows.map((row) => row.uri));
      let legacyQueued = 0;
      for (const row of rows) {
        const listenedAt = Math.floor(Date.parse(row.listened_at) / 1000);
        if (
          hasCanonicalListenSurvivor(legacyTracked, {
            did: DID,
            listenedAt,
            artistKey: row.artist_key,
            trackKey: row.track_key,
            excluding,
          })
        )
          continue;
        tombstoneListen(legacyTracked, {
          did: DID,
          identity: `live:${row.uri}:${row.cid}`,
          second: listenedAt,
          artistKey: row.artist_key,
          trackKey: row.track_key,
          nowMs: NOW,
        });
        const identityKey = projectionListenKey(DID, row.listened_at, row.artist_key, row.track_key);
        legacyQueued += enqueueListenDelete(legacyTracked, {
          did: DID,
          identityKey,
          eventKey: `${identityKey}:${row.cid}:rev:3333333333333`,
          listenedAt,
          artistKey: row.artist_key,
          trackKey: row.track_key,
          artist: row.artist,
          track: row.track,
          sourcePath: 'live',
          authorizationRev: '3333333333333',
          now: NOW,
          excluding,
        });
      }
      expect(legacyQueued).toBe(1);
      expect(legacySurvivorReads).toBe(count * 2);
      expect(legacyStatements).toBeGreaterThan(count * 5);
    });
  });
});

it('executes one complete validator-sized 10,000-member container group in linear statements', async () => {
  await withMigratedDb((db) => {
    expect(BATCH_MAX_LISTENS).toBe(10_000);
    db.tx(() => {
      for (let i = 0; i < BATCH_MAX_LISTENS; i++)
        db.run(
          `INSERT INTO live_pending_removals
           (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,
            artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
           VALUES(?,?,?,'scrobble','','2222222222222','','key-'||?,1768474800,'artist-'||?,'track-'||?,'Artist','Track','2222222222222',?,?)`,
          URI,
          `${URI}#member:${i}`,
          `cid-${i}`,
          String(i),
          String(i),
          String(i),
          NOW,
          NOW + LIVE_EVIDENCE_TTL_MS,
        );
    });
    let statements = 0;
    const traced: Db = {
      all<T>(sql: string, ...params: SqlParam[]) {
        statements++;
        return db.all<T>(sql, ...params);
      },
      one<T>(sql: string, ...params: SqlParam[]) {
        statements++;
        return db.one<T>(sql, ...params);
      },
      run(sql: string, ...params: SqlParam[]) {
        statements++;
        return db.run(sql, ...params);
      },
      tx: db.tx.bind(db),
    };
    const result = executeAuthorizedRemovals(traced, { nowMs: NOW, random, limit: 1 });
    expect(result.groups).toBe(1);
    expect(result.effects).toBe(0);
    expect(db.one('SELECT count(*) AS n FROM live_pending_removals')).toEqual({ n: 0 });
    expect(db.one("SELECT count(*) AS n FROM linked_pull_tombstones WHERE kind='listen'")).toEqual({
      n: BATCH_MAX_LISTENS,
    });
    expect(statements).toBeLessThanOrEqual(BATCH_MAX_LISTENS * 5 + 20);
  });
});

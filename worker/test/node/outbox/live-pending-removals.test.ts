import { trackKey } from '@atmusic/core/music-key';
import { BATCH_MAX_LISTENS } from '@atmusic/core/scrobble-batch';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import type { Db, SqlParam } from '../../../src/do/db';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { LIVE_EVIDENCE_TTL_MS, readLiveEvidence, recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import {
  authorizePendingRemovals,
  executeAuthorizedRemovals,
  type PendingRemovalInput,
  recordPendingRemoval,
} from '../../../src/do/ingest/live-pending-removals';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { executeListenRemovals } from '../../../src/forward/live-removal-effects';
import {
  admitForwardIdentity,
  cleanupForwardAdmissionsForSuppression,
  projectionListenKey,
} from '../../../src/forward/projection';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import {
  ALICE as DID,
  deleteProof,
  fixtureScrobble,
  NOW_MS,
  NOW_NS,
  OPTS,
  PREFIX,
  putProof,
  repoFor,
  SCROBBLE,
  seedUser,
} from '../../write/support';
import { withMigratedDb } from '../support/node-db';

const URI = `at://${DID}/com.example.atmusic.scrobble/r1`;
const NOW = NOW_MS;
const LISTENED_AT = '2026-01-15T11:00:00Z';
const random = seededRandom(4901);

it('removes the projection before the delete event, then runs one delayed deletion from the coalesced sweep', async () => {
  const repo = await repoFor('alice');
  const record = await putProof(repo, SCROBBLE, 'pending-d1', fixtureScrobble('r02'));
  if (record.state !== 'present') throw new Error('expected present scrobble proof');
  const absent = await deleteProof(repo, SCROBBLE, 'pending-d1');
  const uri = `at://${DID}/${SCROBBLE}/pending-d1`;
  await withMigratedDb((db) => {
    seedUser(db, DID);
    db.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
       VALUES('pending-link',?,'listenbrainz','remote',X'00','fixture',?,?)`,
      DID,
      NOW,
      NOW,
    );
    db.tx(() =>
      recordLiveEvidence(
        db,
        {
          uri,
          did: DID,
          collection: SCROBBLE,
          rkey: 'pending-d1',
          rev: record.commit.rev,
          action: 'create',
          cid: record.cid,
        },
        NOW,
      ),
    );
    const live = { random, evidence: readLiveEvidence(db, uri, NOW), legacyRev: null };
    db.tx(() => applyRecordProof(db, record, { ...OPTS, prefix: PREFIX, live }));
    const removedProjection = db.one<{
      uri: string;
      cid: string;
      listened_at: string;
      artist_key: string;
      track_key: string;
      artist: string;
      track: string;
      recording_mbid: string | null;
    }>('SELECT uri,cid,listened_at,artist_key,track_key,artist,track,recording_mbid FROM scrobbles WHERE uri=?', uri)!;
    db.run("UPDATE forward_outbox SET state='sent' WHERE did=? AND kind='scrobble'", DID);
    expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='scrobble' AND state='sent'")).toEqual({ n: 1 });

    db.tx(() =>
      applyRecordProof(db, absent, {
        ...OPTS,
        nowNs: NOW_NS + 1_000_000_000n,
        live,
      }),
    );
    expect(db.one('SELECT count(*) AS n FROM scrobbles WHERE uri=?', uri)).toEqual({ n: 0 });
    expect(db.one('SELECT count(*) AS n FROM live_pending_removals')).toEqual({ n: 1 });
    expect(db.one('SELECT count(*) AS n FROM listenbrainz_deletes')).toEqual({ n: 0 });

    enqueueHints(db, [
      {
        did: DID,
        collection: SCROBBLE,
        rkey: 'pending-d1',
        source: 'jetstream',
        hintRev: absent.commit.rev,
        live: { operation: 'delete' },
        receiptMs: NOW + 2_000,
      },
    ]);
    enqueueHints(
      db,
      Array.from({ length: 30 }, () => ({
        did: DID,
        collection: SCROBBLE,
        rkey: 'pending-d1',
        source: 'notify' as const,
        receiptMs: NOW + 2_001,
      })),
    );
    expect(db.one('SELECT count(*) AS n FROM hints WHERE uri=?', uri)).toEqual({ n: 1 });
    expect(db.one<{ authorized_rev: string }>('SELECT authorized_rev FROM live_pending_removals')).toEqual({
      authorized_rev: absent.commit.rev,
    });
    executeAuthorizedRemovals(db, { nowMs: NOW + 2_000, random, limit: 1 });
    executeAuthorizedRemovals(db, { nowMs: NOW + 2_000, random, limit: 1 });
    executeListenRemovals(db, {
      did: DID,
      rows: [removedProjection],
      authRev: absent.commit.rev,
      now: NOW + 2_000,
      identity: (row) => projectionListenKey(DID, row.listened_at, row.artist_key, row.track_key),
      tombstoneIdentity: (row) => `live:${row.uri}:${row.cid}`,
    });
    expect(db.one('SELECT count(*) AS n FROM listenbrainz_deletes')).toEqual({ n: 1 });
    expect(db.one('SELECT count(*) AS n FROM live_pending_removals')).toEqual({ n: 0 });
  });
});

it('keeps a surviving canonical copy and expires an unapproved window without forwarding', async () => {
  await withMigratedDb((db) => {
    seedUser(db, DID);
    setup(db);
    const row = pending('1111111111111', '2222222222222');
    recordPendingRemoval(db, row);
    db.run(
      `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,album,listened_at,created_at,indexed_at,
       artist_key,track_key,album_key)
       VALUES(?,? ,?,'copy','2222222222222','Artist','Track',NULL,?,?,?,'artist-key','track-key',NULL)`,
      `${URI.split('/').slice(0, -1).join('/')}/canonical-copy`,
      'other-cid',
      DID,
      toStorage(fromMs(Date.parse(LISTENED_AT))),
      toStorage(fromMs(Date.parse(LISTENED_AT))),
      toStorage(fromMs(NOW)),
    );
    authorizePendingRemovals(db, { uri: URI, rev: '2222222222222', action: 'delete' }, NOW);
    executeAuthorizedRemovals(db, { uri: URI, nowMs: NOW, random, limit: 1 });
    expect(db.all('SELECT * FROM listenbrainz_deletes')).toHaveLength(0);
    expect(db.all("SELECT * FROM linked_pull_tombstones WHERE kind='listen'")).toHaveLength(0);

    recordPendingRemoval(db, pending('3333333333333', '4444444444444'));
    executeAuthorizedRemovals(db, { uri: URI, nowMs: NOW + LIVE_EVIDENCE_TTL_MS + 1, random, limit: 1 });
    expect(db.all('SELECT * FROM live_pending_removals')).toHaveLength(0);
    expect(db.one("SELECT value FROM counters WHERE name='live_admission' AND label='pending_expired'")).toEqual({
      value: 1,
    });
    expect(db.all('SELECT * FROM listenbrainz_deletes')).toHaveLength(0);
  });
});

it('delays love removal while preserving import exclusions, local re-love, and newer API intent', async () => {
  await withMigratedDb((db) => {
    seedUser(db, DID);
    for (const [id, service] of [
      ['love-lb', 'listenbrainz'],
      ['love-lfm', 'lastfm'],
    ] as const)
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
         VALUES(?,?,?,'remote',X'00','fixture',?,?)`,
        id,
        DID,
        service,
        NOW,
        NOW,
      );
    const cases = [
      { rkey: 'imported', artist: 'Imported Artist', track: 'Imported Track', sources: ['listenbrainz'] },
      { rkey: 'reloved', artist: 'Local Relove', track: 'Track', sources: [] },
      { rkey: 'api-intent', artist: 'API Intent', track: 'Track', sources: [] },
    ];
    for (const item of cases) {
      const uri = `at://${DID}/com.example.atmusic.love/${item.rkey}`;
      const identityKey = `love:${uri}:incarnation`;
      if (item.rkey === 'imported')
        admitForwardIdentity(db, {
          did: DID,
          identityKey: `love-delete:${identityKey}`,
          path: 'snapshot',
          now: NOW,
        });
      recordPendingRemoval(db, {
        did: DID,
        uri,
        kind: 'love',
        row: {
          uri,
          record_uri: null,
          listen_id: null,
          cid: 'love-cid',
          listened_at: '',
          artist_key: 'artist-key',
          track_key: 'track-key',
          artist: item.artist,
          track: item.track,
          recording_mbid: null,
        },
        identityKey,
        windowLo: '1111111111111',
        windowHi: '2222222222222',
        replacedByCid: null,
        loveSourceService: item.rkey === 'imported' ? 'listenbrainz' : null,
        loveImportSources: item.sources,
        nowMs: NOW,
      });
      authorizePendingRemovals(db, { uri, rev: '2222222222222', action: 'delete' }, NOW);
    }
    const [localKey, localTrackKey] = trackKey('Local Relove', 'Track');
    db.run(
      `INSERT INTO linked_love_intents(did,love_key,intent,operation_id,updated_at_ms) VALUES(?,?,'love','relove-op',?)`,
      DID,
      `${localKey}\u0000${localTrackKey}`,
      NOW,
    );
    db.run(
      `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,record_json,digest,due_at,created_at_ms,updated_at_ms)
       VALUES('love-put-op',?,'love.put','web',1,'com.example.atmusic.love','api-intent',?, 'digest',?,?,?)`,
      DID,
      JSON.stringify({ artist: 'API Intent', track: 'Track' }),
      NOW,
      NOW,
      NOW,
    );
    executeAuthorizedRemovals(db, { nowMs: NOW, random, limit: 3 });
    expect(db.all('SELECT link_id,kind FROM forward_outbox')).toEqual([{ link_id: 'love-lfm', kind: 'unlove' }]);
    expect(
      db.one(
        'SELECT path FROM forward_admissions WHERE did=? AND identity_key=?',
        DID,
        'love-delete:love:at://'.concat(DID, '/com.example.atmusic.love/imported:incarnation'),
      ),
    ).toEqual({ path: 'live' });
    expect(db.all("SELECT identity_key FROM linked_pull_tombstones WHERE kind='love'")).toHaveLength(1);
    expect(db.all('SELECT * FROM live_pending_removals')).toHaveLength(0);
  });
});

function pending(windowLo: string, windowHi: string, cid = 'same-cid'): PendingRemovalInput {
  const artistKey = 'artist-key';
  const trackKey = 'track-key';
  return {
    did: DID,
    uri: URI,
    kind: 'scrobble',
    row: {
      uri: URI,
      record_uri: null,
      listen_id: null,
      cid,
      listened_at: LISTENED_AT,
      artist_key: artistKey,
      track_key: trackKey,
      artist: 'Artist',
      track: 'Track',
      recording_mbid: null,
    },
    identityKey: projectionListenKey(DID, LISTENED_AT, artistKey, trackKey),
    windowLo,
    windowHi,
    replacedByCid: null,
    nowMs: NOW,
  };
}

function setup(db: Db): void {
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
     VALUES('pending-link',?,'listenbrainz','remote',X'00','fixture',?,?)`,
    DID,
    NOW,
    NOW,
  );
  const identity = projectionListenKey(DID, LISTENED_AT, 'artist-key', 'track-key');
  enqueueForwards(db, {
    did: DID,
    items: [{ kind: 'scrobble', listenKey: identity, payload: {} }],
    now: NOW,
    random,
  });
  db.run("UPDATE forward_outbox SET state='sent' WHERE link_id='pending-link' AND kind='scrobble'");
}

it('keeps repeated same-CID removal windows distinct and only authorizes the matching delete revision', async () => {
  await withMigratedDb((db) => {
    setup(db);
    const first = pending('1111111111111', '2222222222222');
    const second = pending('3333333333333', '4444444444444');
    recordPendingRemoval(db, first);
    recordPendingRemoval(db, { ...first, windowHi: '2222222222222', nowMs: NOW + 1 }); // exact restore replay
    recordPendingRemoval(db, second);
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM live_pending_removals')?.n).toBe(2);

    expect(authorizePendingRemovals(db, { uri: URI, rev: '3333333333333', action: 'delete' }, NOW)).toBe(0);
    expect(authorizePendingRemovals(db, { uri: URI, rev: '2222222222222', action: 'delete' }, NOW)).toBe(1);
    expect(executeAuthorizedRemovals(db, { uri: URI, nowMs: NOW, random, limit: 1 }).groups).toBe(1);
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM listenbrainz_deletes')?.n).toBe(1);
    expect(db.all('SELECT window_lo,window_hi,authorized_rev FROM live_pending_removals')).toEqual([
      { window_lo: '3333333333333', window_hi: '4444444444444', authorized_rev: null },
    ]);

    expect(authorizePendingRemovals(db, { uri: URI, rev: '4444444444444', action: 'delete' }, NOW)).toBe(1);
    executeAuthorizedRemovals(db, { uri: URI, nowMs: NOW, random, limit: 1 });
    executeAuthorizedRemovals(db, { uri: URI, nowMs: NOW, random, limit: 1 });
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM listenbrainz_deletes')?.n).toBe(2);
    expect(db.all('SELECT * FROM live_pending_removals')).toHaveLength(0);
  });
});

it('requires the matching replacement CID or an in-window real delete, and rechecks conflicts before effects', async () => {
  await withMigratedDb((db) => {
    setup(db);
    const row = pending('1111111111111', '2222222222222');
    row.replacedByCid = 'replacement-cid';
    recordPendingRemoval(db, row);
    expect(authorizePendingRemovals(db, { uri: URI, rev: '2222222222222', action: 'update', cid: 'wrong' }, NOW)).toBe(
      0,
    );
    expect(
      authorizePendingRemovals(db, { uri: URI, rev: '2222222222222', action: 'update', cid: 'replacement-cid' }, NOW),
    ).toBe(1);
    db.run(
      `INSERT INTO live_record_evidence(uri,did,collection,rkey,up_rev,up_action,up_cid,del_rev,conflict_rev,received_ms,expires_at_ms)
       VALUES(?,?,?,'r1',NULL,NULL,NULL,?, ?,?,?)`,
      URI,
      DID,
      'com.example.atmusic.scrobble',
      '2222222222222',
      '2222222222222',
      NOW,
      NOW + 1_000,
    );
    executeAuthorizedRemovals(db, { uri: URI, nowMs: NOW, random, limit: 1 });
    expect(db.all('SELECT * FROM listenbrainz_deletes')).toHaveLength(0);
    expect(db.one('SELECT authorized_rev,conflicted_auth_rev FROM live_pending_removals')).toEqual({
      authorized_rev: null,
      conflicted_auth_rev: '2222222222222',
    });
  });
});

it('uses indexed pending eligibility and expiry access paths', async () => {
  await withMigratedDb((db) => {
    const checkPlans = () => {
      const global = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT uri,kind,window_lo,window_hi,replaced_by_cid,authorized_rev
         FROM live_pending_removals INDEXED BY live_pending_removals_ready
         WHERE authorized_rev IS NOT NULL AND expires_at_ms>?
         ORDER BY authorized_rev,created_at_ms,uri,window_hi LIMIT 1`,
        NOW,
      );
      const byUri = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT uri,kind,window_lo,window_hi,replaced_by_cid,authorized_rev
         FROM live_pending_removals INDEXED BY live_pending_removals_uri_ready
         WHERE uri=? AND authorized_rev IS NOT NULL AND expires_at_ms>?
         ORDER BY authorized_rev,created_at_ms,uri,window_hi LIMIT 1`,
        URI,
        NOW,
      );
      const group = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT * FROM live_pending_removals INDEXED BY live_pending_removals_group
         WHERE uri=? AND kind=? AND window_lo=? AND window_hi=? AND replaced_by_cid=? AND authorized_rev=? AND expires_at_ms>?`,
        URI,
        'scrobble',
        '1111111111111',
        '2222222222222',
        '',
        '2222222222222',
        NOW,
      );
      const authorization = db.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT kind,window_lo,window_hi,replaced_by_cid,authorized_rev,expires_at_ms
         FROM live_pending_removals INDEXED BY live_pending_removals_authorize
         WHERE uri=? AND window_hi>=? ORDER BY window_hi,window_lo DESC LIMIT 1`,
        URI,
        '2222222222222',
      );
      const details = [global, byUri, group, authorization].map((rows) => rows.map((row) => row.detail).join(' '));
      expect(details[0]).toContain('live_pending_removals_ready');
      expect(details[1]).toContain('live_pending_removals_uri_ready');
      expect(details[2]).toContain('live_pending_removals_group');
      expect(details[3]).toContain('live_pending_removals_authorize');
      expect(details.join(' ')).not.toMatch(/SCAN live_pending_removals\b/);
    };
    const addWindows = (from: number, to: number) =>
      db.tx(() => {
        for (let i = from; i < to; i++) {
          const lo = String(i * 2 + 1).padStart(13, '0');
          const hi = String(i * 2 + 2).padStart(13, '0');
          db.run(
            `INSERT INTO live_pending_removals
             (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,
              artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
             VALUES(?,?,?,'scrobble',?,?,'','key',1,'artist-key','track-key','Artist','Track',NULL,1,?)`,
            URI,
            `${URI}#${i}`,
            `cid-${i}`,
            lo,
            hi,
            NOW + 60_000,
          );
        }
      });
    addWindows(0, 1_000);
    checkPlans();
    addWindows(1_000, 10_000);
    checkPlans();
    expect(db.one<{ n: number }>('SELECT count(*) AS n FROM live_pending_removals WHERE uri=?', URI)?.n).toBe(10_000);
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

it('DID suppression cleanup removes only that DID’s pending authorization and event cursor', async () => {
  await withMigratedDb((db) => {
    seedUser(db, DID);
    const otherDid = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
    seedUser(db, otherDid);
    setup(db);
    const otherUri = `at://${otherDid}/com.example.atmusic.scrobble/r2`;
    const row = pending('1111111111111', '2222222222222');
    recordPendingRemoval(db, row);
    authorizePendingRemovals(db, { uri: URI, rev: '2222222222222', action: 'delete' }, NOW);
    authorizePendingRemovals(db, { uri: otherUri, rev: '2222222222222', action: 'delete' }, NOW);
    db.run(
      `INSERT INTO live_pending_removal_reconcile(uri,window_lo,window_hi,replaced_by_cid,cursor_rev,next_due_ms,created_at_ms)
       VALUES(?, '1111111111111','2222222222222','', '1111111111111',?,?)`,
      otherUri,
      NOW,
      NOW,
    );

    cleanupForwardAdmissionsForSuppression(db, DID);

    expect(
      db.one('SELECT count(*) AS n FROM live_pending_removals WHERE uri>=? AND uri<?', `at://${DID}/`, `at://${DID}0`),
    ).toEqual({ n: 0 });
    expect(
      db.one(
        'SELECT count(*) AS n FROM live_pending_removal_events WHERE uri>=? AND uri<?',
        `at://${DID}/`,
        `at://${DID}0`,
      ),
    ).toEqual({ n: 0 });
    expect(db.one('SELECT count(*) AS n FROM live_pending_removal_events WHERE uri=?', otherUri)).toEqual({ n: 1 });
    expect(
      db.one(
        'SELECT count(*) AS n FROM live_pending_removal_reconcile WHERE uri>=? AND uri<?',
        `at://${DID}/`,
        `at://${DID}0`,
      ),
    ).toEqual({ n: 0 });
    expect(db.one('SELECT count(*) AS n FROM live_pending_removal_reconcile WHERE uri=?', otherUri)).toEqual({ n: 1 });
  });
});

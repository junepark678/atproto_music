import type { Clock } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import { seededRandom } from '@atmusic/core/test-support/random';
import { expect, it } from 'vitest';
import type { CredentialDeps } from '../../../src/credentials/accounts';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Box } from '../../../src/crypto/box';
import type { Db } from '../../../src/do/db';
import { enqueueHints } from '../../../src/do/ingest/hints';
import { LIVE_EVIDENCE_TTL_MS } from '../../../src/do/ingest/live-evidence';
import {
  AUTHORIZATION_EVENT_HEAD_SQL,
  AUTHORIZATION_EVENT_HEAD_URI_SQL,
  AUTHORIZATION_PAGE_SQL,
  authorizePendingRemovals,
  CONFLICT_RETENTION_SCAN_SQL,
  executeAuthorizedRemovals,
  type PendingListen,
  recordPendingRemoval,
} from '../../../src/do/ingest/live-pending-removals';
import { armAlarm } from '../../../src/do/timers';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { enqueueListenDelete } from '../../../src/forward/delete-enqueue';
import type { DeleteForwardDeps } from '../../../src/forward/delete-forwarder';
import { runDeleteSlice } from '../../../src/forward/delete-forwarder';
import type { ListenbrainzClient } from '../../../src/forward/listenbrainz-client';
import { projectionListenKey } from '../../../src/forward/projection';
import { UpstreamPacing } from '../../../src/forward/upstream-pacing';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { closeHarnesses, control, harness, resetControl } from '../../composition/support';
import {
  ALICE,
  authorizedLiveOptions,
  deleteProof,
  NOW_MS,
  OPTS,
  putProof,
  repoFor,
  SCROBBLE,
  scrobble,
  seedUser,
} from '../../write/support';
import { reopen, withMigratedDb } from '../support/node-db';

const record = scrobble({ artist: 'Björk', track: 'Jóga' });
const second = Date.parse(record.listenedAt as string) / 1000;
const [artistKey, musicTrackKey] = trackKey('Björk', 'Jóga');
const identity = projectionListenKey(ALICE, record.listenedAt as string, artistKey, musicTrackKey);
const live = (db: Db, proof: Awaited<ReturnType<typeof putProof>>) => authorizedLiveOptions(db, proof, rng);
const cidOf = (proof: Awaited<ReturnType<typeof putProof>>) => {
  if (proof.state !== 'present') throw new Error('expected present proof');
  return proof.cid;
};
function seedLink(db: Db) {
  seedUser(db, ALICE);
  const accountDeps: Pick<CredentialDeps, 'db' | 'clock'> = { db, clock: { nowMs: () => NOW_MS } };
  ensureAccount(accountDeps, { did: ALICE, verifiedHandle: null });
  db.run(
    `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
    VALUES ('replacement-link',?,'listenbrainz','alice',X'00','fixture',?,?)`,
    ALICE,
    NOW_MS,
    NOW_MS,
  );
}
function delivered(db: Db) {
  enqueueForwards(db, {
    did: ALICE,
    items: [{ kind: 'scrobble', listenKey: identity, payload: { listen: record } }],
    now: NOW_MS,
    random: seededRandom(
      620 +
        db.one<{ generation: number }>("SELECT generation FROM linked_accounts WHERE id='replacement-link'")!
          .generation,
    ),
  });
  db.run("UPDATE forward_outbox SET state='sent'");
}
const deletion = {
  did: ALICE,
  identityKey: identity,
  eventKey: 'same-event',
  listenedAt: second,
  artistKey,
  trackKey: musicTrackKey,
  artist: 'Björk',
  track: 'Jóga',
  sourcePath: 'live',
  now: NOW_MS,
};

const uri = (key: string) => `at://${ALICE}/${SCROBBLE}/${key}`;
async function drain(db: Db) {
  let now = NOW_MS,
    deletes = 0,
    lookups = 0;
  const clock = { nowMs: () => now };
  const deps: DeleteForwardDeps = {
    db,
    clock,
    random: seededRandom(9),
    box: { openText: () => 'fixture' } as unknown as Box,
    pacing: new UpstreamPacing(clock as Clock),
    client: {
      listWindowPage: async () => {
        lookups++;
        return {
          ok: true,
          rate: { remaining: 100, resetInS: 0 },
          value: [{ listenedAt: second, artist: 'Björk', track: 'Jóga', recordingMsid: 'fixture-msid' }],
        };
      },
      deleteListen: async () => {
        deletes++;
        return { ok: true, accepted: true, rate: { remaining: 100, resetInS: 0 } };
      },
    } as unknown as ListenbrainzClient,
  };
  for (let i = 0; i < 12; i++) {
    await runDeleteSlice(deps);
    now += 1000;
  }
  return { deletes, lookups };
}

const rng = seededRandom(888);
const sweep = (db: Db, nowMs = NOW_MS) => db.tx(() => executeAuthorizedRemovals(db, { nowMs, random: rng, limit: 10 }));

it('fresh: late same-revision replacement conflict survives newer up evidence', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const changed = await putProof(repo, SCROBBLE, 'a', scrobble({ artist: 'Other', track: 'Replacement' }));
  const newer = await putProof(repo, SCROBBLE, 'a', scrobble({ artist: 'Other', track: 'Newest' }));
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    db.tx(() => applyRecordProof(db, changed, OPTS));
    for (const [rev, cid] of [
      [changed.commit.rev, cidOf(changed)],
      [newer.commit.rev, cidOf(newer)],
      [changed.commit.rev, cidOf(first)],
    ])
      enqueueHints(db, [
        {
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'a',
          source: 'jetstream',
          hintRev: rev,
          live: { operation: 'update', cid },
          receiptMs: NOW_MS,
        },
      ]);
    sweep(db);
    expect((await drain(db)).deletes).toBe(0);
  });
});
it('fresh: insertion behind completed cursors finds later matching retained event', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const middle = await putProof(repo, SCROBBLE, 'a', scrobble({ artist: 'Other', track: 'Middle' }));
  const last = await putProof(repo, SCROBBLE, 'a', scrobble({ artist: 'Other', track: 'Last' }));
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    const row = db.one<PendingListen>('SELECT * FROM scrobbles')!;
    for (const p of [middle, last])
      enqueueHints(db, [
        {
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'a',
          source: 'jetstream',
          hintRev: p.commit.rev,
          live: { operation: 'update', cid: cidOf(p) },
          receiptMs: NOW_MS,
        },
      ]);
    recordPendingRemoval(db, {
      did: ALICE,
      uri: uri('a'),
      kind: 'scrobble',
      row,
      identityKey: identity,
      windowLo: first.commit.rev,
      windowHi: last.commit.rev,
      replacedByCid: cidOf(last),
      nowMs: NOW_MS,
    });
    for (let i = 0; i < 3; i++) sweep(db);
    expect(db.one('SELECT authorized_rev FROM live_pending_removals')).not.toEqual({ authorized_rev: null });
  });
});
it('fresh: unrelated conflict must not veto a later valid deletion in the same window', async () => {
  const repo = await repoFor('alice');
  const first = await putProof(repo, SCROBBLE, 'a', record);
  const middle = await putProof(repo, SCROBBLE, 'a', scrobble({ artist: 'Other', track: 'Middle' }));
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  await withMigratedDb(async (db) => {
    seedLink(db);
    db.tx(() => applyRecordProof(db, first, live(db, first)));
    delivered(db);
    db.tx(() => applyRecordProof(db, gone, OPTS));
    for (const [rev, operation, cid] of [
      [middle.commit.rev, 'update', cidOf(middle)],
      [middle.commit.rev, 'update', cidOf(first)],
      [gone.commit.rev, 'delete', undefined],
    ] as const)
      enqueueHints(db, [
        {
          did: ALICE,
          collection: SCROBBLE,
          rkey: 'a',
          source: 'jetstream',
          hintRev: rev,
          live: { operation, cid },
          receiptMs: NOW_MS,
        },
      ]);
    sweep(db);
    expect((await drain(db)).deletes).toBe(1);
  });
});

it('fresh: a late same-revision conflict blocks a previously queued remote delete at dispatch', async () => {
  const repo = await repoFor('alice');
  const gone = await deleteProof(repo, SCROBBLE, 'a');
  await withMigratedDb(async (db, context) => {
    seedLink(db);
    const row = {
      uri: uri('a'),
      record_uri: null,
      listen_id: null,
      cid: 'old',
      listened_at: record.listenedAt as string,
      artist_key: artistKey,
      track_key: musicTrackKey,
      artist: 'Björk',
      track: 'Jóga',
      recording_mbid: null,
    };
    delivered(db);
    recordPendingRemoval(db, {
      did: ALICE,
      uri: uri('a'),
      kind: 'scrobble',
      row,
      identityKey: identity,
      windowLo: '',
      windowHi: gone.commit.rev,
      replacedByCid: null,
      nowMs: NOW_MS,
    });
    authorizePendingRemovals(db, { uri: uri('a'), rev: gone.commit.rev, action: 'delete' }, NOW_MS);
    sweep(db);
    expect(db.one('SELECT authorization_uri,authorization_rev,state FROM listenbrainz_deletes')).toEqual({
      authorization_uri: uri('a'),
      authorization_rev: gone.commit.rev,
      state: 'queued',
    });

    authorizePendingRemovals(
      db,
      {
        uri: uri('a'),
        rev: gone.commit.rev,
        action: 'update',
        cid: 'late-conflicting-cid',
      },
      NOW_MS + 1,
    );
    const reopened = reopen(db);
    context.current = reopened;
    expect((await drain(reopened)).deletes).toBe(0);
    expect(reopened.one('SELECT state,last_error FROM listenbrainz_deletes')).toEqual({
      state: 'ignored',
      last_error: 'authorization_conflicted',
    });
  });
});

import { drain as drainIngest } from '../../../src/do/ingest/verify-drain';
import { depsFor, kit } from '../../ingest/drain-support';

it('fresh: no-hint drain retains wakeup for unfinished authorization pages', async () => {
  const k = await kit();
  await withMigratedDb(async (db) => {
    seedLink(db);
    const row = {
      uri: uri('a'),
      record_uri: null,
      listen_id: null,
      cid: 'old',
      listened_at: record.listenedAt as string,
      artist_key: artistKey,
      track_key: musicTrackKey,
      artist: 'Björk',
      track: 'Jóga',
      recording_mbid: null,
    };
    for (let i = 0; i < 1000; i++)
      recordPendingRemoval(db, {
        did: ALICE,
        uri: uri('a'),
        kind: 'scrobble',
        row,
        identityKey: identity,
        windowLo: String(i).padStart(13, '0'),
        windowHi: 'zzzzzzzzzzzzz',
        replacedByCid: i === 999 ? 'match' : 'wrong',
        nowMs: NOW_MS,
      });
    authorizePendingRemovals(db, { uri: uri('a'), rev: '3mchjvhag2322', action: 'update', cid: 'match' }, NOW_MS);
    await drainIngest(depsFor(db, k), NOW_MS);
    expect(db.one('SELECT scan_complete FROM live_pending_removal_events')).toEqual({ scan_complete: 0 });
    expect(db.one("SELECT due_at FROM timers WHERE name='drain'")).not.toBeNull();
  });
});

it('fresh: timer-driven no-hint drains finish 1k and 10k authorization tails', async () => {
  for (const size of [1_000, 10_000]) {
    resetControl();
    const h = await harness(`a2-removal-tail-${size}`);
    try {
      const db = h.db;
      const eventUri = uri(`timer-tail-${size}`);
      const lastLo = String(size - 1).padStart(13, '0');
      for (let i = 0; i < size; i++) {
        const lo = String(i).padStart(13, '0');
        db.run(
          `INSERT INTO live_pending_removals
           (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,
            artist_key,track_key,artist,track,recording_mbid,authorized_rev,created_at_ms,expires_at_ms)
           VALUES(?,?,'old','scrobble',?,?,?, ?,1,'artist','track','Artist','Track',NULL,NULL,?,?)`,
          eventUri,
          `member-${lo}`,
          lo,
          'zzzzzzzzzzzzz',
          i === size - 1 ? 'matching' : 'wrong',
          `identity-${lo}`,
          control.clock.nowMs(),
          control.clock.nowMs() + LIVE_EVIDENCE_TTL_MS,
        );
      }
      const eventRev = '3mchjvhag2322';
      authorizePendingRemovals(
        db,
        { uri: eventUri, rev: eventRev, action: 'update', cid: 'matching' },
        control.clock.nowMs(),
      );
      expect(db.one('SELECT count(*) AS n FROM hints')).toEqual({ n: 0 });
      db.run("DELETE FROM timers WHERE name='drain'");
      await h.restart();
      expect(h.coreAlarm()).not.toBeNull();
      const alarms = await h.alarmsUntil(
        (state) =>
          state.one<{ scan_complete: number }>(
            'SELECT scan_complete FROM live_pending_removal_events WHERE uri=? AND rev=?',
            eventUri,
            eventRev,
          )?.scan_complete === 1,
        { max: 200, stepMs: 2_000 },
      );
      expect(alarms).toBeGreaterThanOrEqual(Math.ceil(size / 128) - 1);
      expect(
        h.db.one(
          'SELECT scan_complete,cursor_window_lo FROM live_pending_removal_events WHERE uri=? AND rev=?',
          eventUri,
          eventRev,
        ),
      ).toEqual({ scan_complete: 1, cursor_window_lo: lastLo });
    } finally {
      await h.close();
    }
  }
  await closeHarnesses();
});

it('fresh: 30 distinct same-DID URIs trigger snapshot coalescing', async () => {
  resetControl();
  const h = await harness('a2-distinct-uri-coalescing');
  try {
    seedUser(h.db, ALICE);
    const receiptMs = control.clock.nowMs();
    enqueueHints(
      h.db,
      Array.from({ length: 30 }, (_, index) => ({
        did: ALICE,
        collection: SCROBBLE,
        rkey: `coalesce-${String(index).padStart(2, '0')}`,
        source: 'notify' as const,
        receiptMs,
      })),
    );
    expect(h.db.one('SELECT count(*) AS n FROM hints')).toEqual({ n: 30 });
    armAlarm(h.core.host.alarm, h.db);
    await h.alarmsUntil(
      (db) =>
        db.one("SELECT 1 FROM repo_jobs WHERE did=? AND kind='snapshot' AND reason='coalesced' LIMIT 1", ALICE) !==
        null,
      { max: 10, stepMs: 2_000 },
    );
    expect(h.db.one('SELECT count(*) AS n FROM hints')).toEqual({ n: 0 });
    expect(h.db.one("SELECT reason FROM repo_jobs WHERE did=? AND kind='snapshot'", ALICE)).toEqual({
      reason: 'coalesced',
    });
  } finally {
    await h.close();
    await closeHarnesses();
  }
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
    expect(JSON.parse(firstFrontier!.cleanup_frontier)).toHaveLength(6);
    expect(db.one('SELECT count(*) AS n FROM live_pending_removals WHERE uri=?', frontierUri)).toEqual({ n: 10_000 });
    for (let page = 1; page < 79; page++) {
      frontierNow += 60_000;
      cleanup();
    }
    expect(
      db.one(
        'SELECT cleanup_frontier FROM live_pending_removal_events WHERE uri=? AND rev=?',
        frontierUri,
        frontierRev,
      ),
    ).toEqual({ cleanup_frontier: '' });
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

it('fresh: authorization cursor transaction rollback retries the same page, including a window inserted between pages', async () => {
  await withMigratedDb(async (db) => {
    seedLink(db);
    const eventUri = uri('cursor-fault-interleave');
    const eventRev = '3333333333333';
    const eventHi = 'zzzzzzzzzzzzz';
    for (let i = 0; i < 130; i++) {
      const lo = String(i).padStart(13, '0');
      db.run(
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,listened_at,
          artist_key,track_key,artist,track,authorized_rev,created_at_ms,expires_at_ms)
         VALUES(?,?,'old','scrobble',?,?,'wrong',?,1,'artist','track','Artist','Track',NULL,?,?)`,
        eventUri,
        `initial-${lo}`,
        lo,
        eventHi,
        `identity-${lo}`,
        NOW_MS,
        NOW_MS + LIVE_EVIDENCE_TTL_MS,
      );
    }
    db.run(
      `INSERT INTO live_pending_removal_events(uri,rev,action,cid,conflicted,scan_complete,created_at_ms,expires_at_ms,cleanup_due_ms)
       VALUES(?,?,'delete','',0,0,?,?,?)`,
      eventUri,
      eventRev,
      NOW_MS,
      NOW_MS + LIVE_EVIDENCE_TTL_MS,
      NOW_MS + LIVE_EVIDENCE_TTL_MS,
    );
    let failCursorWrite = true;
    const faulted: Db = {
      all: db.all.bind(db),
      one: db.one.bind(db),
      tx: (fn) => db.tx(fn),
      run(sql, ...params) {
        if (failCursorWrite && sql.includes('UPDATE live_pending_removal_events SET\n       cursor_window_hi')) {
          failCursorWrite = false;
          throw new Error('injected authorization cursor write failure');
        }
        return db.run(sql, ...params);
      },
    };
    expect(() =>
      db.tx(() => executeAuthorizedRemovals(faulted, { nowMs: NOW_MS, random: seededRandom(0xa2), limit: 0 })),
    ).toThrow('injected authorization cursor write failure');
    expect(
      db.one(
        'SELECT cursor_window_hi,cursor_window_lo,scan_complete FROM live_pending_removal_events WHERE uri=?',
        eventUri,
      ),
    ).toEqual({ cursor_window_hi: '', cursor_window_lo: '', scan_complete: 0 });
    expect(db.one('SELECT count(*) AS n FROM live_pending_removals WHERE authorized_rev IS NOT NULL')).toEqual({
      n: 0,
    });

    db.tx(() => executeAuthorizedRemovals(db, { nowMs: NOW_MS, random: seededRandom(0xa2), limit: 0 }));
    expect(
      db.one('SELECT cursor_window_hi,scan_complete FROM live_pending_removal_events WHERE uri=?', eventUri),
    ).toEqual({
      cursor_window_hi: eventHi,
      scan_complete: 0,
    });
    const inserted = uri('interleaved-window');
    recordPendingRemoval(db, {
      did: ALICE,
      uri: eventUri,
      kind: 'scrobble',
      row: {
        uri: inserted,
        record_uri: null,
        listen_id: null,
        cid: 'old',
        listened_at: record.listenedAt as string,
        artist_key: artistKey,
        track_key: musicTrackKey,
        artist: 'Björk',
        track: 'Jóga',
        recording_mbid: null,
      },
      identityKey: identity,
      windowLo: '2222222222222',
      windowHi: '4444444444444',
      replacedByCid: 'match',
      nowMs: NOW_MS,
    });
    expect(
      db.one('SELECT authorized_rev FROM live_pending_removals WHERE uri=? AND member_uri=?', eventUri, inserted),
    ).toEqual({ authorized_rev: eventRev });
    for (let i = 0; i < 3; i++)
      db.tx(() => executeAuthorizedRemovals(db, { nowMs: NOW_MS, random: seededRandom(0xa2), limit: 0 }));
    expect(db.one('SELECT scan_complete FROM live_pending_removal_events WHERE uri=?', eventUri)).toEqual({
      scan_complete: 1,
    });
    expect(
      db.one('SELECT authorized_rev FROM live_pending_removals WHERE uri=? AND member_uri=?', eventUri, inserted),
    ).toEqual({ authorized_rev: eventRev });
  });
});

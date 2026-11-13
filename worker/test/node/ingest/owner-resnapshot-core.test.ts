import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { createFixtureKit, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config';
import { OWNER_RESNAPSHOT_INTERVAL_MS, OWNER_RESNAPSHOT_TIMER } from '../../../src/do/ingest/owner-resnapshot';
import { dueAt, schedule } from '../../../src/do/timers';
import { indexCore, runAlarmNow, withIndex } from '../support/with-index';

const PREFIX = 'com.example.atmusic';
const DID_OTHER = 'did:plc:dddddddddddddddddddddddd';
const NOW = Date.parse('2026-01-15T12:00:00Z');

function config(overrides: Record<string, string> = {}) {
  return parseConfig(
    {
      PUBLIC_ORIGIN: 'https://music.example.test',
      LEXICON_PREFIX: PREFIX,
      NAMESPACE_OWNERSHIP_REF: '',
      NAMESPACE_PUBLICATION_REF: '',
      INGEST_MODE: 'socket',
      JETSTREAM_URLS: 'wss://jetstream.example.test',
      JETSTREAM_LOOKBACK_HOURS: '24',
      RELAY_URL: 'https://relay.example.test',
      ...overrides,
    },
    { allowFixturePrefix: true },
  );
}

function addAccount(db: { run(sql: string, ...params: unknown[]): unknown }, did: string, username: string) {
  db.run('INSERT INTO accounts(did,username,created_at_ms,updated_at_ms) VALUES(?,?,?,?)', did, username, NOW, NOW);
}

describe('owner resnapshot through IndexCore', () => {
  it('periodically discovers a signed PDS record, completes the snapshot, rearms backfill, and settles', async () => {
    const clock = fixedClock();
    const kit = await createFixtureKit({ clock });
    await seedReadModels(kit);
    const alice = kit.users.Alice.did;
    const fakePds = kit.pds.Alice;
    expect(fakePds).toBeInstanceOf(FakePds);

    await withIndex(async (db) => {
      // Start Alice as a locally-owned but not-yet-indexed account, and keep
      // fixture users from earlier setup out of the eligibility query.
      for (const did of [kit.users.Alice.did, 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'did:plc:cccccccccccccccccccccccc']) {
        db.run('DELETE FROM repo_jobs WHERE did=?', did);
        db.run('DELETE FROM users WHERE did=?', did);
        db.run('DELETE FROM accounts WHERE did=?', did);
      }
      addAccount(db, alice, 'alice');
      db.run(
        `INSERT INTO users(did,joined_at,active,account_status,indexing_state,generation)
         VALUES(?, '2026-01-15T12:00:00Z', 1, 'active', 'current', 1)`,
        DID_OTHER,
      );
      db.run(
        `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms,
           forward_scrobbles,backfill_state,backfill_discovery_done)
         VALUES('owner-resnapshot-link',?,'listenbrainz','alice',x'00','test-key',?,?,1,'done',1)`,
        alice,
        NOW,
        NOW,
      );
      // Hold the independent gap discovery pass beyond this scenario so it
      // cannot admit fixture relay users before the owner timer selects Alice.
      schedule(db, 'discovery', NOW + OWNER_RESNAPSHOT_INTERVAL_MS);

      // Commit directly to the signed repository without relay hints. The
      // fake Jetstream is never connected, so discovery can only come from
      // the owner's full signed PDS snapshot.
      const uri = `at://${alice}/${kit.collections.scrobble}/periodic-new`;
      const commit = await kit.externalPut('Alice', kit.collections.scrobble, 'periodic-new', {
        $type: kit.collections.scrobble,
        artist: 'Periodic Artist',
        track: 'Periodic Song',
        listenedAt: '2026-01-15T11:59:00Z',
        createdAt: '2026-01-15T11:59:00Z',
      });
      kit.resetCalls();

      const transport = Object.assign(kit.transport, { attempts: [] as string[] });
      const coreFixture = indexCore(db, { clock, config: config(), transport });
      coreFixture.core.start();
      expect(dueAt(db, OWNER_RESNAPSHOT_TIMER)).toBe(NOW);
      await runAlarmNow(coreFixture.core);
      expect(db.one("SELECT generation FROM repo_jobs WHERE did=? AND kind='snapshot'", alice)).not.toBeNull();
      expect(db.one("SELECT value FROM counters WHERE name='owner_resnapshot_receipt' AND label=?", alice)).toEqual({
        value: NOW,
      });
      expect(db.one("SELECT 1 AS x FROM repo_jobs WHERE did=? AND kind='snapshot'", DID_OTHER)).toBeNull();

      let completed = false;
      for (let slice = 0; slice < 80; slice++) {
        if (
          db.one<{ indexing_state: string }>('SELECT indexing_state FROM users WHERE did=?', alice)?.indexing_state ===
          'current'
        ) {
          const row = db.one<{ last_snapshot_at_ms: number | null }>(
            'SELECT last_snapshot_at_ms FROM users WHERE did=?',
            alice,
          );
          completed =
            row?.last_snapshot_at_ms !== null &&
            row?.last_snapshot_at_ms !== undefined &&
            row.last_snapshot_at_ms >= NOW;
          if (completed) break;
        }
        clock.advance(1_000);
        await runAlarmNow(coreFixture.core);
      }
      expect(completed).toBe(true);
      expect(db.one('SELECT uri,cid,revision,artist,track FROM scrobbles WHERE uri=?', uri)).toEqual({
        uri,
        cid: commit.ops[0]!.cid,
        revision: commit.rev,
        artist: 'Periodic Artist',
        track: 'Periodic Song',
      });
      expect(
        db.one('SELECT backfill_state,backfill_run_revision FROM linked_accounts WHERE id=?', 'owner-resnapshot-link'),
      ).toEqual({
        backfill_state: 'pending',
        backfill_run_revision: 2,
      });
      expect(fakePds.calls.count()).toBeGreaterThan(0);
      expect(dueAt(db, OWNER_RESNAPSHOT_TIMER)).toBe(NOW + OWNER_RESNAPSHOT_INTERVAL_MS);

      const callsAfterCompletion = fakePds.calls.count();
      const rescanStarts =
        db.one<{ value: number }>(
          "SELECT value FROM counters WHERE name='snapshot_rescan_started' AND label='admission'",
        )?.value ?? 0;
      const completedJob = db.one<{ attempts: number; restarts: number; state: string }>(
        "SELECT attempts,restarts,state FROM repo_jobs WHERE did=? AND kind='snapshot'",
        alice,
      );
      expect(completedJob).toEqual({ attempts: 0, restarts: 0, state: 'complete' });
      await runAlarmNow(coreFixture.core);
      await runAlarmNow(coreFixture.core);
      expect(fakePds.calls.count()).toBe(callsAfterCompletion);
      expect(
        db.one<{ value: number }>(
          "SELECT value FROM counters WHERE name='snapshot_rescan_started' AND label='admission'",
        )?.value ?? 0,
      ).toBe(rescanStarts);
      expect(db.one("SELECT attempts,restarts,state FROM repo_jobs WHERE did=? AND kind='snapshot'", alice)).toEqual(
        completedJob,
      );
      expect(db.one("SELECT value FROM counters WHERE name='owner_resnapshot_receipt' AND label=?", alice)).toEqual({
        value: NOW,
      });
    });
  });

  it('does not seed the owner timer when namespace or ingestion is disabled', async () => {
    await withIndex(async (db) => {
      const clock = fixedClock();
      const disabledIngest = indexCore(db, { clock, config: config({ INGEST_MODE: 'off' }) });
      disabledIngest.core.start();
      expect(dueAt(db, OWNER_RESNAPSHOT_TIMER)).toBeNull();
      db.run('DELETE FROM timers');
      const disabledNamespace = indexCore(db, { clock, config: config({ LEXICON_PREFIX: '' }) });
      disabledNamespace.core.start();
      expect(dueAt(db, OWNER_RESNAPSHOT_TIMER)).toBeNull();
    });
  });
});

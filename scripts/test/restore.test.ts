// scripts/admin/restore.ts (ADR 0005 §14.5, §14.3; plan cases M6.3.1/
// restore_state and M6.3.1/wrong_key; N4-02).
//
// Each test builds a "live" world on a temporary state directory with the real
// modules: a migrated database (worker/src/node/sqlite-db.ts), the revocation
// journal (app/revocations.ts FileRevocations), accounts, web sessions, sealed
// OAuth sessions (bff/oauth-stores.ts), app passwords, a sealed linked
// account, queued operations and a few derived index rows, then takes a real
// online backup (node/backup.ts) and changes the live state after it. The
// restore runs through the CLI's main() with an injected fake systemd: its
// `systemctl --user` answers from unit states the test controls, and its
// `start` really starts the server in-process (node/run.ts run(), with the
// frozen clock, seeded randomness, manual timers, the empty fixture router
// transport and an ephemeral 127.0.0.1 port), so "reports ready" is the real
// /health/ready. The crash test runs the restore in a child process and kills
// it with SIGKILL at each swap step. No real systemctl, network or
// 127.2.0.1:8888 is involved.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { connect, createServer as createNetServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import * as sqlite from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { createFixtureKit } from '@atmusic/atproto/test-support/read-models';
import { type FixtureTransport, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { trackKey } from '@atmusic/core/music-key';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs } from '@atmusic/core/timestamp';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtensionContext } from '../../worker/src/app/host.ts';
import { FileRevocations, revocationLogPath } from '../../worker/src/app/revocations.ts';
import { OAuthSessionStore } from '../../worker/src/bff/oauth-stores.ts';
import { createWebSessions } from '../../worker/src/bff/sessions.ts';
import { parseConfig } from '../../worker/src/config.ts';
import { ensureAccount, renameAccount } from '../../worker/src/credentials/accounts.ts';
import { createAppPassword, revokeAppPassword, verifyAppPassword } from '../../worker/src/credentials/app-passwords.ts';
import { type Box, createBox } from '../../worker/src/crypto/box.ts';
import type { ModuleDeps } from '../../worker/src/do/contracts.ts';
import { enqueueHints } from '../../worker/src/do/ingest/hints';
import { cachedIdentityResolver } from '../../worker/src/do/ingest/identity-cache';
import { recordLiveEvidence } from '../../worker/src/do/ingest/live-evidence';
import {
  executeAuthorizedRemovals,
  nextPendingRemovalDue,
  recordPendingRemovals,
} from '../../worker/src/do/ingest/live-pending-removals';
import { migrate } from '../../worker/src/do/migrate.ts';
import { MIGRATIONS, SCHEMA_VERSION, TABLE_CLASS } from '../../worker/src/do/schema.ts';
import { applyRecordProof } from '../../worker/src/do/write/apply-record.ts';
import { runLinkBackfill } from '../../worker/src/forward/backfill.ts';
import { settleRows } from '../../worker/src/forward/forward-outbox.ts';
import {
  FORWARD_LOVE_RECORDING_LOOKUP_SQL,
  type ForwardRuntime,
  runForward,
} from '../../worker/src/forward/forwarder.ts';
import { LastfmClient } from '../../worker/src/forward/lastfm-client.ts';
import {
  deleteLink,
  getLinkById,
  openLinkCredential,
  patchLink,
  revokeLink,
  saveLink,
} from '../../worker/src/forward/links.ts';
import { ListenbrainzClient } from '../../worker/src/forward/listenbrainz-client.ts';
import { reclaimLoveApiProofRows } from '../../worker/src/forward/love-api-maintenance.ts';
import { materializeLoveApiRecipientDecisions } from '../../worker/src/forward/love-api-materializer.ts';
import { runDeferredLoveMaintenance } from '../../worker/src/forward/love-deferral-maintenance.ts';
import { admitForwardIdentity } from '../../worker/src/forward/projection.ts';
import { UpstreamPacing } from '../../worker/src/forward/upstream-pacing.ts';
import { enqueueCoverArt, putCoverArt } from '../../worker/src/musicbrainz/cover-art-store.ts';
import { createBackups } from '../../worker/src/node/backup.ts';
import { bindPolicyFetch, createPolicyFetch } from '../../worker/src/node/policy-fetch.ts';
import { type ExitCode, type RunningServer, run } from '../../worker/src/node/run.ts';
import { parseSecrets, type Secrets } from '../../worker/src/node/secrets.ts';
import { openSqliteDb, type SqliteDb } from '../../worker/src/node/sqlite-db.ts';
import { enqueueForwards } from '../../worker/src/outbox/forward-enqueue.ts';
import { acceptListens } from '../../worker/src/outbox/ingress.ts';
import { enqueueLove } from '../../worker/src/outbox/love-ops.ts';
import { cancelUnsent } from '../../worker/src/outbox/operations.ts';
import { PDS_WRITER_CAPS } from '../../worker/src/outbox/pds-writer.ts';
import { type OutboxDeps, runOutbox } from '../../worker/src/outbox/runner.ts';
import {
  captureLog,
  manualTimers,
  refusingJetstream,
  testEnv,
  testSecretsDocument,
} from '../../worker/test/node/support/app.ts';
import { authorizedLiveOptions } from '../../worker/test/write/support.ts';
import { type CommandResult, main, type RestoreStep } from '../admin/restore.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUSY_MS = 200;
const DID_A = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const DID_B = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const DID_C = 'did:plc:cccccccccccccccccccccccc';
const PREFIX = 'com.example.atmusic';
const LOVE_COLLECTION = `${PREFIX}.love`;
const LASTFM_SK = 'lastfm-session-key-of-alice-0123456789';
const ORIGINAL_FETCH = globalThis.fetch;

// ---------------------------------------------------------------------------
// Fixture world

interface World {
  dir: string;
  state: string;
  dbPath: string;
  backupPath: string;
  secretsFile: string;
  secretsDoc: Record<string, unknown>;
  dist: string;
  clock: FixedClock;
  /** Values the tests look up afterwards. */
  ids: Record<string, string>;
  /** The sealed OAuth session of alice as the backup holds it. */
  backupCiphertextA: Uint8Array;
}

const dirs: string[] = [];
const running: Array<{ result: Promise<ExitCode>; server: RunningServer | null }> = [];
const netServers: NetServer[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    if (r.server !== null) await r.server.shutdown('SIGTERM');
    await r.result;
  }
  for (const s of netServers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  globalThis.fetch = ORIGINAL_FETCH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeSecrets(path: string, doc: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(doc));
  chmodSync(path, 0o600);
}

/** A secrets document whose only encryption key is `e2` (the backup's sessions are sealed with e1). */
function secretsWithoutE1(): Record<string, unknown> {
  return { ...testSecretsDocument(), encryptionKeys: [{ id: 'e2', key: Buffer.alloc(32, 0x7e).toString('base64') }] };
}

function savedSession(did: string, refresh: string): never {
  return {
    dpopJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
    authMethod: { method: 'private_key_jwt', kid: 'k1' },
    tokenSet: {
      iss: 'https://as.example.test',
      sub: did,
      aud: 'https://pds.example.test',
      scope: 'atproto',
      access_token: `access-${did}`,
      refresh_token: refresh,
      token_type: 'DPoP',
    },
  } as never;
}

function ts30(iso: string): string {
  // 2026-01-15T11:00:00 → 2026-01-15T11:00:00.000000000Z (30 characters).
  return `${iso}.000000000Z`;
}

function insertScrobble(db: SqliteDb, did: string, rkey: string, at: string): void {
  db.run(
    `INSERT INTO scrobbles (uri, cid, did, rkey, revision, artist, track, album, listened_at, created_at, indexed_at,
       artist_key, track_key) VALUES (?, ?, ?, ?, '3l', 'Artist', ?, NULL, ?, ?, ?, 'artist', ?)`,
    `at://${did}/${PREFIX}.scrobble/${rkey}`,
    `bafy${rkey}`,
    did,
    rkey,
    `Track ${rkey}`,
    ts30(at),
    `${at}Z`,
    `${at}Z`,
    `track ${rkey}`,
  );
}

function insertOperation(db: SqliteDb, id: string, did: string, now: number): void {
  db.run(
    `INSERT INTO operations (id, did, kind, origin, priority, collection, rkey, record_json, digest, state, due_at,
       created_at_ms, updated_at_ms) VALUES (?, ?, 'scrobble.create', 'lastfm', 1, ?, ?, '{}', 'digest', 'queued', ?, ?, ?)`,
    id,
    did,
    `${PREFIX}.scrobble`,
    `rk${id}`,
    now,
    now,
    now,
  );
}

interface WorldOptions {
  /** Leave the live database open with its newest commits only in the WAL (for the crash test). */
  keepWal?: boolean;
  /** Extra SQL run on the live database after the backup. */
  liveSql?: string[];
  /** SQL run immediately before the backup for stale-backup merge coverage. */
  backupSql?: string[];
  /** Production writes run immediately before the online backup. */
  beforeBackup?: (context: { db: SqliteDb; clock: FixedClock; linkId: string }) => void;
  /** Production writes run against the live DB after the backup. */
  afterBackup?: (context: { db: SqliteDb; clock: FixedClock; linkId: string }) => void;
}

/**
 * The live world (module comment). Before the backup (12:00): accounts alice
 * and bob, alice's web session, OAuth sessions of both, app passwords P1
 * (alice) and P3 (bob), alice's Last.fm link, operation op1, scrobble S1, a
 * follow alice→bob, the Jetstream cursor 1000. After it (12:01): scrobble S2,
 * the follow deleted, cursor 2000, alice renamed to alice2, carol signs in
 * (account, OAuth and web session), app password P2, alice signs out, P1
 * revoked, operation op2, and with `journalLinkAndOauth`: alice's link
 * deleted and bob's OAuth session deleted.
 */
async function buildWorld(
  options: WorldOptions & { journalLinkAndOauth?: boolean } = {},
): Promise<World & { live: SqliteDb | null }> {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-restore-'));
  dirs.push(dir);
  const state = join(dir, 'state');
  mkdirSync(state, { mode: 0o700 });
  const dist = join(dir, 'web', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>atmusic</title>');
  const secretsFile = join(dir, 'secrets.json');
  const secretsDoc = testSecretsDocument();
  writeSecrets(secretsFile, secretsDoc);
  const secrets = parseSecrets(secretsDoc);
  const clock = fixedClock();
  const random = seededRandom(0x5eed);
  const log = captureLog().logger;
  const dbPath = join(state, 'atmusic.db');
  let db = openSqliteDb(dbPath, { create: true, busyTimeoutMs: BUSY_MS });
  expect(migrate(db)).toEqual({ status: 'ready', version: SCHEMA_VERSION });
  const journal = new FileRevocations({ path: revocationLogPath(state), clock });
  const box = createBox(secrets.encryptionKeys, random);
  let deps = { db, clock, random, revocations: journal };
  let sessions = createWebSessions(deps);
  let oauth = new OAuthSessionStore({ db, clock, box, log, revocations: journal });
  const ids: Record<string, string> = {};

  // --- Before the backup ------------------------------------------------------
  db.tx(() => {
    for (const did of [DID_A, DID_B])
      db.run("INSERT INTO users (did, handle, joined_at) VALUES (?, NULL, '2026-01-01T00:00:00Z')", did);
    insertScrobble(db, DID_A, 's1', '2026-01-15T11:00:00');
    db.run(
      `INSERT INTO follows (uri, cid, actor, subject, revision, created_at, indexed_at) VALUES (?, 'bafyf', ?, ?, '3l', ?, ?)`,
      `at://${DID_A}/${PREFIX}.follow/f1`,
      DID_A,
      DID_B,
      ts30('2026-01-15T11:00:00'),
      '2026-01-15T11:00:00Z',
    );
    db.run("UPDATE ingest_checkpoint SET cursor = 1000 WHERE stream = 'jetstream'");
  });
  ensureAccount(deps, { did: DID_A, verifiedHandle: 'alice.test' });
  ensureAccount(deps, { did: DID_B, verifiedHandle: 'bob.test' });
  ids.webA = sessions.create(DID_A).token;
  oauth.set(DID_A, savedSession(DID_A, 'refresh-a1'));
  oauth.set(DID_B, savedSession(DID_B, 'refresh-b1'));
  const p1 = createAppPassword(deps, { did: DID_A, label: 'pano' });
  ids.p1 = p1.password;
  ids.p1Id = p1.id;
  ids.p3 = createAppPassword(deps, { did: DID_B, label: 'phone' }).password;
  ids.link = saveLink(
    { db, clock, random, box },
    { did: DID_A, service: 'lastfm', remoteUser: 'alice', credential: LASTFM_SK },
  ).link.id;
  insertOperation(db, 'op1', DID_A, clock.nowMs());

  for (const sql of options.backupSql ?? []) db.exec(sql);
  options.beforeBackup?.({ db, clock, linkId: ids.link! });

  const backups = createBackups({ db, dir: join(state, 'backups'), clock, log, minFreeBytes: 0, revocations: journal });
  const outcome = await backups.run('manual');
  if (outcome.status !== 'ok') throw new Error(`backup failed: ${JSON.stringify(outcome)}`);
  const backupPath = outcome.path;
  const backupCiphertextA = new Uint8Array(
    (
      db.one<{ ciphertext: ArrayBuffer }>('SELECT ciphertext FROM oauth_sessions WHERE did = ?', DID_A) as {
        ciphertext: ArrayBuffer;
      }
    ).ciphertext,
  );

  // Reopen (closing checkpoints the WAL), so every later commit lives in a fresh WAL.
  db.close();
  db = openSqliteDb(dbPath, { busyTimeoutMs: BUSY_MS });
  deps = { db, clock, random, revocations: journal };
  sessions = createWebSessions(deps);
  oauth = new OAuthSessionStore({ db, clock, box, log, revocations: journal });

  // --- After the backup -------------------------------------------------------
  clock.advance(60_000);
  db.tx(() => {
    insertScrobble(db, DID_A, 's2', '2026-01-15T12:00:30');
    db.run('DELETE FROM follows');
    db.run("UPDATE ingest_checkpoint SET cursor = 2000 WHERE stream = 'jetstream'");
  });
  expect(renameAccount(deps, { did: DID_A, username: 'alice2' })).toMatchObject({ ok: true, changed: true });
  db.run("INSERT INTO users (did, handle, joined_at) VALUES (?, NULL, '2026-01-15T12:01:00Z')", DID_C);
  ensureAccount(deps, { did: DID_C, verifiedHandle: 'carol.test' });
  oauth.set(DID_C, savedSession(DID_C, 'refresh-c1'));
  ids.webC = sessions.create(DID_C).token;
  ids.p2 = createAppPassword(deps, { did: DID_A, label: 'web scrobbler' }).password;
  expect(sessions.logout(ids.webA)).toBe(true);
  expect(revokeAppPassword(deps, DID_A, ids.p1Id)).toBe(true);
  insertOperation(db, 'op2', DID_A, clock.nowMs());
  if (options.journalLinkAndOauth === true) {
    expect(deleteLink({ db, revocations: journal }, DID_A, ids.link)).toBe(true);
    oauth.del(DID_B);
  }
  for (const sql of options.liveSql ?? []) db.exec(sql);
  options.afterBackup?.({ db, clock, linkId: ids.link! });
  journal.close();

  const world = { dir, state, dbPath, backupPath, secretsFile, secretsDoc, dist, clock, ids, backupCiphertextA };
  if (options.keepWal === true) return { ...world, live: db };
  db.close();
  return { ...world, live: null };
}

function populateDeferredLoveState(db: SqliteDb, clock: FixedClock, linkId: string, label: string): string {
  const now = clock.nowMs();
  const link = getLinkById(db, linkId);
  if (link === null) throw new Error(`restore fixture link ${linkId} is missing`);
  const tag = label.toLowerCase();
  const loveOperation = `${tag}-delivery-love`;
  const unloveOperation = `${tag}-deferred-unlove`;
  const sharedPayload = {
    artist: 'Restore Matrix Artist',
    track: `${label} shared track`,
    recordingMbid: '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae',
    origin: 'web',
  };
  const lovePayload = sharedPayload;
  const deferredPayload = sharedPayload;
  db.run("UPDATE linked_accounts SET service='listenbrainz' WHERE id=?", linkId);
  const [deliveryArtist, deliveryTrack] = trackKey(lovePayload.artist, lovePayload.track);
  const [deferredArtist, deferredTrack] = trackKey(deferredPayload.artist, deferredPayload.track);

  if (link.forward_scrobbles !== 1) patchLink({ db, clock }, link.did, linkId, { forwardScrobbles: true });
  db.run("UPDATE linked_accounts SET backfill_state='done' WHERE id=?", linkId);
  enqueueForwards(db, {
    did: link.did,
    items: [{ kind: 'love', operationId: loveOperation, payload: lovePayload }],
    now,
    random: seededRandom(label.length + 1),
  });
  const storedLoveKey = link.generation === 1 ? loveOperation : `g${link.generation}:${loveOperation}`;
  const row = db.one<{ id: string }>(
    "SELECT id FROM forward_outbox WHERE link_id=? AND generation=? AND kind='love' AND dedupe_key=?",
    linkId,
    link.generation,
    storedLoveKey,
  );
  if (row === null) throw new Error(`restore fixture ${label} love was not enqueued`);
  settleRows(db, [row.id], 'sent', now + 1);
  patchLink({ db, clock }, link.did, linkId, { forwardScrobbles: false });

  const uri = `at://${link.did}/${PREFIX}.love/${tag}-authorized-unlove`;
  const rev = '3lbcdefghijkm';
  db.run(
    `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,record_json,digest,state,due_at,
       created_at_ms,updated_at_ms,send_state)
     VALUES(?,?,'love.delete','web',0,?,?,?,?,'queued',?,?,?,'unsent')`,
    unloveOperation,
    link.did,
    `${PREFIX}.love`,
    `${tag}-authorized-unlove`,
    JSON.stringify(deferredPayload),
    `digest-${tag}`,
    now,
    now,
    now,
  );
  enqueueHints(db, [
    {
      did: link.did,
      collection: `${PREFIX}.love`,
      rkey: `${tag}-authorized-unlove`,
      source: 'jetstream',
      hintRev: rev,
      live: { operation: 'delete' },
      receiptMs: now,
    },
  ]);
  enqueueForwards(db, {
    did: link.did,
    items: [{ kind: 'unlove', operationId: unloveOperation, payload: deferredPayload, authorization: { uri, rev } }],
    now: now + 2,
    random: seededRandom(label.length + 2),
  });
  // This is the actual bounded maintenance entry point; it initializes and
  // advances allocator/frontier metadata without fabricating any row ids.
  runDeferredLoveMaintenance(db, now + 3);
  if (
    db.one(
      'SELECT 1 FROM forward_love_delivery WHERE link_id=? AND love_artist_key=? AND love_track_key=?',
      linkId,
      deliveryArtist,
      deliveryTrack,
    ) === null ||
    db.one(
      'SELECT 1 FROM forward_deferred_love_heads WHERE link_id=? AND love_artist_key=? AND love_track_key=?',
      linkId,
      deferredArtist,
      deferredTrack,
    ) === null ||
    db.one(
      'SELECT 1 FROM forward_deferred_love_intents WHERE link_id=? AND operation_id=?',
      linkId,
      unloveOperation,
    ) === null ||
    db.one(
      'SELECT 1 FROM forward_deferred_love_witnesses WHERE link_id=? AND operation_id=?',
      linkId,
      unloveOperation,
    ) === null ||
    db.one(
      'SELECT 1 FROM forward_deferred_love_authorities WHERE authorization_uri=? AND authorization_rev=?',
      uri,
      rev,
    ) === null ||
    db.one('SELECT 1 FROM forward_deferred_love_maintenance WHERE singleton=1') === null
  )
    throw new Error(`restore fixture ${label} did not populate all six B2 tables`);
  return unloveOperation;
}

const LOVE_API_TABLES = [
  'love_api_bindings',
  'love_api_recipients',
  'love_api_recipient_members',
  'love_api_comparison_facts',
  'love_api_window_owners',
  'love_api_unlove_decisions',
  'love_api_intent_epochs',
  'love_api_proof_state',
] as const;

function populateLoveApiProofState(db: SqliteDb, clock: FixedClock, linkId: string, label: string): string {
  const link = getLinkById(db, linkId);
  if (link === null) throw new Error(`restore fixture link ${linkId} is missing`);
  const now = clock.nowMs();
  const tag = label.toLowerCase();
  const uri = `at://${link.did}/${PREFIX}.love/${tag}-api-origin`;
  const incarnation = `love:${uri}:api:${tag}-api-put`;
  const apiOperation = `${tag}-api-put`;
  const pendingOperation = `${tag}-api-pending-put`;
  const memberUri = `at://${link.did}/${PREFIX}.scrobble/${tag}-removed-member`;
  const rev = '3lbcdefghijkm';
  const windowLo = '3lbcdefghijkh';
  const windowHi = '3lbcdefghijkn';
  const artist = `Restore ${label} artist`;
  const track = `Restore ${label} track`;
  const [artistKey, trackKeyValue] = trackKey(artist, track);
  const payload = JSON.stringify({ artist, track, origin: 'lastfm' });
  const horizon = now + 60 * 60_000;
  const bindingSeq = label === 'Backup' ? 31 : 41;
  const aggregateSeq = label === 'Backup' ? 32 : 42;
  const factSeq = label === 'Backup' ? 33 : 43;
  const dedupe = link.generation === 1 ? apiOperation : `g${link.generation}:${apiOperation}`;
  db.run(
    `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,record_json,digest,state,due_at,
       created_at_ms,updated_at_ms,send_state)
     VALUES(?,?,'love.put','lastfm',0,?,?,?,?, 'succeeded',?,?,?,'sent')`,
    apiOperation,
    link.did,
    `${PREFIX}.love`,
    `${tag}-request-rkey`,
    JSON.stringify({ $type: `${PREFIX}.love`, artist, track }),
    `digest-${tag}-api`,
    now,
    now,
    now,
  );
  db.run(
    `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,record_json,digest,state,due_at,
       created_at_ms,updated_at_ms,send_state)
     VALUES(?,?,'love.put','lastfm',0,?,?,?,?, 'queued',?,?,?,'unsent')`,
    pendingOperation,
    link.did,
    `${PREFIX}.love`,
    `${tag}-pending-rkey`,
    JSON.stringify({ $type: `${PREFIX}.love`, artist, track }),
    `digest-${tag}-pending`,
    now,
    now,
    now,
  );
  db.run(
    `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
     VALUES(?,?,'present','api',NULL,?)`,
    uri,
    incarnation,
    now,
  );
  db.run(
    `INSERT INTO love_api_bindings(did,operation_id,api_origin,uri,incarnation_key,binding_seq,created_at_ms)
     VALUES(?,?,'lastfm',?,?,?,?)`,
    link.did,
    apiOperation,
    uri,
    incarnation,
    bindingSeq,
    now,
  );
  db.run(
    `INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,? ,?,'sent',1,?,?,?)`,
    `${tag}-api-sent-row`,
    linkId,
    link.generation,
    link.did,
    'love',
    dedupe,
    payload,
    now,
    now,
    now,
  );
  db.run(
    `INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,sent_operation_id,created_at_ms,updated_at_ms)
     VALUES(?,?,?,?,?,?,'sealed',?,?,?)`,
    link.did,
    uri,
    incarnation,
    linkId,
    link.generation,
    aggregateSeq,
    apiOperation,
    now,
    now,
  );
  db.run(
    `INSERT INTO love_api_recipient_members(link_id,generation,operation_id,did,uri,incarnation_key,member_seq,created_at_ms)
     VALUES(?,?,?,?,?,?,1,?)`,
    linkId,
    link.generation,
    pendingOperation,
    link.did,
    uri,
    incarnation,
    now,
  );
  db.run(
    `INSERT INTO live_pending_removals(uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,
       listened_at,artist_key,track_key,artist,track,recording_mbid,love_source_service,love_import_sources,
       authorized_rev,created_at_ms,expires_at_ms,conflict_invalidated,conflicted_auth_rev)
     VALUES(?,?,?,'love',?,?,? ,?,NULL,?,?,?,?,NULL,'lastfm',NULL,?,?,?,0,NULL)`,
    uri,
    memberUri,
    `removed-${tag}-cid`,
    windowLo,
    windowHi,
    '',
    incarnation,
    artistKey,
    trackKeyValue,
    artist,
    track,
    rev,
    now,
    horizon,
  );
  db.run(
    `INSERT INTO love_api_window_owners(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid,did,incarnation_key,link_id,generation,created_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    uri,
    memberUri,
    `removed-${tag}-cid`,
    windowLo,
    windowHi,
    '',
    link.did,
    incarnation,
    linkId,
    link.generation,
    now,
  );
  db.run(
    `INSERT INTO love_api_comparison_facts(authorization_uri,authorization_rev,fact_seq,action,cid,horizon_ms,created_at_ms)
     VALUES(?,?,?,'delete','',?,?)`,
    uri,
    rev,
    factSeq,
    horizon,
    now,
  );
  db.run(
    `INSERT INTO love_api_unlove_decisions(did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,
       recording_mbid,payload_json,love_source_service,love_import_sources,authorization_uri,authorization_rev,
       fact_action,fact_cid,expires_at_ms,due_at_ms,scan_session,alias_epoch,alias_cursor,created_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,NULL,?,NULL,NULL,?,?,'delete','',?,?,NULL,NULL,NULL,?)`,
    link.did,
    uri,
    incarnation,
    linkId,
    link.generation,
    artist,
    track,
    artistKey,
    trackKeyValue,
    payload,
    uri,
    rev,
    horizon,
    now,
    now,
  );
  db.run(
    `INSERT INTO love_api_intent_epochs(did,epoch) VALUES(?,?)
     ON CONFLICT(did) DO UPDATE SET epoch=excluded.epoch`,
    link.did,
    label === 'Backup' ? 3 : 5,
  );
  db.run(
    `INSERT INTO love_api_proof_state(singleton,next_binding_seq,next_aggregate_seq,next_fact_seq,updated_at_ms)
     VALUES(1,?,?,?,?)
     ON CONFLICT(singleton) DO UPDATE SET next_binding_seq=excluded.next_binding_seq,
       next_aggregate_seq=excluded.next_aggregate_seq,next_fact_seq=excluded.next_fact_seq,updated_at_ms=excluded.updated_at_ms`,
    bindingSeq + 1,
    aggregateSeq + 1,
    factSeq + 1,
    now,
  );
  for (const table of LOVE_API_TABLES)
    if (db.one(`SELECT 1 FROM ${table} LIMIT 1`) === null) throw new Error(`restore fixture omitted ${table}`);
  return uri;
}

function restoreB2Snapshot(path: string): string {
  const tables: Array<[string, string]> = [
    ['forward_love_delivery', 'link_id,generation,love_artist_key,love_track_key'],
    ['forward_deferred_love_heads', 'link_id,generation,love_artist_key,love_track_key'],
    ['forward_deferred_love_intents', 'link_id,generation,love_artist_key,love_track_key,intent_seq'],
    ['forward_deferred_love_witnesses', 'link_id,generation,operation_id'],
    ['forward_deferred_love_authorities', 'authorization_uri,authorization_rev'],
    ['forward_deferred_love_maintenance', 'singleton'],
    ['forward_receipts', 'link_id,generation,kind,dedupe_key'],
    ['forward_link_gaps', 'link_id,generation,from_seq'],
    ['forward_outbox', 'id'],
  ];
  return JSON.stringify(
    tables.map(([table, order]) => [table, query(path, `SELECT * FROM ${table} ORDER BY ${order}`)]),
  );
}

async function dispatchListenbrainz(
  db: SqliteDb,
  now: number,
): Promise<{ report: Awaited<ReturnType<typeof runForward>>; feedbacks: unknown[] }> {
  const feedbacks: unknown[] = [];
  const clock = { nowMs: () => now };
  const listenbrainz = new ListenbrainzClient({
    apiRoot: 'https://listenbrainz.invalid/',
    fetch: async (_url, init) => {
      feedbacks.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const runtime = {
    db,
    clock,
    random: seededRandom(741),
    log: { log: () => undefined },
    box: { openText: () => 'fixture-token' },
    pacing: new UpstreamPacing(clock),
    lastfm: null,
    listenbrainz,
  } as unknown as ForwardRuntime;
  return { report: await runForward(runtime, now), feedbacks };
}

async function produceApiLoveWithRealPds(db: SqliteDb, clock: FixedClock, label: string) {
  const kit = await createFixtureKit({ clock });
  expect(kit.users.Alice.did).toBe(DID_A);
  const random = seededRandom(label === 'Live' ? 0x71 : 0x70);
  const box = createBox(parseSecrets(testSecretsDocument()).encryptionKeys, random);
  const transport = kit.transport;
  const policyFetch = bindPolicyFetch(createPolicyFetch({ transport }), PDS_WRITER_CAPS);
  const writers: OutboxDeps['writers'] = {
    async writerFor(did) {
      const user = kit.user(did);
      return {
        did,
        scope: 'transition:generic',
        fetchHandler(pathname, init) {
          const headers = new Headers(init?.headers);
          headers.set('authorization', `Bearer ${user.token}`);
          return policyFetch(new URL(pathname, user.origin), { ...init, headers });
        },
      };
    },
  };
  const config = {
    ...parseConfig(
      {
        PUBLIC_ORIGIN: 'https://music.example.test',
        LEXICON_PREFIX: PREFIX,
        NAMESPACE_OWNERSHIP_REF: '',
        NAMESPACE_PUBLICATION_REF: '',
        INGEST_MODE: 'off',
        JETSTREAM_URLS: '',
        JETSTREAM_LOOKBACK_HOURS: '24',
        RELAY_URL: 'https://relay.example.test',
      } as Parameters<typeof parseConfig>[0],
      { allowFixturePrefix: true },
    ),
    publication: true,
    batchPublication: true,
  };
  const m: OutboxDeps = {
    db,
    clock,
    random,
    transport,
    identity: cachedIdentityResolver(db, { transport, clock }),
    config,
    log: captureLog().logger,
    writers,
  };
  const listenbrainzLink = saveLink(
    { db, clock, random, box },
    {
      did: DID_A,
      service: 'listenbrainz',
      remoteUser: `restore-${label.toLowerCase()}`,
      credential: `fixture-${label}-token`,
    },
  ).link.id;
  db.run("UPDATE operations SET state='cancelled' WHERE id IN ('op1','op2')");
  const created = await enqueueLove(m, {
    did: DID_A,
    input: {
      artist: `Producer restore ${label}`,
      track: 'SENT love',
      album: 'Actual producer album',
      recordingMbid: '12345678-1234-1234-1234-123456789abc',
    },
    origin: 'lastfm',
  });
  if (!created.ok) throw new Error(`restore producer API love rejected: ${created.reason.code}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    await runOutbox(m, clock.nowMs());
    const state = db.one<{ state: string }>('SELECT state FROM operations WHERE id=?', created.operation.id)?.state;
    if (state === 'succeeded') break;
    if (state === 'failed') throw new Error('restore producer PDS love failed');
  }
  const operation = db.one<{ state: string; rkey: string; result_uri: string | null }>(
    'SELECT state,rkey,result_uri FROM operations WHERE id=?',
    created.operation.id,
  );
  if (operation?.state !== 'succeeded' || operation.result_uri === null)
    throw new Error('restore producer PDS love did not reach SENT success');
  return {
    kit,
    m,
    operationId: created.operation.id,
    uri: operation.result_uri,
    rkey: operation.rkey,
    listenbrainzLink,
  };
}

async function dispatchRestoreLoveTransports(db: SqliteDb, now: number) {
  const listenbrainzRequests: unknown[] = [];
  const lastfmRequests: string[] = [];
  const clock = { nowMs: () => now };
  const listenbrainz = new ListenbrainzClient({
    apiRoot: 'https://listenbrainz.invalid/',
    fetch: async (_url, init) => {
      listenbrainzRequests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    },
  });
  const lastfm = new LastfmClient({
    apiRoot: 'https://lastfm.invalid/2.0/',
    apiKey: 'fixture-key',
    sharedSecret: 'fixture-secret',
    fetch: async (_url, init) => {
      lastfmRequests.push(new URLSearchParams(String(init?.body)).get('method') ?? 'unknown');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const runtime = {
    db,
    clock,
    random: seededRandom(0x72),
    log: { log: () => undefined },
    box: { openText: () => 'fixture-token' },
    pacing: new UpstreamPacing(clock),
    lastfm,
    listenbrainz,
  } as unknown as ForwardRuntime;
  return { report: await runForward(runtime, now), listenbrainzRequests, lastfmRequests };
}

/** Overwrites the live database with bytes that are not SQLite (a failed disk). */
function corruptLive(world: World): Buffer {
  const garbage = Buffer.alloc(8192, 0x5a);
  writeFileSync(world.dbPath, garbage);
  rmSync(`${world.dbPath}-wal`, { force: true });
  return garbage;
}

/**
 * Turns the world's open live database (buildWorld keepWal) into a crash-time
 * pair: the main file and its WAL as they were while it was open, with every
 * post-backup commit only in the WAL (no checkpoint).
 */
function crashConsistentLive(world: World & { live: SqliteDb | null }): void {
  const live = world.live as SqliteDb;
  const copy = join(world.dir, 'crash');
  mkdirSync(copy);
  copyFileSync(world.dbPath, join(copy, 'atmusic.db'));
  copyFileSync(`${world.dbPath}-wal`, join(copy, 'atmusic.db-wal'));
  live.close();
  rmSync(world.dbPath);
  rmSync(`${world.dbPath}-wal`, { force: true });
  rmSync(`${world.dbPath}-shm`, { force: true });
  copyFileSync(join(copy, 'atmusic.db'), world.dbPath);
  copyFileSync(join(copy, 'atmusic.db-wal'), `${world.dbPath}-wal`);
  // The main file alone does not have the post-backup rows: they live in the WAL.
  const mainOnly = join(copy, 'main-only.db');
  copyFileSync(join(copy, 'atmusic.db'), mainOnly);
  expect(query(mainOnly, 'SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }]);
}

/** Runs `read` on a scratch copy of `path` and its WAL, so the inspected files stay as they are. */
function onScratchCopy<T>(world: World, label: string, path: string, read: (db: sqlite.DatabaseSync) => T): T {
  const scratch = join(world.dir, `scratch-${label}`);
  mkdirSync(scratch);
  copyFileSync(path, join(scratch, 'x.db'));
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, join(scratch, 'x.db-wal'));
  const db = new sqlite.DatabaseSync(join(scratch, 'x.db'));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function integrity(db: sqlite.DatabaseSync, table?: string): string[] {
  const sql = table === undefined ? 'PRAGMA integrity_check' : `PRAGMA integrity_check("${table}")`;
  try {
    return (db.prepare(sql).all() as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0]));
  } catch (error) {
    return [`error: ${(error as { errstr?: string }).errstr ?? String(error)}`];
  }
}

/** The page numbers a WAL file holds frames for (32-byte header, then 24-byte frame headers). */
function walPages(wal: Buffer, pageSize: number): Set<number> {
  const pages = new Set<number>();
  for (let at = 32; at + 24 + pageSize <= wal.length; at += 24 + pageSize) pages.add(wal.readUInt32BE(at));
  return pages;
}

/** Overwrites one page of the main database file in place (a bad sector). */
function damagePage(path: string, page: number, pageSize: number): void {
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, Buffer.alloc(pageSize, 0x07), 0, pageSize, (page - 1) * pageSize);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// The server and the fake systemd

async function freePort(): Promise<number> {
  const s = createNetServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Started {
  server: RunningServer;
  logLines: string[];
}

/** run() of node/run.ts on the world's state directory, as atmusic.service would. */
async function startServer(world: World, port: number, secretsFile = world.secretsFile): Promise<Started> {
  const log = captureLog();
  let ready: (s: RunningServer) => void = () => {};
  const server = new Promise<RunningServer>((r) => {
    ready = r;
  });
  const entry: { result: Promise<ExitCode>; server: RunningServer | null } = {
    result: Promise.resolve(0),
    server: null,
  };
  entry.result = run({
    argv: ['node', 'main.mjs'],
    env: {
      ...testEnv(world.dir),
      STATE_DIRECTORY: world.state,
      ATMUSIC_LISTEN: `127.0.0.1:${port}`,
      ATMUSIC_ASSETS_DIR: world.dist,
      ATMUSIC_SECRETS_FILE: secretsFile,
      ATMUSIC_SIGNIN_DIDS: [DID_A, DID_B, DID_C].join(','),
    },
    clock: world.clock,
    random: seededRandom(0x77),
    busyTimeoutMs: BUSY_MS,
    drainMs: 200,
    log: log.logger,
    stdout: () => {},
    stderr: (t) => log.lines.push(t),
    configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
    transport: routerTransport({}) as FixtureTransport,
    connectJetstream: refusingJetstream(),
    timers: manualTimers(),
    signals: new EventEmitter(),
    onReady: (s) => ready(s),
  });
  running.push(entry);
  const started = await Promise.race([server, entry.result.then((code) => code)]);
  if (typeof started === 'number') throw new Error(`run() exited ${started}: ${log.lines.join('\n')}`);
  entry.server = started;
  return { server: started, logLines: log.lines };
}

async function stopServer(server: RunningServer): Promise<void> {
  const entry = running.find((r) => r.server === server);
  await server.shutdown('SIGTERM');
  if (entry !== undefined) {
    await entry.result;
    running.splice(running.indexOf(entry), 1);
  }
}

function accepts(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      r(true);
    });
    s.once('error', () => r(false));
  });
}

type UnitState = 'active' | 'inactive' | 'failed';

/**
 * A fake `systemctl --user` for atmusic.socket and atmusic.service. The socket
 * unit is a listener on `socketPort` that counts the connections that would
 * socket-activate the service; the service is run() on `servicePort`.
 */
class FakeSystemd {
  readonly units: Record<string, UnitState> = { 'atmusic.socket': 'inactive', 'atmusic.service': 'inactive' };
  readonly events: string[] = [];
  activations = 0;
  server: Started | null = null;
  private listener: NetServer | null = null;

  constructor(
    private readonly world: World,
    private readonly options: {
      servicePort: number | null;
      socketPort?: number;
      /** A unit `stop` leaves running (a stuck stop). */
      stuck?: string;
      secretsFile?: string;
    },
  ) {}

  private async openSocket(): Promise<void> {
    if (this.options.socketPort === undefined) return;
    const listener = createNetServer((socket) => {
      this.activations++;
      socket.destroy();
    });
    await new Promise<void>((r) => listener.listen(this.options.socketPort, '127.0.0.1', () => r()));
    netServers.push(listener);
    this.listener = listener;
  }

  async boot(): Promise<void> {
    await this.openSocket();
    this.units['atmusic.socket'] = 'active';
    if (this.options.servicePort !== null) {
      this.server = await startServer(this.world, this.options.servicePort, this.options.secretsFile);
    }
    this.units['atmusic.service'] = 'active';
  }

  readonly systemctl = async (args: readonly string[]): Promise<CommandResult> => {
    this.events.push(`systemctl ${args.join(' ')}`);
    const [verb, ...units] = args;
    if (verb === 'stop') {
      for (const unit of units) {
        if (unit === this.options.stuck) continue;
        if (unit === 'atmusic.socket' && this.listener !== null) {
          const l = this.listener;
          this.listener = null;
          await new Promise<void>((r) => l.close(() => r()));
          netServers.splice(netServers.indexOf(l), 1);
        }
        if (unit === 'atmusic.service' && this.server !== null) {
          await stopServer(this.server.server);
          this.server = null;
        }
        this.units[unit] = 'inactive';
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (verb === 'is-active') {
      const states = units.map((u) => this.units[u] ?? 'inactive');
      return { code: states.every((s) => s === 'active') ? 0 : 3, stdout: `${states.join('\n')}\n`, stderr: '' };
    }
    if (verb === 'start') {
      for (const unit of units) {
        if (unit === 'atmusic.socket') await this.openSocket();
        if (unit === 'atmusic.service' && this.options.servicePort !== null) {
          this.server = await startServer(this.world, this.options.servicePort, this.options.secretsFile);
        }
        this.units[unit] = 'active';
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected systemctl ${args.join(' ')}` };
  };
}

interface Restored {
  code: number;
  stdout: string;
  stderr: string;
}

async function restoreCli(
  world: World,
  systemd: FakeSystemd,
  args: string[],
  onStep?: (step: RestoreStep) => void | Promise<void>,
): Promise<Restored> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...args, world.backupPath], {
    env: { HOME: join(world.dir, 'home') },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    systemctl: systemd.systemctl,
    busyTimeoutMs: BUSY_MS,
    clock: world.clock,
    readyTimeoutMs: 5000,
    onStep: async (step) => {
      systemd.events.push(`step ${step}`);
      await onStep?.(step);
    },
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const baseArgs = (world: World) => ['--db', world.dbPath, '--state-dir', world.state, '--secrets', world.secretsFile];

/** Rows of a closed database file (its WAL, if any, applied; nothing is written). */
function query(path: string, sql: string, ...params: sqlite.SQLInputValue[]): Record<string, unknown>[] {
  const db = new sqlite.DatabaseSync(pathToFileURL(path));
  try {
    return db.prepare(sql).all(...params) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function downgradeFixtureTo56(path: string): void {
  const db = openSqliteDb(path, { busyTimeoutMs: BUSY_MS });
  try {
    expect(migrate(db, MIGRATIONS)).toEqual({ status: 'ready', version: 57 });
    db.tx(() => {
      for (const index of [
        'love_api_intent_alias_scan',
        'love_api_active_love_put',
        'love_api_active_love_put_malformed',
      ])
        db.exec(`DROP INDEX ${index}`);
      for (const table of [
        'love_api_unlove_decisions',
        'love_api_window_owners',
        'love_api_recipient_members',
        'love_api_recipients',
        'love_api_bindings',
        'love_api_comparison_facts',
        'love_api_intent_epochs',
        'love_api_proof_state',
      ])
        db.exec(`DROP TABLE ${table}`);
      db.run('DELETE FROM schema_migrations WHERE version=57');
    });
    expect(migrate(db, MIGRATIONS.slice(0, 56))).toEqual({ status: 'ready', version: 56 });
  } finally {
    db.close();
  }
}

function downgradeFixtureTo55(path: string): void {
  downgradeFixtureTo56(path);
  const db = openSqliteDb(path, { busyTimeoutMs: BUSY_MS });
  try {
    db.tx(() => {
      db.exec('DROP INDEX forward_outbox_unlove_authority_dependency');
      for (const table of [
        'forward_deferred_love_intents',
        'forward_deferred_love_witnesses',
        'forward_deferred_love_authorities',
        'forward_deferred_love_heads',
        'forward_love_delivery',
        'forward_deferred_love_maintenance',
      ])
        db.exec(`DROP TABLE ${table}`);
      db.run('DELETE FROM schema_migrations WHERE version=56');
    });
    expect(migrate(db, MIGRATIONS.slice(0, 55))).toEqual({ status: 'ready', version: 55 });
  } finally {
    db.close();
  }
}

function boxOf(doc: Record<string, unknown>): { box: Box; secrets: Secrets } {
  const secrets = parseSecrets(doc);
  return { box: createBox(secrets.encryptionKeys, seededRandom(1)), secrets };
}

// ---------------------------------------------------------------------------

describe('restore.ts', () => {
  it('retains live receipts and gaps in a readable restore', async () => {
    const world = await buildWorld({
      backupSql: [
        `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
         SELECT 'backup-receipt-row',id,did,'scrobble','backup-receipt','{}','sent',0,10,10,10 FROM linked_accounts WHERE did='${DID_A}'`,
        `INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms)
         SELECT id,generation,'scrobble','backup-receipt',10 FROM linked_accounts WHERE did='${DID_A}'`,
      ],
      liveSql: [
        `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
         SELECT 'live-receipt-row',id,did,'love','live-receipt','{}','sent',0,20,20,20 FROM linked_accounts WHERE did='${DID_A}'`,
        `INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms)
         SELECT id,generation,'love','live-receipt',20 FROM linked_accounts WHERE did='${DID_A}'`,
        `INSERT INTO forward_link_gaps(link_id,generation,from_seq,to_seq,reason,opened_at_ms,closed_at_ms)
         SELECT id,generation,3,8,'revoked',20,25 FROM linked_accounts WHERE did='${DID_A}'`,
      ],
    });
    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(query(world.dbPath, 'SELECT kind,dedupe_key FROM forward_receipts ORDER BY generation,kind')).toEqual([
      { kind: 'love', dedupe_key: 'live-receipt' },
      { kind: 'scrobble', dedupe_key: 'backup-receipt' },
    ]);
    expect(query(world.dbPath, 'SELECT generation,from_seq,to_seq,reason FROM forward_link_gaps')).toEqual([
      { generation: 1, from_seq: 3, to_seq: 8, reason: 'revoked' },
    ]);
    expect(query(world.dbPath, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('restores real acceptance, cancellation, revocation, relink, and backfill across a fresh server composition', async () => {
    const world = await buildWorld();
    const servicePort = await freePort();
    const systemd = new FakeSystemd(world, { servicePort });
    await systemd.boot();
    let liveServer = systemd.server as Started;
    const liveDb = liveServer.server.db;
    const linkId = world.ids.link as string;
    const now = world.clock.nowMs();
    const m = {
      db: liveDb,
      clock: world.clock,
      random: seededRandom(0x22),
      config: liveServer.server.config.app,
      log: captureLog().logger,
    } as unknown as ModuleDeps;
    const makeListen = async (track: string, listenedAt: string) => {
      const result = await acceptListens(m, {
        did: DID_A,
        origin: 'web',
        listens: [{ input: { artist: 'Restore Artist', track, listenedAt } }],
        receiptMs: world.clock.nowMs(),
      });
      const item = result.results[0];
      expect(item?.status).toBe('accepted');
      if (item?.status !== 'accepted' || item.operationId === null) throw new Error('live listen was not accepted');
      return { ...item, operationId: item.operationId };
    };
    const original = getLinkById(liveDb, linkId);
    expect(original).not.toBeNull();
    patchLink({ db: liveDb, clock: world.clock }, DID_A, linkId, { forwardScrobbles: false });
    const cancelled = await makeListen('Cancel then retry', '2026-01-15T11:59:00Z');
    expect(cancelUnsent(liveDb, cancelled.operationId, now + 1)).toBe(true);
    expect(liveDb.one('SELECT state FROM operations WHERE id=?', cancelled.operationId)).toEqual({
      state: 'cancelled',
    });
    patchLink({ db: liveDb, clock: world.clock }, DID_A, linkId, { forwardScrobbles: true });
    const reaccepted = await makeListen('Cancel then retry', '2026-01-15T11:59:00Z');
    expect(liveDb.one('SELECT state FROM operations WHERE id=?', reaccepted.operationId)).toEqual({ state: 'queued' });
    expect(
      liveDb.one('SELECT 1 FROM forward_receipts WHERE link_id=? AND dedupe_key=?', linkId, reaccepted.listenKey),
    ).not.toBeNull();
    patchLink({ db: liveDb, clock: world.clock }, DID_A, linkId, { forwardScrobbles: false });
    const revokedListen = await makeListen('Restore revoked history', '2026-01-15T11:59:30Z');
    expect(revokeLink(liveDb, original!, 'credential_revoked', now + 2)).toBe(true);
    expect(liveDb.one('SELECT status FROM linked_accounts WHERE id=?', linkId)).toEqual({ status: 'revoked' });

    const keys = await fixtureKeys();
    const repo = new SignedRepo(DID_A, keys.alice, { clock: world.clock });
    const proofs = [] as Array<{
      proof: Awaited<ReturnType<typeof verifyRecordProof>>;
      collection: string;
      rkey: string;
    }>;
    for (const operationId of [reaccepted.operationId, revokedListen.operationId]) {
      const operation = liveDb.one<{ collection: string; rkey: string; record_json: string }>(
        'SELECT collection,rkey,record_json FROM operations WHERE id=?',
        operationId,
      )!;
      const record = JSON.parse(operation.record_json) as Record<string, unknown>;
      await repo.put(operation.collection, operation.rkey, record);
      const proof = await verifyRecordProof(await repo.getRecordCar(operation.collection, operation.rkey), {
        did: DID_A,
        collection: operation.collection,
        rkey: operation.rkey,
        signingKey: repo.key.didKey,
      });
      expect(proof.state).toBe('present');
      if (proof.state !== 'present') throw new Error('expected signed live record proof');
      proofs.push({ proof, collection: operation.collection, rkey: operation.rkey });
      const proofNow = fromMs(world.clock.nowMs());
      liveDb.tx(() =>
        applyRecordProof(liveDb, proof, {
          prefix: PREFIX,
          nowNs: proofNow,
          receiptNs: proofNow,
          live: authorizedLiveOptions(liveDb, proof, seededRandom(0x28)).live,
        }),
      );
    }
    expect(liveDb.all('SELECT from_seq,to_seq,reason FROM forward_link_gaps WHERE link_id=?', linkId)).toEqual([
      { from_seq: 0, to_seq: 1, reason: 'disabled' },
      { from_seq: 2, to_seq: null, reason: 'disabled' },
    ]);

    // Backup predates disable, cancel/reaccept, revocation and both verified proof applications.
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--listen', `127.0.0.1:${servicePort}`]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    liveServer = systemd.server as Started;
    const db = liveServer.server.db;
    expect(db.one('SELECT state FROM operations WHERE id=?', cancelled.operationId)).toEqual({ state: 'cancelled' });
    expect(
      db.one('SELECT 1 FROM forward_receipts WHERE link_id=? AND dedupe_key=?', linkId, reaccepted.listenKey),
    ).not.toBeNull();
    for (const { proof } of proofs) {
      const proofNow = fromMs(world.clock.nowMs());
      db.tx(() =>
        applyRecordProof(db, proof, {
          prefix: PREFIX,
          nowNs: proofNow,
          receiptNs: proofNow,
          live: authorizedLiveOptions(db, proof, seededRandom(0x29)).live,
        }),
      );
    }
    const secrets = parseSecrets(world.secretsDoc);
    const box = createBox(secrets.encryptionKeys, seededRandom(0x26));
    const relinked = saveLink(
      { db, clock: world.clock, random: seededRandom(0x27), box },
      { did: DID_A, service: 'lastfm', remoteUser: 'alice', credential: LASTFM_SK },
    );
    expect(relinked.link).toMatchObject({ id: world.ids.link, generation: 1, status: 'active' });
    patchLink({ db, clock: world.clock }, DID_A, linkId, { forwardScrobbles: true });
    db.run("UPDATE users SET indexing_state='current' WHERE did=?", DID_A);
    const revision = db.one<{ backfill_run_revision: number; backfill_state: string }>(
      'SELECT backfill_run_revision,backfill_state FROM linked_accounts WHERE id=?',
      linkId,
    );
    expect(revision?.backfill_state).toBe('pending');
    await runLinkBackfill(db, seededRandom(0x30), world.clock.nowMs(), 1);
    const running = db.one<{
      backfill_run_revision: number;
      backfill_state: string;
      backfill_cursor: string | null;
      backfill_discovery_cursor: string | null;
    }>(
      'SELECT backfill_run_revision,backfill_state,backfill_cursor,backfill_discovery_cursor FROM linked_accounts WHERE id=?',
      linkId,
    );
    expect(running?.backfill_state).toBe('running');
    const progressBeforeCompose = {
      receiptCount: db.one<{ n: number }>('SELECT count(*) AS n FROM forward_receipts WHERE link_id=?', linkId)?.n,
      gapRows: db.all('SELECT from_seq,to_seq,reason FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq', linkId),
    };
    const oldComposition = liveServer.server;
    await systemd.systemctl(['stop', 'atmusic.service']);
    await systemd.systemctl(['start', 'atmusic.service']);
    liveServer = systemd.server as Started;
    expect(liveServer.server).not.toBe(oldComposition);
    const resumedDb = liveServer.server.db;
    expect(
      resumedDb.one(
        'SELECT backfill_state,backfill_run_revision,backfill_cursor,backfill_discovery_cursor FROM linked_accounts WHERE id=?',
        linkId,
      ),
    ).toEqual(running);
    expect(resumedDb.one<{ n: number }>('SELECT count(*) AS n FROM forward_receipts WHERE link_id=?', linkId)?.n).toBe(
      progressBeforeCompose.receiptCount,
    );
    expect(
      resumedDb.all('SELECT from_seq,to_seq,reason FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq', linkId),
    ).toEqual(progressBeforeCompose.gapRows);
    for (let index = 0; index < 10; index++)
      await runLinkBackfill(resumedDb, seededRandom(0x31 + index), world.clock.nowMs(), 1);

    expect(resumedDb.one('SELECT state FROM operations WHERE id=?', cancelled.operationId)).toEqual({
      state: 'cancelled',
    });
    expect(
      resumedDb.one("SELECT count(*) AS n FROM forward_outbox WHERE link_id=? AND kind='scrobble'", linkId),
    ).toEqual({ n: 3 });
    expect(
      resumedDb.one("SELECT count(*) AS n FROM forward_receipts WHERE link_id=? AND kind='scrobble'", linkId),
    ).toEqual({ n: 3 });
    expect(resumedDb.one('SELECT backfill_state FROM linked_accounts WHERE id=?', linkId)).toEqual({
      backfill_state: 'done',
    });
    await systemd.systemctl(['stop', 'atmusic.service']);
    expect(query(world.dbPath, 'PRAGMA foreign_key_check')).toEqual([]);
  }, 30_000);

  it('clears migration-55 state when readable live schema 54 has no receipt or gap tables', async () => {
    const world = await buildWorld({
      backupSql: [
        `INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms)
         SELECT id,generation,'scrobble','backup-only',1 FROM linked_accounts WHERE did='${DID_A}'`,
        `INSERT INTO forward_link_gaps(link_id,generation,from_seq,to_seq,reason,opened_at_ms,closed_at_ms)
         SELECT id,generation,0,1,'disabled',1,2 FROM linked_accounts WHERE did='${DID_A}'`,
      ],
    });
    const oldLivePath = join(world.dir, 'live-schema-54.db');
    const oldLive = openSqliteDb(oldLivePath, { create: true, busyTimeoutMs: BUSY_MS });
    expect(migrate(oldLive, MIGRATIONS.slice(0, 54))).toEqual({ status: 'ready', version: 54 });
    oldLive.run(
      `INSERT INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms)
       VALUES(?,?,'lastfm','alice',X'00','e1',1,1)`,
      world.ids.link!,
      DID_A,
    );
    oldLive.run(
      `INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms)
       VALUES('live-54-row',?,?,'scrobble','live-54-key','{}','sent',0,1,1,1)`,
      world.ids.link!,
      DID_A,
    );
    oldLive.close();

    const liveWorld = { ...world, dbPath: oldLivePath };
    const systemd = new FakeSystemd(liveWorld, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(liveWorld, systemd, [...baseArgs(liveWorld), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const restored = openSqliteDb(oldLivePath, { busyTimeoutMs: BUSY_MS });
    try {
      expect(restored.one('SELECT id FROM forward_outbox WHERE link_id=?', world.ids.link!)).toEqual({
        id: 'live-54-row',
      });
      expect(restored.one('SELECT 1 FROM forward_receipts')).toBeNull();
      expect(restored.one('SELECT 1 FROM forward_link_gaps')).toBeNull();
    } finally {
      restored.close();
    }
    expect(query(oldLivePath, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('migrates a real schema-55 backup to 56 while preserving a readable schema-55 live receipt and gap', async () => {
    const world = await buildWorld({
      backupSql: [
        `INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms)
         SELECT id,generation,'scrobble','schema55-receipt',101 FROM linked_accounts WHERE did='${DID_A}'`,
        `INSERT INTO forward_link_gaps(link_id,generation,from_seq,to_seq,reason,opened_at_ms,closed_at_ms)
         SELECT id,generation,4,7,'disabled','101','102' FROM linked_accounts WHERE did='${DID_A}'`,
      ],
      liveSql: [
        `INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms)
         SELECT id,generation,'scrobble','schema55-live-receipt',201 FROM linked_accounts WHERE did='${DID_A}'`,
        `INSERT INTO forward_link_gaps(link_id,generation,from_seq,to_seq,reason,opened_at_ms,closed_at_ms)
         SELECT id,generation,8,9,'disabled','201','202' FROM linked_accounts WHERE did='${DID_A}'`,
      ],
    });
    const backup55 = join(world.dir, 'backup-schema-55.db');
    const live55 = join(world.dir, 'live-schema-55.db');
    copyFileSync(world.backupPath, backup55);
    copyFileSync(world.dbPath, live55);
    downgradeFixtureTo55(backup55);
    downgradeFixtureTo55(live55);
    expect(query(backup55, 'SELECT max(version) AS v FROM schema_migrations')).toEqual([{ v: 55 }]);
    expect(query(live55, 'SELECT max(version) AS v FROM schema_migrations')).toEqual([{ v: 55 }]);

    const oldWorld = { ...world, dbPath: live55, backupPath: backup55 };
    const systemd = new FakeSystemd(oldWorld, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(oldWorld, systemd, [...baseArgs(oldWorld), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('migrated the copy from version 55 to 57');
    const restored = openSqliteDb(live55, { busyTimeoutMs: BUSY_MS });
    try {
      expect(restored.one('SELECT max(version) AS version FROM schema_migrations')).toEqual({ version: 57 });
      expect(restored.all('SELECT kind,dedupe_key,created_at_ms FROM forward_receipts ORDER BY dedupe_key')).toEqual([
        { kind: 'scrobble', dedupe_key: 'schema55-live-receipt', created_at_ms: 201 },
        { kind: 'scrobble', dedupe_key: 'schema55-receipt', created_at_ms: 101 },
      ]);
      expect(
        restored.all(
          'SELECT from_seq,to_seq,reason FROM forward_link_gaps WHERE link_id=? ORDER BY from_seq',
          world.ids.link!,
        ),
      ).toEqual([
        { from_seq: 4, to_seq: 7, reason: 'disabled' },
        { from_seq: 8, to_seq: 9, reason: 'disabled' },
      ]);
      for (const table of [
        'forward_love_delivery',
        'forward_deferred_love_heads',
        'forward_deferred_love_intents',
        'forward_deferred_love_witnesses',
        'forward_deferred_love_authorities',
        'forward_deferred_love_maintenance',
      ])
        expect(restored.one(`SELECT 1 AS present FROM ${table}`)).toBeNull();
    } finally {
      restored.close();
    }
    expect(query(live55, 'PRAGMA foreign_key_check')).toEqual([]);
  }, 30_000);

  it('migrates real schema-56 backup and live files to 57 through the restore CLI', async () => {
    const world = await buildWorld();
    const backup56 = join(world.dir, 'backup-schema-56.db');
    const live56 = join(world.dir, 'live-schema-56.db');
    copyFileSync(world.backupPath, backup56);
    copyFileSync(world.dbPath, live56);
    downgradeFixtureTo56(backup56);
    downgradeFixtureTo56(live56);
    expect(query(backup56, 'SELECT max(version) AS v FROM schema_migrations')).toEqual([{ v: 56 }]);
    expect(query(live56, 'SELECT max(version) AS v FROM schema_migrations')).toEqual([{ v: 56 }]);

    const oldWorld = { ...world, dbPath: live56, backupPath: backup56 };
    const systemd = new FakeSystemd(oldWorld, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(oldWorld, systemd, [...baseArgs(oldWorld), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('migrated the copy from version 56 to 57');
    const restored = openSqliteDb(live56, { busyTimeoutMs: BUSY_MS });
    try {
      expect(restored.one('SELECT max(version) AS version FROM schema_migrations')).toEqual({ version: 57 });
      expect(
        restored.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'love_api_%' ORDER BY name"),
      ).toHaveLength(8);
      expect(
        restored.all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'love_api_%' ORDER BY name"),
      ).toHaveLength(9);
      for (const table of LOVE_API_TABLES)
        expect(restored.one(`SELECT count(*) AS count FROM ${table}`), table).toEqual({ count: 0 });
    } finally {
      restored.close();
    }
    expect(query(live56, 'PRAGMA foreign_key_check')).toEqual([]);
  }, 30_000);

  it('restores populated schema-57 API-love proof rows from live after operation and sent-outbox cleanup', async () => {
    let liveUri: string | null = null;
    const world = await buildWorld({
      beforeBackup: ({ db, clock, linkId }) => {
        populateDeferredLoveState(db, clock, linkId, 'Backup');
        populateLoveApiProofState(db, clock, linkId, 'Backup');
      },
      afterBackup: ({ db, clock, linkId }) => {
        populateDeferredLoveState(db, clock, linkId, 'Live');
        liveUri = populateLoveApiProofState(db, clock, linkId, 'Live');
        db.run('DELETE FROM operations WHERE id=?', 'live-api-put');
        db.run("DELETE FROM forward_outbox WHERE id='live-api-sent-row'");
      },
    });
    expect(liveUri).not.toBeNull();
    for (const table of LOVE_API_TABLES) {
      expect(query(world.backupPath, `SELECT count(*) AS count FROM ${table}`)[0]?.count, `${table} backup`).toBe(1);
      const expectedLiveRows = table === 'love_api_intent_epochs' || table === 'love_api_proof_state' ? 1 : 2;
      expect(query(world.dbPath, `SELECT count(*) AS count FROM ${table}`)[0]?.count, `${table} live`).toBe(
        expectedLiveRows,
      );
    }
    expect(query(world.backupPath, 'SELECT api_origin FROM love_api_bindings')).toEqual([{ api_origin: 'lastfm' }]);
    expect(query(world.dbPath, 'SELECT api_origin,operation_id FROM love_api_bindings ORDER BY operation_id')).toEqual([
      { api_origin: 'lastfm', operation_id: 'backup-api-put' },
      { api_origin: 'lastfm', operation_id: 'live-api-put' },
    ]);
    expect(query(world.dbPath, "SELECT 1 AS present FROM operations WHERE id='live-api-put'")).toEqual([]);
    expect(query(world.dbPath, "SELECT 1 AS present FROM forward_outbox WHERE id='live-api-sent-row'")).toEqual([]);

    const servicePort = await freePort();
    const systemd = new FakeSystemd(world, { servicePort });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--listen', `127.0.0.1:${servicePort}`]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const db = systemd.server!.server.db;
    expect(db.one('SELECT max(version) AS version FROM schema_migrations')).toEqual({ version: 57 });
    for (const table of LOVE_API_TABLES) {
      const expectedRows = table === 'love_api_intent_epochs' || table === 'love_api_proof_state' ? 1 : 2;
      expect(db.one(`SELECT count(*) AS count FROM ${table}`), table).toEqual({ count: expectedRows });
    }
    expect(
      db.one('SELECT api_origin,operation_id FROM love_api_bindings WHERE operation_id=?', 'live-api-put'),
    ).toEqual({
      api_origin: 'lastfm',
      operation_id: 'live-api-put',
    });
    expect(db.one('SELECT state,sent_operation_id FROM love_api_recipients WHERE uri=?', liveUri)).toEqual({
      state: 'sealed',
      sent_operation_id: 'live-api-put',
    });
    expect(db.one('SELECT 1 FROM operations WHERE id=?', 'live-api-put')).toBeNull();
    expect(db.one('SELECT 1 FROM forward_outbox WHERE id=?', 'live-api-sent-row')).toBeNull();
    expect(
      materializeLoveApiRecipientDecisions(db, world.clock.nowMs(), seededRandom(77), 'restore-fresh-session'),
    ).toMatchObject({ visited: 2, awaiting: 2, queued: 0, refused: 0 });
    const l2Timer = systemd
      .server!.server.features.features.flatMap((feature) => feature.extensions ?? [])
      .find((extension) => extension.name === 'link-backfill')?.timers?.['link-backfill'];
    expect(l2Timer).toBeTypeOf('function');
    const scheduled: number[] = [];
    const timerNow = world.clock.nowMs() + 2_000;
    const timerContext = {
      schedule: (_name: 'link-backfill', at: number) => {
        scheduled.push(at);
        return at;
      },
      kick: () => null,
    } as unknown as ExtensionContext;
    let finalTimerNow = timerNow;
    for (let turn = 0; turn < 8; turn++) {
      finalTimerNow = timerNow + turn * 1_000;
      await l2Timer!(finalTimerNow, timerContext);
      const due = db.one<{ due: number }>('SELECT min(due_at_ms) AS due FROM love_api_unlove_decisions')?.due;
      if (due !== undefined && due > finalTimerNow) break;
    }
    expect(scheduled.length).toBeGreaterThan(0);
    expect(db.one<{ due: number }>('SELECT min(due_at_ms) AS due FROM love_api_unlove_decisions')!.due).toBeGreaterThan(
      timerNow,
    );
    expect(reclaimLoveApiProofRows(db, world.clock.nowMs())).toMatchObject({ visited: 2, bindingsDeleted: 0 });
    expect(db.one('SELECT api_origin FROM love_api_bindings WHERE operation_id=?', 'live-api-put')).toEqual({
      api_origin: 'lastfm',
    });
    await stopServer(systemd.server!.server);
    systemd.server = null;
    expect(query(world.dbPath, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(query(world.backupPath, 'PRAGMA foreign_key_check')).toEqual([]);
  }, 30_000);

  it('restores producer-derived API love proof after real PDS SENT, verified absence, and both remote deliveries', async () => {
    const world = await buildWorld();
    const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    let source: Awaited<ReturnType<typeof produceApiLoveWithRealPds>> | null = null;
    let absenceRev = '';
    try {
      source = await produceApiLoveWithRealPds(db, world.clock, 'Live');
      const firstDelivery = await dispatchRestoreLoveTransports(db, world.clock.nowMs());
      expect(firstDelivery.report.requests).toBe(2);
      expect(firstDelivery.lastfmRequests).toEqual(['track.love']);
      expect(firstDelivery.listenbrainzRequests).toEqual([
        { recording_mbid: '12345678-1234-1234-1234-123456789abc', score: 1 },
      ]);
      const apiOperation = db.one<{ state: string; result_uri: string | null; rkey: string }>(
        'SELECT state,result_uri,rkey FROM operations WHERE id=?',
        source.operationId,
      );
      expect(apiOperation).toMatchObject({ state: 'succeeded', result_uri: source.uri });
      expect(
        db.one('SELECT api_origin FROM love_api_bindings WHERE did=? AND operation_id=?', DID_A, source.operationId),
      ).toEqual({ api_origin: 'lastfm' });
      const presentProof = await verifyRecordProof(
        await source.kit.repos.Alice.getRecordCar(LOVE_COLLECTION, source.rkey),
        {
          did: DID_A,
          collection: LOVE_COLLECTION,
          rkey: source.rkey,
          signingKey: source.kit.users.Alice.key.didKey,
        },
      );
      expect(presentProof.state).toBe('present');
      if (presentProof.state !== 'present') throw new Error('expected actual PDS present proof');
      const proofNow = fromMs(world.clock.nowMs());
      db.tx(() =>
        applyRecordProof(db, presentProof, {
          prefix: PREFIX,
          nowNs: proofNow,
          receiptNs: proofNow,
          live: authorizedLiveOptions(db, presentProof, seededRandom(0x73)).live,
        }),
      );
      const incarnation = db.one<{ incarnation_key: string }>(
        "SELECT incarnation_key FROM love_incarnations WHERE uri=? AND state='present'",
        source.uri,
      )!;
      const loveRow = db.one<{
        uri: string;
        cid: string;
        artist_key: string;
        track_key: string;
        artist: string;
        track: string;
        recording_mbid: string | null;
      }>('SELECT uri,cid,artist_key,track_key,artist,track,recording_mbid FROM loves WHERE uri=?', source.uri)!;
      const laterLove = await enqueueLove(source.m, {
        did: DID_A,
        input: { artist: 'Producer restore pending', track: 'Member survives restore' },
        origin: 'web',
      });
      if (!laterLove.ok) throw new Error(`pending restore API love rejected: ${laterLove.reason.code}`);
      await runOutbox(source.m, world.clock.nowMs());
      expect(db.one('SELECT state FROM operations WHERE id=?', laterLove.operation.id)).toEqual({ state: 'succeeded' });
      expect(db.one('SELECT count(*) AS n FROM love_api_recipient_members')).toEqual({ n: 2 });

      const lastfmLink = getLinkById(db, world.ids.link!);
      const listenbrainzLink = getLinkById(db, source.listenbrainzLink);
      if (lastfmLink === null || listenbrainzLink === null) throw new Error('producer recipient link is missing');
      expect(revokeLink(db, lastfmLink, 'credential_revoked', world.clock.nowMs())).toBe(true);
      expect(
        patchLink({ db, clock: world.clock }, DID_A, listenbrainzLink.id, { forwardScrobbles: false }),
      ).not.toBeNull();

      const deleteCommit = await source.kit.externalDelete('Alice', LOVE_COLLECTION, source.rkey);
      const absentProof = await verifyRecordProof(
        await source.kit.repos.Alice.getRecordCar(LOVE_COLLECTION, source.rkey),
        {
          did: DID_A,
          collection: LOVE_COLLECTION,
          rkey: source.rkey,
          signingKey: source.kit.users.Alice.key.didKey,
        },
      );
      expect(absentProof.state).toBe('absent');
      if (absentProof.state !== 'absent') throw new Error('expected actual PDS absence proof');
      absenceRev = absentProof.commit.rev;
      recordPendingRemovals(db, [
        {
          did: DID_A,
          uri: source.uri,
          kind: 'love',
          row: {
            uri: loveRow.uri,
            cid: loveRow.cid,
            listened_at: new Date(world.clock.nowMs()).toISOString(),
            artist_key: loveRow.artist_key,
            track_key: loveRow.track_key,
            artist: loveRow.artist,
            track: loveRow.track,
            recording_mbid: loveRow.recording_mbid,
            record_uri: null,
            listen_id: null,
          },
          identityKey: incarnation.incarnation_key,
          windowLo: presentProof.commit.rev,
          windowHi: deleteCommit.rev,
          replacedByCid: null,
          nowMs: world.clock.nowMs(),
        },
      ]);
      recordLiveEvidence(
        db,
        {
          uri: source.uri,
          did: DID_A,
          collection: LOVE_COLLECTION,
          rkey: source.rkey,
          rev: absenceRev,
          action: 'delete',
        },
        world.clock.nowMs(),
      );
      db.tx(() =>
        applyRecordProof(db, absentProof, {
          prefix: PREFIX,
          nowNs: fromMs(world.clock.nowMs()),
          receiptNs: fromMs(world.clock.nowMs()),
          live: authorizedLiveOptions(db, absentProof, seededRandom(0x74)).live,
        }),
      );
      expect(db.one('SELECT count(*) AS n FROM love_api_window_owners')).toEqual({ n: 2 });
      expect(db.one('SELECT count(*) AS n FROM love_api_unlove_decisions')).toEqual({ n: 2 });
      expect(
        db.one('SELECT count(*) AS n FROM love_api_comparison_facts WHERE authorization_rev=?', absenceRev),
      ).toEqual({
        n: 1,
      });
      const sentRows = db.all<{ id: string }>(
        "SELECT id FROM forward_outbox WHERE kind='love' AND dedupe_key=? AND state='sent'",
        source.operationId,
      );
      expect(sentRows).toHaveLength(2);
      db.run('DELETE FROM operations WHERE id=?', source.operationId);
      for (const row of sentRows) db.run('DELETE FROM forward_outbox WHERE id=?', row.id);
      expect(db.one('SELECT 1 FROM operations WHERE id=?', source.operationId)).toBeNull();
      expect(db.one("SELECT 1 FROM forward_outbox WHERE kind='love' AND dedupe_key=?", source.operationId)).toBeNull();
      expect(db.one('SELECT api_origin FROM love_api_bindings WHERE operation_id=?', source.operationId)).toEqual({
        api_origin: 'lastfm',
      });
    } finally {
      db.close();
    }

    const servicePort = await freePort();
    const systemd = new FakeSystemd(world, { servicePort });
    await systemd.boot();
    const priorServer = systemd.server;
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--listen', `127.0.0.1:${servicePort}`]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(systemd.server).not.toBe(priorServer);
    const restored = systemd.server!.server.db;
    expect(restored.one('SELECT max(version) AS version FROM schema_migrations')).toEqual({ version: 57 });
    for (const table of LOVE_API_TABLES) expect(restored.one(`SELECT 1 FROM ${table} LIMIT 1`), table).not.toBeNull();
    expect(restored.one('SELECT api_origin FROM love_api_bindings WHERE operation_id=?', source!.operationId)).toEqual({
      api_origin: 'lastfm',
    });
    expect(restored.one('SELECT 1 FROM operations WHERE id=?', source!.operationId)).toBeNull();
    expect(
      restored.one("SELECT 1 FROM forward_outbox WHERE kind='love' AND dedupe_key=?", source!.operationId),
    ).toBeNull();
    expect(restored.one('SELECT count(*) AS n FROM love_api_unlove_decisions')).toEqual({ n: 2 });
    const timer = systemd
      .server!.server.features.features.flatMap((feature) => feature.extensions ?? [])
      .find((extension) => extension.name === 'link-backfill')?.timers?.['link-backfill'];
    expect(timer).toBeTypeOf('function');
    const scheduled: number[] = [];
    const timerNow = world.clock.nowMs() + 2_000;
    const timerContext = {
      schedule: (_name: 'link-backfill', at: number) => {
        scheduled.push(at);
        return at;
      },
      kick: () => null,
    } as unknown as ExtensionContext;
    const recipientLinkIds = restored.all<{ id: string; generation: number }>(
      "SELECT id,generation FROM linked_accounts WHERE did=? AND service IN ('lastfm','listenbrainz') ORDER BY service",
      DID_A,
    );
    expect(recipientLinkIds).toHaveLength(2);
    const generationByLink = new Map(recipientLinkIds.map((row) => [row.id, row.generation]));
    const lastfmRow = recipientLinkIds
      .map(({ id }) => getLinkById(restored, id))
      .find((row) => row?.service === 'lastfm');
    const listenbrainzRow = recipientLinkIds
      .map(({ id }) => getLinkById(restored, id))
      .find((row) => row?.service === 'listenbrainz');
    if (lastfmRow === undefined || lastfmRow === null || listenbrainzRow === undefined || listenbrainzRow === null)
      throw new Error('restored API recipient links are missing');
    expect(lastfmRow.status).toBe('revoked');
    expect(listenbrainzRow.forward_scrobbles).toBe(0);
    for (let turn = 0; turn < 4; turn++) {
      await timer!(timerNow + turn * 1_000, timerContext);
      if (restored.one<{ n: number }>('SELECT count(*) AS n FROM love_api_unlove_decisions')?.n === 0) break;
    }
    expect(scheduled.length).toBeGreaterThan(0);
    expect(restored.one('SELECT count(*) AS n FROM love_api_unlove_decisions')).toEqual({ n: 0 });
    expect(
      restored.one<{ n: number }>(
        `SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove' AND authorization_uri=?`,
        source!.uri,
      )?.n,
    ).toBe(0);
    const pausedDispatch = await dispatchRestoreLoveTransports(restored, timerNow + 1_000);
    expect(pausedDispatch.report.requests).toBe(0);
    expect(pausedDispatch.lastfmRequests).toEqual([]);
    expect(pausedDispatch.listenbrainzRequests).toEqual([]);
    const restoreBox = createBox(parseSecrets(world.secretsDoc).encryptionKeys, seededRandom(0x75));
    expect(
      saveLink(
        { db: restored, clock: world.clock, random: seededRandom(0x76), box: restoreBox },
        {
          did: DID_A,
          service: 'lastfm',
          remoteUser: lastfmRow.remote_user,
          credential: 'resume-fixture-token',
        },
      ).link.generation,
    ).toBe(generationByLink.get(lastfmRow.id));
    expect(
      patchLink({ db: restored, clock: world.clock }, DID_A, listenbrainzRow.id, { forwardScrobbles: true })
        ?.generation,
    ).toBe(generationByLink.get(listenbrainzRow.id));
    restored.run("UPDATE users SET indexing_state='current' WHERE did=?", DID_A);
    // The fixture has already sealed its source-history frontier; resume the real
    // production coverage lane without asking restore to fetch another history page.
    restored.run(
      "UPDATE linked_accounts SET backfill_state='running',backfill_discovery_done=1 WHERE did=? AND status='active' AND forward_scrobbles=1",
      DID_A,
    );
    for (let turn = 0; turn < 4; turn++) await timer!(timerNow + 30_000 + turn * 1_000, timerContext);
    const queuedUnloves = restored.all<{ service: string; state: string }>(
      `SELECT l.service,o.state FROM forward_outbox o JOIN linked_accounts l ON l.id=o.link_id
       WHERE o.kind='unlove' AND o.authorization_uri=?`,
      source!.uri,
    );
    expect(queuedUnloves).toHaveLength(2);
    expect(queuedUnloves.filter((row) => row.service === 'lastfm')).toHaveLength(1);
    expect(queuedUnloves.filter((row) => row.service === 'listenbrainz')).toHaveLength(1);
    expect(
      restored.one(
        `SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove' AND authorization_uri=?
         AND dedupe_key LIKE '%:api-recipient'`,
        source!.uri,
      ),
    ).toEqual({ n: 2 });
    const dispatchedLastfm: string[] = [];
    const dispatchedListenbrainz: unknown[] = [];
    let requestCount = 0;
    for (let turn = 0; turn < 8; turn++) {
      const dispatch = await dispatchRestoreLoveTransports(restored, timerNow + 1_000 + turn * 10_000);
      requestCount += dispatch.report.requests;
      dispatchedLastfm.push(...dispatch.lastfmRequests);
      dispatchedListenbrainz.push(...dispatch.listenbrainzRequests);
      const sent = restored.one<{ n: number }>(
        `SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove' AND authorization_uri=? AND state='sent'`,
        source!.uri,
      )?.n;
      if (sent === 2) break;
    }
    expect(requestCount).toBeGreaterThanOrEqual(2);
    expect(dispatchedLastfm.filter((method) => method === 'track.unlove')).toHaveLength(1);
    expect(dispatchedListenbrainz).toContainEqual({
      recording_mbid: '12345678-1234-1234-1234-123456789abc',
      score: 0,
    });
    expect(dispatchedListenbrainz.filter((request) => (request as { score?: number }).score === 0)).toHaveLength(1);
    const secondDispatch = await dispatchRestoreLoveTransports(restored, timerNow + 90_000);
    expect(secondDispatch.report.requests).toBe(0);
    await stopServer(systemd.server!.server);
    systemd.server = null;
    expect(query(world.dbPath, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(absenceRev).not.toBe('');
  }, 30_000);

  it('merges populated schema-56 love state from the readable live DB and reopens it in a fresh server composition', async () => {
    let backupUnlove: string | null = null;
    const world = await buildWorld({
      beforeBackup: ({ db, clock, linkId }) => {
        backupUnlove = populateDeferredLoveState(db, clock, linkId, 'Backup');
      },
      afterBackup: ({ db, clock, linkId }) => {
        expect(backupUnlove).not.toBeNull();
        expect(cancelUnsent(db, backupUnlove!, clock.nowMs())).toBe(true);
        expect(db.one('SELECT 1 FROM forward_deferred_love_intents WHERE operation_id=?', backupUnlove!)).toBeNull();
        populateDeferredLoveState(db, clock, linkId, 'Live');
      },
    });
    for (const table of [
      'forward_love_delivery',
      'forward_deferred_love_heads',
      'forward_deferred_love_intents',
      'forward_deferred_love_witnesses',
      'forward_deferred_love_authorities',
      'forward_deferred_love_maintenance',
    ]) {
      expect(query(world.backupPath, `SELECT count(*) AS n FROM ${table}`)[0]?.n).toBeGreaterThan(0);
      expect(query(world.dbPath, `SELECT count(*) AS n FROM ${table}`)[0]?.n).toBeGreaterThan(0);
    }
    expect(
      query(
        world.backupPath,
        'SELECT count(*) AS n FROM forward_deferred_love_intents WHERE operation_id=?',
        'backup-deferred-unlove',
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      query(
        world.dbPath,
        'SELECT count(*) AS n FROM forward_deferred_love_intents WHERE operation_id=?',
        'backup-deferred-unlove',
      ),
    ).toEqual([{ n: 0 }]);

    const servicePort = await freePort();
    const systemd = new FakeSystemd(world, { servicePort });
    await systemd.boot();
    const priorComposition = systemd.server;
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--listen', `127.0.0.1:${servicePort}`]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(systemd.server).not.toBe(priorComposition);
    const db = systemd.server!.server.db;
    expect(db.one('SELECT max(version) AS version FROM schema_migrations')).toEqual({ version: 57 });
    expect(
      db.one("SELECT last_sent_dedupe_key FROM forward_love_delivery WHERE last_sent_dedupe_key='live-delivery-love'"),
    ).not.toBeNull();
    expect(
      db.one("SELECT operation_id FROM forward_deferred_love_intents WHERE operation_id='live-deferred-unlove'"),
    ).toEqual({
      operation_id: 'live-deferred-unlove',
    });
    expect(
      db.one("SELECT operation_id FROM forward_deferred_love_witnesses WHERE operation_id='live-deferred-unlove'"),
    ).toEqual({
      operation_id: 'live-deferred-unlove',
    });
    expect(
      db.one(
        "SELECT authorization_uri FROM forward_deferred_love_authorities WHERE authorization_uri LIKE '%live-authorized-unlove'",
      ),
    ).not.toBeNull();
    const allocator = db.one<{ next_head_seq: number; next_group_seq: number; next_authority_seq: number }>(
      'SELECT next_head_seq,next_group_seq,next_authority_seq FROM forward_deferred_love_maintenance',
    )!;
    const frontier = db.one<{
      head_seq: number;
      armed_seq: number;
      group_seq: number;
      authority_seq: number;
      due_seq: number;
      maintenance_seq: number;
    }>(
      `SELECT (SELECT coalesce(max(head_seq),0) FROM forward_deferred_love_heads) AS head_seq,
         (SELECT coalesce(max(armed_seq),0) FROM forward_deferred_love_heads) AS armed_seq,
         (SELECT coalesce(max(maintenance_seq),0) FROM forward_deferred_love_heads) AS maintenance_seq,
         (SELECT coalesce(max(group_seq),0) FROM forward_deferred_love_witnesses) AS group_seq,
         (SELECT coalesce(max(authority_seq),0) FROM forward_deferred_love_authorities) AS authority_seq,
         (SELECT coalesce(max(due_seq),0) FROM forward_deferred_love_authorities) AS due_seq`,
    )!;
    expect(allocator.next_head_seq).toBeGreaterThan(frontier.head_seq);
    expect(allocator.next_head_seq).toBeGreaterThan(frontier.armed_seq);
    expect(allocator.next_head_seq).toBeGreaterThan(frontier.maintenance_seq);
    expect(allocator.next_group_seq).toBeGreaterThan(frontier.group_seq);
    expect(allocator.next_authority_seq).toBeGreaterThan(frontier.authority_seq);
    expect(allocator.next_authority_seq).toBeGreaterThan(frontier.due_seq);
    expect(
      db.one(
        `SELECT i.operation_id FROM forward_deferred_love_intents i JOIN forward_deferred_love_authorities a
           ON a.authorization_uri=i.authorization_uri AND a.authorization_rev=i.authorization_rev
         WHERE i.operation_id='live-deferred-unlove' AND a.state='active'`,
      ),
    ).toEqual({ operation_id: 'live-deferred-unlove' });
    expect(
      db.one(
        `SELECT count(*) AS n FROM forward_deferred_love_heads h
         JOIN forward_love_delivery d ON d.link_id=h.link_id AND d.generation=h.generation
           AND d.love_artist_key=h.love_artist_key AND d.love_track_key=h.love_track_key
         JOIN forward_deferred_love_intents i ON i.link_id=h.link_id AND i.generation=h.generation
           AND i.love_artist_key=h.love_artist_key AND i.love_track_key=h.love_track_key
         JOIN forward_deferred_love_witnesses w ON w.link_id=i.link_id AND w.generation=i.generation
           AND w.operation_id=i.operation_id
         JOIN forward_deferred_love_authorities a ON a.authorization_uri=i.authorization_uri
           AND a.authorization_rev=i.authorization_rev
         WHERE i.operation_id='live-deferred-unlove' AND i.kind='unlove' AND w.kind=i.kind
           AND w.love_artist_key=i.love_artist_key AND w.love_track_key=i.love_track_key
           AND w.authorization_uri=i.authorization_uri AND w.authorization_rev=i.authorization_rev
           AND a.state='active' AND d.last_sent_kind='love' AND d.last_sent_dedupe_key='live-delivery-love'`,
      ),
    ).toEqual({ n: 1 });
    const headSequences = db.one<{ next_seq: number; live_from_seq: number; intent_seq: number }>(
      `SELECT h.next_seq,h.live_from_seq,max(i.intent_seq) AS intent_seq FROM forward_deferred_love_heads h
       JOIN forward_deferred_love_intents i USING(link_id,generation,love_artist_key,love_track_key)
       WHERE i.operation_id='live-deferred-unlove' GROUP BY h.link_id,h.generation,h.love_artist_key,h.love_track_key`,
    )!;
    expect(headSequences.next_seq).toBeGreaterThan(headSequences.intent_seq);
    expect(headSequences.live_from_seq).toBeLessThanOrEqual(headSequences.next_seq);
    expect(db.one('SELECT 1 FROM forward_deferred_love_intents WHERE operation_id=?', backupUnlove!)).toBeNull();
    for (const table of [
      'forward_love_delivery',
      'forward_deferred_love_heads',
      'forward_deferred_love_intents',
      'forward_deferred_love_witnesses',
      'forward_deferred_love_authorities',
      'forward_deferred_love_maintenance',
    ])
      expect(db.one(`SELECT 1 FROM ${table} LIMIT 1`)).not.toBeNull();
    patchLink({ db, clock: world.clock }, DID_A, world.ids.link!, { forwardScrobbles: true });
    db.run("UPDATE users SET indexing_state='current' WHERE did=?", DID_A);
    const extensions = systemd.server!.server.features.features.flatMap((feature) => feature.extensions ?? []);
    const backfillTimer = extensions.find((extension) => extension.name === 'link-backfill')?.timers?.['link-backfill'];
    expect(backfillTimer).toBeTypeOf('function');
    const scheduled: number[] = [];
    const timerContext = {
      schedule: (_name: string, at: number) => {
        scheduled.push(at);
        return at;
      },
      kick: () => null,
    } as unknown as ExtensionContext;
    for (let turn = 0; turn < 8; turn++) {
      await backfillTimer!(world.clock.nowMs() + turn, timerContext);
      if (db.one("SELECT 1 FROM forward_outbox WHERE kind='unlove' AND state='queued'") !== null) break;
    }
    for (let turn = 8; turn < 16; turn++) {
      if (
        db.one<{ backfill_state: string }>('SELECT backfill_state FROM linked_accounts WHERE id=?', world.ids.link!)
          ?.backfill_state === 'done'
      )
        break;
      await backfillTimer!(world.clock.nowMs() + turn, timerContext);
    }
    expect(db.one('SELECT backfill_state FROM linked_accounts WHERE id=?', world.ids.link!)).toEqual({
      backfill_state: 'done',
    });
    expect(scheduled.length).toBeGreaterThan(0);
    expect(
      db.one("SELECT state FROM forward_outbox WHERE kind='unlove' AND dedupe_key='live-deferred-unlove'"),
    ).toEqual({ state: 'queued' });
    const laterLove = await enqueueLove(systemd.server!.server.app.core.deps, {
      did: DID_A,
      input: {
        artist: 'Restore Matrix Artist',
        track: 'Live shared track',
        recordingMbid: '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae',
      },
      origin: 'web',
    });
    expect(laterLove.ok).toBe(true);
    if (!laterLove.ok) throw new Error('restore fixture later API love was rejected');
    expect(db.one('SELECT state FROM operations WHERE id=?', laterLove.operation.id)).toEqual({ state: 'queued' });
    runDeferredLoveMaintenance(db, world.clock.nowMs() + 20_000);
    expect(cancelUnsent(db, laterLove.operation.id, world.clock.nowMs() + 21_000)).toBe(true);
    runDeferredLoveMaintenance(db, world.clock.nowMs() + 22_000);
    expect(
      db.one(
        "SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove' AND dedupe_key='live-deferred-unlove' AND state='queued'",
      ),
    ).toEqual({ n: 1 });
    expect(
      db.one("SELECT value FROM counters WHERE name='link_coverage' AND label='deferred_coverage_unlove'"),
    ).toEqual({ value: 1 });
    const feedbacks: unknown[] = [];
    for (let turn = 0; turn < 8; turn++) {
      const delivered = await dispatchListenbrainz(db, world.clock.nowMs() + 10_000 + turn * 10_000);
      feedbacks.push(...delivered.feedbacks);
      if (
        db.one(
          "SELECT 1 FROM forward_outbox WHERE kind='unlove' AND dedupe_key='live-deferred-unlove' AND state='sent'",
        ) !== null
      )
        break;
    }
    expect(feedbacks).toContainEqual({ recording_mbid: '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae', score: 0 });
    expect(
      db.one("SELECT state FROM forward_outbox WHERE kind='unlove' AND dedupe_key='live-deferred-unlove'"),
    ).toEqual({ state: 'sent' });
    expect(
      db.one(
        "SELECT last_sent_kind,last_sent_dedupe_key FROM forward_love_delivery WHERE last_sent_dedupe_key='live-deferred-unlove'",
      ),
    ).toEqual({ last_sent_kind: 'unlove', last_sent_dedupe_key: 'live-deferred-unlove' });
    await stopServer(systemd.server!.server);
    systemd.server = null;
    expect(query(world.dbPath, 'PRAGMA foreign_key_check')).toEqual([]);
  }, 30_000);

  it('keeps populated schema-56 live and backup state intact when the completed merge fails before the file swap', async () => {
    const world = await buildWorld({
      beforeBackup: ({ db, clock, linkId }) => {
        populateDeferredLoveState(db, clock, linkId, 'Backup');
      },
      afterBackup: ({ db, clock, linkId }) => {
        populateDeferredLoveState(db, clock, linkId, 'Live');
      },
    });
    const backupBytes = readFileSync(world.backupPath);
    const liveBefore = restoreB2Snapshot(world.dbPath);
    const backupBefore = restoreB2Snapshot(world.backupPath);
    for (const table of [
      'forward_love_delivery',
      'forward_deferred_love_heads',
      'forward_deferred_love_intents',
      'forward_deferred_love_witnesses',
      'forward_deferred_love_authorities',
      'forward_deferred_love_maintenance',
    ]) {
      expect(query(world.dbPath, `SELECT count(*) AS n FROM ${table}`)[0]?.n).toBeGreaterThan(0);
      expect(query(world.backupPath, `SELECT count(*) AS n FROM ${table}`)[0]?.n).toBeGreaterThan(0);
    }
    const servicePort = await freePort();
    const systemd = new FakeSystemd(world, { servicePort });
    await systemd.boot();
    const result = await restoreCli(
      world,
      systemd,
      [...baseArgs(world), '--listen', `127.0.0.1:${servicePort}`],
      (step) => {
        if (step === 'merged') throw new Error('injected after complete six-table merge');
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed (Error)');
    expect(result.stderr).toContain('both units are left stopped');
    expect(systemd.server).toBeNull();
    expect(restoreB2Snapshot(world.dbPath)).toBe(liveBefore);
    expect(restoreB2Snapshot(world.backupPath)).toBe(backupBefore);
    expect(readFileSync(world.backupPath).equals(backupBytes)).toBe(true);
    expect(restoreB2Snapshot(`${world.dbPath}.pre-restore`)).toBe(liveBefore);
    expect(existsSync(`${world.dbPath}.restore.tmp`)).toBe(false);
    expect(existsSync(`${world.dbPath}.restore.tmp-wal`)).toBe(false);
    expect(query(world.dbPath, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(query(`${world.dbPath}.pre-restore`, 'PRAGMA foreign_key_check')).toEqual([]);
  }, 30_000);

  it('keeps the newest live evidence, candidate, and pending removal when a readable restore merges an older backup', async () => {
    const uri = `at://${DID_A}/${PREFIX}.scrobble/evidence-restore`;
    const identity = 'listen:restore-candidate';
    const world = await buildWorld({
      backupSql: [
        `INSERT INTO live_record_evidence(uri,did,collection,rkey,up_rev,up_action,up_cid,del_rev,conflict_rev,received_ms,expires_at_ms)
         VALUES('${uri}','${DID_A}','${PREFIX}.scrobble','evidence-restore','2222222222222','create','bafyold',NULL,NULL,1,9999999999999)`,
        `INSERT INTO live_acceptance_candidates(uri,identity_key,kind,member_uri,cid,created_at_ms,expires_at_ms)
         VALUES('${uri}','${identity}','scrobble','${uri}','bafyold',1,9999999999999)`,
        `INSERT INTO live_pending_removals
         (uri,member_uri,removed_cid,kind,window_lo,window_hi,replaced_by_cid,identity_key,artist_key,track_key,artist,track,
          authorized_rev,created_at_ms,expires_at_ms)
         VALUES('${uri}','${uri}','bafyold','scrobble','1111111111111','2222222222222','','${identity}',
          'artist-key','track-key','Artist','Track',NULL,1,9999999999999)`,
        `INSERT INTO live_pending_removal_events(uri,rev,action,cid,created_at_ms,expires_at_ms)
         VALUES('${uri}','2222222222222','delete','',1,9999999999999)`,
        `INSERT INTO live_pending_removal_reconcile(uri,window_lo,window_hi,replaced_by_cid,cursor_rev,next_due_ms,created_at_ms)
         VALUES('${uri}','1111111111111','2222222222222','','1111111111111',1,1)`,
      ],
      liveSql: [
        `UPDATE live_record_evidence SET up_rev='3333333333333',up_action='update',up_cid='bafynew' WHERE uri='${uri}'`,
        `UPDATE live_acceptance_candidates SET cid='bafynew',created_at_ms=2 WHERE uri='${uri}' AND identity_key='${identity}'`,
        `UPDATE live_pending_removals SET authorized_rev='2222222222222',expires_at_ms=9999999999998 WHERE uri='${uri}'`,
        `UPDATE live_pending_removals SET conflict_invalidated=1 WHERE uri='${uri}'`,
        `UPDATE live_pending_removal_events SET conflicted=1,cursor_window_hi='2222222222222',scan_complete=0 WHERE uri='${uri}'`,
        `UPDATE live_pending_removal_reconcile SET cursor_rev='2222222222222',next_due_ms=2 WHERE uri='${uri}'`,
      ],
    });
    expect(TABLE_CLASS.live_record_evidence).toBe('non-derived');
    expect(TABLE_CLASS.live_acceptance_candidates).toBe('non-derived');
    expect(TABLE_CLASS.live_pending_removals).toBe('non-derived');
    expect(TABLE_CLASS.live_pending_removal_events).toBe('non-derived');
    expect(TABLE_CLASS.live_pending_removal_reconcile).toBe('non-derived');
    expect(TABLE_CLASS.forward_receipts).toBe('non-derived');
    expect(TABLE_CLASS.forward_link_gaps).toBe('non-derived');
    expect(TABLE_CLASS.forward_love_delivery).toBe('non-derived');
    expect(TABLE_CLASS.forward_deferred_love_heads).toBe('non-derived');
    expect(TABLE_CLASS.forward_deferred_love_intents).toBe('non-derived');
    expect(TABLE_CLASS.forward_deferred_love_witnesses).toBe('non-derived');
    expect(TABLE_CLASS.forward_deferred_love_authorities).toBe('non-derived');
    expect(TABLE_CLASS.forward_deferred_love_maintenance).toBe('non-derived');
    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    try {
      expect(db.one('SELECT up_rev,up_action,up_cid FROM live_record_evidence WHERE uri=?', uri)).toEqual({
        up_rev: '3333333333333',
        up_action: 'update',
        up_cid: 'bafynew',
      });
      expect(
        db.one(
          'SELECT cid,created_at_ms FROM live_acceptance_candidates WHERE uri=? AND identity_key=?',
          uri,
          identity,
        ),
      ).toEqual({
        cid: 'bafynew',
        created_at_ms: 2,
      });
      expect(
        db.one('SELECT window_lo,window_hi,authorized_rev,expires_at_ms FROM live_pending_removals WHERE uri=?', uri),
      ).toEqual({
        window_lo: '1111111111111',
        window_hi: '2222222222222',
        authorized_rev: '2222222222222',
        expires_at_ms: 9999999999998,
      });
      expect(
        db.one('SELECT conflicted,cursor_window_hi,scan_complete FROM live_pending_removal_events WHERE uri=?', uri),
      ).toEqual({
        conflicted: 1,
        cursor_window_hi: '2222222222222',
        scan_complete: 0,
      });
      expect(db.one('SELECT cursor_rev,next_due_ms FROM live_pending_removal_reconcile WHERE uri=?', uri)).toEqual({
        cursor_rev: '2222222222222',
        next_due_ms: 2,
      });
      expect(
        executeAuthorizedRemovals(db, { nowMs: world.clock.nowMs(), random: seededRandom(0xa2), limit: 1 }),
      ).toMatchObject({
        groups: 1,
        effects: 0,
      });
      const retainedObservation = {
        window_lo: '1111111111111',
        window_hi: '2222222222222',
        authorized_rev: null,
        expires_at_ms: 9999999999998,
      };
      const pendingObservation = () =>
        db.all('SELECT window_lo,window_hi,authorized_rev,expires_at_ms FROM live_pending_removals WHERE uri=?', uri);
      expect(pendingObservation()).toEqual([retainedObservation]);
      expect(db.one('SELECT cursor_rev,next_due_ms FROM live_pending_removal_reconcile WHERE uri=?', uri)).toEqual({
        cursor_rev: '1111111111111',
        next_due_ms: world.clock.nowMs(),
      });
      expect(nextPendingRemovalDue(db, world.clock.nowMs())).toBe(world.clock.nowMs());
      expect(
        executeAuthorizedRemovals(db, { nowMs: world.clock.nowMs(), random: seededRandom(0xa3), limit: 1 }),
      ).toMatchObject({ groups: 0, effects: 0 });
      expect(pendingObservation()).toEqual([retainedObservation]);
      expect(db.all('SELECT * FROM live_pending_removal_reconcile WHERE uri=?', uri)).toHaveLength(0);
      expect(db.one('SELECT conflicted FROM live_pending_removal_events WHERE uri=?', uri)).toEqual({ conflicted: 1 });
      expect(db.all('SELECT * FROM listenbrainz_deletes')).toHaveLength(0);
      expect(db.all("SELECT * FROM forward_outbox WHERE kind='unlove'")).toHaveLength(0);
      expect(nextPendingRemovalDue(db, world.clock.nowMs())).toBeGreaterThan(world.clock.nowMs());
    } finally {
      db.close();
    }
  }, 60_000);

  it('preserves live non-derived MusicBrainz and cover-art state while rebuilding derived projections from backup', async () => {
    expect(TABLE_CLASS.mb_tracks).toBe('non-derived');
    expect(TABLE_CLASS.mb_cover_art).toBe('non-derived');
    expect(TABLE_CLASS.mb_cover_art_jobs).toBe('non-derived');
    expect(TABLE_CLASS.mb_cover_art_usage).toBe('non-derived');
    const world = await buildWorld();
    const live = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    live.run(`INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,title,artist_credit,created_at_ms)
      VALUES ('artist','late song','','matched','3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10','Late Song','Artist',1)`);
    const imageBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03]);
    const releaseMbid = '01234567-89ab-4cde-8fab-0123456789ab';
    const releaseGroupMbid = '11234567-89ab-4cde-8fab-0123456789ab';
    expect(
      putCoverArt(live, {
        releaseMbid,
        mimeType: 'image/webp',
        bytes: imageBytes,
        nowMs: world.clock.nowMs(),
        budgetBytes: 1024,
      }),
    ).toBe(true);
    enqueueCoverArt(live, releaseMbid, releaseGroupMbid, world.clock.nowMs());
    live.run(
      'UPDATE mb_cover_art_jobs SET attempts=3,next_due_ms=? WHERE release_mbid=?',
      world.clock.nowMs() + 60_000,
      releaseMbid,
    );
    live.close();
    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    try {
      expect(db.one("SELECT title,recording_mbid FROM mb_tracks WHERE track_key='late song'")).toEqual({
        title: 'Late Song',
        recording_mbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
      });
      expect(
        db.one<{
          mime_type: string;
          byte_size: number;
          payload: string;
          created_at_ms: number;
          fetched_at_ms: number;
          last_access_ms: number;
        }>(
          'SELECT mime_type,byte_size,hex(image_bytes) AS payload,created_at_ms,fetched_at_ms,last_access_ms FROM mb_cover_art WHERE release_mbid=?',
          releaseMbid,
        ),
      ).toEqual({
        mime_type: 'image/webp',
        byte_size: imageBytes.length,
        payload: Buffer.from(imageBytes).toString('hex').toUpperCase(),
        created_at_ms: world.clock.nowMs(),
        fetched_at_ms: world.clock.nowMs(),
        last_access_ms: world.clock.nowMs(),
      });
      expect(
        db.one(
          'SELECT release_group_mbid,status,attempts,next_due_ms FROM mb_cover_art_jobs WHERE release_mbid=?',
          releaseMbid,
        ),
      ).toEqual({
        release_group_mbid: releaseGroupMbid,
        status: 'pending',
        attempts: 3,
        next_due_ms: world.clock.nowMs() + 60_000,
      });
      expect(db.one('SELECT used_bytes FROM mb_cover_art_usage')).toEqual({ used_bytes: imageBytes.length });
      expect(db.all('SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }]);
    } finally {
      db.close();
    }
  }, 30_000);

  it('the actual restore CLI keeps love incarnation admissions from live, so reprojecting the same love does not forward a duplicate', async () => {
    const world = await buildWorld();
    const keys = await fixtureKeys();
    const repo = new SignedRepo(DID_A, keys.alice, { clock: world.clock });
    const collection = `${PREFIX}.love`;
    const rkey = '3krestorelove';
    const uri = `at://${DID_A}/${collection}/${rkey}`;
    const love = {
      $type: collection,
      artist: 'Björk',
      track: 'Jóga',
      album: 'Homogenic',
      createdAt: '2026-01-15T11:00:00Z',
    };
    const proof = async () =>
      verifyRecordProof(await repo.getRecordCar(collection, rkey), {
        did: DID_A,
        collection,
        rkey,
        signingKey: repo.key.didKey,
      });
    const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    const project = (recordProof: Awaited<ReturnType<typeof proof>>) => {
      const nowNs = fromMs(world.clock.nowMs());
      return db.tx(() =>
        applyRecordProof(db, recordProof, {
          prefix: PREFIX,
          nowNs,
          receiptNs: nowNs,
          live: authorizedLiveOptions(db, recordProof, seededRandom(0x51)).live,
        }),
      );
    };
    try {
      await repo.put(collection, rkey, love);
      expect(project(await proof()).outcome).toBe('applied');
      expect(TABLE_CLASS.love_incarnations).toBe('non-derived');
      expect(db.one('SELECT count(*) AS n FROM love_incarnations WHERE uri=?', uri)).toEqual({ n: 1 });
      expect(db.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='love'")).toEqual({ n: 1 });
      const incarnationKey = db.one<{ incarnation_key: string }>(
        'SELECT incarnation_key FROM love_incarnations WHERE uri=?',
        uri,
      )!.incarnation_key;
      db.run(
        `INSERT INTO love_import_bridges(did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
         VALUES (?,'restore-import-op',?,?,?,'bound',?)`,
        DID_A,
        uri,
        incarnationKey,
        'listenbrainz',
        world.clock.nowMs(),
      );
      expect(TABLE_CLASS.linked_pull_love_admissions).toBe('non-derived');
      db.run(
        `INSERT INTO linked_pull_love_admissions(
           did,link_id,generation,operation_id,love_key,recording_mbid,source_service,source_account,state,uri,incarnation_key,updated_at_ms
         ) VALUES(?,?,2,'restore-pull-op',?,'00000000-0000-4000-8000-000000000003',
           'listenbrainz','alice-source','present',?,?,?)`,
        DID_A,
        world.ids.link!,
        `artist-key\u0000track-key`,
        uri,
        incarnationKey,
        world.clock.nowMs(),
      );
      expect(TABLE_CLASS.love_delete_bridges).toBe('non-derived');
      db.run(
        `INSERT INTO love_delete_bridges(
           did,uri,incarnation_key,expected_cid,operation_id,state,created_at_ms,delete_rev
         ) VALUES(?,?,?,'bafyreitest','restore-delete-op','succeeded',?,'3lb2aaaaaaa2a')`,
        DID_A,
        uri,
        incarnationKey,
        world.clock.nowMs(),
      );
    } finally {
      db.close();
    }
    expect(query(world.backupPath, 'SELECT count(*) AS n FROM loves')).toEqual([{ n: 0 }]);

    // The post-backup live link generation and its admission clock are
    // non-derived restore state. Rotate at the same fixed time as the
    // admission to prove the boundary is sequence-based, not timestamp-based.
    const generationDb = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    let generationBoundary = 0;
    try {
      const restoreBox = createBox(parseSecrets(world.secretsDoc).encryptionKeys, seededRandom(0x75));
      admitForwardIdentity(generationDb, {
        did: DID_A,
        identityKey: 'restore-generation-admission',
        path: 'api',
        now: world.clock.nowMs(),
      });
      generationBoundary = generationDb.one<{ boundary: number }>(
        'SELECT max(admission_seq) AS boundary FROM forward_admissions',
      )!.boundary;
      const rotated = saveLink(
        { db: generationDb, clock: world.clock, random: seededRandom(0x76), box: restoreBox },
        { did: DID_A, service: 'lastfm', remoteUser: 'alice-v2', credential: LASTFM_SK },
      );
      expect(rotated.link).toMatchObject({ generation: 2, generation_start_seq: generationBoundary });
    } finally {
      generationDb.close();
    }

    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const restored = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(restored.code, `${restored.stdout}\n${restored.stderr}`).toBe(0);
    expect(restored.stdout).toMatch(/love_incarnations\s+1\s+live/);
    expect(restored.stdout).toMatch(/love_import_bridges\s+1\s+live/);
    expect(restored.stdout).toMatch(/linked_pull_love_admissions\s+1\s+live/);
    expect(restored.stdout).toMatch(/love_delete_bridges\s+1\s+live/);
    expect(TABLE_CLASS.love_import_bridges).toBe('non-derived');
    expect(TABLE_CLASS.linked_pull_love_admissions).toBe('non-derived');
    expect(TABLE_CLASS.love_delete_bridges).toBe('non-derived');
    expect(query(world.dbPath, 'SELECT source_service,state FROM love_import_bridges')).toEqual([
      { source_service: 'listenbrainz', state: 'bound' },
    ]);
    expect(
      query(
        world.dbPath,
        'SELECT love_key,recording_mbid,source_service,source_account,state,uri FROM linked_pull_love_admissions',
      ),
    ).toEqual([
      {
        love_key: `artist-key\u0000track-key`,
        recording_mbid: '00000000-0000-4000-8000-000000000003',
        source_service: 'listenbrainz',
        source_account: 'alice-source',
        state: 'present',
        uri,
      },
    ]);
    expect(query(world.dbPath, 'SELECT state,delete_rev FROM love_delete_bridges')).toEqual([
      { state: 'succeeded', delete_rev: '3lb2aaaaaaa2a' },
    ]);
    expect(query(world.dbPath, "SELECT count(*) AS n FROM forward_outbox WHERE kind='love'")).toEqual([{ n: 1 }]);
    expect(
      query(world.dbPath, 'SELECT generation,generation_start_seq FROM linked_accounts WHERE id=?', world.ids.link!),
    ).toEqual([{ generation: 2, generation_start_seq: generationBoundary }]);
    expect(query(world.dbPath, 'SELECT next_seq FROM forward_admission_clock')).toEqual([
      { next_seq: generationBoundary },
    ]);

    const restoredDb = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    try {
      const nowNs = fromMs(world.clock.nowMs());
      const projectionRandom = seededRandom(0x52);
      const apply = (recordProof: Awaited<ReturnType<typeof proof>>) =>
        restoredDb.tx(() =>
          applyRecordProof(restoredDb, recordProof, {
            prefix: PREFIX,
            nowNs,
            receiptNs: nowNs,
            live: authorizedLiveOptions(restoredDb, recordProof, projectionRandom).live,
          }),
        );
      expect(apply(await proof()).outcome).toBe('applied');
      expect(restoredDb.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='love'")).toEqual({ n: 1 });

      await repo.put(collection, rkey, { ...love, album: 'Metadata update' });
      expect(apply(await proof()).outcome).toBe('applied');
      expect(restoredDb.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='love'")).toEqual({ n: 1 });

      await repo.delete(collection, rkey);
      expect(apply(await proof()).outcome).toBe('absent');
      expect(restoredDb.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='unlove'")).toEqual({ n: 1 });
      const oldIncarnation = restoredDb.one<{ incarnation_key: string }>(
        'SELECT incarnation_key FROM love_incarnations WHERE uri=?',
        uri,
      )!.incarnation_key;
      await repo.put(collection, rkey, love);
      expect(apply(await proof()).outcome).toBe('applied');
      expect(restoredDb.one("SELECT count(*) AS n FROM forward_outbox WHERE kind='love'")).toEqual({ n: 2 });
      expect(
        restoredDb.one<{ incarnation_key: string }>('SELECT incarnation_key FROM love_incarnations WHERE uri=?', uri)
          ?.incarnation_key,
      ).not.toBe(oldIncarnation);
    } finally {
      restoredDb.close();
    }
  }, 30_000);

  it('preserves sparse canonical rowids referenced by forwarding caches across live restore', async () => {
    const world = await buildWorld();
    const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    const link = db.one<{ id: string; did: string }>('SELECT id,did FROM linked_accounts LIMIT 1')!;
    // Leave holes and use equal timestamps so temporal ordering's rowid tie
    // breaker and the initializer cursors are exercised through real restore.
    db.run(
      `INSERT INTO forward_outbox(rowid,id,link_id,did,kind,dedupe_key,payload_json,state,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key,generation,love_lane)
      VALUES(100,'retained-love',?,?,'love','retained-love','{"artist":"Band","track":"Song","recordingMbid":"8f3471b5-7e6a-48da-86a9-c1c07a0f47ae"}','sent',1,1,1,'band','song',1,1)`,
      link.id,
      link.did,
    );
    db.run(
      `INSERT INTO forward_outbox(rowid,id,link_id,did,kind,dedupe_key,payload_json,state,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key,generation,love_lane)
      VALUES(101,'retained-unlove',?,?,'unlove','retained-unlove','{"artist":"Band","track":"Song"}','queued',1,1,1,'band','song',1,1)`,
      link.id,
      link.did,
    );
    db.run(
      "INSERT INTO forward_love_recording_targets(forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid) VALUES(100,?,1,'band','song',1,'8f3471b5-7e6a-48da-86a9-c1c07a0f47ae')",
      link.id,
    );
    db.run('INSERT INTO forward_love_recording_targets_state VALUES(1,101,1)');
    db.run(
      `INSERT INTO operations(rowid,id,did,kind,origin,priority,collection,record_json,digest,due_at,created_at_ms,updated_at_ms)
      VALUES(200,'retained-love-op',?,'love.put','web',0,'fm.rocksky.love','{"artist":"Band","track":"Song","recordingMbid":"11111111-2222-4333-8444-555555555555"}','digest',1,1,1)`,
      link.did,
    );
    db.run(
      `INSERT INTO forward_love_operation_targets(operation_rowid,did,artist_key,track_key,created_at_ms,recording_mbid)
      VALUES(200,?,'band','song',1,'11111111-2222-4333-8444-555555555555')`,
      link.did,
    );
    db.run('INSERT INTO forward_love_operation_targets_state VALUES(1,200,1)');
    db.run('INSERT INTO forward_unlove_lookup_progress VALUES(101,1,200)');
    db.close();

    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(
      query(
        world.dbPath,
        `SELECT f.rowid AS actual,t.forward_rowid AS cached FROM forward_outbox f JOIN forward_love_recording_targets t ON t.link_id=f.link_id WHERE f.id='retained-love'`,
      ),
    ).toEqual([{ actual: 100, cached: 100 }]);
    expect(query(world.dbPath, "SELECT rowid FROM forward_outbox WHERE id='retained-unlove'")).toEqual([
      { rowid: 101 },
    ]);
    expect(query(world.dbPath, "SELECT rowid FROM operations WHERE id='retained-love-op'")).toEqual([{ rowid: 200 }]);
    expect(
      query(world.dbPath, 'SELECT unlove_rowid,cursor_operation_rowid FROM forward_unlove_lookup_progress'),
    ).toEqual([{ unlove_rowid: 101, cursor_operation_rowid: 200 }]);
    const found = query(world.dbPath, FORWARD_LOVE_RECORDING_LOOKUP_SQL, link.id, 1, 'band', 'song', 1, 101);
    expect(found).toEqual([{ recording_mbid: '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae' }]);
    expect(query(world.dbPath, 'SELECT cursor_rowid,complete FROM forward_love_recording_targets_state')).toEqual([
      { cursor_rowid: 101, complete: 1 },
    ]);
    expect(query(world.dbPath, 'SELECT cursor_rowid,complete FROM forward_love_operation_targets_state')).toEqual([
      { cursor_rowid: 200, complete: 1 },
    ]);
    expect(query(world.dbPath, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  }, 30_000);

  it('keeps canonical rows and dependent caches intact when live merge rejects an unknown column', async () => {
    const world = await buildWorld({ liveSql: ['ALTER TABLE operations ADD COLUMN future_column TEXT'] });
    const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    const link = db.one<{ id: string; did: string }>('SELECT id,did FROM linked_accounts LIMIT 1')!;
    db.run(
      `INSERT INTO forward_outbox(rowid,id,link_id,did,kind,dedupe_key,payload_json,state,due_at,created_at_ms,updated_at_ms,love_artist_key,love_track_key,generation,love_lane)
      VALUES(100,'restore-atomic-love',?,?,'love','restore-atomic-love','{"artist":"Band","track":"Song","recordingMbid":"8f3471b5-7e6a-48da-86a9-c1c07a0f47ae"}','sent',1,1,1,'band','song',1,1)`,
      link.id,
      link.did,
    );
    db.run(
      "INSERT INTO forward_love_recording_targets(forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid) VALUES(100,?,1,'band','song',1,'8f3471b5-7e6a-48da-86a9-c1c07a0f47ae')",
      link.id,
    );
    db.close();
    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('the live table operations has columns this code does not know (future_column)');
    expect(query(world.dbPath, "SELECT rowid,id FROM forward_outbox WHERE id='restore-atomic-love'")).toEqual([
      { rowid: 100, id: 'restore-atomic-love' },
    ]);
    expect(query(world.dbPath, 'SELECT forward_rowid,recording_mbid FROM forward_love_recording_targets')).toEqual([
      { forward_rowid: 100, recording_mbid: '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae' },
    ]);
    expect(query(world.dbPath, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(existsSync(`${world.dbPath}.restore.tmp`)).toBe(false);
  }, 30_000);

  it('with a fake systemctl, restore stops atmusic.socket and atmusic.service, proceeds only when both report inactive, swaps the db in, and starts both units only afterwards; a connection attempted mid-restore starts no server', async () => {
    const world = await buildWorld();
    const servicePort = await freePort();
    const socketPort = await freePort();
    const systemd = new FakeSystemd(world, { servicePort, socketPort });
    await systemd.boot();
    // The fake models socket activation: a connection to the socket unit would start the service.
    expect(await accepts(socketPort)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(systemd.activations).toBe(1);
    expect(await accepts(servicePort)).toBe(true);

    const midRestore: Array<{ socket: boolean; service: boolean }> = [];
    const result = await restoreCli(
      world,
      systemd,
      [...baseArgs(world), '--listen', `127.0.0.1:${servicePort}`],
      async (step) => {
        if (step === 'merged' || step === 'live_wal_removed') {
          midRestore.push({ socket: await accepts(socketPort), service: await accepts(servicePort) });
        }
      },
    );
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);

    // Stop both, check both, the swap, then start both: in that order.
    const order = systemd.events;
    expect(order).toEqual([
      'systemctl stop atmusic.socket atmusic.service',
      'systemctl is-active atmusic.socket atmusic.service',
      'step stopped',
      'step live_opened',
      'step pre_restore_copied',
      'step merged',
      'step temp_closed',
      'step temp_fsynced',
      'step live_wal_removed',
      'step renamed',
      'systemctl start atmusic.socket atmusic.service',
      'step started',
    ]);
    // Mid-restore nothing listens and nothing was activated: no server touched the database.
    expect(midRestore).toEqual([
      { socket: false, service: false },
      { socket: false, service: false },
    ]);
    expect(systemd.activations).toBe(1);
    // The restored database is live: S2 (indexed after the backup) is gone, carol's sign-in kept.
    const server = (systemd.server as Started).server;
    expect(server.db.all('SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }]);
    expect(server.db.one('SELECT username FROM accounts WHERE did = ?', DID_C)).toEqual({ username: 'carol.test' });
    expect(result.stdout).toContain('atmusic restore: ready');
    expect(existsSync(`${world.dbPath}.pre-restore`)).toBe(true);
    expect(existsSync(`${world.dbPath}.restore.tmp`)).toBe(false);

    // A stop that leaves the service running: no further step, nothing changed, nothing started.
    const stuckWorld = await buildWorld();
    const before = readFileSync(stuckWorld.dbPath);
    const stuck = new FakeSystemd(stuckWorld, { servicePort: null, stuck: 'atmusic.service' });
    await stuck.boot();
    const refused = await restoreCli(stuckWorld, stuck, [...baseArgs(stuckWorld), '--no-ready-check']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      'the units are not both stopped (atmusic.socket=inactive, atmusic.service=active)',
    );
    expect(stuck.events).toEqual([
      'systemctl stop atmusic.socket atmusic.service',
      'systemctl is-active atmusic.socket atmusic.service',
    ]);
    expect(readFileSync(stuckWorld.dbPath).equals(before)).toBe(true);
    expect(existsSync(`${stuckWorld.dbPath}.pre-restore`)).toBe(false);
    expect(existsSync(`${stuckWorld.dbPath}.restore.tmp`)).toBe(false);
  }, 60_000);

  it('with an unreadable live database restore prints what will be lost and refuses without --accept-loss', async () => {
    const world = await buildWorld();
    const garbage = corruptLive(world);
    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`the live database ${world.dbPath} is unusable (it cannot be read:`);
    expect(result.stderr).toContain(
      'Restoring without it loses every non-derived change made after the backup (2026-01-15T12:00:00.000Z)',
    );
    expect(result.stderr).toContain('every web session: all web_sessions rows are deleted');
    expect(result.stderr).toContain('sign-ins, new accounts and account renames');
    expect(result.stderr).toContain('scrobbles and other writes accepted but not yet written to a PDS');
    // What the backup carries, per non-derived table.
    expect(result.stderr).toContain('accounts=2');
    expect(result.stderr).toContain('web_sessions=1');
    expect(result.stderr).toContain('operations=1');
    // revocations.log: the logout and the app-password revocation after the backup.
    expect(result.stderr).toContain(`from revocations.log (2 entries, 2 after the backup)`);
    expect(result.stderr).toContain('refusing without --accept-loss; nothing was changed');
    expect(result.stderr).toContain('start them with: systemctl --user start atmusic.socket atmusic.service');
    // Nothing changed and nothing started.
    expect(readFileSync(world.dbPath).equals(garbage)).toBe(true);
    for (const leftover of ['.pre-restore', '.restore.tmp', '.restore.tmp-wal']) {
      expect(existsSync(`${world.dbPath}${leftover}`), leftover).toBe(false);
    }
    expect(systemd.events.filter((e) => e.startsWith('systemctl'))).toEqual([
      'systemctl stop atmusic.socket atmusic.service',
      'systemctl is-active atmusic.socket atmusic.service',
    ]);
    expect(systemd.units).toEqual({ 'atmusic.socket': 'inactive', 'atmusic.service': 'inactive' });
  }, 30_000);

  it('a restored database whose OAuth sessions and linked credentials open with the configured keys reports ready', async () => {
    const world = await buildWorld();
    const servicePort = await freePort();
    const systemd = new FakeSystemd(world, { servicePort });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--listen', `127.0.0.1:${servicePort}`]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      'keys: 3/3 OAuth sessions, 1/1 linked-account credentials and 0/0 issued Last.fm app secrets open with the configured encryption keys (e1)',
    );
    expect(result.stdout).toContain(`ready (GET /health/ready on 127.0.0.1:${servicePort} answered 200 ready)`);
    expect(result.stderr).toBe('');

    // The server started on the restored file and is ready.
    const { server } = systemd.server as Started;
    const ready = await fetchReady(servicePort);
    expect([ready.status, JSON.parse(ready.body)]).toEqual([200, { status: 'ready' }]);
    // Encrypted auth decrypts with the configured key: the OAuth sessions and the link credential.
    const { box } = boxOf(world.secretsDoc);
    const store = new OAuthSessionStore({
      db: server.db,
      clock: world.clock,
      box,
      log: captureLog().logger,
      revocations: {
        record() {},
        entries: () => [],
        replay: () => ({ entries: 0, deleted: {} }),
        truncateBefore: () => 0,
      },
    });
    for (const did of [DID_A, DID_B, DID_C]) expect(store.get(did)?.tokenSet.sub, did).toBe(did);
    const link = getLinkById(server.db, world.ids.link as string);
    expect(link === null ? null : openLinkCredential(box, link)).toBe(LASTFM_SK);
    expect(server.db.all('SELECT did, oauth_status FROM accounts ORDER BY did')).toEqual([
      { did: DID_A, oauth_status: 'active' },
      { did: DID_B, oauth_status: 'active' },
      { did: DID_C, oauth_status: 'active' },
    ]);
    // History, follows and the ingest checkpoint are the backup's (one consistent index);
    // the operations are the live ones.
    expect(server.db.all('SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }]);
    expect(server.db.all('SELECT actor, subject FROM follows')).toEqual([{ actor: DID_A, subject: DID_B }]);
    expect(server.db.one("SELECT cursor FROM ingest_checkpoint WHERE stream = 'jetstream'")).toEqual({ cursor: 1000 });
    expect(server.db.all('SELECT id, state FROM operations ORDER BY id')).toEqual([
      { id: 'op1', state: 'queued' },
      { id: 'op2', state: 'queued' },
    ]);
    expect(server.db.pragmas().journal_mode).toBe('wal');
  }, 60_000);

  it("restoring with secrets that lack the backup's encryption key id starts the server, marks undecryptable sessions reauth_required and prints no ciphertext or key material", async () => {
    const world = await buildWorld();
    corruptLive(world);
    const wrongSecrets = join(world.dir, 'secrets-e2.json');
    const wrongDoc = secretsWithoutE1();
    writeSecrets(wrongSecrets, wrongDoc);
    const servicePort = await freePort();
    const systemd = new FakeSystemd(world, { servicePort, secretsFile: wrongSecrets });
    const result = await restoreCli(world, systemd, [
      '--db',
      world.dbPath,
      '--state-dir',
      world.state,
      '--secrets',
      wrongSecrets,
      '--accept-loss',
      '--listen',
      `127.0.0.1:${servicePort}`,
    ]);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    // The server started and is ready although no session opens.
    expect(result.stdout).toContain('atmusic restore: ready');
    const { server, logLines } = systemd.server as Started;
    expect((await fetchReady(servicePort)).status).toBe(200);
    // The failure is explicit, names only key ids, and says what it did.
    expect(result.stdout).toContain(
      'keys: 0/2 OAuth sessions, 0/1 linked-account credentials and 0/0 issued Last.fm app secrets open with the configured encryption keys (e2)',
    );
    expect(result.stderr).toContain(
      '2 OAuth sessions do not open with the configured keys (sealed with key id e1): 2 accounts are now reauth_required and 1 queued operations blocked',
    );
    expect(result.stderr).toContain('1 linked-account credentials do not open (key id e1)');
    expect(server.db.all('SELECT did, oauth_status FROM accounts ORDER BY did')).toEqual([
      { did: DID_A, oauth_status: 'reauth_required' },
      { did: DID_B, oauth_status: 'reauth_required' },
    ]);
    expect(server.db.all('SELECT id, state FROM operations')).toEqual([{ id: 'op1', state: 'blocked' }]);
    // No token corruption: the ciphertext is the backup's, byte for byte, and opens with the right key.
    const stored = server.db.one<{ ciphertext: ArrayBuffer; key_id: string }>(
      'SELECT ciphertext, key_id FROM oauth_sessions WHERE did = ?',
      DID_A,
    );
    expect(stored?.key_id).toBe('e1');
    const ciphertext = new Uint8Array(stored?.ciphertext ?? new ArrayBuffer(0));
    expect(Buffer.from(ciphertext).equals(Buffer.from(world.backupCiphertextA))).toBe(true);
    expect(JSON.parse(boxOf(world.secretsDoc).box.openText('oauth-session', ciphertext, DID_A)).tokenSet.sub).toBe(
      DID_A,
    );

    // Nothing printed (restore output, server log) carries ciphertext or key material.
    const printed = `${result.stdout}\n${result.stderr}\n${logLines.join('\n')}`;
    const forbidden: string[] = [];
    const sealed = server.db.all<{ c: ArrayBuffer }>(
      'SELECT ciphertext AS c FROM oauth_sessions UNION ALL SELECT credential_ciphertext FROM linked_accounts',
    );
    for (const { c } of sealed) {
      const b = Buffer.from(c);
      forbidden.push(
        b.toString('hex'),
        b.toString('base64'),
        b.toString('base64url'),
        b.subarray(8, 24).toString('hex'),
      );
    }
    for (const doc of [world.secretsDoc, wrongDoc]) {
      for (const { key } of doc.encryptionKeys as Array<{ key: string }>) {
        const b = Buffer.from(key, 'base64');
        forbidden.push(key, b.toString('hex'), b.toString('base64url'));
      }
      forbidden.push(doc.cursorKey as string);
      for (const jwk of doc.oauthSigningKeys as Array<{ d: string }>) forbidden.push(jwk.d);
    }
    forbidden.push(LASTFM_SK, 'refresh-a1', 'refresh-b1', 'access-');
    expect(forbidden.length).toBeGreaterThan(15);
    for (const needle of forbidden) expect(printed.includes(needle), needle.slice(0, 12)).toBe(false);
  }, 60_000);

  it('with a readable live db, a sign-in, an app password and a sign-out that happened after the backup are all as they were live after restore, an account renamed after the backup keeps its new name, and the derived index rows come from the backup', async () => {
    const world = await buildWorld();
    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('its non-derived tables are kept');

    const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    try {
      const deps = { db, clock: world.clock, random: seededRandom(3), revocations: { record() {} } as never };
      const sessions = createWebSessions(deps);
      // Carol's sign-in: account, OAuth session and web session.
      expect(db.one('SELECT username, oauth_status FROM accounts WHERE did = ?', DID_C)).toEqual({
        username: 'carol.test',
        oauth_status: 'active',
      });
      expect(db.one('SELECT client_kid FROM oauth_sessions WHERE did = ?', DID_C)).toEqual({ client_kid: 'k1' });
      expect(sessions.lookup(world.ids.webC as string)?.did).toBe(DID_C);
      // Alice's sign-out stays signed out.
      expect(sessions.lookup(world.ids.webA as string)).toBeNull();
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM web_sessions')?.n).toBe(1);
      // Alice's rename and her post-backup app password (found under the new name).
      expect(db.one('SELECT username FROM accounts WHERE did = ?', DID_A)).toEqual({ username: 'alice2' });
      expect(verifyAppPassword(deps, { username: 'alice2', password: world.ids.p2 as string })?.did).toBe(DID_A);
      expect(verifyAppPassword(deps, { username: DID_B, password: world.ids.p3 as string })?.did).toBe(DID_B);
      // Derived rows are the backup's: S2 and carol's users row are gone, the deleted follow is back.
      expect(db.all('SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }]);
      expect(db.all('SELECT did FROM users ORDER BY did')).toEqual([{ did: DID_A }, { did: DID_B }]);
      expect(db.all('SELECT actor FROM follows')).toEqual([{ actor: DID_A }]);
      expect(db.one("SELECT cursor FROM ingest_checkpoint WHERE stream = 'jetstream'")).toEqual({ cursor: 1000 });
    } finally {
      db.close();
    }
    // The per-table summary says where each table came from.
    expect(result.stdout).toMatch(/\n {2}accounts +3 {2}live\n/);
    expect(result.stdout).toMatch(/\n {2}scrobbles +1 {2}backup\n/);
    // The pre-restore copy is the live database as it was (S2 included).
    expect(query(`${world.dbPath}.pre-restore`, 'SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([
      { rkey: 's1' },
      { rkey: 's2' },
    ]);
  }, 30_000);

  it('a credential revoked and an operation accepted after the backup are respectively still rejected and still queued after restore', async () => {
    const world = await buildWorld();
    // In the backup P1 is valid and op2 does not exist.
    expect(
      query(world.backupPath, 'SELECT count(*) AS n FROM app_passwords WHERE id = ?', world.ids.p1Id as string),
    ).toEqual([{ n: 1 }]);
    expect(query(world.backupPath, "SELECT count(*) AS n FROM operations WHERE id = 'op2'")).toEqual([{ n: 0 }]);
    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    const db = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    try {
      const deps = { db, clock: world.clock };
      expect(verifyAppPassword(deps, { username: 'alice2', password: world.ids.p1 as string })).toBeNull();
      expect(verifyAppPassword(deps, { username: DID_A, password: world.ids.p1 as string })).toBeNull();
      expect(db.one('SELECT count(*) AS n FROM app_passwords WHERE id = ?', world.ids.p1Id as string)).toEqual({
        n: 0,
      });
      expect(db.all('SELECT id, did, state, attempts FROM operations ORDER BY id')).toEqual([
        { id: 'op1', did: DID_A, state: 'queued', attempts: 0 },
        { id: 'op2', did: DID_A, state: 'queued', attempts: 0 },
      ]);
    } finally {
      db.close();
    }
  }, 30_000);

  it('a table missing from TABLE_CLASS aborts the restore before anything is renamed', async () => {
    // In the live database.
    const world = await buildWorld({
      liveSql: ['CREATE TABLE stray_notes (x TEXT)', "INSERT INTO stray_notes VALUES ('kept')"],
    });
    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'the live database has tables missing from TABLE_CLASS (stray_notes); nothing was renamed',
    );
    expect(query(world.dbPath, 'SELECT x FROM stray_notes')).toEqual([{ x: 'kept' }]);
    expect(query(world.dbPath, 'SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }, { rkey: 's2' }]);
    for (const leftover of ['.pre-restore', '.restore.tmp'])
      expect(existsSync(`${world.dbPath}${leftover}`)).toBe(false);
    expect(systemd.events.filter((e) => e.startsWith('systemctl start'))).toEqual([]);

    // In the backup: found after the copy is migrated, still before any rename.
    const other = await buildWorld();
    const tampered = join(other.dir, 'atmusic-20260115T1200Z.db');
    copyFileSync(other.backupPath, tampered);
    const t = new sqlite.DatabaseSync(tampered);
    t.exec('CREATE TABLE stray_cache (y INTEGER)');
    t.close();
    other.backupPath = tampered;
    const otherSystemd = new FakeSystemd(other, { servicePort: null });
    await otherSystemd.boot();
    const refused = await restoreCli(other, otherSystemd, [...baseArgs(other), '--no-ready-check']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      'the backup has tables missing from TABLE_CLASS (stray_cache); nothing was renamed',
    );
    expect(otherSystemd.events).not.toContain('step merged');
    expect(otherSystemd.events).not.toContain('step renamed');
    expect(query(other.dbPath, 'SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }, { rkey: 's2' }]);
    expect(query(other.dbPath, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'stray_cache'")).toEqual([
      { n: 0 },
    ]);
    expect(existsSync(`${other.dbPath}.restore.tmp`)).toBe(false);
    expect(otherSystemd.events.filter((e) => e.startsWith('systemctl start'))).toEqual([]);
  }, 30_000);

  it('with --accept-loss on an unreadable live db, every web session is gone and each credential, link and OAuth session in revocations.log is deleted from the restored copy', async () => {
    const world = await buildWorld({ journalLinkAndOauth: true });
    const journal = readFileSync(revocationLogPath(world.state), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { kind: string; did: string });
    expect(journal.map((e) => e.kind)).toEqual(['web_session', 'app_password', 'linked_account', 'oauth_session']);
    // The backup still has all of them.
    expect(query(world.backupPath, 'SELECT count(*) AS n FROM web_sessions')).toEqual([{ n: 1 }]);
    expect(query(world.backupPath, 'SELECT count(*) AS n FROM linked_accounts')).toEqual([{ n: 1 }]);
    expect(query(world.backupPath, 'SELECT did FROM oauth_sessions ORDER BY did')).toEqual([
      { did: DID_A },
      { did: DID_B },
    ]);
    const backup = new sqlite.DatabaseSync(world.backupPath);
    try {
      backup.exec(`
        INSERT INTO forward_outbox(rowid,id,link_id,did,kind,dedupe_key,payload_json,state,due_at,created_at_ms,updated_at_ms)
        SELECT 100,'restore-cached-love',id,did,'love','restore-cached-love','{}','sent',1,1,1 FROM linked_accounts LIMIT 1;
        INSERT INTO forward_outbox(rowid,id,link_id,did,kind,dedupe_key,payload_json,state,due_at,created_at_ms,updated_at_ms)
        SELECT 101,'restore-cached-unlove',id,did,'unlove','restore-cached-unlove','{}','queued',1,1,1 FROM linked_accounts LIMIT 1;
        INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms)
        SELECT id,1,'scrobble','revoked-link-receipt',1 FROM linked_accounts LIMIT 1;
        INSERT INTO forward_link_gaps(link_id,generation,from_seq,to_seq,reason,opened_at_ms,closed_at_ms)
        SELECT id,1,0,1,'disabled',1,2 FROM linked_accounts LIMIT 1;
        INSERT INTO forward_love_recording_targets(forward_rowid,link_id,generation,artist_key,track_key,created_at_ms,recording_mbid)
        SELECT 100,id,1,'band','song',1,'8f3471b5-7e6a-48da-86a9-c1c07a0f47ae' FROM linked_accounts LIMIT 1;
        INSERT INTO forward_unlove_lookup_progress VALUES(101,1,200);
        INSERT INTO forward_love_delivery(link_id,generation,love_artist_key,love_track_key,last_sent_kind,
          last_sent_dedupe_key,row_created_at_ms,sent_at_ms)
          SELECT id,1,'restore-artist','restore-track','love','restore-b2-delivery',1,2 FROM linked_accounts LIMIT 1;
        INSERT INTO forward_deferred_love_heads(link_id,generation,love_artist_key,love_track_key,head_seq,next_seq,
          live_from_seq,armed_seq,created_at_ms)
          SELECT id,1,'restore-artist','restore-track',1,2,1,2,1 FROM linked_accounts LIMIT 1;
        INSERT INTO forward_deferred_love_intents(link_id,generation,love_artist_key,love_track_key,intent_seq,kind,
          operation_id,origin_class,payload_json,authorization_uri,authorization_rev,intent_at_ms)
          SELECT id,1,'restore-artist','restore-track',1,'unlove','restore-b2-intent','authorized','{}',
            'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/restore','3lbcdefghijkm',1
          FROM linked_accounts LIMIT 1;
        INSERT INTO forward_deferred_love_witnesses(link_id,generation,operation_id,group_seq,kind,love_artist_key,
          love_track_key,authorization_uri,authorization_rev,created_at_ms)
          SELECT id,1,'restore-b2-intent',1,'unlove','restore-artist','restore-track',
            'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/restore','3lbcdefghijkm',1
          FROM linked_accounts LIMIT 1;
        INSERT INTO forward_deferred_love_authorities(authorization_uri,authorization_rev,authority_seq,action,cid,
          state,due_seq,created_at_ms)
          VALUES('at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/restore','3lbcdefghijkm',1,
            'delete','','conflicted',2,1);
        INSERT INTO forward_deferred_love_maintenance(singleton,next_head_seq,next_group_seq,next_authority_seq,
          auth_cursor,auth_frontier)
          VALUES(1,3,2,3,0,2);
      `);
    } finally {
      backup.close();
    }
    corruptLive(world);

    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--accept-loss', '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('--accept-loss given: continuing');
    expect(result.stdout).toContain(
      'deleted 1 web sessions; replayed 4 revocations (deleted: app_passwords=1, linked_accounts=1, oauth_sessions=1)',
    );
    const rows = (sql: string, ...p: sqlite.SQLInputValue[]) => query(world.dbPath, sql, ...p);
    expect(rows('SELECT count(*) AS n FROM web_sessions')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM app_passwords WHERE id = ?', world.ids.p1Id as string)).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM app_passwords')).toEqual([{ n: 1 }]); // bob's P3, never revoked
    expect(rows('SELECT count(*) AS n FROM linked_accounts')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_outbox')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_receipts')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_link_gaps')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_love_recording_targets')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_unlove_lookup_progress')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_love_delivery')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_deferred_love_heads')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_deferred_love_intents')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_deferred_love_witnesses')).toEqual([{ n: 0 }]);
    expect(rows('SELECT count(*) AS n FROM forward_deferred_love_authorities')).toEqual([{ n: 1 }]);
    expect(
      rows('SELECT next_head_seq,next_group_seq,next_authority_seq FROM forward_deferred_love_maintenance'),
    ).toEqual([{ next_head_seq: 3, next_group_seq: 2, next_authority_seq: 3 }]);
    expect(rows('SELECT did FROM oauth_sessions ORDER BY did')).toEqual([{ did: DID_A }]);
    const restoredDb = openSqliteDb(world.dbPath, { busyTimeoutMs: BUSY_MS });
    try {
      runDeferredLoveMaintenance(restoredDb, world.clock.nowMs());
      runDeferredLoveMaintenance(restoredDb, world.clock.nowMs() + 1);
      expect(restoredDb.one('SELECT count(*) AS n FROM forward_deferred_love_authorities')).toEqual({ n: 0 });
      expect(
        restoredDb.one('SELECT next_head_seq,next_group_seq,next_authority_seq FROM forward_deferred_love_maintenance'),
      ).toEqual({ next_head_seq: 3, next_group_seq: 2, next_authority_seq: 3 });
    } finally {
      restoredDb.close();
    }
    // The raw unreadable files are kept aside.
    expect(readFileSync(`${world.dbPath}.pre-restore`).equals(Buffer.alloc(8192, 0x5a))).toBe(true);
    expect(rows('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  }, 30_000);

  it('a live database that opens but fails integrity_check in a non-derived table, with commits only in its WAL, is left byte-identical by the refusal, and --accept-loss keeps that original db and -wal as the pre-restore pair', async () => {
    const world = await buildWorld({ keepWal: true });
    crashConsistentLive(world);
    expect(TABLE_CLASS.linked_accounts).toBe('non-derived');
    // Damage the linked_accounts root page in the main file. Nothing after the
    // backup wrote it, so the WAL holds no newer copy of that page.
    const { pageSize, root } = onScratchCopy(world, 'schema', world.dbPath, (db) => ({
      pageSize: (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size,
      root: (
        db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'linked_accounts'").get() as { rootpage: number }
      ).rootpage,
    }));
    expect(walPages(readFileSync(`${world.dbPath}-wal`), pageSize).has(root)).toBe(false);
    damagePage(world.dbPath, root, pageSize);
    const mainBefore = readFileSync(world.dbPath);
    const walBefore = readFileSync(`${world.dbPath}-wal`);
    // The damaged pair still opens: carol's post-backup sign-in reads (from the WAL only),
    // the file and linked_accounts fail integrity_check, accounts passes.
    onScratchCopy(world, 'damaged', world.dbPath, (db) => {
      expect(db.prepare('SELECT username FROM accounts WHERE did = ?').all(DID_C)).toEqual([
        { username: 'carol.test' },
      ]);
      expect(integrity(db)).not.toEqual(['ok']);
      expect(integrity(db, 'linked_accounts')).not.toEqual(['ok']);
      expect(integrity(db, 'accounts')).toEqual(['ok']);
    });

    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const refused = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(refused.code, `${refused.stdout}\n${refused.stderr}`).toBe(1);
    expect(refused.stderr).toContain(
      `the live database ${world.dbPath} is unusable (it cannot be read: integrity_check fails for the non-derived tables linked_accounts)`,
    );
    expect(refused.stderr).toContain('refusing without --accept-loss; nothing was changed');
    // Nothing was changed: the main file and the WAL are byte-identical, no -shm or copy is left.
    expect(readFileSync(world.dbPath).equals(mainBefore)).toBe(true);
    expect(existsSync(`${world.dbPath}-wal`)).toBe(true);
    expect(readFileSync(`${world.dbPath}-wal`).equals(walBefore)).toBe(true);
    for (const leftover of ['-shm', '-journal', '.pre-restore', '.pre-restore-wal', '.restore.tmp']) {
      expect(existsSync(`${world.dbPath}${leftover}`), leftover).toBe(false);
    }
    expect(systemd.events).toEqual([
      'systemctl stop atmusic.socket atmusic.service',
      'systemctl is-active atmusic.socket atmusic.service',
      'step stopped',
    ]);

    // --accept-loss: the pre-restore pair is the original main file and WAL, byte for byte.
    const accepted = await restoreCli(world, systemd, [...baseArgs(world), '--accept-loss', '--no-ready-check']);
    expect(accepted.code, `${accepted.stdout}\n${accepted.stderr}`).toBe(0);
    expect(accepted.stdout).toContain(
      `copied the unreadable live files to ${world.dbPath}.pre-restore, ${world.dbPath}.pre-restore-wal`,
    );
    expect(readFileSync(`${world.dbPath}.pre-restore`).equals(mainBefore)).toBe(true);
    expect(readFileSync(`${world.dbPath}.pre-restore-wal`).equals(walBefore)).toBe(true);
    // ...so the post-backup state is still recoverable from it.
    onScratchCopy(world, 'pre-restore', `${world.dbPath}.pre-restore`, (db) => {
      expect(db.prepare('SELECT username FROM accounts ORDER BY did').all()).toEqual([
        { username: 'alice2' },
        { username: 'bob.test' },
        { username: 'carol.test' },
      ]);
    });
    // The restored database is the backup's (with every web session deleted), and sound.
    expect(query(world.dbPath, 'SELECT username FROM accounts ORDER BY did')).toEqual([
      { username: 'alice.test' },
      { username: 'bob.test' },
    ]);
    expect(query(world.dbPath, 'SELECT count(*) AS n FROM web_sessions')).toEqual([{ n: 0 }]);
    expect(query(world.dbPath, 'SELECT count(*) AS n FROM linked_accounts')).toEqual([{ n: 1 }]);
    expect(query(world.dbPath, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  }, 60_000);

  it('damage confined to a derived index leaves the live database readable: post-backup accounts, renames, web sessions and queued operations survive without --accept-loss, and the damaged derived table comes from the backup', async () => {
    const world = await buildWorld();
    expect(TABLE_CLASS.scrobbles).toBe('derived');
    const { pageSize, index } = onScratchCopy(world, 'schema', world.dbPath, (db) => ({
      pageSize: (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size,
      index: db
        .prepare(
          "SELECT name, rootpage FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scrobbles' ORDER BY name",
        )
        .get() as { name: string; rootpage: number },
    }));
    expect(existsSync(`${world.dbPath}-wal`)).toBe(false);
    damagePage(world.dbPath, index.rootpage, pageSize);
    onScratchCopy(world, 'damaged', world.dbPath, (db) => {
      expect(integrity(db)).not.toEqual(['ok']);
      expect(integrity(db, 'scrobbles')).not.toEqual(['ok']);
      expect(integrity(db, 'accounts')).toEqual(['ok']);
    });

    const systemd = new FakeSystemd(world, { servicePort: null });
    await systemd.boot();
    const result = await restoreCli(world, systemd, [...baseArgs(world), '--no-ready-check']);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('its non-derived tables are kept');
    expect(result.stdout).toContain("the live database's derived tables scrobbles fail integrity_check");
    expect(result.stderr).not.toContain('unusable');
    // Post-backup non-derived state is as it was live.
    expect(query(world.dbPath, 'SELECT did, username FROM accounts ORDER BY did')).toEqual([
      { did: DID_A, username: 'alice2' },
      { did: DID_B, username: 'bob.test' },
      { did: DID_C, username: 'carol.test' },
    ]);
    expect(query(world.dbPath, 'SELECT did FROM web_sessions')).toEqual([{ did: DID_C }]);
    expect(query(world.dbPath, 'SELECT id, state FROM operations ORDER BY id')).toEqual([
      { id: 'op1', state: 'queued' },
      { id: 'op2', state: 'queued' },
    ]);
    expect(
      query(world.dbPath, 'SELECT count(*) AS n FROM app_passwords WHERE id = ?', world.ids.p1Id as string),
    ).toEqual([{ n: 0 }]);
    // The derived table is the backup's, intact.
    expect(query(world.dbPath, 'SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([{ rkey: 's1' }]);
    expect(query(world.dbPath, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(result.stdout).toMatch(/\n {2}scrobbles +1 {2}backup\n/);
    expect(result.stdout).toMatch(/\n {2}accounts +3 {2}live\n/);
  }, 30_000);

  it('killing restore after each swap step (temp file closed, temp fsynced, live WAL removed, renamed) leaves a database whose integrity_check is ok, never a restored file paired with a stale WAL, and a completed restore contains the merged live rows with no restore.tmp-wal left', async () => {
    const entryDir = mkdtempSync(join(tmpdir(), 'atmusic-restore-entry-'));
    dirs.push(entryDir);
    const entry = join(entryDir, 'entry.mjs');
    await build({
      stdin: {
        contents: `import { main } from ${JSON.stringify(join(REPO, 'scripts/admin/restore.ts'))};
const spec = JSON.parse(process.env.RESTORE_SPEC);
const code = await main(spec.args, {
  env: {},
  busyTimeoutMs: 200,
  // A stopped fake systemd: both units report inactive; start does nothing.
  systemctl: async (args) => ({ code: 0, stdout: args[0] === 'is-active' ? 'inactive\\ninactive\\n' : '', stderr: '' }),
  onStep: (step) => {
    if (step === spec.killAt) process.kill(process.pid, 'SIGKILL');
  },
});
process.exit(code);
`,
        resolveDir: REPO,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node26',
      outfile: entry,
      logLevel: 'silent',
      banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
      external: ['bufferutil', 'utf-8-validate'],
    });

    /** A crash-time live database: the post-backup commits are only in its WAL. */
    const crashWorld = async (): Promise<World> => {
      const world = await buildWorld({ keepWal: true });
      crashConsistentLive(world);
      return world;
    };

    const runChild = (world: World, killAt: RestoreStep | 'none') =>
      new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((done) => {
        const child = spawn(process.execPath, [entry], {
          env: {
            PATH: process.env.PATH ?? '',
            RESTORE_SPEC: JSON.stringify({
              killAt,
              args: [...baseArgs(world), '--no-ready-check', world.backupPath],
            }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (c: Buffer) => {
          output += c.toString();
        });
        child.stderr.on('data', (c: Buffer) => {
          output += c.toString();
        });
        child.on('exit', (code, signal) => done({ code, signal, output }));
      });

    /** Opens atmusic.db as the server would next (with whatever WAL lies next to it), on a copy. */
    const inspect = (world: World, label: string) => {
      const probe = join(world.dir, `inspect-${label}`);
      mkdirSync(probe);
      copyFileSync(world.dbPath, join(probe, 'atmusic.db'));
      const hasWal = existsSync(`${world.dbPath}-wal`);
      if (hasWal) copyFileSync(`${world.dbPath}-wal`, join(probe, 'atmusic.db-wal'));
      const db = new sqlite.DatabaseSync(join(probe, 'atmusic.db'));
      try {
        return {
          hasWal,
          integrity: (db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>).map(
            (r) => r.integrity_check,
          ),
          scrobbles: (db.prepare('SELECT rkey FROM scrobbles ORDER BY rkey').all() as Array<{ rkey: string }>).map(
            (r) => r.rkey,
          ),
          carol: (db.prepare('SELECT count(*) AS n FROM accounts WHERE did = ?').get(DID_C) as { n: number }).n,
        };
      } finally {
        db.close();
      }
    };

    const killSteps: RestoreStep[] = ['temp_closed', 'temp_fsynced', 'live_wal_removed', 'renamed'];
    for (const killAt of killSteps) {
      const world = await crashWorld();
      const child = await runChild(world, killAt);
      expect(child.signal, `${killAt}: ${child.output}`).toBe('SIGKILL');
      const seen = inspect(world, killAt);
      expect(seen.integrity, killAt).toEqual(['ok']);
      const restored = !seen.scrobbles.includes('s2'); // the backup's index has no S2
      if (killAt === 'renamed') {
        // The complete restored file, alone: merged live rows, the backup's index, no WAL.
        expect(restored, killAt).toBe(true);
        expect(seen.hasWal, killAt).toBe(false);
        expect(seen.carol, killAt).toBe(1);
      } else {
        // The old file, complete (with its WAL before 4.3, checkpointed without it after).
        expect(restored, killAt).toBe(false);
        expect(seen.scrobbles, killAt).toEqual(['s1', 's2']);
        expect(seen.carol, killAt).toBe(1);
        expect(seen.hasWal, killAt).toBe(killAt !== 'live_wal_removed');
        // The restored copy waits, self-contained, beside it.
        expect(existsSync(`${world.dbPath}.restore.tmp`), killAt).toBe(true);
        expect(existsSync(`${world.dbPath}.restore.tmp-wal`), killAt).toBe(false);
      }
      // Never a restored file paired with a stale WAL.
      expect(restored && seen.hasWal, killAt).toBe(false);
      // The live state as it was is always recoverable from the pre-restore copy.
      expect(query(`${world.dbPath}.pre-restore`, 'SELECT rkey FROM scrobbles ORDER BY rkey')).toEqual([
        { rkey: 's1' },
        { rkey: 's2' },
      ]);
    }

    // Uninterrupted: the merged live rows (including those that were only in the WAL), nothing left over.
    const world = await crashWorld();
    const complete = await runChild(world, 'none');
    expect(complete.code, complete.output).toBe(0);
    for (const s of ['-wal', '-shm', '-journal']) {
      expect(existsSync(`${world.dbPath}.restore.tmp${s}`), s).toBe(false);
      expect(existsSync(`${world.dbPath}${s}`), s).toBe(false);
    }
    expect(existsSync(`${world.dbPath}.restore.tmp`)).toBe(false);
    const seen = inspect(world, 'complete');
    expect(seen).toEqual({ hasWal: false, integrity: ['ok'], scrobbles: ['s1'], carol: 1 });
    expect(query(world.dbPath, 'SELECT username FROM accounts ORDER BY did')).toEqual([
      { username: 'alice2' },
      { username: 'bob.test' },
      { username: 'carol.test' },
    ]);
    expect(query(world.dbPath, 'SELECT id FROM operations ORDER BY id')).toEqual([{ id: 'op1' }, { id: 'op2' }]);
    expect(query(world.dbPath, 'PRAGMA journal_mode')).toEqual([{ journal_mode: 'delete' }]);
  }, 120_000);
});

function fetchReady(port: number): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    import('node:http').then((http) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/health/ready', headers: { host: `127.0.0.1:${port}` }, agent: false },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            body += c;
          });
          res.on('end', () => done({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', fail);
      req.end();
    }, fail);
  });
}

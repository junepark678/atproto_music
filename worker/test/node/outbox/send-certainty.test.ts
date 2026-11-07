// Send certainty for cancellation, rebatching and chained removals (ADR 0005
// §5.8, §7.5 library.removeScrobble; ADR 0006 legacy import upgrade).
//
// Only an operation explicitly known never sent (its `unsent` insertion
// receipt, no attempt) may be cancelled locally or rebatched. A create whose
// send history is unknown — a migrated row at any attempt count, or one whose
// attempt was refunded by reauth — is reconciled at its original rkey and a
// removal chains a delete behind it, so the owner's record is removed rather
// than reported withdrawn while it stays on the PDS.

import { listenKey } from '@atmusic/core/listen-key';
import { expect, it } from 'vitest';
import { migrate } from '../../../src/do/migrate';
import { MIGRATIONS } from '../../../src/do/schema';
import { createJob } from '../../../src/imports/jobs';
import { rebatchUnsentImports } from '../../../src/imports/rebatch';
import { removeScrobble } from '../../../src/lastfm/write-methods';
import { cancelUnsentForDid, unblockOperations } from '../../../src/outbox/operations';
import { insertScrobbleCreate, prepareScrobble } from '../../../src/outbox/scrobble-ops';
import { withMigratedDb } from '../support/node-db';
import {
  CREATE,
  DELETE,
  GET,
  type Harness,
  listenInput,
  PREFIX,
  remoteRecords,
  SCROBBLE,
  T0,
  withHarness,
} from './support';

const STORAGE_NS = (iso: string) => iso.replace('.000Z', '.000000000Z');

async function keyOf(did: string, input: ReturnType<typeof listenInput>): Promise<string> {
  return listenKey({
    did,
    listenedAtNs: BigInt(Date.parse(input.listenedAt)) * 1_000_000n,
    artist: input.artist,
    track: input.track,
  });
}

/** One queued import single with its item and key, as a pre-upgrade job left it. */
async function legacySingle(h: Harness, fields: { attempts: number; state?: string }) {
  h.seedUser(h.alice);
  createJob(h.db, { id: 'legacy', did: h.alice, source: 'lastfm_json', remoteUser: null, now: T0 });
  h.db.run("UPDATE import_jobs SET state='writing' WHERE id='legacy'");
  const input = listenInput(0);
  const prepared = await prepareScrobble(input, PREFIX, T0);
  if (!prepared.ok) throw new Error('fixture listen did not validate');
  const op = insertScrobbleCreate(
    h.m,
    { did: h.alice, origin: 'import', prepared: prepared.prepared, importJobId: 'legacy' },
    T0,
  );
  const key = await keyOf(h.alice, input);
  h.db.run(
    "INSERT INTO import_items(job_id,seq,dedupe_key,listened_at,record_json,state,operation_id) VALUES ('legacy',0,?,?,?,'queued',?)",
    key,
    STORAGE_NS(input.listenedAt),
    JSON.stringify({ kind: 'listen', input }),
    op.id,
  );
  h.db.run(
    "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms) VALUES (?,?,?,'import',?)",
    h.alice,
    key,
    op.id,
    T0,
  );
  h.db.run(
    "UPDATE operations SET attempts=?, state=?, send_state='unknown' WHERE id=?",
    fields.attempts,
    fields.state ?? 'queued',
    op.id,
  );
  return { op, input };
}

const remove = (h: Harness, input: ReturnType<typeof listenInput>) =>
  removeScrobble(h.m, {
    did: h.alice,
    artist: input.artist,
    track: input.track,
    timestamp: Date.parse(input.listenedAt) / 1000,
  });

it.each([
  { name: 'absent', committed: false, attempts: 1, creates: 1 },
  { name: 'already committed', committed: true, attempts: 1, creates: 0 },
  { name: 'absent after an interrupted tenth attempt', committed: false, attempts: 10, creates: 0 },
])(
  'an uncertain legacy import single ($name) with a chained Last.fm removal converges at its original rkey',
  async ({ committed, attempts, creates }) => {
    await withHarness(async (h) => {
      const { op, input } = await legacySingle(h, { attempts, state: attempts === 10 ? 'running' : 'queued' });
      if (committed) await h.kit.externalPut('Alice', op.collection, op.rkey!, JSON.parse(op.record_json!));
      const removed = await remove(h, input);
      expect(removed).toEqual([expect.objectContaining({ kind: 'delete_chained', operationId: op.id })]);

      // Nothing is cancelled, rebatched or detached; both lanes progress.
      for (let n = 0; n < 3; n++) {
        expect(await rebatchUnsentImports(h.m, 'legacy', h.alice, h.kit.clock.nowMs())).toBe(0);
        await h.runUntilIdle();
        h.kit.clock.advance(60_000);
      }
      h.restart();
      const after = await h.run();

      expect(after.nextDueMs).toBeNull();
      expect(h.ops().map((o) => [o.kind, o.state])).toEqual([
        ['scrobble.create', attempts === 10 ? 'failed' : 'succeeded'],
        ['scrobble.delete', 'succeeded'],
      ]);
      expect(h.db.all('SELECT * FROM operation_deps')).toHaveLength(1);
      // At most one create, at the persisted key; the owner's record is gone.
      expect(h.writers.sent.filter((s) => s.nsid === CREATE).map((s) => s.body?.rkey)).toEqual(
        Array.from({ length: creates }, () => op.rkey),
      );
      expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toEqual([]);
      expect(h.ops(`collection LIKE '%scrobbleBatch'`)).toEqual([]);
    });
  },
);

it('a schema-4 zero-attempt create whose send committed is removed through Last.fm, never falsely cancelled', async () => {
  await withHarness(async (h) => {
    const input = listenInput(0);
    const prepared = await prepareScrobble(input, PREFIX, T0);
    if (!prepared.ok) throw new Error('fixture listen did not validate');
    const rkey = '3mchjvhag222q';
    const key = await keyOf(h.alice, input);
    await withMigratedDb(
      async (old) => {
        // Pre-upgrade code persisted the create, sent it (committed), lost the
        // answer, and refunded the attempt on reauth: attempts 0, queued.
        old.run(
          `INSERT INTO accounts(did, username, oauth_status, import_share_pct, daily_listen_cap, created_at_ms, updated_at_ms)
           VALUES (?, 'alice', 'active', 50, 3000, ?, ?)`,
          h.alice,
          T0,
          T0,
        );
        old.run(
          `INSERT INTO operations(id,did,kind,origin,priority,collection,rkey,record_json,digest,state,attempts,
             due_at,created_at_ms,updated_at_ms)
           VALUES('legacy-live',?,'scrobble.create','web',0,?,?,?,?,'queued',0,?,?,?)`,
          h.alice,
          SCROBBLE,
          rkey,
          JSON.stringify(prepared.prepared.record),
          prepared.prepared.digest,
          T0,
          T0,
          T0,
        );
        old.run(
          "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms) VALUES (?,?,'legacy-live','web',?)",
          h.alice,
          key,
          T0,
        );
        expect(migrate(old)).toEqual({ status: 'ready', version: MIGRATIONS.at(-1)!.version });
        expect(old.one('SELECT attempts, send_state FROM operations WHERE id = ?', 'legacy-live')).toEqual({
          attempts: 0,
          send_state: 'unknown',
        });
        await h.kit.externalPut('Alice', SCROBBLE, rkey, prepared.prepared.record);
        h.db = old;
        h.m = { ...h.m, db: old };
        expect(cancelUnsentForDid(old, h.alice, T0)).toEqual([]);

        const removed = await remove(h, input);
        expect(removed).toEqual([expect.objectContaining({ kind: 'delete_chained', operationId: 'legacy-live' })]);
        expect(h.op('legacy-live').state).toBe('queued');
        await h.runUntilIdle();

        expect(h.ops().map((o) => [o.kind, o.state])).toEqual([
          ['scrobble.create', 'succeeded'],
          ['scrobble.delete', 'succeeded'],
        ]);
        // The original-key create meets the committed record (RecordAlreadyExists),
        // is reconciled by digest, and the record is then deleted.
        expect(h.writers.order()).toEqual([CREATE, GET, DELETE]);
        expect(h.kit.pds.Alice.calls.filter({ nsid: CREATE }).map((c) => c.status)).toEqual([400]);
        expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toEqual([]);
      },
      { migrations: MIGRATIONS.slice(0, 4) },
    );
  });
});

it('the migrated zero-attempt import single shape is reconciled and deleted rather than cancelled', async () => {
  await withHarness(async (h) => {
    const { op, input } = await legacySingle(h, { attempts: 0 });
    await h.kit.externalPut('Alice', op.collection, op.rkey!, JSON.parse(op.record_json!));
    const removed = await remove(h, input);
    expect(removed).toEqual([expect.objectContaining({ kind: 'delete_chained', operationId: op.id })]);
    await h.runUntilIdle();
    expect(h.ops().map((o) => [o.kind, o.state])).toEqual([
      ['scrobble.create', 'succeeded'],
      ['scrobble.delete', 'succeeded'],
    ]);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toEqual([]);
  });
});

it('a new explicitly unsent create is still cancelled without any request; disconnect cancels only those', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.account(h.alice);
    const input = listenInput(0);
    const prepared = await prepareScrobble(input, PREFIX, T0);
    if (!prepared.ok) throw new Error('fixture listen did not validate');
    const op = insertScrobbleCreate(h.m, { did: h.alice, origin: 'lastfm', prepared: prepared.prepared }, T0);
    h.db.run(
      "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms) VALUES (?,?,?,'lastfm',?)",
      h.alice,
      await keyOf(h.alice, input),
      op.id,
      T0,
    );
    expect(op).toMatchObject({ send_state: 'unsent', attempts: 0 });

    expect(await remove(h, input)).toEqual([expect.objectContaining({ kind: 'cancelled', operationId: op.id })]);
    expect(h.op(op.id).state).toBe('cancelled');
    expect(h.db.all('SELECT * FROM listen_keys')).toEqual([]);
    expect(h.writers.sent).toEqual([]);

    const fresh = insertScrobbleCreate(h.m, { did: h.alice, origin: 'web', prepared: prepared.prepared }, T0);
    const migrated = insertScrobbleCreate(h.m, { did: h.alice, origin: 'web', prepared: prepared.prepared }, T0);
    h.db.run("UPDATE operations SET send_state='unknown' WHERE id=?", migrated.id);
    expect(cancelUnsentForDid(h.db, h.alice, T0)).toEqual([fresh.id]);
    expect(h.op(migrated.id).state).toBe('queued');
  });
});

it('a refunded reauth attempt and a later sign-in never restore certainty: the removal chains a delete', async () => {
  await withHarness(async (h) => {
    h.seedUser(h.alice);
    h.account(h.alice);
    const input = listenInput(0);
    const prepared = await prepareScrobble(input, PREFIX, T0);
    if (!prepared.ok) throw new Error('fixture listen did not validate');
    const op = insertScrobbleCreate(h.m, { did: h.alice, origin: 'lastfm', prepared: prepared.prepared }, T0);
    h.db.run(
      "INSERT INTO listen_keys(did,dedupe_key,operation_id,source,created_at_ms) VALUES (?,?,?,'lastfm',?)",
      h.alice,
      await keyOf(h.alice, input),
      op.id,
      T0,
    );
    // The create commits, but the answer asks for a new sign-in.
    h.kit.pds.Alice.fail(
      { nsid: CREATE },
      {
        kind: 'respond',
        respond: async () => {
          await h.kit.repos.Alice.put(SCROBBLE, op.rkey!, prepared.prepared.record);
          return Response.json({ error: 'InvalidToken', message: 'expired' }, { status: 401 });
        },
      },
    );
    await h.run();
    expect(h.op(op.id)).toMatchObject({ state: 'blocked', attempts: 0, send_state: 'unknown' });
    unblockOperations(h.db, h.alice, T0);
    expect(h.op(op.id)).toMatchObject({ state: 'queued', attempts: 0, send_state: 'unknown' });

    expect(await remove(h, input)).toEqual([expect.objectContaining({ kind: 'delete_chained', operationId: op.id })]);
    await h.runUntilIdle();
    expect(h.ops().map((o) => [o.kind, o.state])).toEqual([
      ['scrobble.create', 'succeeded'],
      ['scrobble.delete', 'succeeded'],
    ]);
    expect(await remoteRecords(h.kit, 'Alice', SCROBBLE)).toEqual([]);
  });
});

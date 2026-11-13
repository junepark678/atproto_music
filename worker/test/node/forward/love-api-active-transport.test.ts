// Forwarding to linked ListenBrainz accounts (ADR 0005 §12.2, §12.3, §11.3;
// N3-08): `single` for a live listen, `import` batches of ≤ 100 for a
// backlog, `playing_now` once, recording feedback by MBID, 401 revocation,
// the X-RateLimit-Reset-In wait on 429, 400 as a permanent failure, and the
// 30-day expiry.
//
// The real composition (support/app.ts) with the links feature, the frozen
// clock 2026-01-15T12:00:00Z (stepped, never slept) and seeded randomness.
// ListenBrainz is the fake at listenbrainz.test behind the fixture router; it
// accepts a submission only with a registered `Token`.

import { FakePds } from '@atmusic/atproto/test-support/fake-pds';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { trackKey } from '@atmusic/core/music-key';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs } from '@atmusic/core/timestamp';
import { afterEach, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { ForwardOutboxRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import type { Db, SqlParam } from '../../../src/do/db';
import { cachedIdentityResolver } from '../../../src/do/ingest/identity-cache';
import { recordLiveEvidence } from '../../../src/do/ingest/live-evidence';
import {
  authorizePendingRemovals,
  executeAuthorizedRemovals,
  recordPendingRemovals,
} from '../../../src/do/ingest/live-pending-removals';
import type { MIGRATIONS } from '../../../src/do/schema';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { type ForwardRuntime, runForward } from '../../../src/forward/forwarder';
import { saveLink } from '../../../src/forward/links';
import { materializeLoveApiRecipientDecisions } from '../../../src/forward/love-api-materializer';
import { type LinksService, linksFeature } from '../../../src/http/links';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { parseSecrets } from '../../../src/node/secrets';
import { enqueueForwards, type ForwardItem } from '../../../src/outbox/forward-enqueue';
import { enqueueLove } from '../../../src/outbox/love-ops';
import { PDS_WRITER_CAPS, type PdsWriterSource } from '../../../src/outbox/pds-writer';
import { runOutbox } from '../../../src/outbox/runner';
import { authorizedLiveOptions } from '../../write/support';
import { closeApps, startApp, type TestApp, testSecretsDocument } from '../support/app';
import { FakeLastfm } from '../support/fake-lastfm';
import { FakeListenBrainz, type LbSubmission } from '../support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const _BOB = 'did:plc:bobbobbobbobbobbob';
const TOKEN = '5c7f3a3e-2f1d-4c1b-9a77-0d1e2f3a4b5c';
const MBID = '8f3471b5-7e6a-48da-86a9-c1c07a0f47ae';
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

interface World {
  app: TestApp;
  clock: FixedClock;
  lb: FakeListenBrainz;
  lastfm: FakeLastfm;
  rt: ForwardRuntime;
  /** Every request to listenbrainz.test: [method, path, clock ms]. */
  seen: Array<[string, string, number]>;
  /** Answers the next ListenBrainz request with this response instead of the fake (which `res` may still call). */
  intercept(res: (req: Request) => Response | Promise<Response>): void;
  link(credential?: string): string;
  scrobbles(n: number, tag?: string): void;
  enqueue(items: ForwardItem[]): number;
  rows(): ForwardOutboxRow[];
  run(): ReturnType<typeof runForward>;
}

function traceDb(raw: Db): {
  db: Db;
  result: () => {
    reads: number;
    mutationStatements: number;
    returnedRows: number;
    changedRows: number;
    transactions: Array<{
      name: string;
      parentName: string | null;
      depth: number;
      inclusive: true;
      reads: number;
      mutationStatements: number;
      changedRows: number;
      returnedRows: number;
      nestedTransactions: number;
      nestedOwners: string[];
    }>;
  };
} {
  let reads = 0;
  let mutationStatements = 0;
  let returnedRows = 0;
  const activeTransactions: Array<{
    name: string;
    parentName: string | null;
    depth: number;
    before: number;
    reads: number;
    mutationStatements: number;
    returnedRows: number;
    nestedTransactions: number;
    nestedOwners: string[];
  }> = [];
  const transactions: Array<{
    name: string;
    parentName: string | null;
    depth: number;
    inclusive: true;
    reads: number;
    mutationStatements: number;
    changedRows: number;
    returnedRows: number;
    nestedTransactions: number;
    nestedOwners: string[];
  }> = [];
  const mutation = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
  const callsite = () =>
    new Error().stack
      ?.split('\n')
      .slice(2)
      .find((line) => line.includes('/worker/src/'))
      ?.trim() ?? 'test-owned transaction';
  const account = (sql: string, rowCount: number) => {
    if (mutation.test(sql)) {
      mutationStatements++;
      for (const frame of activeTransactions) frame.mutationStatements++;
    } else {
      reads++;
      for (const frame of activeTransactions) frame.reads++;
    }
    returnedRows += rowCount;
    for (const frame of activeTransactions) frame.returnedRows += rowCount;
  };
  const before = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
  const db: Db = {
    all<T>(sql: string, ...params: SqlParam[]): T[] {
      const rows = raw.all<T>(sql, ...params);
      account(sql, rows.length);
      return rows;
    },
    one<T>(sql: string, ...params: SqlParam[]): T | null {
      const row = raw.one<T>(sql, ...params);
      account(sql, row === null ? 0 : 1);
      return row;
    },
    run(sql: string, ...params: SqlParam[]) {
      account(sql, 0);
      return raw.run(sql, ...params);
    },
    tx<T>(fn: () => T extends Promise<unknown> ? never : T): T {
      const transaction = {
        name: callsite(),
        parentName: activeTransactions.at(-1)?.name ?? null,
        depth: activeTransactions.length,
        before: raw.one<{ n: number }>('SELECT total_changes() AS n')!.n,
        reads: 0,
        mutationStatements: 0,
        returnedRows: 0,
        nestedTransactions: 0,
        nestedOwners: [] as string[],
      };
      for (const frame of activeTransactions) {
        frame.nestedTransactions++;
        frame.nestedOwners.push(transaction.name);
      }
      activeTransactions.push(transaction);
      try {
        return raw.tx(fn);
      } finally {
        const after = raw.one<{ n: number }>('SELECT total_changes() AS n')!.n;
        transactions.push({
          name: transaction.name,
          parentName: transaction.parentName,
          depth: transaction.depth,
          inclusive: true,
          reads: transaction.reads,
          mutationStatements: transaction.mutationStatements,
          changedRows: after - transaction.before,
          returnedRows: transaction.returnedRows,
          nestedTransactions: transaction.nestedTransactions,
          nestedOwners: transaction.nestedOwners,
        });
        activeTransactions.pop();
      }
    },
  };
  return {
    db,
    result: () => ({
      reads,
      mutationStatements,
      returnedRows,
      changedRows: raw.one<{ n: number }>('SELECT total_changes() AS n')!.n - before,
      transactions,
    }),
  };
}

function _assertL2DecisionBudget(transaction: { reads: number; changedRows: number }, visits: number): void {
  if (transaction.reads > 128) throw new Error('L2 decision read budget exceeded');
  if (transaction.changedRows > 28) throw new Error('L2 decision DECISION changed-row budget exceeded');
  if (visits > 16) throw new Error('L2 decision visit budget exceeded');
}

async function world(migrations?: readonly (typeof MIGRATIONS)[number][]): Promise<World> {
  const clock = fixedClock();
  const lb = new FakeListenBrainz({ clock, rateLimit: 10_000 });
  const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
  lb.addToken('alice_lb', TOKEN);
  const seen: Array<[string, string, number]> = [];
  const intercepts: Array<(req: Request) => Response | Promise<Response>> = [];
  const lbEndpoint = async (req: Request) => {
    const url = new URL(req.url);
    seen.push([req.method, url.pathname, clock.nowMs()]);
    const next = intercepts.shift();
    return next === undefined ? lb.fetch(req) : next(req);
  };
  const app = await startApp({
    migrations,
    clock,
    secrets: parseSecrets({ ...testSecretsDocument(), lastfm: { apiKey: API_KEY, sharedSecret: SECRET } }),
    transport: routerTransport({ hosts: { 'listenbrainz.test': lbEndpoint, 'lastfm.test': lastfm } }),
    features: [linksFeature({ revocations: new MemoryRevocations(clock) })],
    env: {
      LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
      LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
      LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
    },
  });
  ensureAccount({ db: app.db, clock }, { did: ALICE, verifiedHandle: null });
  const rt = (app.composed.app as unknown as { links: LinksService }).links.forwarding;
  const random = seededRandom(23);
  let seq = 0;
  const w: World = {
    app,
    clock,
    lb,
    lastfm,
    rt,
    seen,
    intercept: (res) => intercepts.push(res),
    link(credential = TOKEN) {
      return saveLink(
        { db: app.db, clock, random: rt.random, box: rt.box },
        { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential },
      ).link.id;
    },
    enqueue: (items) => enqueueForwards(app.db, { did: ALICE, items, now: clock.nowMs(), random }),
    scrobbles(n, tag = 's') {
      const items: ForwardItem[] = [];
      for (let i = 0; i < n; i++) {
        seq += 1;
        items.push({
          kind: 'scrobble',
          listenKey: `${tag}-${seq}`,
          payload: {
            listen: {
              artist: `Artist ${seq}`,
              track: `Track ${seq}`,
              listenedAt: new Date(Date.parse('2026-01-14T00:00:00Z') + seq * MINUTE).toISOString(),
              album: 'Album',
              recordingMbid: MBID,
              durationSeconds: 180,
            },
            origin: 'listenbrainz',
          },
        });
      }
      w.enqueue(items);
    },
    rows: () => app.db.all<ForwardOutboxRow>('SELECT * FROM forward_outbox ORDER BY created_at_ms, rowid'),
    run: () => runForward(rt, clock.nowMs()),
  };
  return w;
}

afterEach(async () => {
  await closeApps();
});

const _listensOf = (s: LbSubmission) =>
  (s.json as { payload: Array<{ track_metadata: { track_name: string } }> }).payload;

function _queueDelete(w: World, linkId: string, id: string, listenedAt: number, artist: string, track: string) {
  const [artistKey, trackKeyValue] = trackKey(artist, track);
  const now = w.clock.nowMs();
  w.app.db.run(
    `INSERT INTO listenbrainz_deletes
    (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
    VALUES(?,?,?,1,?,?, ?,?,?,?,?,'api','queued',0,?,?,?,?)`,
    id,
    id,
    linkId,
    ALICE,
    id,
    listenedAt,
    artistKey,
    trackKeyValue,
    artist,
    track,
    now,
    now + 7 * DAY,
    now,
    now,
  );
}

it.each([true, false])(
  'active producer sends one unlove per remote, love SENT before absence=%s',
  async (sentBeforeAbsence) => {
    const w = await world();
    const linkId = w.link();
    const sk = w.lastfm.addSession('alice_fm');
    saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm', credential: sk },
    );
    let fmUnloves = 0;
    const oldFetch = w.lastfm.fetch.bind(w.lastfm);
    w.lastfm.fetch = async (req: Request) => {
      const form = new URLSearchParams(await req.clone().text());
      if (form.get('method') === 'track.unlove') fmUnloves++;
      return oldFetch(req);
    };
    const deps = w.app.composed.core.deps;
    const wholeDecisionTrace = traceDb(w.app.db);
    const tracedDeps = { ...deps, db: wholeDecisionTrace.db };
    const artist = 'L2 Paused API Artist';
    const track = 'L2 Paused API Track';
    const keys = await fixtureKeys();
    const repo = new SignedRepo(ALICE, keys.alice, { clock: w.clock });
    const pds = new FakePds('api-proof-pds.test', { clock: w.clock });
    const account = await pds.addAccount(repo);
    const pdsTransport = routerTransport({ hosts: { 'api-proof-pds.test': pds } });
    const policyFetch = bindPolicyFetch(createPolicyFetch({ transport: pdsTransport }), PDS_WRITER_CAPS);
    const writers: PdsWriterSource = {
      async writerFor(did) {
        if (did !== ALICE) return null;
        return {
          did,
          fetchHandler: (pathname, init) => {
            const headers = new Headers(init?.headers);
            headers.set('authorization', `Bearer ${account.token}`);
            return policyFetch(new URL(pathname, pds.origin), { ...init, headers });
          },
        };
      },
    };
    w.app.db.run('UPDATE users SET pds=? WHERE did=?', pds.origin, ALICE);
    const outboxDeps = {
      ...deps,
      db: wholeDecisionTrace.db,
      config: { ...deps.config, publication: true },
      transport: pdsTransport,
      identity: cachedIdentityResolver(wholeDecisionTrace.db, { transport: pdsTransport, clock: w.clock }),
      writers,
    };
    const created = await enqueueLove(tracedDeps, {
      did: ALICE,
      input: { artist, track, recordingMbid: MBID },
      origin: 'web',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await runOutbox(outboxDeps, w.clock.nowMs());
    if (sentBeforeAbsence) {
      for (let i = 0; i < 4; i++) {
        w.clock.advance(SECOND);
        await runForward({ ...w.rt, db: wholeDecisionTrace.db }, w.clock.nowMs());
      }
      expect(w.lb.feedback.map((entry) => entry.json)).toEqual([{ recording_mbid: MBID, score: 1 }]);
    }
    const binding = w.app.db.one<{ uri: string; incarnation_key: string }>(
      'SELECT uri,incarnation_key FROM love_api_bindings WHERE did=? AND operation_id=?',
      ALICE,
      created.operation.id,
    );
    expect(binding).not.toBeNull();
    expect(
      w.app.db.one('SELECT sent_operation_id FROM love_api_recipients WHERE link_id=? AND uri=?', linkId, binding!.uri),
    ).toEqual({ sent_operation_id: sentBeforeAbsence ? created.operation.id : null });
    const rkey = binding!.uri.slice(binding!.uri.lastIndexOf('/') + 1);
    const presentCar = await repo.getRecordCar('com.example.atmusic.love', rkey);
    const presentProof = await verifyRecordProof(presentCar, {
      did: ALICE,
      collection: 'com.example.atmusic.love',
      rkey,
      signingKey: keys.alice.didKey,
    });
    const presentNs = fromMs(w.clock.nowMs());
    const presentResult = w.app.db.tx(() =>
      applyRecordProof(wholeDecisionTrace.db, presentProof, {
        ...authorizedLiveOptions(wholeDecisionTrace.db, presentProof, w.rt.random),
        nowNs: presentNs,
        receiptNs: presentNs,
      }),
    );
    if (presentResult.outcome !== 'applied' || w.app.db.one('SELECT 1 FROM loves WHERE uri=?', binding!.uri) === null)
      throw new Error(`API love projection missing: ${JSON.stringify(presentResult)}`);

    await repo.delete('com.example.atmusic.love', rkey);
    const absentCar = await repo.getRecordCar('com.example.atmusic.love', rkey);
    const absentProof = await verifyRecordProof(absentCar, {
      did: ALICE,
      collection: 'com.example.atmusic.love',
      rkey,
      signingKey: keys.alice.didKey,
    });
    recordLiveEvidence(
      wholeDecisionTrace.db,
      {
        uri: binding!.uri,
        did: ALICE,
        collection: 'com.example.atmusic.love',
        rkey,
        rev: absentProof.commit.rev,
        action: 'delete',
      },
      w.clock.nowMs(),
    );
    const absentNs = fromMs(w.clock.nowMs());
    const applyOptions = authorizedLiveOptions(wholeDecisionTrace.db, absentProof, w.rt.random);
    const absentResult = wholeDecisionTrace.db.tx(() =>
      applyRecordProof(wholeDecisionTrace.db, absentProof, {
        ...applyOptions,
        nowNs: absentNs,
        receiptNs: absentNs,
      }),
    );
    expect(absentResult.outcome).toBe('absent');
    expect(w.app.db.one('SELECT 1 FROM love_api_unlove_decisions')).toBeNull();
    expect(w.app.db.all("SELECT link_id,kind,dedupe_key,state FROM forward_outbox WHERE kind='unlove'")).toHaveLength(
      2,
    );
    const materialized = materializeLoveApiRecipientDecisions(
      wholeDecisionTrace.db,
      w.clock.nowMs(),
      w.rt.random,
      'paused-world',
    );
    expect(materialized.queued).toBe(0);
    expect(materialized.awaiting).toBe(0);
    for (let i = 0; i < 8; i++) {
      w.clock.advance(SECOND);
      await w.run();
    }
    const lbUnloves = w.lb.feedback.filter((x) => (x.json as { score: number }).score === 0).length;
    console.log(
      'ACTUAL_DUPLICATE_TRANSPORT',
      JSON.stringify({
        fmUnloves,
        lbUnloves,
        rows: w.app.db.all("SELECT kind,dedupe_key,state FROM forward_outbox WHERE kind='unlove'"),
      }),
    );
    const prior = w.lb.feedback.length;
    const priorFm = fmUnloves;
    w.clock.advance(SECOND);
    await w.run();
    expect(w.lb.feedback.length).toBe(prior);
    expect(fmUnloves).toBe(priorFm);
    expect({ fmUnloves, lbUnloves }).toEqual({ fmUnloves: 1, lbUnloves: 1 });
  },
);

it.each([
  { count: 1, sentBeforeAbsence: true, absencePath: 'direct' as const },
  { count: 2, sentBeforeAbsence: true, absencePath: 'direct' as const },
  { count: 2, sentBeforeAbsence: false, absencePath: 'direct' as const },
  { count: 2, sentBeforeAbsence: false, absencePath: 'delayed' as const },
])(
  'sends one actual unlove per service after %o API operations reuse one snapshot incarnation',
  async ({ count, sentBeforeAbsence, absencePath }) => {
    const w = await world();
    const linkId = w.link();
    const sk = w.lastfm.addSession('alice_fm');
    const lastfmLinkId = saveLink(
      { db: w.app.db, clock: w.clock, random: w.rt.random, box: w.rt.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm', credential: sk },
    ).link.id;
    let fmUnloves = 0;
    const oldFetch = w.lastfm.fetch.bind(w.lastfm);
    w.lastfm.fetch = async (req: Request) => {
      const form = new URLSearchParams(await req.clone().text());
      if (form.get('method') === 'track.unlove') fmUnloves++;
      return oldFetch(req);
    };
    const deps = w.app.composed.core.deps;
    const wholeDecisionTrace = traceDb(w.app.db);
    const tracedDeps = { ...deps, db: wholeDecisionTrace.db };
    const artist = 'L2 Paused API Artist';
    const track = 'L2 Paused API Track';
    const keys = await fixtureKeys();
    const repo = new SignedRepo(ALICE, keys.alice, { clock: w.clock });
    const pds = new FakePds('api-proof-pds.test', { clock: w.clock });
    const account = await pds.addAccount(repo);
    const pdsTransport = routerTransport({ hosts: { 'api-proof-pds.test': pds } });
    const policyFetch = bindPolicyFetch(createPolicyFetch({ transport: pdsTransport }), PDS_WRITER_CAPS);
    const writers: PdsWriterSource = {
      async writerFor(did) {
        if (did !== ALICE) return null;
        return {
          did,
          fetchHandler: (pathname, init) => {
            const headers = new Headers(init?.headers);
            headers.set('authorization', `Bearer ${account.token}`);
            return policyFetch(new URL(pathname, pds.origin), { ...init, headers });
          },
        };
      },
    };
    w.app.db.run('UPDATE users SET pds=? WHERE did=?', pds.origin, ALICE);
    const outboxDeps = {
      ...deps,
      db: wholeDecisionTrace.db,
      config: { ...deps.config, publication: true },
      transport: pdsTransport,
      identity: cachedIdentityResolver(wholeDecisionTrace.db, { transport: pdsTransport, clock: w.clock }),
      writers,
    };
    w.app.db.run(
      "INSERT OR IGNORE INTO users(did,joined_at,indexing_state) VALUES(?,'2026-01-15T00:00:00Z','current')",
      ALICE,
    );
    const snapshotKey = '3ksnapshotprobe';
    if (!sentBeforeAbsence)
      w.app.db.run(
        `INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq)
         VALUES(?,?,'import','lastfm',?,101)`,
        ALICE,
        `love-uri:${ALICE}:com.example.atmusic.love:${snapshotKey}`,
        w.clock.nowMs(),
      );
    await repo.put('com.example.atmusic.love', snapshotKey, {
      $type: 'com.example.atmusic.love',
      artist,
      track,
      recordingMbid: MBID,
      createdAt: '2026-01-15T11:00:00Z',
    });
    const snapshotProof = await verifyRecordProof(await repo.getRecordCar('com.example.atmusic.love', snapshotKey), {
      did: ALICE,
      collection: 'com.example.atmusic.love',
      rkey: snapshotKey,
      signingKey: keys.alice.didKey,
    });
    expect(
      w.app.db.tx(() =>
        applyRecordProof(w.app.db, snapshotProof, {
          prefix: 'com.example.atmusic',
          nowNs: fromMs(w.clock.nowMs()),
          receiptNs: fromMs(w.clock.nowMs()),
        }),
      ).outcome,
    ).toBe('applied');
    expect(
      w.app.db.one(
        'SELECT path FROM love_incarnations WHERE uri=?',
        `at://${ALICE}/com.example.atmusic.love/${snapshotKey}`,
      ),
    ).toEqual({ path: sentBeforeAbsence ? 'snapshot' : 'import' });
    const created = await enqueueLove(tracedDeps, {
      did: ALICE,
      input: { artist, track, recordingMbid: MBID },
      origin: 'web',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await runOutbox(outboxDeps, w.clock.nowMs());
    if (sentBeforeAbsence) {
      for (let i = 0; i < 4; i++) {
        w.clock.advance(SECOND);
        await runForward({ ...w.rt, db: wholeDecisionTrace.db }, w.clock.nowMs());
      }
      expect(w.lb.feedback.map((entry) => entry.json)).toEqual([{ recording_mbid: MBID, score: 1 }]);
    }
    const binding = w.app.db.one<{ uri: string; incarnation_key: string }>(
      'SELECT uri,incarnation_key FROM love_api_bindings WHERE did=? AND operation_id=?',
      ALICE,
      created.operation.id,
    );
    expect(binding).not.toBeNull();
    const apiOperationIds = [created.operation.id];
    expect(
      w.app.db.one('SELECT sent_operation_id FROM love_api_recipients WHERE link_id=? AND uri=?', linkId, binding!.uri),
    ).toEqual({ sent_operation_id: sentBeforeAbsence ? created.operation.id : null });
    const rkey = binding!.uri.slice(binding!.uri.lastIndexOf('/') + 1);
    const presentCar = await repo.getRecordCar('com.example.atmusic.love', rkey);
    const presentProof = await verifyRecordProof(presentCar, {
      did: ALICE,
      collection: 'com.example.atmusic.love',
      rkey,
      signingKey: keys.alice.didKey,
    });
    const presentNs = fromMs(w.clock.nowMs());
    const presentResult = w.app.db.tx(() =>
      applyRecordProof(wholeDecisionTrace.db, presentProof, {
        ...authorizedLiveOptions(wholeDecisionTrace.db, presentProof, w.rt.random),
        nowNs: presentNs,
        receiptNs: presentNs,
      }),
    );
    if (
      presentResult.outcome !== 'noop_older' ||
      w.app.db.one('SELECT 1 FROM loves WHERE uri=?', binding!.uri) === null
    )
      throw new Error(`API love projection missing: ${JSON.stringify(presentResult)}`);

    if (count === 2) {
      const second = await enqueueLove(tracedDeps, {
        did: ALICE,
        input: { artist, track, recordingMbid: MBID },
        origin: 'lastfm',
      });
      if (!second.ok) throw new Error(JSON.stringify(second.reason));
      apiOperationIds.push(second.operation.id);
      await runOutbox(outboxDeps, w.clock.nowMs());
      expect(
        w.app.db.one('SELECT uri,incarnation_key FROM love_api_bindings WHERE operation_id=?', second.operation.id),
      ).toEqual(binding);
      expect(
        w.app.db.all<{ operation_id: string; api_origin: string }>(
          'SELECT operation_id,api_origin FROM love_api_bindings WHERE operation_id IN (?,?) ORDER BY binding_seq',
          created.operation.id,
          second.operation.id,
        ),
      ).toEqual([
        { operation_id: created.operation.id, api_origin: 'web' },
        { operation_id: second.operation.id, api_origin: 'lastfm' },
      ]);
      if (sentBeforeAbsence) {
        for (let i = 0; i < 4; i++) {
          w.clock.advance(SECOND);
          await w.run();
        }
        expect(
          w.app.db.all("SELECT state FROM forward_outbox WHERE kind='love' AND dedupe_key=?", second.operation.id),
        ).toEqual([{ state: 'sent' }, { state: 'sent' }]);
      }
      expect(w.app.db.all('SELECT 1 FROM love_api_recipient_members')).toHaveLength(sentBeforeAbsence ? 0 : count * 2);
    }
    await repo.delete('com.example.atmusic.love', rkey);
    const absentCar = await repo.getRecordCar('com.example.atmusic.love', rkey);
    const absentProof = await verifyRecordProof(absentCar, {
      did: ALICE,
      collection: 'com.example.atmusic.love',
      rkey,
      signingKey: keys.alice.didKey,
    });
    const nowMs = w.clock.nowMs();
    if (absencePath === 'delayed') {
      const currentLove = wholeDecisionTrace.db.one<{
        uri: string;
        cid: string;
        artist_key: string;
        track_key: string;
        artist: string;
        track: string;
        recording_mbid: string | null;
      }>('SELECT uri,cid,artist_key,track_key,artist,track,recording_mbid FROM loves WHERE uri=?', binding!.uri);
      if (currentLove === null) throw new Error('imported projection missing before delayed API absence');
      recordPendingRemovals(wholeDecisionTrace.db, [
        {
          did: ALICE,
          uri: binding!.uri,
          kind: 'love',
          row: {
            ...currentLove,
            listened_at: new Date(nowMs).toISOString(),
            record_uri: null,
            listen_id: null,
          },
          identityKey: binding!.incarnation_key,
          windowLo: presentProof.commit.rev,
          windowHi: absentProof.commit.rev,
          replacedByCid: null,
          loveSourceService: 'lastfm',
          nowMs,
        },
      ]);
    }
    recordLiveEvidence(
      wholeDecisionTrace.db,
      {
        uri: binding!.uri,
        did: ALICE,
        collection: 'com.example.atmusic.love',
        rkey,
        rev: absentProof.commit.rev,
        action: 'delete',
      },
      nowMs,
    );
    const absentNs = fromMs(nowMs);
    const applyOptions = authorizedLiveOptions(wholeDecisionTrace.db, absentProof, w.rt.random);
    const absentResult = wholeDecisionTrace.db.tx(() =>
      applyRecordProof(wholeDecisionTrace.db, absentProof, {
        ...applyOptions,
        nowNs: absentNs,
        receiptNs: absentNs,
      }),
    );
    expect(absentResult.outcome).toBe('absent');
    if (absencePath === 'delayed') {
      wholeDecisionTrace.db.tx(() =>
        authorizePendingRemovals(
          wholeDecisionTrace.db,
          { uri: binding!.uri, rev: absentProof.commit.rev, action: 'delete' },
          nowMs,
        ),
      );
      expect(
        wholeDecisionTrace.db.tx(() =>
          executeAuthorizedRemovals(wholeDecisionTrace.db, {
            uri: binding!.uri,
            nowMs,
            random: w.rt.random,
            limit: 1,
          }),
        ).groups,
      ).toBe(1);
    }

    const unloveRowsBeforeDispatch = w.app.db.all(
      "SELECT link_id,kind,dedupe_key,state FROM forward_outbox WHERE kind='unlove'",
    );
    const materialized = materializeLoveApiRecipientDecisions(
      wholeDecisionTrace.db,
      w.clock.nowMs(),
      w.rt.random,
      'paused-world',
    );
    if (!sentBeforeAbsence) {
      expect(materialized).toMatchObject({ queued: 0, awaiting: 1 });
      expect(
        w.app.db.one<{ state: string; sent_operation_id: string | null }>(
          'SELECT state,sent_operation_id FROM love_api_recipients WHERE link_id=? AND uri=?',
          lastfmLinkId,
          binding!.uri,
        ),
      ).toEqual({ state: 'sealed', sent_operation_id: null });
      for (let i = 0; i < 8; i++) {
        w.clock.advance(SECOND);
        await w.run();
      }
      expect(w.app.db.all("SELECT state FROM forward_outbox WHERE kind='love' ORDER BY link_id,dedupe_key")).toEqual(
        Array.from({ length: count * 2 }, () => ({ state: 'sent' })),
      );
      const recipientAfterSent = w.app.db.one<{ state: string; sent_operation_id: string | null }>(
        'SELECT state,sent_operation_id FROM love_api_recipients WHERE link_id=? AND uri=?',
        lastfmLinkId,
        binding!.uri,
      );
      expect(recipientAfterSent?.sent_operation_id).toBeTruthy();
      expect(apiOperationIds).toContain(recipientAfterSent?.sent_operation_id);
      const resumed = materializeLoveApiRecipientDecisions(
        wholeDecisionTrace.db,
        w.clock.nowMs(),
        w.rt.random,
        'late-sent-resume',
      );
      expect(resumed.queued).toBe(1);
      expect(materialized.awaiting).toBe(1);
    } else {
      expect(materialized.queued).toBe(2);
      expect(materialized.awaiting).toBe(0);
    }
    for (let i = 0; i < 8; i++) {
      w.clock.advance(SECOND);
      await w.run();
    }
    const lbUnloves = w.lb.feedback.filter((x) => (x.json as { score: number }).score === 0).length;
    console.log(
      'ACTUAL_DUPLICATE_TRANSPORT',
      JSON.stringify({
        count,
        unloveRowsBeforeDispatch,
        fmUnloves,
        lbUnloves,
        rows: w.app.db.all("SELECT kind,dedupe_key,state FROM forward_outbox WHERE kind='unlove'"),
      }),
    );
    const prior = w.lb.feedback.length;
    const priorFm = fmUnloves;
    w.clock.advance(SECOND);
    await w.run();
    expect(w.lb.feedback.length).toBe(prior);
    expect(fmUnloves).toBe(priorFm);
    expect({ fmUnloves, lbUnloves }).toEqual({ fmUnloves: 1, lbUnloves: 1 });
  },
);

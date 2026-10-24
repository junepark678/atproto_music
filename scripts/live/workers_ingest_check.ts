// Live gate: publish, index, external writer, delete and reconcile (ADR 0004
// §5.2, §5.4, A6, A13; W6-05).
//
// Usage: npx tsx scripts/live/workers_ingest_check.ts
//
// 1. App publish on PDS A. The deployed SPA (Playwright, signed in as A, see
//    workers_oauth_check.ts) publishes a scrobble from /scrobble. The SPA's
//    notify call is answered in the browser with 202 and never reaches the
//    Worker, so the record can only arrive through Jetstream: the measured
//    time from the PDS createRecord answer to `indexed` in
//    GET /api/v1/records/status is the Jetstream→indexed lag.
// 2. External writer on PDS B. The record is created directly on PDS B with
//    an app password (com.atproto.server.createSession + repo.createRecord);
//    nothing tells the Worker, so it too arrives through Jetstream.
// 3. Every indexed record is independently fetched from its PDS and verified
//    with the production verifier (fresh identity, signed commit, MST
//    inclusion). The evidence records the verified CID and revision next to
//    what the API reported; the CIDs must be equal.
// 4. Delete and reconcile: A's record is deleted through the app (profile
//    page "Delete" → "Confirm delete", notify again intercepted) and B's
//    record externally (repo.deleteRecord). Each must become `absent` in
//    records/status, and absence is independently verified at a signed head
//    newer than the one that proved the record present: with an MST
//    exclusion proof from getRecord when the PDS offers one, otherwise (F4,
//    ADR §13.8) with the production snapshot verifier, a verified getRepo
//    enumeration of the collection that lacks the key. Each entry records the
//    method (`exclusionProof` or `snapshot`); the evidence verifier requires
//    it to match the pdsCompat exclusion-proof result for that PDS.
// 5. /internal/admin/status (ADMIN_TOKEN) is sampled before and after for the
//    ingest mode, socket state and Jetstream cursor lag.
//
// Cleanup: every record the gate created is deleted (step 4, or in a finally
// block on failure) and the evidence says what, if anything, is left.
//
// Without the prerequisites (owned NSID, deployed origin and version, two
// identities on independent PDSs, Jetstream coverage, ADMIN_TOKEN, sign-in for
// A and an app password for B) it prints `blocked`, lists each missing
// variable and exits 2 before any request.

import { collectionsFor } from '@atmusic/core/namespace';
import { parseRecordUri } from '@atmusic/core/syntax';
import type { Page } from '@playwright/test';
import {
  ADMIN_REQ,
  adminStatus,
  checkDeployment,
  checkIdentityPds,
  ENV,
  expect,
  field,
  type GateContext,
  type GateSpec,
  httpJson,
  IDENTITY_REQS,
  intRequirement,
  isMain,
  JETSTREAM_REQ,
  main,
  PartialResult,
  PDS_IMPLEMENTATION_REQS,
  type PdsInfo,
  pdsInfo,
  pollUntil,
  RELEASE_REQS,
  type Requirement,
  verifyAbsent,
  verifyRecordAt,
  xrpcUrl,
} from './live-gate.ts';
import {
  launchBrowser,
  OAUTH_ENV,
  signInChecks,
  signInThroughApp,
  signInTimeoutMs,
  signOutOfApp,
} from './workers_oauth_check.ts';

export const INGEST_ENV = {
  appPasswordB: 'ATMUSIC_LIVE_APP_PASSWORD_B',
  timeoutSeconds: 'ATMUSIC_LIVE_INGEST_TIMEOUT_S',
} as const;

export const INGEST_REQS: readonly Requirement[] = [
  {
    name: OAUTH_ENV.handleA,
    what: 'handle of the identity on PDS A, which publishes through the app',
  },
  { name: OAUTH_ENV.handleB, what: 'handle of the identity on PDS B, the external writer' },
  { name: INGEST_ENV.appPasswordB, what: 'app password of identity B for direct, external PDS writes' },
  intRequirement(INGEST_ENV.timeoutSeconds, 'seconds to wait for indexing or reconciliation, default 300', 10, 3600),
];

type RecordStatus = { state: string; cid?: string; revision?: string; reason?: string };

async function recordStatus(ctx: GateContext, uri: string): Promise<RecordStatus> {
  const url = new URL('/api/v1/records/status', ctx.origin);
  url.searchParams.set('uri', uri);
  const res = await httpJson(url);
  expect(res.status === 200, `records/status for ${uri} returned ${res.status}`);
  return res.json as RecordStatus;
}

function ingestSnapshot(status: Record<string, unknown>) {
  const ingest = field<Record<string, unknown>>(status, 'ingest') ?? {};
  const lastUs = field<number>(ingest, 'lastEventTimeUs');
  return {
    mode: field(ingest, 'mode'),
    connected: field(ingest, 'connected'),
    pendingGap: field(ingest, 'pendingGap'),
    hostIndex: field(ingest, 'hostIndex'),
    cursorLagMs: typeof lastUs === 'number' ? Math.max(0, Date.now() - Math.floor(lastUs / 1000)) : null,
  };
}

interface Written {
  uri: string;
  cid: string;
  rev: string | null;
  committedAtMs: number;
}

/** Wait for `indexed` with the written CID, then verify the record independently at its PDS. */
async function awaitIndexed(ctx: GateContext, written: Written, timeoutMs: number) {
  const done = await pollUntil(
    async () => {
      const status = await recordStatus(ctx, written.uri);
      return status.state === 'indexed' ? status : null;
    },
    { timeoutMs, intervalMs: 1000 },
  );
  expect(done !== null, `${written.uri} was not indexed within ${timeoutMs / 1000} s`);
  const lagMs = Date.now() - written.committedAtMs;
  const parsed = parseRecordUri(written.uri);
  expect(parsed !== null, `malformed URI ${written.uri}`);
  const proof = await verifyRecordAt(parsed.did, parsed.collection, parsed.rkey);
  expect(proof.state === 'present', `${written.uri} is indexed but its PDS proves it absent`);
  expect(
    proof.cid === written.cid,
    `${written.uri}: verified CID ${proof.cid} differs from the written ${written.cid}`,
  );
  expect(
    done.value.cid === proof.cid,
    `${written.uri}: indexed CID ${done.value.cid} differs from verified ${proof.cid}`,
  );
  return {
    uri: written.uri,
    cid: written.cid,
    rev: written.rev,
    indexedCid: done.value.cid,
    indexedRevision: done.value.revision ?? null,
    verifiedCid: proof.cid,
    verifiedRev: proof.rev,
    verifiedCommitCid: proof.commitCid,
    lagMs,
  };
}

/**
 * Wait for `absent`, then verify absence independently at a signed head newer
 * than `presentRev`, the head at which the record was verified present (a
 * stale head from before the write would lack the key as well).
 */
async function awaitAbsent(
  ctx: GateContext,
  uri: string,
  presentRev: string,
  deleted: { atMs: number; rev: string | null },
  timeoutMs: number,
) {
  const done = await pollUntil(
    async () => {
      const status = await recordStatus(ctx, uri);
      return status.state === 'absent' ? status : null;
    },
    { timeoutMs, intervalMs: 1000 },
  );
  expect(done !== null, `${uri} was not reconciled to absent within ${timeoutMs / 1000} s`);
  const lagMs = Date.now() - deleted.atMs;
  const parsed = parseRecordUri(uri);
  expect(parsed !== null, `malformed URI ${uri}`);
  const absence = await verifyAbsent(parsed.did, parsed.collection, parsed.rkey, { after: presentRev });
  expect(
    deleted.rev === null || absence.rev >= deleted.rev,
    `${uri}: absence verified at rev ${absence.rev}, older than the delete commit ${deleted.rev}`,
  );
  return {
    uri,
    absentVerified: true,
    method: absence.method,
    ...(absence.exclusionProofUnavailable === undefined
      ? {}
      : { exclusionProofUnavailable: absence.exclusionProofUnavailable, keysEnumerated: absence.keysEnumerated }),
    statusRevision: done.value.revision ?? null,
    presentRev,
    deleteRev: deleted.rev,
    verifiedRev: absence.rev,
    verifiedCommitCid: absence.commitCid,
    lagMs,
  };
}

function scrobbleRecord(collection: string, runId: string, who: string) {
  const now = new Date();
  const listened = new Date(now.getTime() - 60_000);
  const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
  return {
    $type: collection,
    artist: 'atmusic live gate',
    track: `${who} ${runId}`,
    listenedAt: iso(listened),
    createdAt: iso(now),
  };
}

interface PdsSession {
  did: string;
  accessJwt: string;
}

async function createSession(pds: string, identifier: string, password: string): Promise<PdsSession> {
  const res = await httpJson(xrpcUrl(pds, 'com.atproto.server.createSession'), {
    method: 'POST',
    body: { identifier, password },
  });
  const did = field<string>(res.json, 'did');
  const accessJwt = field<string>(res.json, 'accessJwt');
  expect(
    res.status === 200 && typeof did === 'string' && typeof accessJwt === 'string',
    `createSession: HTTP ${res.status}`,
  );
  return { did, accessJwt };
}

async function externalCreate(pds: string, session: PdsSession, collection: string, record: object): Promise<Written> {
  const res = await httpJson(xrpcUrl(pds, 'com.atproto.repo.createRecord'), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessJwt}` },
    body: { repo: session.did, collection, record, validate: false },
  });
  const committedAtMs = Date.now();
  const uri = field<string>(res.json, 'uri');
  const cid = field<string>(res.json, 'cid');
  expect(res.status === 200 && typeof uri === 'string' && typeof cid === 'string', `createRecord: HTTP ${res.status}`);
  return { uri, cid, rev: field<string>(field(res.json, 'commit'), 'rev') ?? null, committedAtMs };
}

async function externalDelete(
  pds: string,
  session: PdsSession,
  uri: string,
): Promise<{ atMs: number; rev: string | null }> {
  const parsed = parseRecordUri(uri);
  expect(parsed !== null, `malformed URI ${uri}`);
  const res = await httpJson(xrpcUrl(pds, 'com.atproto.repo.deleteRecord'), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessJwt}` },
    body: { repo: session.did, collection: parsed.collection, rkey: parsed.rkey },
  });
  const atMs = Date.now();
  expect(res.status === 200, `deleteRecord ${uri}: HTTP ${res.status}`);
  return { atMs, rev: field<string>(field(res.json, 'commit'), 'rev') ?? null };
}

/** Answer the SPA's notify in the browser so only Jetstream can deliver the record. */
async function interceptNotify(page: Page, origin: string): Promise<{ count: number }> {
  const counter = { count: 0 };
  await page.route(`${origin}/api/v1/notify`, async (route) => {
    counter.count++;
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ state: 'queued' }) });
  });
  return counter;
}

/** Wait for the SPA's PDS answer to `nsid` and return its JSON. */
function nextPdsAnswer(page: Page, origin: string, nsid: string, timeoutMs: number) {
  return page
    .waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).origin !== origin &&
        new URL(r.url()).pathname === `/xrpc/${nsid}` &&
        r.status() === 200,
      { timeout: timeoutMs },
    )
    .then(async (r) => ({ json: (await r.json()) as unknown, atMs: Date.now() }));
}

async function appPublish(page: Page, ctx: GateContext, runId: string, timeoutMs: number): Promise<Written> {
  await page.goto(new URL('/scrobble', ctx.origin).href);
  const listened = `${new Date(Date.now() - 60_000).toISOString().slice(0, 19)}Z`;
  await page.locator('[name="artist"]').fill('atmusic live gate');
  await page.locator('[name="track"]').fill(`app ${runId}`);
  await page.locator('[name="listenedAt"]').fill(listened);
  const answer = nextPdsAnswer(page, ctx.origin, 'com.atproto.repo.createRecord', timeoutMs);
  await page.getByRole('button', { name: 'Publish scrobble', exact: true }).click();
  const { json, atMs } = await answer;
  const uri = field<string>(json, 'uri');
  const cid = field<string>(json, 'cid');
  expect(typeof uri === 'string' && typeof cid === 'string', 'the app createRecord answer has no uri/cid');
  return { uri, cid, rev: field<string>(field(json, 'commit'), 'rev') ?? null, committedAtMs: atMs };
}

async function appDelete(
  page: Page,
  ctx: GateContext,
  did: string,
  uri: string,
  timeoutMs: number,
): Promise<{ atMs: number; rev: string | null }> {
  await page.goto(new URL(`/u/${did}`, ctx.origin).href);
  const item = page.locator(`li[data-uri="${uri}"]`);
  await item.getByRole('button', { name: /^Delete / }).click({ timeout: 30_000 });
  const answer = nextPdsAnswer(page, ctx.origin, 'com.atproto.repo.deleteRecord', timeoutMs);
  await item.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  const { json, atMs } = await answer;
  return { atMs, rev: field<string>(field(json, 'commit'), 'rev') ?? null };
}

export const spec: GateSpec = {
  gate: 'ingest',
  script: 'scripts/live/workers_ingest_check.ts',
  requirements: [
    ...RELEASE_REQS,
    ...IDENTITY_REQS,
    ...PDS_IMPLEMENTATION_REQS,
    JETSTREAM_REQ,
    ADMIN_REQ,
    ...INGEST_REQS,
  ],
  extraChecks: (env) => signInChecks(env, OAUTH_ENV.passwordA, 'A'),
  async run(ctx) {
    const timeoutMs = Number(ctx.env[INGEST_ENV.timeoutSeconds] || 300) * 1000;
    const collection = collectionsFor(ctx.prefix).scrobble;
    const runId = new Date().toISOString();
    const deployment = await checkDeployment(ctx);
    const didA = ctx.get(ENV.didA);
    const didB = ctx.get(ENV.didB);
    const pds: PdsInfo[] = [
      await pdsInfo(ctx.get(ENV.pdsA), ctx.get(ENV.pdsAImplementation)),
      await pdsInfo(ctx.get(ENV.pdsB), ctx.get(ENV.pdsBImplementation)),
    ];
    await checkIdentityPds(didA, pds[0]!.endpoint);
    await checkIdentityPds(didB, pds[1]!.endpoint);
    const before = ingestSnapshot(await adminStatus(ctx));
    expect(
      before.mode === 'socket' || before.mode === 'pulse',
      `ingest mode is ${String(before.mode)}, not socket/pulse`,
    );

    const results: Record<string, unknown> = { deployment, ingestBefore: before };
    const created: { uri: string; via: 'app' | 'external'; deleted: boolean }[] = [];
    const browser = await launchBrowser(ctx.env);
    const context = await browser.newContext();
    let session: PdsSession | null = null;
    const page = await context.newPage();
    const subjects = () => created.map((c) => ({ did: parseRecordUri(c.uri)?.did ?? '', uri: c.uri }));
    try {
      const signIn = await signInThroughApp(page, {
        origin: ctx.origin,
        handle: ctx.get(OAUTH_ENV.handleA),
        password: ctx.env[OAUTH_ENV.interactive] === '1' ? undefined : ctx.get(OAUTH_ENV.passwordA),
        timeoutMs: signInTimeoutMs(ctx.env),
      });
      expect(signIn.did === didA, `the app signed in as ${signIn.did}, not ${didA}`);
      const notify = await interceptNotify(page, ctx.origin);

      // 1. App publish on A (Jetstream only).
      const local = await appPublish(page, ctx, runId, timeoutMs);
      created.push({ uri: local.uri, via: 'app', deleted: false });
      expect(parseRecordUri(local.uri)?.did === didA, `the app wrote ${local.uri}, not into ${didA}`);
      const localIndexed = await awaitIndexed(ctx, local, timeoutMs);
      results.localPublish = localIndexed;

      // 2. External writer on B.
      session = await createSession(pds[1]!.endpoint, ctx.get(OAUTH_ENV.handleB), ctx.get(INGEST_ENV.appPasswordB));
      expect(session.did === didB, `PDS B session is ${session.did}, not ${didB}`);
      const external = await externalCreate(
        pds[1]!.endpoint,
        session,
        collection,
        scrobbleRecord(collection, runId, 'external'),
      );
      created.push({ uri: external.uri, via: 'external', deleted: false });
      const externalIndexed = await awaitIndexed(ctx, external, timeoutMs);
      results.externalPublish = externalIndexed;

      // 3. Delete and reconcile, both paths.
      const deleteReconcile: unknown[] = [];
      const appDeleted = await appDelete(page, ctx, didA, local.uri, timeoutMs);
      created[0]!.deleted = true;
      deleteReconcile.push({
        via: 'app',
        ...(await awaitAbsent(ctx, local.uri, localIndexed.verifiedRev, appDeleted, timeoutMs)),
      });
      const extDeleted = await externalDelete(pds[1]!.endpoint, session, external.uri);
      created[1]!.deleted = true;
      deleteReconcile.push({
        via: 'external',
        ...(await awaitAbsent(ctx, external.uri, externalIndexed.verifiedRev, extDeleted, timeoutMs)),
      });
      results.deleteReconcile = deleteReconcile;
      results.notifyIntercepted = notify.count;
      results.ingestAfter = ingestSnapshot(await adminStatus(ctx));
    } catch (error) {
      // Keep what was observed before the failure in the evidence.
      throw new PartialResult(error instanceof Error ? error.message : String(error), {
        pds,
        subjects: subjects(),
        results,
      });
    } finally {
      for (const item of created.filter((c) => !c.deleted)) {
        try {
          if (item.via === 'external' && session !== null) await externalDelete(pds[1]!.endpoint, session, item.uri);
          else if (item.via === 'app') await appDelete(page, ctx, didA, item.uri, timeoutMs);
          else continue;
          item.deleted = true;
        } catch {
          // Reported below.
        }
      }
      for (const item of created) {
        ctx.cleanup(item.deleted ? `${item.uri} deleted (${item.via})` : `${item.uri} LEFT BEHIND: delete it by hand`);
      }
      await signOutOfApp(page, ctx.origin);
      await context.close();
      await browser.close();
    }
    return { pds, subjects: subjects(), results };
  },
};

if (isMain(import.meta.url)) main(spec);

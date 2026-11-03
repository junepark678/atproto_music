// Node live gate: app BFF publish, independent PDS B writer, proof indexing,
// and delete reconciliation. This is deliberately separate from the Workers
// driver because the Node OAuth exchange is server-side.

import { randomUUID } from 'node:crypto';
import { collectionsFor } from '@atmusic/core/namespace';
import { parseRecordUri } from '@atmusic/core/syntax';
import type { Browser, Page } from '@playwright/test';
import {
  checkIdentityPds,
  ENV,
  expect,
  field,
  httpJson,
  IDENTITY_REQS,
  JETSTREAM_REQ,
  PDS_IMPLEMENTATION_REQS,
  type PdsInfo,
  pdsInfo,
  pollUntil,
  type Requirement,
  verifyAbsent,
  verifyRecordAt,
  xrpcUrl,
} from './live-gate.ts';
import {
  isNodeGateMain,
  mainNodeGate,
  type NodeGateBodyResult,
  type NodeGateContext,
  type NodeGateSpec,
} from './node-live-gate.ts';
import { launchBrowser, OAUTH_ENV, signInChecks, signInTimeoutMs } from './workers_oauth_check.ts';

export const NODE_INGEST_ENV = {
  appPasswordB: 'ATMUSIC_LIVE_APP_PASSWORD_B',
  timeoutSeconds: 'ATMUSIC_LIVE_INGEST_TIMEOUT_S',
} as const;

const timeoutRequirement: Requirement = {
  name: NODE_INGEST_ENV.timeoutSeconds,
  what: 'seconds to wait for operation, indexing or reconciliation, default 300',
  optional: true,
  check: (value) =>
    /^(?:[1-9]\d{0,3})$/.test(value) && Number(value) <= 3600 ? null : 'must be an integer from 1 to 3600',
};

export const NODE_INGEST_REQUIREMENTS: readonly Requirement[] = [
  ...IDENTITY_REQS,
  ...PDS_IMPLEMENTATION_REQS,
  JETSTREAM_REQ,
  {
    name: OAUTH_ENV.handleA,
    what: 'handle of identity A for app UI sign-in',
    check: (v) => (/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/i.test(v) ? null : 'not a handle'),
  },
  {
    name: OAUTH_ENV.handleB,
    what: 'handle of identity B for PDS B session',
    check: (v) => (/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/i.test(v) ? null : 'not a handle'),
  },
  { name: NODE_INGEST_ENV.appPasswordB, what: 'app password of identity B for direct PDS B record create/delete' },
  timeoutRequirement,
];

interface BrowserSession {
  did: string;
  csrfToken: string;
}

interface PdsSession {
  did: string;
  accessJwt: string;
}

interface Written {
  uri: string;
  cid: string;
  rev: string | null;
}

interface BrowserApiResponse {
  status: number;
  json: unknown;
}

export interface IngestDependencies {
  browser(): Promise<Browser>;
  pdsInfo(endpoint: string, implementation: string): Promise<PdsInfo>;
  httpJson: typeof httpJson;
  verifyRecordAt: typeof verifyRecordAt;
  verifyAbsent: typeof verifyAbsent;
  now(): Date;
  sleep(ms: number): Promise<void>;
  checkIdentityPds(did: string, pds: string): Promise<unknown>;
}

const dependencies: IngestDependencies = {
  browser: () => launchBrowser(process.env),
  pdsInfo,
  httpJson,
  verifyRecordAt,
  verifyAbsent,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  checkIdentityPds,
};

async function browserRequest(
  page: Page,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  csrf?: string,
  extraHeaders: Record<string, string> = {},
): Promise<BrowserApiResponse> {
  return page.evaluate(
    async ({ path, method, body, csrf, extraHeaders }) => {
      const headers: Record<string, string> = { accept: 'application/json' };
      Object.assign(headers, extraHeaders);
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (csrf !== undefined) headers['x-csrf-token'] = csrf;
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        /* Preserve only status on malformed replies. */
      }
      return { status: response.status, json };
    },
    { path, method, body, csrf, extraHeaders },
  );
}

async function appUiSignIn(
  page: Page,
  context: NodeGateContext,
  timeoutMs: number,
  deps: IngestDependencies,
): Promise<BrowserSession> {
  const origin = context.origin;
  await page.goto(new URL('/signin', origin).href);
  await page.locator('#signin-handle').fill(context.get(OAUTH_ENV.handleA));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.origin !== origin, { timeout: 30_000 });

  const password = page.locator('input[type="password"]').first();
  if (context.env[OAUTH_ENV.interactive] !== '1') {
    await password.waitFor({ state: 'visible', timeout: timeoutMs });
    const identifier = page.locator('input[autocomplete="username"], input[name="username"]').first();
    if ((await identifier.isVisible().catch(() => false)) && (await identifier.inputValue()) === '') {
      await identifier.fill(context.get(OAUTH_ENV.handleA));
    }
    await password.fill(context.get(OAUTH_ENV.passwordA));
    await password.press('Enter');
  }

  const deadline = Date.now() + timeoutMs;
  while (new URL(page.url()).origin !== origin && Date.now() < deadline) {
    const consent = page.getByRole('button', { name: /^(authorize|accept|allow|approve)$/i }).first();
    if (await consent.isVisible().catch(() => false)) await consent.click();
    else {
      const next = page.getByRole('button', { name: /^(next|continue|sign in|log in)$/i }).first();
      if (await next.isVisible().catch(() => false)) await next.click();
      else await deps.sleep(250);
    }
  }
  await page.waitForURL((url) => url.origin === origin, { timeout: Math.max(1, deadline - Date.now()) });
  const sessionResponse = await browserRequest(page, '/api/v1/auth/session', 'GET');
  const did = field<string>(sessionResponse.json, 'did');
  const csrfToken = field<string>(sessionResponse.json, 'csrfToken');
  expect(
    sessionResponse.status === 200 && typeof did === 'string' && typeof csrfToken === 'string',
    `GET /api/v1/auth/session returned ${sessionResponse.status} without an active session and csrfToken`,
  );
  expect(did === context.get(ENV.didA), `the app signed in as ${did}, not ${context.get(ENV.didA)}`);
  return { did, csrfToken };
}

async function createPdsSession(
  deps: IngestDependencies,
  pds: string,
  identifier: string,
  password: string,
): Promise<PdsSession> {
  const response = await deps.httpJson(xrpcUrl(pds, 'com.atproto.server.createSession'), {
    method: 'POST',
    body: { identifier, password },
  });
  const did = field<string>(response.json, 'did');
  const accessJwt = field<string>(response.json, 'accessJwt');
  expect(
    response.status === 200 && typeof did === 'string' && typeof accessJwt === 'string',
    `PDS B createSession returned HTTP ${response.status}`,
  );
  return { did, accessJwt };
}

async function pdsCreate(
  deps: IngestDependencies,
  pds: string,
  session: PdsSession,
  collection: string,
  record: object,
): Promise<Written> {
  const response = await deps.httpJson(xrpcUrl(pds, 'com.atproto.repo.createRecord'), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessJwt}` },
    body: { repo: session.did, collection, record, validate: false },
  });
  const uri = field<string>(response.json, 'uri');
  const cid = field<string>(response.json, 'cid');
  expect(
    response.status === 200 && typeof uri === 'string' && typeof cid === 'string',
    `PDS B createRecord returned HTTP ${response.status}`,
  );
  return { uri, cid, rev: field<string>(field(response.json, 'commit'), 'rev') ?? null };
}

async function pdsDelete(
  deps: IngestDependencies,
  pds: string,
  session: PdsSession,
  uri: string,
): Promise<string | null> {
  const parsed = parseRecordUri(uri);
  expect(parsed !== null, `malformed record URI ${uri}`);
  const response = await deps.httpJson(xrpcUrl(pds, 'com.atproto.repo.deleteRecord'), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessJwt}` },
    body: { repo: session.did, collection: parsed.collection, rkey: parsed.rkey },
  });
  expect(response.status === 200, `PDS B deleteRecord ${uri} returned HTTP ${response.status}`);
  return field<string>(field(response.json, 'commit'), 'rev') ?? null;
}

async function localDelete(page: Page, csrfToken: string, uri: string): Promise<string> {
  const response = await browserRequest(
    page,
    `/api/v1/scrobbles/${encodeURIComponent(uri)}`,
    'DELETE',
    undefined,
    csrfToken,
  );
  const operation = field<Record<string, unknown>>(response.json, 'operation');
  const id = field<string>(operation, 'id');
  expect(response.status === 202 && typeof id === 'string', `DELETE /api/v1/scrobbles returned ${response.status}`);
  return id;
}

async function operationUntilSucceeded(page: Page, id: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const found = await pollUntil(
    async () => {
      const response = await browserRequest(page, `/api/v1/operations/${encodeURIComponent(id)}`, 'GET');
      expect(response.status === 200, `GET /api/v1/operations/${id} returned ${response.status}`);
      const operation = field<Record<string, unknown>>(response.json, 'operation');
      const state = field<string>(operation, 'state');
      if (state === 'failed' || state === 'blocked' || state === 'cancelled')
        throw new Error(`operation ${id} ended ${state}`);
      return state === 'succeeded' ? (operation ?? null) : null;
    },
    { timeoutMs, intervalMs: 500 },
  );
  expect(found !== null, `operation ${id} was not succeeded within ${timeoutMs / 1000} s`);
  return found.value;
}

async function recordStatus(page: Page, uri: string): Promise<Record<string, unknown>> {
  const response = await browserRequest(page, `/api/v1/records/status?uri=${encodeURIComponent(uri)}`, 'GET');
  expect(response.status === 200, `GET /api/v1/records/status returned ${response.status}`);
  return (response.json ?? {}) as Record<string, unknown>;
}

function opUpdatedAtMs(operation: Record<string, unknown>, uri: string): number {
  const raw = field<string>(operation, 'updatedAt');
  const parsed = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  expect(Number.isFinite(parsed), `${uri}: succeeded operation has no valid updatedAt timestamp`);
  return parsed;
}

function timestampMs(value: string, uri: string): number {
  const parsed = Date.parse(value);
  expect(Number.isFinite(parsed), `${uri}: delete receipt has no valid timestamp`);
  return parsed;
}

async function awaitIndexed(
  page: Page,
  written: Written,
  receipt: { kind: 'operation'; dto: Record<string, unknown> } | { kind: 'pds'; completedAt: string },
  timeoutMs: number,
  deps: IngestDependencies,
) {
  const done = await pollUntil(
    async () => {
      const status = await recordStatus(page, written.uri);
      return field<string>(status, 'state') === 'indexed' ? status : null;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
  expect(done !== null, `${written.uri} was not indexed within ${timeoutMs / 1000} s after its operation succeeded`);
  const indexedObservedAt = deps.now().getTime();
  const parsed = parseRecordUri(written.uri);
  expect(parsed !== null, `malformed record URI ${written.uri}`);
  const proof = await deps.verifyRecordAt(parsed.did, parsed.collection, parsed.rkey);
  const statusCid = field<string>(done.value, 'cid');
  expect(proof.state === 'present', `${written.uri} was indexed but its PDS proof is absent`);
  expect(
    written.cid === statusCid && statusCid === proof.cid,
    `${written.uri}: operation CID ${written.cid}, status CID ${statusCid}, and independent proof CID ${proof.cid} differ`,
  );
  const updatedAt =
    receipt.kind === 'operation' ? opUpdatedAtMs(receipt.dto, written.uri) : Date.parse(receipt.completedAt);
  expect(Number.isFinite(updatedAt), `${written.uri}: write receipt has no valid timestamp`);
  const lagMs = Math.max(0, indexedObservedAt - updatedAt);
  return {
    uri: written.uri,
    cid: written.cid,
    ...(receipt.kind === 'operation'
      ? {
          operationCid: written.cid,
          operationState: 'succeeded',
          operationUpdatedAt: field(receipt.dto, 'updatedAt'),
        }
      : { pdsWriteCid: written.cid, pdsWriteCompletedAt: receipt.completedAt }),
    statusCid,
    indexedCid: statusCid,
    indexedRevision: field(done.value, 'revision') ?? null,
    verifiedCid: proof.cid,
    verifiedRev: proof.rev,
    verifiedCommitCid: proof.commitCid,
    lagMs,
    lagMeasurement:
      receipt.kind === 'operation'
        ? 'approximate wall-clock time from succeeded operation.updatedAt to first indexed status observation; includes polling delay and clock skew'
        : 'approximate wall-clock time from PDS createRecord response to first indexed status observation; includes polling delay and clock skew',
  };
}

async function awaitAbsent(
  page: Page,
  uri: string,
  presentRev: string,
  deleteCompletedAt: string,
  timeoutMs: number,
  deps: IngestDependencies,
) {
  const found = await pollUntil(
    async () => {
      const status = await recordStatus(page, uri);
      return field<string>(status, 'state') === 'absent' ? status : null;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
  expect(found !== null, `${uri} was not reconciled to absent within ${timeoutMs / 1000} s`);
  const absentObservedAt = deps.now().getTime();
  const parsed = parseRecordUri(uri);
  expect(parsed !== null, `malformed record URI ${uri}`);
  const absence = await deps.verifyAbsent(parsed.did, parsed.collection, parsed.rkey, { after: presentRev });
  expect(absence.rev > presentRev, `${uri}: absence proof is not newer than its present proof`);
  return {
    uri,
    absentVerified: true,
    method: absence.method,
    ...(absence.exclusionProofUnavailable === undefined
      ? {}
      : {
          exclusionProofUnavailable: absence.exclusionProofUnavailable,
          keysEnumerated: absence.keysEnumerated,
        }),
    statusRevision: field(found.value, 'revision') ?? null,
    presentRev,
    verifiedRev: absence.rev,
    verifiedCommitCid: absence.commitCid,
    lagMs: Math.max(0, absentObservedAt - timestampMs(deleteCompletedAt, uri)),
    lagMeasurement:
      'approximate wall-clock time from delete operation/PDS response to first absent status observation; includes polling delay and clock skew',
  };
}

function scrobbleRecord(collection: string, runId: string) {
  const now = new Date();
  return {
    $type: collection,
    artist: 'atmusic Node ingest gate',
    track: `external ${runId}`,
    listenedAt: new Date(now.getTime() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    createdAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export async function runNodeIngest(
  context: NodeGateContext,
  deps: IngestDependencies = dependencies,
): Promise<NodeGateBodyResult> {
  const timeoutMs = Number(context.env[NODE_INGEST_ENV.timeoutSeconds] || 300) * 1000;
  const pds: PdsInfo[] = [];
  const didA = context.get(ENV.didA);
  const didB = context.get(ENV.didB);
  const endpointA = context.get(ENV.pdsA);
  const endpointB = context.get(ENV.pdsB);
  const records: Array<{ uri: string; via: 'app' | 'pdsB'; deleted: boolean; reconciled: boolean }> = [];
  const results: Record<string, unknown> = {};
  let browser: Browser | null = null;
  let browserContext: Awaited<ReturnType<Browser['newContext']>> | null = null;
  let page: Page | null = null;
  let appSession: BrowserSession | null = null;
  let pdsSession: PdsSession | null = null;
  try {
    pds.push(await deps.pdsInfo(endpointA, context.get(ENV.pdsAImplementation)));
    pds.push(await deps.pdsInfo(endpointB, context.get(ENV.pdsBImplementation)));
    await deps.checkIdentityPds(didA, pds[0]!.endpoint);
    await deps.checkIdentityPds(didB, pds[1]!.endpoint);
    browser = await deps.browser();
    browserContext = await browser.newContext();
    page = await browserContext.newPage();
    appSession = await appUiSignIn(page, context, signInTimeoutMs(context.env), deps);

    const runId = randomUUID();
    const localResponse = await browserRequest(
      page,
      '/api/v1/scrobbles',
      'POST',
      {
        artist: 'atmusic Node ingest gate',
        track: `app ${runId}`,
        listenedAt: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
      appSession.csrfToken,
      { 'idempotency-key': runId },
    );
    const localOperation = field<Record<string, unknown>>(localResponse.json, 'operation');
    const localOperationId = field<string>(localOperation, 'id');
    expect(
      localResponse.status === 202 && typeof localOperationId === 'string',
      `POST /api/v1/scrobbles returned ${localResponse.status}`,
    );
    const localOp = await operationUntilSucceeded(page, localOperationId, timeoutMs);
    const localUri = field<string>(localOp, 'uri');
    const localCid = field<string>(localOp, 'cid');
    expect(typeof localUri === 'string' && typeof localCid === 'string', 'succeeded scrobble operation lacks URI/CID');
    const local: Written = { uri: localUri, cid: localCid, rev: null };
    records.push({ uri: local.uri, via: 'app', deleted: false, reconciled: false });
    expect(parseRecordUri(local.uri)?.did === didA, `local BFF wrote ${local.uri}, not identity A`);
    const localIndexed = await awaitIndexed(page, local, { kind: 'operation', dto: localOp }, timeoutMs, deps);
    results.localPublish = localIndexed;

    pdsSession = await createPdsSession(
      deps,
      pds[1]!.endpoint,
      context.get(OAUTH_ENV.handleB),
      context.get(NODE_INGEST_ENV.appPasswordB),
    );
    expect(pdsSession.did === didB, `PDS B session is ${pdsSession.did}, not ${didB}`);
    const collection = collectionsFor(context.lexiconPrefix).scrobble;
    const external = await pdsCreate(deps, pds[1]!.endpoint, pdsSession, collection, scrobbleRecord(collection, runId));
    records.push({ uri: external.uri, via: 'pdsB', deleted: false, reconciled: false });
    expect(parseRecordUri(external.uri)?.did === didB, `PDS B wrote ${external.uri}, not identity B`);
    // Direct PDS writes have no BFF operation DTO; record the PDS answer as the
    // write timestamp and label the same wall-clock observation as approximate.
    const externalWriteAt = deps.now().toISOString();
    const externalIndexed = await awaitIndexed(
      page,
      external,
      { kind: 'pds', completedAt: externalWriteAt },
      timeoutMs,
      deps,
    );
    results.externalPublish = externalIndexed;

    const deleteReconcile: Record<string, unknown>[] = [];
    const appDeleteId = await localDelete(page, appSession.csrfToken, local.uri);
    const appDelete = await operationUntilSucceeded(page, appDeleteId, timeoutMs);
    records[0]!.deleted = true;
    deleteReconcile.push({
      via: 'app',
      ...(await awaitAbsent(
        page,
        local.uri,
        String(localIndexed.verifiedRev),
        String(appDelete.updatedAt),
        timeoutMs,
        deps,
      )),
    });
    records[0]!.reconciled = true;
    await pdsDelete(deps, pds[1]!.endpoint, pdsSession, external.uri);
    const externalDeleteAt = deps.now().toISOString();
    records[1]!.deleted = true;
    deleteReconcile.push({
      via: 'pdsB',
      ...(await awaitAbsent(
        page,
        external.uri,
        String(externalIndexed.verifiedRev),
        externalDeleteAt,
        timeoutMs,
        deps,
      )),
    });
    records[1]!.reconciled = true;
    results.deleteReconcile = deleteReconcile;
    results.indexingLag =
      'local publish lag uses succeeded operation.updatedAt; external PDS publish uses the createRecord answer timestamp. Both are approximate wall-clock intervals to first indexed status observation, including poll delay and clock skew.';
  } catch (error) {
    context.fail(error instanceof Error ? error.message : String(error));
  } finally {
    if (page !== null && pds.length === 2) {
      for (const record of records.filter((item) => !item.deleted)) {
        try {
          if (record.via === 'app') {
            if (appSession === null) {
              context.fail(`cleanup delete failed for ${record.uri}: app session unavailable`);
              continue;
            }
            await localDelete(page, appSession.csrfToken, record.uri);
          } else {
            if (pdsSession === null) {
              context.fail(`cleanup delete failed for ${record.uri}: PDS B session unavailable`);
              continue;
            }
            await pdsDelete(deps, pds[1]!.endpoint, pdsSession, record.uri);
          }
          record.deleted = true;
        } catch (error) {
          context.fail(
            `cleanup delete failed for ${record.uri}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    for (const record of records) {
      context.cleanup(
        record.reconciled
          ? `${record.uri} deleted and reconciled absent (${record.via})`
          : record.deleted
            ? `${record.uri} delete accepted but absence not proven (${record.via}); verify manually`
            : `${record.uri} LEFT BEHIND: delete and reconcile manually`,
      );
    }
    if (browserContext !== null) await browserContext.close();
    if (browser !== null) await browser.close();
    if (appSession !== null)
      context.cleanup(`${didA}: browser context discarded; no sign-out or upstream revocation claim was made`);
  }
  return { pds, subjects: records.map(({ uri }) => ({ did: parseRecordUri(uri)?.did ?? '', uri })), results };
}

export const spec: NodeGateSpec = {
  gate: 'ingest',
  script: 'scripts/live/node_ingest_check.ts',
  requirements: NODE_INGEST_REQUIREMENTS,
  extraChecks: (env) => (env[OAUTH_ENV.interactive] === '1' ? [] : signInChecks(env, OAUTH_ENV.passwordA, 'A')),
  async run(context) {
    return runNodeIngest(context, dependencies);
  },
};

if (isNodeGateMain(import.meta.url)) mainNodeGate(spec);

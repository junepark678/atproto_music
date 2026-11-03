// Node live gate: app BFF publish, independent PDS B writer, proof indexing,
// and delete reconciliation. This is deliberately separate from the Workers
// driver because the Node OAuth exchange is server-side.

import { randomUUID } from 'node:crypto';
import { canonicalDigest } from '@atmusic/core/canonical';
import { cryptoRandom, systemClock } from '@atmusic/core/deps';
import { collectionsFor } from '@atmusic/core/namespace';
import { newTid } from '@atmusic/core/record-key';
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

interface RecordIntent {
  did: string;
  route: string;
  uri: string | null;
  expectedUri?: string;
  via: 'app' | 'pdsB';
  deleted: boolean;
  reconciled: boolean;
  operationId?: string;
  deleteOperationId?: string;
  idempotencyKey?: string;
  rkey?: string;
  operationState?: string;
  deleteAttempted?: boolean;
  requestBody?: object;
  cid?: string;
  presentRev?: string;
  owned?: boolean;
}

interface BrowserApiResponse {
  status: number;
  json: unknown;
}

export interface IngestDependencies {
  browser(): Promise<Browser>;
  pdsInfo(endpoint: string, implementation: string, timeoutMs?: number): Promise<PdsInfo>;
  httpJson: typeof httpJson;
  verifyRecordAt(did: string, collection: string, rkey: string, timeoutMs?: number): ReturnType<typeof verifyRecordAt>;
  verifyAbsent(
    did: string,
    collection: string,
    rkey: string,
    options: { after: string; timeoutMs?: number },
  ): ReturnType<typeof verifyAbsent>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  checkIdentityPds(did: string, pds: string, timeoutMs?: number): Promise<unknown>;
}

function deadlineTimer(deadlineAt: number) {
  return {
    timeout(ms: number): AbortSignal {
      return AbortSignal.timeout(Math.max(1, Math.min(ms, deadlineAt - performance.now())));
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const dependencies: IngestDependencies = {
  browser: () => launchBrowser(process.env),
  pdsInfo: (endpoint, implementation, timeoutMs) => pdsInfo(endpoint, implementation, timeoutMs),
  httpJson,
  verifyRecordAt: (did, collection, rkey, timeoutMs = 15_000) =>
    verifyRecordAt(did, collection, rkey, { timer: deadlineTimer(performance.now() + timeoutMs) }),
  verifyAbsent: (did, collection, rkey, options) =>
    verifyAbsent(did, collection, rkey, {
      after: options.after,
      timer: deadlineTimer(performance.now() + (options.timeoutMs ?? 15_000)),
    }),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  checkIdentityPds: (did, pds, timeoutMs = 15_000) =>
    checkIdentityPds(did, pds, { timer: deadlineTimer(performance.now() + timeoutMs) }),
};

async function browserRequest(
  page: Page,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
  csrf?: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<BrowserApiResponse> {
  const evaluation = page.evaluate(
    async ({ path, method, body, csrf, extraHeaders, timeoutMs }) => {
      const headers: Record<string, string> = { accept: 'application/json' };
      Object.assign(headers, extraHeaders);
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (csrf !== undefined) headers['x-csrf-token'] = csrf;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(path, {
          method,
          credentials: 'same-origin',
          headers,
          signal: controller.signal,
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
      } finally {
        clearTimeout(timeout);
      }
    },
    { path, method, body, csrf, extraHeaders, timeoutMs },
  );
  return withTimeout(evaluation, timeoutMs, 'browser request');
}

async function appUiSignIn(
  page: Page,
  context: NodeGateContext,
  timeoutMs: number,
  deps: IngestDependencies,
): Promise<BrowserSession> {
  const origin = context.origin;
  await page.goto(new URL('/signin', origin).href, { timeout: timeoutMs });
  await page.locator('#signin-handle').fill(context.get(OAUTH_ENV.handleA), { timeout: timeoutMs });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout: timeoutMs });
  await page.waitForURL((url) => url.origin !== origin, { timeout: Math.min(30_000, timeoutMs) });

  const password = page.locator('input[type="password"]').first();
  if (context.env[OAUTH_ENV.interactive] !== '1') {
    await password.waitFor({ state: 'visible', timeout: timeoutMs });
    const identifier = page.locator('input[autocomplete="username"], input[name="username"]').first();
    if ((await identifier.isVisible().catch(() => false)) && (await identifier.inputValue()) === '') {
      await identifier.fill(context.get(OAUTH_ENV.handleA));
    }
    await password.fill(context.get(OAUTH_ENV.passwordA), { timeout: timeoutMs });
    await password.press('Enter', { timeout: timeoutMs });
  }

  const deadline = performance.now() + timeoutMs;
  while (new URL(page.url()).origin !== origin && performance.now() < deadline) {
    const consent = page.getByRole('button', { name: /^(authorize|accept|allow|approve)$/i }).first();
    if (await consent.isVisible().catch(() => false))
      await consent.click({ timeout: Math.max(1, deadline - performance.now()) });
    else {
      const next = page.getByRole('button', { name: /^(next|continue|sign in|log in)$/i }).first();
      if (await next.isVisible().catch(() => false))
        await next.click({ timeout: Math.max(1, deadline - performance.now()) });
      else await deps.sleep(Math.min(250, Math.max(1, deadline - performance.now())));
    }
  }
  await page.waitForURL((url) => url.origin === origin, { timeout: Math.max(1, deadline - performance.now()) });
  const sessionResponse = await browserRequest(
    page,
    '/api/v1/auth/session',
    'GET',
    undefined,
    undefined,
    {},
    timeoutMs,
  );
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
  timeoutMs = 15_000,
): Promise<PdsSession> {
  const response = await deps.httpJson(xrpcUrl(pds, 'com.atproto.server.createSession'), {
    method: 'POST',
    body: { identifier, password },
    timeoutMs,
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
  rkey: string,
  timeoutMs = 15_000,
): Promise<Written> {
  const response = await deps.httpJson(xrpcUrl(pds, 'com.atproto.repo.createRecord'), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessJwt}` },
    body: { repo: session.did, collection, rkey, record, validate: false },
    timeoutMs,
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
  swapRecord: string,
  timeoutMs = 15_000,
): Promise<string | null> {
  const parsed = parseRecordUri(uri);
  expect(parsed !== null, `malformed record URI ${uri}`);
  const response = await deps.httpJson(xrpcUrl(pds, 'com.atproto.repo.deleteRecord'), {
    method: 'POST',
    headers: { authorization: `Bearer ${session.accessJwt}` },
    body: { repo: session.did, collection: parsed.collection, rkey: parsed.rkey, swapRecord },
    timeoutMs,
  });
  expect(response.status === 200, `PDS B deleteRecord ${uri} returned HTTP ${response.status}`);
  return field<string>(field(response.json, 'commit'), 'rev') ?? null;
}

async function recoverPdsCreate(
  deps: IngestDependencies,
  pds: string,
  did: string,
  collection: string,
  rkey: string,
  intendedRecord: object,
  timeoutMs = 15_000,
): Promise<Written | null> {
  const response = await deps.httpJson(xrpcUrl(pds, 'com.atproto.repo.getRecord', { repo: did, collection, rkey }), {
    method: 'GET',
    timeoutMs,
  });
  if (response.status === 404) return null;
  expect(response.status === 200, `PDS B getRecord returned HTTP ${response.status}`);
  const uri = field<string>(response.json, 'uri');
  const cid = field<string>(response.json, 'cid');
  const value = field<object>(response.json, 'value');
  expect(
    typeof uri === 'string' && typeof cid === 'string' && value !== undefined,
    'PDS B getRecord returned malformed record',
  );
  const expectedUri = `at://${did}/${collection}/${rkey}`;
  expect(uri === expectedUri, 'PDS B getRecord returned a different URI');
  expect(
    (await canonicalDigest(value)) === (await canonicalDigest(intendedRecord)),
    'PDS B record at intended key conflicts with this run',
  );
  const proof = await deps.verifyRecordAt(did, collection, rkey, timeoutMs);
  expect(proof.state === 'present' && proof.cid === cid, 'PDS B recovery CID lacks matching independent proof');
  return { uri, cid, rev: proof.rev };
}

async function localDelete(page: Page, csrfToken: string, uri: string, timeoutMs = 30_000): Promise<string> {
  const response = await browserRequest(
    page,
    `/api/v1/scrobbles/${encodeURIComponent(uri)}`,
    'DELETE',
    undefined,
    csrfToken,
    {},
    timeoutMs,
  );
  const operation = field<Record<string, unknown>>(response.json, 'operation');
  const id = field<string>(operation, 'id');
  expect(response.status === 202 && typeof id === 'string', `DELETE /api/v1/scrobbles returned ${response.status}`);
  return id;
}

async function operationUntilSucceeded(
  page: Page,
  id: string,
  timeoutMs: number,
  onState?: (state: string) => void,
): Promise<Record<string, unknown>> {
  const deadline = performance.now() + timeoutMs;
  const found = await pollUntil(
    async () => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return null;
      const response = await browserRequest(
        page,
        `/api/v1/operations/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        undefined,
        {},
        Math.min(30_000, remaining),
      );
      expect(response.status === 200, `GET /api/v1/operations/${id} returned ${response.status}`);
      const operation = (response.json ?? null) as Record<string, unknown> | null;
      expect(operation !== null, `GET /api/v1/operations/${id} returned an empty DTO`);
      expect(field<string>(operation, 'id') === id, `GET /api/v1/operations/${id} returned a mismatched operation ID`);
      const state = field<string>(operation, 'state');
      expect(
        state === 'queued' ||
          state === 'running' ||
          state === 'succeeded' ||
          state === 'failed' ||
          state === 'blocked' ||
          state === 'cancelled',
        `GET /api/v1/operations/${id} returned an unknown state`,
      );
      if (typeof state === 'string') onState?.(state);
      if (state === 'failed' || state === 'blocked' || state === 'cancelled')
        throw new Error(`operation ${id} ended ${state}`);
      return state === 'succeeded' ? (operation ?? null) : null;
    },
    { timeoutMs, intervalMs: 500 },
  );
  expect(found !== null, `operation ${id} was not succeeded within ${timeoutMs / 1000} s`);
  return found.value;
}

async function recordStatus(page: Page, uri: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const response = await browserRequest(
    page,
    `/api/v1/records/status?uri=${encodeURIComponent(uri)}`,
    'GET',
    undefined,
    undefined,
    {},
    timeoutMs,
  );
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
  deadlineAt: number,
  deps: IngestDependencies,
) {
  const deadline = performance.now() + timeoutMs;
  const done = await pollUntil(
    async () => {
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      const status = await recordStatus(page, written.uri, Math.min(30_000, remaining));
      return field<string>(status, 'state') === 'indexed' ? status : null;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
  expect(done !== null, `${written.uri} was not indexed within ${timeoutMs / 1000} s after its operation succeeded`);
  const indexedObservedAt = deps.now().getTime();
  const parsed = parseRecordUri(written.uri);
  expect(parsed !== null, `malformed record URI ${written.uri}`);
  const proof = await deps.verifyRecordAt(
    parsed.did,
    parsed.collection,
    parsed.rkey,
    Math.max(1, deadlineAt - performance.now()),
  );
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
  deadlineAt: number,
  deps: IngestDependencies,
) {
  const deadline = performance.now() + timeoutMs;
  const found = await pollUntil(
    async () => {
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));
      const status = await recordStatus(page, uri, Math.min(30_000, remaining));
      return field<string>(status, 'state') === 'absent' ? status : null;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
  expect(found !== null, `${uri} was not reconciled to absent within ${timeoutMs / 1000} s`);
  const absentObservedAt = deps.now().getTime();
  const parsed = parseRecordUri(uri);
  expect(parsed !== null, `malformed record URI ${uri}`);
  const absence = await deps.verifyAbsent(parsed.did, parsed.collection, parsed.rkey, {
    after: presentRev,
    timeoutMs: Math.max(1, deadlineAt - performance.now()),
  });
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
  const deadlineAt = performance.now() + timeoutMs;
  const recoveryReserveMs = Math.min(60_000, Math.floor(timeoutMs * 0.2));
  const phaseBudgetMs = () => Math.max(1, Math.floor(deadlineAt - performance.now() - recoveryReserveMs));
  const cleanupBudgetMs = () => Math.max(1, Math.floor(deadlineAt - performance.now()));
  const pds: PdsInfo[] = [];
  const didA = context.get(ENV.didA);
  const didB = context.get(ENV.didB);
  const endpointA = context.get(ENV.pdsA);
  const endpointB = context.get(ENV.pdsB);
  const records: RecordIntent[] = [];
  const results: Record<string, unknown> = {};
  let browser: Browser | null = null;
  let browserContext: Awaited<ReturnType<Browser['newContext']>> | null = null;
  let page: Page | null = null;
  let appSession: BrowserSession | null = null;
  let pdsSession: PdsSession | null = null;
  let phase = 'PDS identity checks';
  try {
    pds.push(await deps.pdsInfo(endpointA, context.get(ENV.pdsAImplementation), phaseBudgetMs()));
    pds.push(await deps.pdsInfo(endpointB, context.get(ENV.pdsBImplementation), phaseBudgetMs()));
    await deps.checkIdentityPds(didA, pds[0]!.endpoint, phaseBudgetMs());
    await deps.checkIdentityPds(didB, pds[1]!.endpoint, phaseBudgetMs());
    browser = await deps.browser();
    browserContext = await browser.newContext();
    page = await browserContext.newPage();
    phase = 'browser sign-in';
    appSession = await appUiSignIn(page, context, Math.min(signInTimeoutMs(context.env), phaseBudgetMs()), deps);

    const runId = randomUUID();
    phase = 'app scrobble submission';
    const localPayload = {
      artist: 'atmusic Node ingest gate',
      track: `app ${runId}`,
      listenedAt: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
    const localRecord: RecordIntent = {
      did: didA,
      route: '/api/v1/scrobbles',
      uri: null,
      via: 'app' as const,
      deleted: false,
      reconciled: false,
      idempotencyKey: runId,
      requestBody: localPayload,
    };
    records.push(localRecord);
    const localResponse = await browserRequest(
      page,
      '/api/v1/scrobbles',
      'POST',
      localPayload,
      appSession.csrfToken,
      { 'idempotency-key': runId },
      phaseBudgetMs(),
    );
    const localOperation = field<Record<string, unknown>>(localResponse.json, 'operation');
    const localOperationId = field<string>(localOperation, 'id');
    if (typeof localOperationId === 'string') localRecord.operationId = localOperationId;
    expect(
      localResponse.status === 202 && typeof localOperationId === 'string',
      `POST /api/v1/scrobbles returned ${localResponse.status}`,
    );
    phase = 'app scrobble operation';
    const localOp = await operationUntilSucceeded(page, localOperationId, phaseBudgetMs(), (state) => {
      localRecord.operationState = state;
    });
    const localUri = field<string>(localOp, 'uri');
    const localCid = field<string>(localOp, 'cid');
    if (typeof localUri === 'string') localRecord.uri = localUri;
    expect(typeof localUri === 'string' && typeof localCid === 'string', 'succeeded scrobble operation lacks URI/CID');
    const local: Written = { uri: localUri, cid: localCid, rev: null };
    localRecord.cid = local.cid;
    expect(parseRecordUri(local.uri)?.did === didA, `local BFF wrote ${local.uri}, not identity A`);
    expect(
      parseRecordUri(local.uri)?.collection === collectionsFor(context.lexiconPrefix).scrobble,
      'local BFF wrote outside the scrobble collection',
    );
    localRecord.owned = true;
    phase = 'app scrobble indexing';
    const localIndexed = await awaitIndexed(
      page,
      local,
      { kind: 'operation', dto: localOp },
      phaseBudgetMs(),
      deadlineAt,
      deps,
    );
    results.localPublish = localIndexed;
    localRecord.presentRev = String(localIndexed.verifiedRev);
    delete localRecord.operationId;
    delete localRecord.idempotencyKey;

    phase = 'PDS B authentication';
    pdsSession = await createPdsSession(
      deps,
      pds[1]!.endpoint,
      context.get(OAUTH_ENV.handleB),
      context.get(NODE_INGEST_ENV.appPasswordB),
      phaseBudgetMs(),
    );
    expect(pdsSession.did === didB, `PDS B session is ${pdsSession.did}, not ${didB}`);
    const collection = collectionsFor(context.lexiconPrefix).scrobble;
    const rkey = newTid(systemClock, cryptoRandom);
    const intendedRecord = scrobbleRecord(collection, runId);
    const externalRecord: RecordIntent = {
      did: didB,
      route: 'com.atproto.repo.createRecord',
      uri: `at://${didB}/${collection}/${rkey}`,
      expectedUri: `at://${didB}/${collection}/${rkey}`,
      via: 'pdsB' as const,
      deleted: false,
      reconciled: false,
      rkey,
      requestBody: intendedRecord,
    };
    records.push(externalRecord);
    phase = 'PDS B scrobble submission';
    const external = await pdsCreate(
      deps,
      pds[1]!.endpoint,
      pdsSession,
      collection,
      intendedRecord,
      rkey,
      phaseBudgetMs(),
    );
    expect(external.uri === externalRecord.uri, 'PDS B createRecord returned a URI other than its preallocated key');
    externalRecord.cid = external.cid;
    externalRecord.owned = true;
    delete externalRecord.rkey;
    expect(parseRecordUri(external.uri)?.did === didB, `PDS B wrote ${external.uri}, not identity B`);
    // Direct PDS writes have no BFF operation DTO; record the PDS answer as the
    // write timestamp and label the same wall-clock observation as approximate.
    const externalWriteAt = deps.now().toISOString();
    phase = 'PDS B scrobble indexing';
    const externalIndexed = await awaitIndexed(
      page,
      external,
      { kind: 'pds', completedAt: externalWriteAt },
      phaseBudgetMs(),
      deadlineAt,
      deps,
    );
    results.externalPublish = externalIndexed;
    externalRecord.presentRev = String(externalIndexed.verifiedRev);

    phase = 'app delete reconciliation';
    const deleteReconcile: Record<string, unknown>[] = [];
    records[0]!.deleteAttempted = true;
    const appDeleteId = await localDelete(page, appSession.csrfToken, local.uri, phaseBudgetMs());
    records[0]!.deleteOperationId = appDeleteId;
    const appDelete = await operationUntilSucceeded(page, appDeleteId, phaseBudgetMs());
    records[0]!.deleted = true;
    delete records[0]!.deleteOperationId;
    deleteReconcile.push({
      via: 'app',
      ...(await awaitAbsent(
        page,
        local.uri,
        String(localIndexed.verifiedRev),
        String(appDelete.updatedAt),
        phaseBudgetMs(),
        deadlineAt,
        deps,
      )),
    });
    records[0]!.reconciled = true;
    phase = 'PDS B delete reconciliation';
    records[1]!.deleteAttempted = true;
    await pdsDelete(deps, pds[1]!.endpoint, pdsSession, external.uri, external.cid, phaseBudgetMs());
    const externalDeleteAt = deps.now().toISOString();
    records[1]!.deleted = true;
    deleteReconcile.push({
      via: 'pdsB',
      ...(await awaitAbsent(
        page,
        external.uri,
        String(externalIndexed.verifiedRev),
        externalDeleteAt,
        phaseBudgetMs(),
        deadlineAt,
        deps,
      )),
    });
    records[1]!.reconciled = true;
    results.deleteReconcile = deleteReconcile;
    results.indexingLag =
      'local publish lag uses succeeded operation.updatedAt; external PDS publish uses the createRecord answer timestamp. Both are approximate wall-clock intervals to first indexed status observation, including poll delay and clock skew.';
  } catch {
    // Playwright errors can contain OAuth callback URLs with code/state/request_uri.
    // Keep evidence limited to a safe phase label, never raw browser text.
    context.fail(`Node ingest failed during ${phase}`);
  } finally {
    // Resolve accepted app operations once more before recording them as unresolved.
    if (page !== null) {
      for (const record of records.filter((item) => item.via === 'app' && item.uri === null)) {
        try {
          if (record.operationId === undefined && record.idempotencyKey && record.requestBody) {
            const replay = await browserRequest(
              page,
              '/api/v1/scrobbles',
              'POST',
              record.requestBody,
              appSession?.csrfToken,
              { 'idempotency-key': record.idempotencyKey },
              Math.min(15_000, cleanupBudgetMs()),
            );
            const ack = field<Record<string, unknown>>(replay.json, 'operation');
            const recoveredId = field<string>(ack, 'id');
            expect(
              replay.status === 202 && typeof recoveredId === 'string',
              'idempotent replay acknowledgement was malformed',
            );
            record.operationId = recoveredId;
          }
          if (
            record.operationId === undefined ||
            ['failed', 'cancelled', 'blocked'].includes(record.operationState ?? '')
          )
            continue;
          const operation = await operationUntilSucceeded(
            page,
            record.operationId,
            Math.min(cleanupBudgetMs(), 15_000),
            (state) => {
              record.operationState = state;
            },
          );
          const uri = field<string>(operation, 'uri');
          if (typeof uri === 'string') {
            record.uri = uri;
            record.cid = field<string>(operation, 'cid');
            const parsed = parseRecordUri(uri);
            record.owned = parsed?.did === didA && parsed.collection === collectionsFor(context.lexiconPrefix).scrobble;
            if (!record.owned)
              context.fail('recovered app operation returned a URI outside its intended owner/collection');
            if (record.owned && record.cid) {
              const indexed = await awaitIndexed(
                page,
                { uri, cid: record.cid, rev: null },
                { kind: 'operation', dto: operation },
                Math.min(cleanupBudgetMs(), 15_000),
                deadlineAt,
                deps,
              );
              record.presentRev = String(indexed.verifiedRev);
              results.localPublish ??= indexed;
              record.operationState = 'succeeded';
              delete record.operationId;
              delete record.idempotencyKey;
            }
          }
        } catch {
          // The operation ID/idempotency key remains in the cleanup evidence.
        }
      }
    }
    // A possibly sent delete is never blindly replayed. Poll its known BFF
    // operation or prove the newer PDS head absent; an uncertain present record
    // remains an operator recovery item.
    for (const record of records.filter(
      (item) => item.deleteAttempted && !item.reconciled && item.uri && item.presentRev,
    )) {
      try {
        if (record.via === 'app' && page !== null && record.deleteOperationId) {
          const deletion = await operationUntilSucceeded(
            page,
            record.deleteOperationId,
            Math.min(cleanupBudgetMs(), 15_000),
          );
          record.deleted = true;
          await awaitAbsent(
            page,
            record.uri!,
            record.presentRev!,
            String(deletion.updatedAt),
            Math.min(cleanupBudgetMs(), 15_000),
            deadlineAt,
            deps,
          );
          record.reconciled = true;
          delete record.deleteOperationId;
        } else {
          const parsed = parseRecordUri(record.uri!);
          if (!parsed) {
            context.fail('delete recovery URI is malformed');
            continue;
          }
          const absence = await deps.verifyAbsent(parsed.did, parsed.collection, parsed.rkey, {
            after: record.presentRev!,
            timeoutMs: Math.min(cleanupBudgetMs(), 15_000),
          });
          if (absence.rev <= record.presentRev!) {
            context.fail('delete recovery absence proof was not newer than the present proof');
            continue;
          }
          record.deleted = true;
          record.reconciled = true;
          delete record.deleteOperationId;
        }
      } catch {
        context.fail(`delete outcome remains unresolved for ${record.uri}`);
      }
    }
    for (const record of records.filter((item) => item.via === 'pdsB' && item.cid === undefined && item.rkey)) {
      try {
        if (pdsSession === null || record.requestBody === undefined) {
          context.fail('PDS B recovery prerequisites unavailable; the expected subject may require operator cleanup');
          continue;
        }
        const parsed = parseRecordUri(record.uri ?? '');
        if (
          parsed === null ||
          parsed.did !== didB ||
          parsed.collection !== collectionsFor(context.lexiconPrefix).scrobble
        ) {
          context.fail('PDS B recovery subject failed ownership validation');
          continue;
        }
        const recovered = await recoverPdsCreate(
          deps,
          pds[1]!.endpoint,
          didB,
          parsed.collection,
          parsed.rkey,
          record.requestBody,
          Math.min(cleanupBudgetMs(), 15_000),
        );
        if (recovered === null) {
          context.fail(
            'PDS B create remains unresolved after an absence observation; a delayed commit is still possible',
          );
          continue;
        }
        if (recovered.uri !== record.uri || recovered.rev === null) {
          context.fail('PDS B recovery evidence did not match the preallocated subject and revision');
          continue;
        }
        record.cid = recovered.cid;
        record.presentRev = recovered.rev;
        record.owned = true;
      } catch {
        context.fail('PDS B create could not be safely recovered; the expected subject may require operator cleanup');
      }
    }
    if (page !== null && pds.length === 2) {
      for (const record of records.filter(
        (item) => !item.deleted && !item.deleteAttempted && item.uri !== null && item.owned,
      )) {
        try {
          const uri = record.uri;
          if (uri === null) continue;
          if (record.via === 'app') {
            if (appSession === null) {
              context.fail(`cleanup delete failed for ${uri}: app session unavailable`);
              continue;
            }
            record.deleteAttempted = true;
            const deletionId = await localDelete(page, appSession.csrfToken, uri, Math.min(cleanupBudgetMs(), 15_000));
            record.deleteOperationId = deletionId;
            const deletion = await operationUntilSucceeded(page, deletionId, Math.min(cleanupBudgetMs(), 15_000));
            record.deleted = true;
            delete record.deleteOperationId;
            if (record.presentRev) {
              await awaitAbsent(
                page,
                uri,
                record.presentRev,
                String(deletion.updatedAt),
                Math.min(cleanupBudgetMs(), 15_000),
                deadlineAt,
                deps,
              );
              record.reconciled = true;
            }
          } else {
            if (pdsSession === null) {
              context.fail(`cleanup delete failed for ${uri}: PDS B session unavailable`);
              continue;
            }
            if (!record.cid) {
              context.fail(`cleanup delete for ${uri} has no verified CID for conditional deletion`);
              continue;
            }
            record.deleteAttempted = true;
            await pdsDelete(deps, pds[1]!.endpoint, pdsSession, uri, record.cid, Math.min(cleanupBudgetMs(), 15_000));
            record.deleted = true;
            if (record.presentRev) {
              const parsed = parseRecordUri(uri);
              if (parsed === null) {
                context.fail(`cleanup absence verification for ${uri} has a malformed URI`);
                continue;
              }
              const absence = await deps.verifyAbsent(parsed.did, parsed.collection, parsed.rkey, {
                after: record.presentRev,
                timeoutMs: Math.min(cleanupBudgetMs(), 15_000),
              });
              expect(absence.rev > record.presentRev, 'cleanup absence proof is stale');
              record.reconciled = true;
            }
          }
        } catch {
          context.fail(`cleanup delete failed for ${record.uri ?? 'unknown URI'}`);
          record.deleteAttempted = true;
        }
      }
    }
    for (const record of records) {
      context.cleanup(
        record.uri === null
          ? `UNRESOLVED ${record.via} write${record.operationId ? ` operation ${record.operationId}` : ''}${record.idempotencyKey ? ` idempotency key ${record.idempotencyKey}` : ''}${record.rkey ? ` rkey ${record.rkey}` : ''}; inspect upstream before retry`
          : record.reconciled
            ? `${record.uri} deleted and reconciled absent (${record.via})`
            : record.deleted
              ? `${record.uri} delete accepted but absence not proven (${record.via}); verify manually`
              : `${record.uri} LEFT BEHIND: ${record.deleteAttempted ? 'delete outcome is uncertain; reconcile without replaying the mutation' : 'delete and reconcile manually'}`,
      );
    }
    const unresolvedSubjects = records
      .filter((record) => record.uri === null || !record.reconciled)
      .map((record) => ({
        did: record.did,
        uri: record.uri,
        expectedUri: record.expectedUri ?? null,
        route: record.route,
        via: record.via,
        state: record.operationState ?? (record.deleted ? 'delete_unreconciled' : 'cleanup_unresolved'),
        ...(record.operationId ? { operationId: record.operationId } : {}),
        ...(record.deleteOperationId ? { deleteOperationId: record.deleteOperationId } : {}),
        ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
        ...(record.rkey ? { rkey: record.rkey } : {}),
      }));
    const unresolvedOperations = records.flatMap((record) => [
      ...(record.operationId
        ? [{ did: record.did, id: record.operationId, action: 'create', state: record.operationState ?? 'unknown' }]
        : []),
      ...(record.deleteOperationId
        ? [{ did: record.did, id: record.deleteOperationId, action: 'delete', state: 'unknown' }]
        : []),
    ]);
    if (unresolvedSubjects.length > 0)
      context.fail('one or more ingest subjects remain unresolved after bounded cleanup');
    results.unresolvedSubjects = unresolvedSubjects;
    results.unresolvedOperations = unresolvedOperations;
    try {
      if (page !== null) await withTimeout(page.close(), cleanupBudgetMs(), 'page close');
    } catch {
      context.fail('page close failed during teardown');
      context.cleanup('page close failed');
    }
    try {
      if (browserContext !== null)
        await withTimeout(browserContext.close(), cleanupBudgetMs(), 'browser context close');
    } catch {
      context.fail('browser context close failed during teardown');
      context.cleanup('browser context close failed');
    }
    try {
      if (browser !== null) await withTimeout(browser.close(), cleanupBudgetMs(), 'browser close');
    } catch {
      context.fail('browser close failed during teardown');
      context.cleanup('browser close failed');
    }
    if (appSession !== null)
      context.cleanup(`${didA}: browser context discarded; no sign-out or upstream revocation claim was made`);
  }
  return {
    pds,
    subjects: records.map(
      ({
        uri,
        expectedUri,
        did,
        route,
        operationId,
        deleteOperationId,
        idempotencyKey,
        rkey,
        operationState,
        reconciled,
      }) => ({
        did,
        uri,
        expectedUri: expectedUri ?? null,
        route,
        ...(operationId ? { operationId } : {}),
        ...(deleteOperationId ? { deleteOperationId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(rkey ? { rkey } : {}),
        ...(operationState ? { operationState } : {}),
        unresolved: !reconciled,
      }),
    ),
    results,
  };
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

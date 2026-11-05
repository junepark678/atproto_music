// Node confidential OAuth live gate.
//
// This gate observes the confidential exchange from the host's sealed session
// row, exercises direct CRUD and every app write route, then asks that same
// host to prove the refresh token was rejected after sign-out. Secrets and
// token material never enter evidence.

import { randomUUID } from 'node:crypto';
import {
  createDeadline,
  type Deadline,
  OAUTH_LIVE_BUDGETS,
  UnsafeRecoveryError,
  withBoundedRecovery,
} from '@atmusic/core/oauth-live-budget';
import { parseRecordUri } from '@atmusic/core/syntax';
import { type AdminRequest, defaultSocketPath, sendOverSocket } from '../admin/atmusic-admin.ts';
import {
  checkIdentityPds,
  ENV,
  exclusionProofUnavailable,
  field,
  httpJson,
  IDENTITY_REQS,
  PDS_IMPLEMENTATION_REQS,
  pdsInfo,
  verifyAbsent,
  verifyAbsentBySnapshot,
  verifyRecordAt,
  xrpcUrl,
} from './live-gate.ts';
import {
  isNodeGateMain,
  mainNodeGate,
  type NodeGateContext,
  type NodeGateRequirement,
  type NodeGateSpec,
} from './node-live-gate.ts';
import { launchBrowser, OAUTH_ENV, signInChecks, signInTimeoutMs } from './workers_oauth_check.ts';

export const NODE_OAUTH_ENV = {
  handleA: OAUTH_ENV.handleA,
  handleB: OAUTH_ENV.handleB,
  passwordA: OAUTH_ENV.passwordA,
  passwordB: OAUTH_ENV.passwordB,
  interactive: OAUTH_ENV.interactive,
  timeoutSeconds: 'ATMUSIC_LIVE_OAUTH_TIMEOUT_S',
} as const;

const CRUD_SOCKET_TIMEOUT_MS = OAUTH_LIVE_BUDGETS.crudMs + OAUTH_LIVE_BUDGETS.crudCleanupMs + 60_000;

const timeout: NodeGateRequirement = {
  name: NODE_OAUTH_ENV.timeoutSeconds,
  what: 'optional timeout in seconds from 30 through 3600 (default 300)',
  optional: true,
  check: (value) =>
    Number.isInteger(Number(value)) && Number(value) >= 30 && Number(value) <= 3600
      ? null
      : 'must be an integer from 30 to 3600',
};

const requirements = [
  ...IDENTITY_REQS,
  ...PDS_IMPLEMENTATION_REQS,
  { name: OAUTH_ENV.handleA, what: 'handle of the dedicated identity on PDS A', check: validHandle },
  { name: OAUTH_ENV.handleB, what: 'handle of the dedicated identity on PDS B', check: validHandle },
  {
    name: OAUTH_ENV.passwordA,
    what: 'password for identity A; may be omitted for headed interactive sign-in',
    optional: true,
  },
  {
    name: OAUTH_ENV.passwordB,
    what: 'password for identity B; may be omitted for headed interactive sign-in',
    optional: true,
  },
  {
    name: OAUTH_ENV.interactive,
    what: 'set to 1 for headed interactive sign-in',
    optional: true,
    check: (v: string) => (v === '1' ? null : 'must be 1'),
  },
  timeout,
] as const;

function validHandle(value: string): string | null {
  return /^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/i.test(value) ? null : 'not a handle';
}

function extraChecks(env: Readonly<Record<string, string | undefined>>): string[] {
  const interactive = env[OAUTH_ENV.interactive] === '1';
  return [
    ...signInChecks(env, OAUTH_ENV.passwordA, 'A'),
    ...signInChecks(env, OAUTH_ENV.passwordB, 'B'),
    ...(!interactive && env[OAUTH_ENV.passwordA]?.trim() === '' ? [`${OAUTH_ENV.passwordA}: blank`] : []),
    ...(!interactive && env[OAUTH_ENV.passwordB]?.trim() === '' ? [`${OAUTH_ENV.passwordB}: blank`] : []),
    ...(env[ENV.didA] === env[ENV.didB] ? [`${ENV.didB}: must differ from DID A`] : []),
    ...(differentPdsProblem(env) ? [differentPdsProblem(env) as string] : []),
  ];
}

function differentPdsProblem(env: Readonly<Record<string, string | undefined>>): string | null {
  const a = env[ENV.pdsA];
  const b = env[ENV.pdsB];
  if (!a || !b) return null;
  try {
    return new URL(a).hostname.toLowerCase() === new URL(b).hostname.toLowerCase()
      ? `${ENV.pdsB}: must use a different PDS host from PDS A`
      : null;
  } catch {
    return null; // The required-value validators report malformed endpoints.
  }
}

type JsonObject = Record<string, unknown>;
type ApiResponse = { status: number; json: unknown };
type Session = { did: string; csrf: string };
type CleanupSession = { did?: string; csrf: string };

export function validatedCallbackSession(
  response: ApiResponse,
  which: 'A' | 'B',
  expectedDid: string,
  onCallbackSession: (session: CleanupSession) => void,
): Session {
  const body = object(response.json);
  // A nonempty CSRF token is required before the caller can safely attempt
  // sign-out, even if the response status or identity validation fails.
  if (typeof body?.csrfToken === 'string' && body.csrfToken.length > 0) {
    onCallbackSession({ did: typeof body.did === 'string' ? body.did : undefined, csrf: body.csrfToken });
  }
  if (
    response.status !== 200 ||
    typeof body?.did !== 'string' ||
    typeof body.csrfToken !== 'string' ||
    body.csrfToken.length === 0
  ) {
    throw new Error(`PDS ${which} sign-in returned no active app session`);
  }
  if (body.did !== expectedDid) throw new Error(`PDS ${which} sign-in resolved to a different DID`);
  return { did: body.did, csrf: body.csrfToken };
}
type CreatedRecord = { uri: string; cid: string; rev: string };

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;

export function handleResolutionMatchesDid(status: number, value: unknown, expectedDid: string): boolean {
  return status === 200 && object(value)?.did === expectedDid;
}

export function expectedAuthorizationOrigin(pds: string, status: number, value: unknown): string {
  const pdsUrl = new URL(pds);
  if (pdsUrl.protocol !== 'https:' || pdsUrl.username || pdsUrl.password) {
    throw new Error('prevalidated PDS origin is not an HTTPS origin');
  }
  if (status === 404) return pdsUrl.origin;
  const metadata = object(value);
  const servers = metadata?.authorization_servers;
  const resource = metadata?.resource;
  if (status !== 200 || typeof resource !== 'string' || !Array.isArray(servers) || servers.length !== 1) {
    throw new Error('PDS authorization-server metadata is not valid for the pinned resource');
  }
  const resourceUrl = new URL(resource);
  const issuerUrl = new URL(servers[0] as string);
  if (
    resourceUrl.origin !== pdsUrl.origin ||
    issuerUrl.protocol !== 'https:' ||
    issuerUrl.username !== '' ||
    issuerUrl.password !== '' ||
    issuerUrl.search !== '' ||
    issuerUrl.hash !== ''
  ) {
    throw new Error('PDS authorization-server metadata does not bind a public HTTPS issuer to this resource');
  }
  return issuerUrl.origin;
}

export function isExpectedAuthorizationOrigin(currentUrl: string, expectedOrigin: string): boolean {
  try {
    return new URL(currentUrl).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

export async function browserRequest(
  page: import('@playwright/test').Page,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  csrf?: string,
  body?: unknown,
  idempotencyKey?: string,
  timeoutMs = 30_000,
): Promise<ApiResponse> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('browser request deadline exceeded');
  const requestId = randomUUID();
  const expiresAt = Date.now() + Math.max(1, Math.ceil(timeoutMs));
  const registryKey = '__atmusicOAuthBrowserRequests';
  const evaluation = page.evaluate(
    async ({ path, method, csrf, body, idempotencyKey, requestId, expiresAt, registryKey }) => {
      type RequestRegistry = { controllers: Map<string, AbortController>; cancelled: Set<string> };
      const global = globalThis as unknown as Record<string, unknown>;
      let registry = global[registryKey] as RequestRegistry | undefined;
      if (registry === undefined) {
        registry = { controllers: new Map<string, AbortController>(), cancelled: new Set<string>() };
        global[registryKey] = registry;
      }
      // Playwright may not begin this evaluation until after the host deadline.
      // The absolute wall-clock expiry is fixed at dispatch, so this check is
      // before fetch and does not grant a fresh timeout after evaluation starts.
      if (registry.cancelled.has(requestId) || Date.now() >= expiresAt) {
        registry.cancelled.delete(requestId);
        throw new Error('browser request deadline exceeded');
      }
      const headers: Record<string, string> = { accept: 'application/json' };
      if (csrf !== undefined) headers['x-csrf-token'] = csrf;
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
      try {
        const controller = new AbortController();
        registry.controllers.set(requestId, controller);
        const timer = setTimeout(() => controller.abort(), Math.max(0, expiresAt - Date.now()));
        try {
          if (Date.now() >= expiresAt || registry.cancelled.has(requestId)) {
            controller.abort();
            throw new Error('browser request deadline exceeded');
          }
          const response = await fetch(path, {
            method,
            credentials: 'same-origin',
            headers,
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          const text = await response.text();
          if (Date.now() >= expiresAt || registry.cancelled.has(requestId))
            throw new Error('browser request deadline exceeded');
          let json: unknown = null;
          try {
            json = text ? (JSON.parse(text) as unknown) : null;
          } catch {
            /* status is enough for failure */
          }
          return { status: response.status, json };
        } finally {
          clearTimeout(timer);
          registry.controllers.delete(requestId);
          registry.cancelled.delete(requestId);
        }
      } catch {
        throw new Error('browser request timed out or failed');
      }
    },
    { path, method, csrf, body, idempotencyKey, requestId, expiresAt, registryKey },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol('expired');
  const outcome = await Promise.race([
    evaluation.then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    ),
    new Promise<typeof expired>((resolve) => {
      timer = setTimeout(() => resolve(expired), Math.max(0, expiresAt - Date.now()));
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome !== expired) {
    if (outcome.kind === 'error') throw new Error('browser request timed out or failed');
    return outcome.value;
  }

  // Mark cancellation even when the original evaluate has not started yet.
  // When it eventually runs, the pre-fetch check observes this tombstone.
  const cancelEvaluation = page.evaluate(
    ({ requestId, registryKey }) => {
      type RequestRegistry = { controllers: Map<string, AbortController>; cancelled: Set<string> };
      const global = globalThis as unknown as Record<string, unknown>;
      const registry = global[registryKey] as RequestRegistry | undefined;
      if (registry === undefined) {
        global[registryKey] = { controllers: new Map(), cancelled: new Set([requestId]) };
        return;
      }
      registry.cancelled.add(requestId);
      registry.controllers.get(requestId)?.abort();
    },
    { requestId, registryKey },
  );
  const cleanupTimeout = 2_000;
  const settled = Symbol('settled');
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = await Promise.race([
    cancelEvaluation.then(
      () => ({ kind: 'settled' as const }),
      () => ({ kind: 'failed' as const }),
    ),
    new Promise<typeof settled>((resolve) => {
      cancellationTimer = setTimeout(() => resolve(settled), cleanupTimeout);
    }),
  ]);
  if (cancellationTimer !== undefined) clearTimeout(cancellationTimer);
  if (cancellation === settled || cancellation.kind === 'failed') {
    // Keep observing the original promise (the race above already attached a
    // rejection handler), but never start record recovery with an unknown
    // browser-side mutation still running.
    throw new UnsafeRecoveryError('browser request cleanup failed; cancellation could not be confirmed');
  }
  let evaluationTimer: ReturnType<typeof setTimeout> | undefined;
  const evaluationSettled = await Promise.race([
    evaluation.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      evaluationTimer = setTimeout(() => resolve(false), cleanupTimeout);
    }),
  ]);
  if (evaluationTimer !== undefined) clearTimeout(evaluationTimer);
  if (!evaluationSettled)
    throw new UnsafeRecoveryError('browser request cleanup failed; evaluation did not settle after cancellation');
  throw new Error('browser request timed out');
}

async function verifyCurrentRecordState(
  did: string,
  collection: string,
  rkey: string,
  deadline: Deadline,
): Promise<{
  state: 'present' | 'absent';
  rev: string;
  method: 'inclusion' | 'exclusionProof' | 'snapshot';
  record?: unknown;
}> {
  try {
    const proof = await verifyRecordAt(did, collection, rkey, {
      timer: deadline,
      assertActive: () => deadline.assertActive(),
    });
    deadline.assertActive();
    return {
      state: proof.state,
      rev: proof.rev,
      method: proof.state === 'present' ? 'inclusion' : 'exclusionProof',
      ...(proof.state === 'present' ? { record: proof.record } : {}),
    };
  } catch (error) {
    if (exclusionProofUnavailable(error) === null) throw error;
    const snapshot = await verifyAbsentBySnapshot(did, collection, rkey, {
      timer: deadline,
      assertActive: () => deadline.assertActive(),
    });
    deadline.assertActive();
    return { state: snapshot.state, rev: snapshot.rev, method: 'snapshot' };
  }
}

export async function assertNoExistingFollow(
  pds: string,
  did: string,
  collection: string,
  subject: string,
  phaseDeadline: Deadline = createDeadline(OAUTH_LIVE_BUDGETS.followEnumerationMs),
): Promise<void> {
  const enumerationDeadline = phaseDeadline.limited(OAUTH_LIVE_BUDGETS.followEnumerationMs);
  let cursor: string | undefined;
  const cursors = new Set<string>();
  const uris = new Set<string>();
  for (let page = 0; page < 500; page++) {
    phaseDeadline.assertActive();
    enumerationDeadline.assertActive();
    const listed = await httpJson(
      xrpcUrl(pds, 'com.atproto.repo.listRecords', {
        repo: did,
        collection,
        limit: '100',
        ...(cursor === undefined ? {} : { cursor }),
      }),
      { timeoutMs: enumerationDeadline.timeoutMs(15_000) },
    );
    const payload = object(listed.json);
    const records = payload?.records;
    if (listed.status !== 200 || !Array.isArray(records))
      throw new Error('could not safely enumerate existing follow records');
    for (const item of records) {
      const row = object(item);
      const uri = row?.uri;
      const cid = row?.cid;
      const value = object(row?.value);
      const parsed = typeof uri === 'string' ? parseRecordUri(uri) : null;
      if (
        !parsed ||
        parsed.did !== did ||
        parsed.collection !== collection ||
        typeof cid !== 'string' ||
        !cid ||
        value === null ||
        uris.has(uri as string)
      )
        throw new Error('PDS returned a malformed or duplicate follow record');
      uris.add(uri as string);
      if (value.subject === subject) {
        // Follow deletion removes every record matching the subject, including
        // records at noncanonical keys written by other clients.
        throw new Error('dedicated OAuth identities already follow each other; refusing to alter existing records');
      }
    }
    const next = payload?.cursor;
    if (next === undefined || next === null || next === '') return;
    if (typeof next !== 'string' || cursors.has(next))
      throw new Error('PDS follow listing returned a malformed or repeated cursor');
    cursors.add(next);
    cursor = next;
  }
  throw new Error('PDS follow listing exceeded the bounded preflight limit');
}

async function signIn(
  context: NodeGateContext,
  page: import('@playwright/test').Page,
  which: 'A' | 'B',
  expectedIssuerOrigin: string,
  timeoutMs: number,
  onCallbackSession: (session: CleanupSession) => void,
): Promise<Session> {
  const handleName = which === 'A' ? OAUTH_ENV.handleA : OAUTH_ENV.handleB;
  const passwordName = which === 'A' ? OAUTH_ENV.passwordA : OAUTH_ENV.passwordB;
  const didName = which === 'A' ? ENV.didA : ENV.didB;
  const origin = context.origin;
  const deadline = performance.now() + timeoutMs;
  const budget = () => Math.max(1, Math.min(30_000, deadline - performance.now()));
  await page.goto(new URL('/signin', origin).href, { timeout: budget() });
  await page.locator('#signin-handle').fill(context.get(handleName), { timeout: budget() });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout: budget() });
  await page.waitForURL((url) => url.origin !== origin, { timeout: budget() });

  let passwordSent = false;
  while (new URL(page.url()).origin !== origin && performance.now() < deadline) {
    const password = page.locator('input[type="password"]').first();
    if (!passwordSent && context.env[passwordName] && (await password.isVisible().catch(() => false))) {
      if (!isExpectedAuthorizationOrigin(page.url(), expectedIssuerOrigin)) {
        throw new Error(`refusing to enter the PDS ${which} password outside its pinned authorization server`);
      }
      const identifier = page.locator('input[autocomplete="username"], input[name="username"]').first();
      if ((await identifier.isVisible().catch(() => false)) && !(await identifier.inputValue().catch(() => ''))) {
        await identifier.fill(context.get(handleName), { timeout: budget() });
      }
      await password.fill(context.get(passwordName), { timeout: budget() });
      await password.press('Enter', { timeout: budget() });
      passwordSent = true;
      continue;
    }
    const consent = page.getByRole('button', { name: /^(authorize|accept|allow|approve)$/i }).first();
    if (await consent.isVisible().catch(() => false)) {
      await consent.click({ timeout: budget() });
      continue;
    }
    const next = page.getByRole('button', { name: /^(next|continue|sign in|log in)$/i }).first();
    if (await next.isVisible().catch(() => false)) {
      await next.click({ timeout: budget() });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (new URL(page.url()).origin !== origin) throw new Error(`PDS ${which} authorization did not return to the app`);

  const response = await browserRequest(page, '/api/v1/auth/session', 'GET');
  const expectedDid = context.get(didName);
  return validatedCallbackSession(response, which, expectedDid, onCallbackSession);
}

async function socketObserve(
  context: NodeGateContext,
  did: string,
  phase: 'capture' | 'crud' | 'prepare_sign_out' | 'after_sign_out',
  followSubject?: string,
  deadline?: Deadline,
): Promise<JsonObject> {
  deadline?.assertActive();
  const body: Record<string, string> = { did, phase };
  if (followSubject !== undefined) body.followSubject = followSubject;
  const request: AdminRequest = {
    method: 'POST',
    path: '/admin/oauth/live-observe',
    body,
    // The observer performs multiple sequential repository calls plus cleanup.
    // Its bounded CRUD phase and cleanup budget fit inside this client wait, so
    // the browser does not sign out while host-side cleanup is still running.
    timeoutMs: deadline ? deadline.timeoutMs(30_000) : phase === 'crud' ? CRUD_SOCKET_TIMEOUT_MS : 30_000,
  };
  const socket = defaultSocketPath(context.env, process.getuid?.() ?? null);
  const answer = await sendOverSocket(socket, request);
  const decoded = object(JSON.parse(answer.body) as unknown);
  if (answer.status !== 200 || decoded === null)
    throw new Error(`host OAuth observation returned HTTP ${answer.status}`);
  return decoded;
}

async function appOperation(
  page: import('@playwright/test').Page,
  csrf: string,
  route: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  idempotencyKey?: string,
  onAccepted?: (operation: JsonObject) => void,
  phaseDeadline: Deadline = createDeadline(OAUTH_LIVE_BUDGETS.appPhaseMs),
): Promise<JsonObject> {
  const deadline = performance.now() + Math.min(5 * 60_000, phaseDeadline.remainingMs());
  let ack: ApiResponse;
  for (;;) {
    phaseDeadline.assertActive();
    try {
      ack = await browserRequest(
        page,
        route,
        method,
        csrf,
        body,
        idempotencyKey,
        Math.min(30_000, deadline - performance.now(), phaseDeadline.remainingMs()),
      );
      break;
    } catch (error) {
      if (error instanceof UnsafeRecoveryError) throw error;
      // Retrying a scrobble is safe only with the same idempotency key; this
      // recovers the accepted operation when its first acknowledgement was lost.
      if (idempotencyKey === undefined || performance.now() >= deadline || phaseDeadline.remainingMs() <= 0)
        throw new Error('app write acknowledgement was not received');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const operation = object(field(ack.json, 'operation'));
  if (ack.status !== 202 || typeof operation?.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(operation.id)) {
    throw new Error(`${method} ${new URL(route, 'https://local.invalid').pathname} was not accepted as an operation`);
  }
  onAccepted?.(operation);
  for (;;) {
    phaseDeadline.assertActive();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('app write did not settle before the acceptance deadline');
    const status = await browserRequest(
      page,
      `/api/v1/operations/${encodeURIComponent(operation.id)}`,
      'GET',
      undefined,
      undefined,
      undefined,
      Math.min(30_000, remaining, phaseDeadline.remainingMs()),
    );
    phaseDeadline.assertActive();
    const value = object(status.json);
    if (status.status !== 200 || value?.id !== operation.id || typeof value.state !== 'string') {
      throw new Error('app write operation status was malformed');
    }
    if (value.state === 'succeeded') {
      phaseDeadline.assertActive();
      return value;
    }
    if (value.state === 'failed' || value.state === 'blocked' || value.state === 'cancelled') {
      throw new Error(`app write operation ended ${value.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remaining)));
  }
}

function operationRecord(operation: JsonObject): CreatedRecord {
  const uri = operation.uri;
  const cid = operation.cid;
  const updatedAt = operation.updatedAt;
  if (
    typeof uri !== 'string' ||
    typeof cid !== 'string' ||
    typeof updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new Error('succeeded app operation did not identify its PDS record');
  }
  const parsed = parseRecordUri(uri);
  if (!parsed) throw new Error('succeeded app operation returned a malformed record URI');
  return { uri, cid, rev: '' };
}

async function provePresent(
  did: string,
  expectedCollection: string,
  record: CreatedRecord,
  expected: JsonObject,
  deadline: Deadline,
): Promise<{ rev: string; rkey: string }> {
  const parsed = parseRecordUri(record.uri);
  if (!parsed || parsed.did !== did || parsed.collection !== expectedCollection)
    throw new Error('app write returned a record outside its intended repo collection');
  const proof = await verifyRecordAt(did, parsed.collection, parsed.rkey, {
    timer: deadline,
    assertActive: () => deadline.assertActive(),
  });
  deadline.assertActive();
  const value = object(proof.record);
  if (proof.state !== 'present' || proof.cid !== record.cid || value === null)
    throw new Error('app write record lacks an independently verified inclusion proof');
  for (const [key, expectedValue] of Object.entries(expected))
    if (value[key] !== expectedValue) throw new Error(`app write record content mismatch for ${key}`);
  return { rev: proof.rev, rkey: parsed.rkey };
}

async function proveAbsent(
  did: string,
  collection: string,
  rkey: string,
  after: string,
  deadline: Deadline,
): Promise<boolean> {
  const proof = await verifyAbsent(did, collection, rkey, {
    after,
    timer: deadline,
    assertActive: () => deadline.assertActive(),
  });
  deadline.assertActive();
  return proof.method === 'exclusionProof' || proof.method === 'snapshot';
}

async function appWrites(
  context: NodeGateContext,
  page: import('@playwright/test').Page,
  session: Session,
  peerDid: string,
  pdsEndpoint: string,
  cleanupNotes: string[],
): Promise<Record<string, unknown>[]> {
  const cleanupNoteStart = cleanupNotes.length;
  let appDeadline = createDeadline(OAUTH_LIVE_BUDGETS.appPhaseMs);
  let cleanupDeadline = createDeadline(OAUTH_LIVE_BUDGETS.appCleanupMs);
  const prefix = context.lexiconPrefix;
  const collections = {
    scrobble: `${prefix}.scrobble`,
    follow: `${prefix}.follow`,
    love: `${prefix}.love`,
    settings: `${prefix}.settings`,
  };
  const nonce = randomUUID();
  const artist = `ATMusic acceptance ${nonce}`;
  const track = `Live OAuth ${nonce}`;
  const listenedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const writes: Record<string, unknown>[] = [];
  type PendingWrite = {
    kind: string;
    collection: string;
    rkey: string | null;
    after: string | null;
    route: string;
    operationId: string;
  };
  const pending: PendingWrite[] = [];
  let previousIndexing: 'enabled' | 'disabled' | null = null;
  let settingsChanged = false;
  let runFailed = false;
  let cleanupFailed = false;
  const record = async (kind: string, created: CreatedRecord, collection: string, expected: JsonObject) => {
    const proof = await provePresent(session.did, collection, created, expected, appDeadline);
    writes.push({ kind, operationState: 'succeeded', recordVerified: true, absenceVerified: false });
    return { ...proof, collection, uri: created.uri };
  };
  const deleted = async (kind: string, collection: string, rkey: string, after: string) => {
    if (!(await proveAbsent(session.did, collection, rkey, after, appDeadline)))
      throw new Error(`${kind} absence was not verified`);
    writes.push({ kind, operationState: 'succeeded', recordVerified: false, absenceVerified: true });
  };
  const removePending = (kind: string) => {
    const index = pending.findIndex((item) => item.kind === kind);
    if (index >= 0) pending.splice(index, 1);
  };
  const registerPending = (kind: string, collection: string, route: string, operation: JsonObject): PendingWrite => {
    const item: PendingWrite = {
      kind,
      collection,
      rkey: null,
      after: null,
      route,
      operationId: typeof operation.id === 'string' ? operation.id : '',
    };
    const parsed = typeof operation.uri === 'string' ? parseRecordUri(operation.uri) : null;
    if (parsed?.did === session.did && parsed.collection === collection) {
      item.rkey = parsed.rkey;
      if (kind === 'scrobble.delete' && item.route === '') {
        item.route = `/api/v1/scrobbles/${encodeURIComponent(operation.uri as string)}`;
      }
    }
    pending.push(item);
    return item;
  };
  const attachRecord = (item: PendingWrite, operation: JsonObject): void => {
    const created = operationRecord(operation);
    const parsed = parseRecordUri(created.uri);
    if (!parsed || parsed.did !== session.did || parsed.collection !== item.collection)
      throw new Error('accepted app write returned a record outside its intended collection');
    item.rkey = parsed.rkey;
  };
  const recoverPendingKey = async (item: PendingWrite): Promise<boolean> => {
    if (item.rkey !== null) return true;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(item.operationId)) return false;
    const deadline = performance.now() + Math.min(30_000, cleanupDeadline.remainingMs());
    while (performance.now() < deadline) {
      cleanupDeadline.assertActive();
      const status = await browserRequest(
        page,
        `/api/v1/operations/${encodeURIComponent(item.operationId)}`,
        'GET',
        undefined,
        undefined,
        undefined,
        Math.min(10_000, deadline - performance.now(), cleanupDeadline.remainingMs()),
      );
      const operation = object(status.json);
      if (status.status !== 200 || operation?.id !== item.operationId || typeof operation.state !== 'string')
        return false;
      if (typeof operation.uri === 'string') {
        const parsed = parseRecordUri(operation.uri);
        if (!parsed || parsed.did !== session.did || parsed.collection !== item.collection) return false;
        item.rkey = parsed.rkey;
        if (item.kind === 'scrobble.delete' && item.route === '') {
          const uri = `at://${parsed.did}/${parsed.collection}/${parsed.rkey}`;
          item.route = `/api/v1/scrobbles/${encodeURIComponent(uri)}`;
        }
        return true;
      }
      if (['failed', 'blocked', 'cancelled'].includes(operation.state)) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };
  return withBoundedRecovery(
    async (deadline) => {
      appDeadline = deadline;
      try {
        const scrobbleKey = randomUUID();
        let scrobbleCleanup: PendingWrite | undefined;
        const scrobbleOp = await appOperation(
          page,
          session.csrf,
          '/api/v1/scrobbles',
          'POST',
          {
            artist,
            track,
            listenedAt,
          },
          scrobbleKey,
          (operation) => {
            scrobbleCleanup = registerPending('scrobble.delete', collections.scrobble, '', operation);
          },
          appDeadline,
        );
        if (scrobbleOp.kind !== 'scrobble.create') throw new Error('scrobble route produced the wrong operation kind');
        const scrobble = operationRecord(scrobbleOp);
        const scrobbleUri = parseRecordUri(scrobble.uri);
        if (!scrobbleUri) throw new Error('scrobble operation returned a malformed record URI');
        if (!scrobbleCleanup) throw new Error('accepted scrobble has no cleanup registration');
        scrobbleCleanup.route = `/api/v1/scrobbles/${encodeURIComponent(scrobble.uri)}`;
        scrobbleCleanup.rkey = scrobbleUri.rkey;
        attachRecord(scrobbleCleanup, scrobbleOp);
        const scrobbleProof = await record('scrobble.create', scrobble, collections.scrobble, { artist, track });
        scrobbleCleanup.after = scrobbleProof.rev;
        const scrobbleDelete = await appOperation(
          page,
          session.csrf,
          `/api/v1/scrobbles/${encodeURIComponent(scrobble.uri)}`,
          'DELETE',
          undefined,
          undefined,
          undefined,
          appDeadline,
        );
        if (scrobbleDelete.kind !== 'scrobble.delete')
          throw new Error('scrobble delete route produced the wrong operation kind');
        await deleted('scrobble.delete', collections.scrobble, scrobbleProof.rkey, scrobbleProof.rev);
        removePending('scrobble.delete');

        await assertNoExistingFollow(pdsEndpoint, session.did, collections.follow, peerDid, appDeadline);
        let followCleanup: PendingWrite | undefined;
        const followRoute = `/api/v1/follows/${encodeURIComponent(peerDid)}`;
        const followOperation = await appOperation(
          page,
          session.csrf,
          followRoute,
          'PUT',
          undefined,
          undefined,
          (operation) => {
            followCleanup = registerPending('follow.delete', collections.follow, followRoute, operation);
          },
          appDeadline,
        );
        if (followOperation.kind !== 'follow.put') throw new Error('follow route produced the wrong operation kind');
        const followCreated = operationRecord(followOperation);
        const followUri = parseRecordUri(followCreated.uri);
        if (!followUri) throw new Error('follow operation returned a malformed record URI');
        if (!followCleanup) throw new Error('accepted follow has no cleanup registration');
        followCleanup.rkey = followUri.rkey;
        attachRecord(followCleanup, followOperation);
        const followProof = await record('follow.put', followCreated, collections.follow, { subject: peerDid });
        followCleanup.after = followProof.rev;
        const unfollow = await appOperation(
          page,
          session.csrf,
          `/api/v1/follows/${encodeURIComponent(peerDid)}`,
          'DELETE',
          undefined,
          undefined,
          undefined,
          appDeadline,
        );
        if (unfollow.kind !== 'follow.delete') throw new Error('unfollow route produced the wrong operation kind');
        await deleted('follow.delete', collections.follow, followProof.rkey, followProof.rev);
        removePending('follow.delete');

        let loveCleanup: PendingWrite | undefined;
        const loveRoute = `/api/v1/loves?artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}`;
        const loveOperation = await appOperation(
          page,
          session.csrf,
          '/api/v1/loves',
          'PUT',
          { artist, track },
          undefined,
          (operation) => {
            loveCleanup = registerPending('love.delete', collections.love, loveRoute, operation);
          },
          appDeadline,
        );
        if (loveOperation.kind !== 'love.put') throw new Error('love route produced the wrong operation kind');
        const loveCreated = operationRecord(loveOperation);
        const loveUri = parseRecordUri(loveCreated.uri);
        if (!loveUri) throw new Error('love operation returned a malformed record URI');
        if (!loveCleanup) throw new Error('accepted love has no cleanup registration');
        loveCleanup.rkey = loveUri.rkey;
        attachRecord(loveCleanup, loveOperation);
        const loveProof = await record('love.put', loveCreated, collections.love, { artist, track });
        loveCleanup.after = loveProof.rev;
        const unlove = await appOperation(
          page,
          session.csrf,
          loveRoute,
          'DELETE',
          undefined,
          undefined,
          undefined,
          appDeadline,
        );
        if (unlove.kind !== 'love.delete') throw new Error('unlove route produced the wrong operation kind');
        await deleted('love.delete', collections.love, loveProof.rkey, loveProof.rev);
        removePending('love.delete');

        const settingsRkey = 'self';
        const beforeSettings = await verifyCurrentRecordState(
          session.did,
          collections.settings,
          settingsRkey,
          appDeadline,
        );
        if (beforeSettings.state === 'present' && beforeSettings.record === undefined)
          throw new Error('existing settings record could not be read with an inclusion proof');
        const priorValue = beforeSettings.state === 'present' ? object(beforeSettings.record)?.indexing : null;
        if (priorValue === 'enabled' || priorValue === 'disabled') previousIndexing = priorValue;
        if (priorValue !== null && priorValue !== undefined && priorValue !== 'enabled' && priorValue !== 'disabled') {
          throw new Error('existing settings record has an unrecognized indexing value');
        }
        const selectedIndexing = previousIndexing === 'enabled' ? 'disabled' : 'enabled';
        // Mark the prior value as needing restoration before issuing the mutation:
        // the request may commit even if its response is lost or polling fails.
        settingsChanged = true;
        const settingsOperation = await appOperation(
          page,
          session.csrf,
          '/api/v1/account/indexing',
          'PUT',
          { indexing: selectedIndexing },
          undefined,
          undefined,
          appDeadline,
        );
        if (settingsOperation.kind !== 'settings.put')
          throw new Error('settings route produced the wrong operation kind');
        const settingsCreated = operationRecord(settingsOperation);
        const settingsProof = await record('settings.put', settingsCreated, collections.settings, {
          indexing: selectedIndexing,
        });

        if (previousIndexing === 'enabled' || previousIndexing === 'disabled') {
          const restore = await appOperation(
            page,
            session.csrf,
            '/api/v1/account/indexing',
            'PUT',
            { indexing: previousIndexing },
            undefined,
            undefined,
            appDeadline,
          );
          if (restore.kind !== 'settings.put')
            throw new Error('settings restoration produced the wrong operation kind');
          const restored = operationRecord(restore);
          await provePresent(session.did, collections.settings, restored, { indexing: previousIndexing }, appDeadline);
          settingsChanged = false;
          cleanupNotes.push(`${session.did}: previous indexing setting restored through the app`);
        } else {
          // Settings has no app-supported delete route. Preserve this one benign
          // default on the dedicated acceptance identity and report it explicitly.
          cleanupNotes.push(
            `${session.did}: created default settings/self=${selectedIndexing}; API exposes no delete route`,
          );
        }

        if (writes.length !== 7 || settingsProof.collection !== collections.settings)
          throw new Error('app write coverage construction failed');
      } catch (error) {
        runFailed = true;
        if (error instanceof UnsafeRecoveryError) {
          cleanupFailed = true;
          cleanupNotes.push(
            `${session.did}: browser request cleanup failed; pending writes remain unresolved and safe recovery was not attempted`,
          );
          throw error;
        }
      }
      if (runFailed) throw new Error('app write verification failed');
      return writes;
    },
    async (deadline, runError) => {
      cleanupDeadline = deadline;
      if (runError !== null) runFailed = true;
      const recoveryCount = pending.length;
      for (const item of [...pending]) {
        try {
          if (!(await recoverPendingKey(item)) || item.rkey === null) {
            cleanupFailed = true;
            continue;
          }
          const current = await verifyCurrentRecordState(session.did, item.collection, item.rkey, cleanupDeadline);
          if (current.state === 'absent') {
            removePending(item.kind);
            continue;
          }
          const operation = await appOperation(
            page,
            session.csrf,
            item.route,
            'DELETE',
            undefined,
            undefined,
            undefined,
            cleanupDeadline,
          );
          if (operation.kind !== item.kind) {
            cleanupFailed = true;
            continue;
          }
          await proveAbsent(session.did, item.collection, item.rkey, current.rev, cleanupDeadline);
          removePending(item.kind);
        } catch {
          // Keep only the fixed local record identity in the cleanup note.
          cleanupFailed = true;
        }
      }
      if (pending.length > 0) {
        cleanupNotes.push(`${session.did}: ${pending.length} app-created record(s) remain unresolved`);
        cleanupFailed = true;
      }
      if (runFailed && previousIndexing === null && settingsChanged) {
        cleanupNotes.push(`${session.did}: settings/self may have been created; API exposes no delete route`);
        cleanupFailed = true;
      }
      if (settingsChanged && previousIndexing !== null) {
        try {
          const restore = await appOperation(
            page,
            session.csrf,
            '/api/v1/account/indexing',
            'PUT',
            { indexing: previousIndexing },
            undefined,
            undefined,
            cleanupDeadline,
          );
          const restored = operationRecord(restore);
          await provePresent(
            session.did,
            collections.settings,
            restored,
            { indexing: previousIndexing },
            cleanupDeadline,
          );
          cleanupNotes.push(`${session.did}: previous indexing setting restored after a failed check`);
          settingsChanged = false;
        } catch {
          cleanupNotes.push(`${session.did}: previous indexing setting could not be restored`);
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) throw new Error('app write recovery failed');
      if (recoveryCount > 0) {
        cleanupNotes.push(`${session.did}: ${recoveryCount} accepted app write(s) reconciled during recovery`);
      }
    },
  ).catch((error: unknown) => {
    for (const note of cleanupNotes.slice(cleanupNoteStart)) context.cleanup(note);
    throw error;
  });
}

async function validateClientMetadata(context: NodeGateContext): Promise<void> {
  const response = await httpJson(new URL('/oauth/client-metadata.json', context.origin));
  const metadata = object(response.json);
  const scope = typeof metadata?.scope === 'string' ? metadata.scope : '';
  if (
    response.status !== 200 ||
    metadata?.client_id !== `${context.origin}/oauth/client-metadata.json` ||
    metadata.token_endpoint_auth_method !== 'private_key_jwt' ||
    metadata.dpop_bound_access_tokens !== true ||
    !hasAllTwelveActions(context.lexiconPrefix, scope) ||
    scope.split(/\s+/).some((token) => token.startsWith('transition:'))
  ) {
    throw new Error('deployed confidential client metadata does not request the complete four-collection scope');
  }
}

export function hasAllTwelveActions(prefix: string, scope: string): boolean {
  const tokens = scope.split(/\s+/).filter(Boolean);
  if (!tokens.includes('atproto')) return false;
  const expected = ['scrobble', 'follow', 'settings', 'love'].map((name) => `${prefix}.${name}`);
  const grants = new Map<string, Set<string>>();
  for (const token of tokens) {
    if (!token.startsWith('repo:') && !token.startsWith('repo?')) continue;
    const splitAt = token.indexOf('?');
    const head = splitAt < 0 ? token : token.slice(0, splitAt);
    const params = new URLSearchParams(splitAt < 0 ? '' : token.slice(splitAt + 1));
    let positional = '';
    try {
      positional = head.startsWith('repo:') ? decodeURIComponent(head.slice('repo:'.length)) : '';
    } catch {
      continue;
    }
    const collections = [...(positional ? [positional] : []), ...params.getAll('collection')];
    const actions = params.getAll('action');
    const allowed = new Set(actions.length === 0 ? ['create', 'update', 'delete'] : actions);
    for (const collection of collections) {
      const set = grants.get(collection) ?? new Set<string>();
      for (const action of allowed) set.add(action);
      grants.set(collection, set);
    }
  }
  return expected.every((collection) =>
    ['create', 'update', 'delete'].every((action) => grants.get(collection)?.has(action)),
  );
}

export const spec: NodeGateSpec = {
  gate: 'oauth',
  script: 'scripts/live/node_oauth_check.ts',
  requirements,
  extraChecks,
  async run(context) {
    await validateClientMetadata(context);
    const identities = [
      {
        which: 'A' as const,
        did: context.get(ENV.didA),
        pds: context.get(ENV.pdsA),
        handle: context.get(OAUTH_ENV.handleA),
        implementation: context.get(ENV.pdsAImplementation),
      },
      {
        which: 'B' as const,
        did: context.get(ENV.didB),
        pds: context.get(ENV.pdsB),
        handle: context.get(OAUTH_ENV.handleB),
        implementation: context.get(ENV.pdsBImplementation),
      },
    ];
    const pds: Awaited<ReturnType<typeof pdsInfo>>[] = [];
    const authorizationOrigins: string[] = [];
    for (const identity of identities) {
      const info = await pdsInfo(identity.pds, identity.implementation);
      await checkIdentityPds(identity.did, info.endpoint);
      const handle = await httpJson(
        xrpcUrl(info.endpoint, 'com.atproto.identity.resolveHandle', { handle: identity.handle }),
      );
      if (!handleResolutionMatchesDid(handle.status, handle.json, identity.did)) {
        throw new Error(
          `configured handle for PDS ${identity.which} does not resolve to the expected DID on its declared PDS`,
        );
      }
      const protectedResource = await httpJson(new URL('/.well-known/oauth-protected-resource', info.endpoint));
      authorizationOrigins.push(
        expectedAuthorizationOrigin(info.endpoint, protectedResource.status, protectedResource.json),
      );
      pds.push(info);
    }

    const timeoutMs = signInTimeoutMs(context.env);
    const browser = await launchBrowser(context.env);
    const signIns: Record<string, unknown>[] = [];
    const cleanupNotes: string[] = [];
    try {
      for (const [index, identity] of identities.entries()) {
        const browserContext = await browser.newContext();
        const page = await browserContext.newPage();
        let appSignOutCompleted = false;
        let signOutDeadline: Deadline | null = null;
        let captured = false;
        const sessionForCleanup: { value: CleanupSession | null } = { value: null };
        try {
          const session = await signIn(
            context,
            page,
            identity.which,
            authorizationOrigins[index]!,
            timeoutMs,
            (session) => {
              sessionForCleanup.value = session;
            },
          );
          const capture = await socketObserve(context, session.did, 'capture');
          if (
            capture.status !== 'captured' ||
            capture.tokenSub !== session.did ||
            capture.issuerHost !== new URL(identity.pds).hostname.toLowerCase() ||
            capture.sealedSessionObserved !== true ||
            capture.clientAuthMethod !== 'private_key_jwt' ||
            capture.dpopBound !== true ||
            capture.refreshTokenPresent !== true ||
            typeof capture.grantedScope !== 'string'
          ) {
            throw new Error(`host did not observe the expected confidential OAuth session for PDS ${identity.which}`);
          }
          captured = true;
          if (
            !hasAllTwelveActions(context.lexiconPrefix, capture.grantedScope) ||
            capture.grantedScope.split(/\s+/).some((token: string) => token.startsWith('transition:'))
          ) {
            throw new Error(`PDS ${identity.which} did not grant all twelve repo actions`);
          }
          const crudResult = await socketObserve(context, session.did, 'crud', identities[index === 0 ? 1 : 0]!.did);
          if (
            crudResult.status !== 'passed' ||
            crudResult.cleanupVerified !== true ||
            !Array.isArray(crudResult.crud)
          ) {
            throw new Error(`direct repository CRUD checks failed for PDS ${identity.which}`);
          }
          const writes = await appWrites(
            context,
            page,
            session,
            identities[index === 0 ? 1 : 0]!.did,
            pds[index]!.endpoint,
            cleanupNotes,
          );
          if (writes.length !== 7) throw new Error(`app write checks were incomplete for PDS ${identity.which}`);

          signOutDeadline = createDeadline(OAUTH_LIVE_BUDGETS.signOutMs);
          const prepared = await socketObserve(context, session.did, 'prepare_sign_out', undefined, signOutDeadline);
          if (
            prepared.status !== 'prepared' ||
            prepared.refreshTokenPresent !== true ||
            prepared.sessionVersionStable !== true
          )
            throw new Error('host could not bind the current refresh token to the upcoming sign-out');
          const logout = await browserRequest(
            page,
            '/api/v1/auth/logout',
            'POST',
            session.csrf,
            {},
            undefined,
            signOutDeadline.timeoutMs(30_000),
          );
          appSignOutCompleted = logout.status === 204;
          if (!appSignOutCompleted) throw new Error(`app sign-out failed for PDS ${identity.which}`);
          const afterSignOut = await socketObserve(context, session.did, 'after_sign_out', undefined, signOutDeadline);
          if (
            afterSignOut.status !== 'revoked' ||
            afterSignOut.localSessionAbsent !== true ||
            afterSignOut.refreshRejected !== true ||
            afterSignOut.refreshError !== 'invalid_grant'
          ) {
            context.cleanup(`${identity.did}: session removal or refresh-token revocation remains unverified`);
            throw new Error(`upstream refresh-token revocation was not proven for PDS ${identity.which}`);
          }
          signIns.push({
            did: session.did,
            issuerHost: capture.issuerHost,
            tokenSub: capture.tokenSub,
            grantedScope: capture.grantedScope,
            exchange: {
              sealedSessionObserved: capture.sealedSessionObserved,
              clientAuthMethod: capture.clientAuthMethod,
              dpopBound: capture.dpopBound,
              refreshTokenPresent: capture.refreshTokenPresent,
            },
            crud: crudResult.crud,
            appWrites: writes,
            signOut: {
              appSignOutCompleted,
              sessionVersionStableUntilSignOut: prepared.sessionVersionStable,
              localSessionAbsent: afterSignOut.localSessionAbsent,
              refreshRejected: afterSignOut.refreshRejected,
              refreshError: afterSignOut.refreshError,
            },
          });
        } finally {
          if (sessionForCleanup.value !== null && !appSignOutCompleted) {
            const cleanupSession = sessionForCleanup.value;
            signOutDeadline ??= createDeadline(OAUTH_LIVE_BUDGETS.signOutMs);
            if (captured && cleanupSession.did !== undefined) {
              try {
                const prepared = await socketObserve(
                  context,
                  cleanupSession.did,
                  'prepare_sign_out',
                  undefined,
                  signOutDeadline,
                );
                if (
                  prepared.status !== 'prepared' ||
                  prepared.refreshTokenPresent !== true ||
                  prepared.sessionVersionStable !== true
                ) {
                  context.cleanup(`${identity.did}: host sign-out preparation incomplete; app logout will still run`);
                }
              } catch {
                context.cleanup(`${identity.did}: host sign-out preparation failed; app logout will still run`);
              }
            }
            try {
              const logout = await browserRequest(
                page,
                '/api/v1/auth/logout',
                'POST',
                cleanupSession.csrf,
                {},
                undefined,
                signOutDeadline.timeoutMs(30_000),
              );
              appSignOutCompleted = logout.status === 204;
            } catch {
              appSignOutCompleted = false;
            }
            if (captured && appSignOutCompleted && cleanupSession.did !== undefined) {
              try {
                const observed = await socketObserve(
                  context,
                  cleanupSession.did,
                  'after_sign_out',
                  undefined,
                  signOutDeadline,
                );
                if (
                  observed.status !== 'revoked' ||
                  observed.localSessionAbsent !== true ||
                  observed.refreshRejected !== true ||
                  observed.refreshError !== 'invalid_grant'
                ) {
                  context.cleanup(`${identity.did}: session removal or refresh-token revocation remains unverified`);
                }
              } catch {
                context.cleanup(`${identity.did}: host revocation verification failed after app logout`);
              }
            }
            if (!appSignOutCompleted) {
              context.cleanup(
                `${identity.did}: sign-out incomplete; host capture is time-limited and acceptance failed`,
              );
            }
          }
          await browserContext.close().catch(() => undefined);
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
    return {
      pds,
      subjects: identities.map((identity) => ({ did: identity.did, uri: null })),
      results: {
        signIns,
        cleanup:
          cleanupNotes.length > 0
            ? cleanupNotes.join('; ')
            : 'all temporary scrobbles, follows, and loves were deleted and absence verified; settings were preserved',
      },
    };
  },
};

if (isNodeGateMain(import.meta.url)) mainNodeGate(spec);

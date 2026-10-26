// The outbox's port to a user's PDS (ADR 0005 §5.8 "Writer port", §3.5; N2-05).
//
// `PdsWriter` is what the outbox needs of an OAuth session: the DID and
// `fetchHandler(pathname, init)`, which resolves the path against the
// session's PDS and adds the DPoP-bound authorization. Production passes
// `@atproto/oauth-client-node`'s `OAuthSession` (through `sessionWriter`),
// whose client is built with `fetch: policyFetch` (N2-03), so every PDS write
// goes through the pinned transport, the URL policy, `redirect: 'manual'`
// (any 3xx is TransportError `redirect`, never followed), the 10 s deadline
// and the body caps of PDS_WRITER_CAPS. Tests pass a writer over the same
// policyFetch and the fake PDS.
//
// `PdsWriterSource.writerFor(did)` answers null when the DID has no usable
// session (sign-in required): its operations become `blocked`, without an
// attempt (ADR §5.8 Re-authentication). A token that cannot be refreshed
// during a request (`ReauthRequiredError`, or the OAuth client's
// TokenRefreshError / TokenRevokedError / TokenInvalidError) and a PDS 401 /
// InvalidToken / ExpiredToken have the same effect.
//
// `PdsXrpc` ports web/src/outbox/runner.ts `PdsXrpc`: every failure is
// classified with @atmusic/core/write-policy (crates/atproto/src/pds/write.rs
// and reconcile.rs): transient (network, 5xx, 429 with its requested wait,
// InvalidSwap), ambiguous create (RecordAlreadyExists), missing (404 /
// RecordNotFound) or permanent. A TransportError is transient with the code
// `transport_<code>`, e.g. `transport_redirect`. Before each write request
// the hooks charge its points (budget.ts) and after it they read the
// rate-limit headers.

import type { Clock } from '@atmusic/core/deps';
import { classify, classifyResponse, type WriteOperation } from '@atmusic/core/write-policy';
import { TokenInvalidError, TokenRefreshError, TokenRevokedError } from '@atproto/oauth-client-node';
import { WRITE_COST } from './budget';

/** policyFetch caps for PdsWriter requests (bound by the composition, N2-03/N4-01). */
export const PDS_WRITER_CAPS = Object.freeze({ maxRequestBytes: 1_000_000, maxResponseBytes: 1_048_576 });

export interface PdsWriter {
  readonly did: string;
  /** `OAuthSession.fetchHandler`: `pathname` is resolved against the session's PDS. */
  fetchHandler(pathname: string, init?: RequestInit): Promise<Response>;
}

export interface PdsWriterSource {
  /** The DID's writer; null when it has no usable OAuth session (sign-in required). */
  writerFor(did: string): Promise<PdsWriter | null>;
}

/** The session cannot be used without a new sign-in. */
export class ReauthRequiredError extends Error {
  constructor(message = 'sign-in required') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

function isReauthError(error: unknown): boolean {
  return (
    error instanceof ReauthRequiredError ||
    error instanceof TokenRefreshError ||
    error instanceof TokenRevokedError ||
    error instanceof TokenInvalidError
  );
}

/** Adapts an OAuth session (`{did, fetchHandler}`) to PdsWriter. */
export function sessionWriter(session: {
  readonly did: string;
  fetchHandler(pathname: string, init?: RequestInit): Promise<Response>;
}): PdsWriter {
  return {
    did: session.did,
    fetchHandler: async (pathname, init) => {
      try {
        return await session.fetchHandler(pathname, init);
      } catch (error) {
        if (isReauthError(error)) throw new ReauthRequiredError();
        throw error;
      }
    },
  };
}

export type FailureKind = 'transient' | 'permanent' | 'ambiguous_create' | 'missing' | 'reauth';

export interface Failure {
  kind: FailureKind;
  /** An error slug (`^[a-z0-9_]{1,64}$`). */
  code: string;
  /** HTTP status of the answer, when there was one. */
  status?: number;
  retryAfterMs?: number;
  error?: string;
}

export type XrpcResult = { ok: true; status: number; body: unknown } | { ok: false; failure: Failure };

export type RecordLookup =
  | { kind: 'present'; uri: string; cid: string; value: unknown }
  | { kind: 'absent' }
  | { kind: 'failed'; failure: Failure };

export interface ListedRecord {
  uri: string;
  cid: string;
  value: unknown;
}

export interface XrpcHooks {
  /** Before a write request is sent: charge its points. */
  beforeWrite?(points: number): void;
  /** After a write request answered (any status). */
  afterWrite?(response: { status: number; headers: Headers }, retryAfterMs?: number): void;
}

const MAX_SUCCESS_BODY_BYTES = 1024 * 1024;

const SLUG = /^[a-z0-9_]{1,64}$/;

function transportCode(error: unknown): string | null {
  if (error instanceof Error && error.name === 'TransportError') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      const slug = `transport_${code}`;
      if (SLUG.test(slug)) return slug;
    }
  }
  return null;
}

/** Points a write request costs (as the reference PDS charges it). */
export function writePoints(nsid: string, body: Record<string, unknown>): number {
  switch (nsid) {
    case 'com.atproto.repo.createRecord':
      return WRITE_COST.create;
    case 'com.atproto.repo.putRecord':
      return WRITE_COST.update;
    case 'com.atproto.repo.deleteRecord':
      return WRITE_COST.delete;
    case 'com.atproto.repo.applyWrites': {
      let points = 0;
      for (const w of Array.isArray(body.writes) ? (body.writes as { $type?: unknown }[]) : []) {
        if (w.$type === 'com.atproto.repo.applyWrites#create') points += WRITE_COST.create;
        else if (w.$type === 'com.atproto.repo.applyWrites#update') points += WRITE_COST.update;
        else points += WRITE_COST.delete;
      }
      return points;
    }
    default:
      return 0;
  }
}

/** XRPC over a PdsWriter; every failure is classified. */
export class PdsXrpc {
  constructor(
    private readonly writer: PdsWriter,
    private readonly clock: Clock,
    private readonly hooks: XrpcHooks = {},
  ) {}

  get did(): string {
    return this.writer.did;
  }

  /** POST a procedure. `operation` decides whether "already exists" is ambiguous. */
  procedure(
    nsid: string,
    body: Record<string, unknown>,
    operation: WriteOperation,
    encoded?: string,
  ): Promise<XrpcResult> {
    this.hooks.beforeWrite?.(writePoints(nsid, body));
    return this.send(
      `/xrpc/${nsid}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: encoded ?? JSON.stringify(body),
      },
      operation,
      true,
    );
  }

  query(nsid: string, params: Record<string, string>): Promise<XrpcResult> {
    const search = new URLSearchParams(params).toString();
    return this.send(
      `/xrpc/${nsid}?${search}`,
      { method: 'GET', headers: { accept: 'application/json' } },
      'put',
      false,
    );
  }

  private async send(path: string, init: RequestInit, operation: WriteOperation, write: boolean): Promise<XrpcResult> {
    let response: Response;
    try {
      response = await this.writer.fetchHandler(path, init);
    } catch (error) {
      if (isReauthError(error)) return { ok: false, failure: { kind: 'reauth', code: 'reauth_required' } };
      const code = transportCode(error);
      if (code !== null) return { ok: false, failure: { kind: 'transient', code } };
      const c = classify(error, { operation, clock: this.clock });
      return { ok: false, failure: { ...c } };
    }
    if (response.status < 200 || response.status > 299) {
      const c = await classifyResponse(response, { operation, clock: this.clock });
      if (write) this.hooks.afterWrite?.(response, c.retryAfterMs);
      const failure: Failure = { ...c, status: response.status };
      if (c.code === 'sign_in_required') failure.kind = 'reauth';
      return { ok: false, failure };
    }
    if (write) this.hooks.afterWrite?.(response);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return { ok: false, failure: { kind: 'transient', code: transportCode(error) ?? 'upstream_transport_error' } };
    }
    if (text.length > MAX_SUCCESS_BODY_BYTES) {
      return { ok: false, failure: { kind: 'transient', code: 'upstream_transport_error' } };
    }
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { ok: true, status: response.status, body };
  }

  /** `com.atproto.repo.getRecord` on the owner's own PDS. */
  async getRecord(collection: string, rkey: string): Promise<RecordLookup> {
    const result = await this.query('com.atproto.repo.getRecord', { repo: this.did, collection, rkey });
    if (!result.ok) {
      if (result.failure.kind === 'missing') return { kind: 'absent' };
      return { kind: 'failed', failure: result.failure };
    }
    const body = result.body as { uri?: unknown; cid?: unknown; value?: unknown } | null;
    const expected = `at://${this.did}/${collection}/${rkey}`;
    if (body === null || typeof body !== 'object' || typeof body.cid !== 'string') {
      return { kind: 'failed', failure: { kind: 'transient', code: 'invalid_pds_response' } };
    }
    if (body.uri !== expected) {
      return { kind: 'failed', failure: { kind: 'permanent', code: 'remote_record_identity_mismatch' } };
    }
    return { kind: 'present', uri: expected, cid: body.cid, value: body.value };
  }

  /**
   * One `listRecords` page (100 records, newest rkey first) of a collection in
   * the owner's repo, and the cursor of the next page (null after the last).
   * Callers walk the pages one at a time (`eachListedRecord`), so a large
   * collection is never held in memory.
   */
  async listPage(
    collection: string,
    cursor?: string,
  ): Promise<{ ok: true; records: ListedRecord[]; cursor: string | null } | { ok: false; failure: Failure }> {
    const params: Record<string, string> = { repo: this.did, collection, limit: '100' };
    if (cursor !== undefined) params.cursor = cursor;
    const result = await this.query('com.atproto.repo.listRecords', params);
    if (!result.ok) return { ok: false, failure: result.failure };
    const body = result.body as { records?: unknown; cursor?: unknown } | null;
    if (body === null || typeof body !== 'object' || !Array.isArray(body.records)) {
      return { ok: false, failure: { kind: 'transient', code: 'invalid_pds_response' } };
    }
    const records: ListedRecord[] = [];
    for (const item of body.records as unknown[]) {
      const r = item as { uri?: unknown; cid?: unknown; value?: unknown } | null;
      if (r === null || typeof r !== 'object' || typeof r.uri !== 'string' || typeof r.cid !== 'string') {
        return { ok: false, failure: { kind: 'transient', code: 'invalid_pds_response' } };
      }
      records.push({ uri: r.uri, cid: r.cid, value: r.value });
    }
    const last = typeof body.cursor !== 'string' || body.cursor === '' || records.length === 0;
    if (!last && body.cursor === cursor) {
      // A cursor that does not advance would list the same page forever.
      return { ok: false, failure: { kind: 'transient', code: 'invalid_pds_response' } };
    }
    return { ok: true, records, cursor: last ? null : (body.cursor as string) };
  }
}

/**
 * Pages a listing walks at most: 1,000,000 records, far beyond any follow or
 * love collection, only so that a PDS serving endless cursors cannot hold an
 * attempt forever.
 */
export const MAX_LIST_PAGES = 10_000;

/**
 * Calls `visit` for every record of `collection`, page by page (each page is
 * visited before the next is requested). `visit` returning an outcome stops
 * the walk with it. Null when every record was visited.
 */
export async function eachListedRecord(
  xrpc: PdsXrpc,
  collection: string,
  visit: (record: ListedRecord) => Promise<Outcome | null>,
): Promise<Outcome | null> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const listed = await xrpc.listPage(collection, cursor);
    if (!listed.ok) return failureOutcome(listed.failure);
    for (const record of listed.records) {
      const stop = await visit(record);
      if (stop !== null) return stop;
    }
    if (listed.cursor === null) return null;
    cursor = listed.cursor;
  }
  return { kind: 'permanent', code: 'too_many_records' };
}

/** A record write that ended: what to hint, and what to persist. */
export interface HintTarget {
  collection: string;
  rkey: string;
}

/** What an attempt (or a read-only reconcile) concluded. */
export type Outcome =
  /** Done. `note` is kept as the operation's `error` slug (e.g. `record_not_ours`); `hints` are notified. */
  | { kind: 'succeeded'; uri?: string; cid?: string; hints: HintTarget[]; note?: string; swapCid?: string }
  | { kind: 'transient'; code: string; retryAfterMs?: number; swapCid?: string }
  | { kind: 'permanent'; code: string }
  /** The session needs a new sign-in: the operation becomes `blocked` and the attempt is not counted. */
  | { kind: 'reauth' }
  /**
   * The point budget cannot afford the next write of this attempt now, and
   * nothing of the operation is left unconfirmed: it waits until `untilMs`
   * (the binding window's end) and the attempt is not counted.
   */
  | { kind: 'deferred'; untilMs: number };

/** A classified failure as an outcome (`ambiguous_create`/`missing` must be handled by the caller first). */
export function failureOutcome(failure: Failure): Outcome {
  switch (failure.kind) {
    case 'transient':
      return failure.retryAfterMs !== undefined
        ? { kind: 'transient', code: failure.code, retryAfterMs: failure.retryAfterMs }
        : { kind: 'transient', code: failure.code };
    case 'permanent':
      return { kind: 'permanent', code: failure.code };
    case 'reauth':
      return { kind: 'reauth' };
    default:
      // ambiguous_create / missing reaching here means the caller could not decide.
      return { kind: 'transient', code: 'remote_write_unconfirmed' };
  }
}

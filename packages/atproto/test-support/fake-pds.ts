// A fake atproto PDS: one XRPC handler (Request → Response) per host, backed by
// real SignedRepos. TEST-ONLY.
//
// Reads:  com.atproto.sync.{getRecord,getBlocks,getRepo,getLatestCommit,getRepoStatus},
//         com.atproto.repo.{getRecord,listRecords}
// Writes: com.atproto.repo.{createRecord,putRecord,deleteRecord}, with swapRecord /
//         swapCommit semantics and RecordAlreadyExists / InvalidSwap errors, and
//         com.atproto.repo.applyWrites: atomic (one signed commit or nothing),
//         at most 200 writes. Write bodies over 1,000,000 bytes are 413
//         PayloadTooLarge, as the reference PDS's jsonLimit.
//
// Authentication is per account (ADR 0005 §5.10):
// - `auth: 'fixture'` (the default): a fixture token (`Authorization: Bearer
//   <token>` or `DPoP <token>`, normally `fixtureToken(did)`); DPoP proofs are
//   not validated;
// - `auth: 'dpop'`: only a DPoP-bound access token from the fake AS given to
//   `useAuthorizationServer`, with a valid DPoP proof (ath, htm, htu and this
//   PDS's nonce: 401 `use_dpop_nonce` with `WWW-Authenticate: DPoP` otherwise)
//   and a `repo:` scope covering the collection and action. The fixture token
//   of such an account is refused. With an AS set, GET
//   /.well-known/oauth-protected-resource names it.
//
// Rate limits: a points ledger per DID, as the reference PDS's
// repo-write-hour (5,000) and repo-write-day (35,000) limits, costing create 3,
// update 2, delete 1 (applyWrites: the sum over its writes). Every write
// response carries RateLimit-Limit/-Remaining/-Reset/-Policy of the tightest
// window; a write that takes a window past its limit is 429 RateLimitExceeded.
// Windows start at their first write and reset on the injected clock.
//
// Fault injection (all through this object, never through production code):
// account status (deactivate/takedown/suspend/delete), key rotation, 429 with
// Retry-After, 5xx, redirects, oversize bodies, hangs, a stale head (serving
// an older commit), getBlocks unsupported (501), BlockNotFound after GC, and
// RecordNotFound instead of an exclusion proof. Every call is logged.

import type { Clock } from '@atmusic/core/deps';
import { checkDpopProof, DpopNonceSource, type FakeOAuthAs } from './fake-oauth-as';
import type { TestKey } from './keys';
import {
  CallLog,
  carResponse,
  type Fault,
  type FaultMatch,
  FaultQueue,
  faultName,
  faultResponse,
  nsidOf,
  paramsOf,
  xrpcError,
  xrpcJson,
} from './router-transport';
import {
  type CommitResult,
  cidOf,
  encodeCar,
  type RepoTransaction,
  type SignedRepo,
  tidFromMicros,
  type WriteOp,
} from './signed-repo';

export type AccountStatus = 'active' | 'deactivated' | 'takendown' | 'suspended' | 'deleted';

const STATUS_ERROR: Record<Exclude<AccountStatus, 'active'>, string> = {
  deactivated: 'RepoDeactivated',
  takendown: 'RepoTakendown',
  suspended: 'RepoSuspended',
  deleted: 'RepoNotFound',
};

/** How writes for an account authenticate: a fixture token, or an OAuth DPoP-bound token from the fake AS. */
export type PdsAuthMode = 'fixture' | 'dpop';

export interface PdsAccount {
  repo: SignedRepo;
  handle: string | null;
  /** The fixture token; accepted only when `auth` is 'fixture'. */
  token: string;
  auth: PdsAuthMode;
  status: AccountStatus;
  /** When set, head-view reads serve this older commit (stale PDS). */
  staleHead: string | null;
}

export interface RateLimitSpec {
  name: string;
  points: number;
  windowSec: number;
}

/** The reference PDS write limits (Bluesky's documented values). */
export const PDS_WRITE_LIMITS: readonly RateLimitSpec[] = [
  { name: 'repo-write-hour', points: 5000, windowSec: 3600 },
  { name: 'repo-write-day', points: 35_000, windowSec: 86_400 },
];

/** Points per write action, as the reference PDS. */
export const WRITE_POINTS = { create: 3, update: 2, delete: 1 } as const;

/** The reference PDS's jsonLimit for createRecord, putRecord and applyWrites. */
export const MAX_WRITE_BODY_BYTES = 1_000_000;
export const MAX_APPLY_WRITES = 200;

export interface FakePdsOptions {
  /** Used for createRecord TID rkeys, rate-limit windows and DPoP checks. Defaults to a fixed 2026-01-15T12:00:00Z. */
  clock?: Clock;
  /** The points ledger's windows; `[]` disables rate limiting. Defaults to PDS_WRITE_LIMITS. */
  rateLimits?: readonly RateLimitSpec[];
  /** The AS whose tokens `auth: 'dpop'` accounts accept (also settable with `useAuthorizationServer`). */
  authorizationServer?: FakeOAuthAs;
}

export type CommitListener = (did: string, commit: CommitResult) => void;

const FIXTURE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

class XrpcFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

const fail = (status: number, error: string, message: string, headers?: Record<string, string>): never => {
  throw new XrpcFailure(status, error, message, headers);
};

const APPLY_WRITES = 'com.atproto.repo.applyWrites';
const RKEY_RE = /^[A-Za-z0-9._:~-]{1,512}$/;

const validRkey = (rkey: string) => RKEY_RE.test(rkey) && rkey !== '.' && rkey !== '..';

export type WriteAction = 'create' | 'update' | 'delete';

interface Authn {
  did: string;
  /** Headers every response to this request carries (the PDS DPoP nonce). */
  headers: Record<string, string>;
  /** OAuth scopes; null for a fixture token (no scope checks). */
  scopes: string[] | null;
}

/** Does an atproto `repo` permission in `scopes` cover `action` on `collection`? */
export function repoScopeAllows(scopes: readonly string[], collection: string, action: WriteAction): boolean {
  if (scopes.includes('transition:generic')) return true;
  for (const scope of scopes) {
    const q = scope.indexOf('?');
    const head = q < 0 ? scope : scope.slice(0, q);
    const params = new URLSearchParams(q < 0 ? '' : scope.slice(q + 1));
    let collections: string[];
    if (head === 'repo') collections = params.getAll('collection');
    else if (head.startsWith('repo:')) collections = [decodeURIComponent(head.slice('repo:'.length))];
    else continue;
    const actions = params.getAll('action');
    if (
      (collections.includes('*') || collections.includes(collection)) &&
      (actions.length === 0 || actions.includes(action))
    ) {
      return true;
    }
  }
  return false;
}

function applyWritesAction(type: unknown): WriteAction | null {
  switch (type) {
    case 'com.atproto.repo.applyWrites#create':
      return 'create';
    case 'com.atproto.repo.applyWrites#update':
      return 'update';
    case 'com.atproto.repo.applyWrites#delete':
      return 'delete';
    default:
      return null;
  }
}

/** Ledger points a write request costs (0 when its body is malformed: the handler refuses it). */
function writePoints(nsid: string, body: Record<string, unknown> | null): number {
  if (!body) return 0;
  switch (nsid) {
    case 'com.atproto.repo.createRecord':
      return WRITE_POINTS.create;
    case 'com.atproto.repo.putRecord':
      return WRITE_POINTS.update;
    case 'com.atproto.repo.deleteRecord':
      return WRITE_POINTS.delete;
    default: {
      if (!Array.isArray(body.writes)) return 0;
      let points = 0;
      for (const w of body.writes as unknown[]) {
        const action = applyWritesAction((w as { $type?: unknown } | null)?.$type);
        points += WRITE_POINTS[action ?? 'delete'];
      }
      return points;
    }
  }
}

function nonceSecret(host: string): Uint8Array {
  const seed = new TextEncoder().encode(`fake-pds-dpop-nonce:${host}`);
  return Uint8Array.from({ length: 32 }, (_, i) => (seed[i % seed.length]! ^ (i * 37)) & 0xff);
}

const quoted = (s: string) => s.replace(/["\\]/g, "'");

export function fixtureToken(did: string): string {
  return `fixture-access-token:${did}`;
}

export class FakePds {
  readonly origin: string;
  readonly calls = new CallLog();
  /** Faults returned instead of processing the call. */
  readonly faults = new FaultQueue();
  /** Faults returned after the call was processed (e.g. an ambiguous create: committed, then 500). */
  readonly faultsAfter = new FaultQueue();
  /** false → getBlocks answers 501 MethodNotImplemented. */
  getBlocksSupported = true;
  /** true → getRecord for an absent key answers 400 RecordNotFound instead of an exclusion proof. */
  noExclusionProof = false;

  private readonly accounts = new Map<string, PdsAccount>();
  private readonly listeners: CommitListener[] = [];
  private readonly clock: Clock;
  private lastTidMicros = 0;
  private readonly rateLimits: readonly RateLimitSpec[];
  /** DID → window name → the window's start and the points consumed in it. */
  private readonly ledger = new Map<string, Map<string, { startMs: number; consumed: number }>>();
  private as: FakeOAuthAs | null;
  /** This PDS's own DPoP nonces (a resource server's, separate from the AS's). */
  readonly dpopNonces: DpopNonceSource;
  private readonly dpopJtis = new Set<string>();

  constructor(
    readonly host: string,
    opts: FakePdsOptions = {},
  ) {
    this.origin = `https://${host}`;
    this.clock = opts.clock ?? { nowMs: () => FIXTURE_NOW_MS };
    this.rateLimits = opts.rateLimits ?? PDS_WRITE_LIMITS;
    this.as = opts.authorizationServer ?? null;
    this.dpopNonces = new DpopNonceSource(nonceSecret(host), this.clock);
  }

  // ---- accounts ---------------------------------------------------------

  /**
   * Host `repo` here. An account without a commit gets its initial (empty) commit.
   * `auth: 'dpop'` makes its writes require a DPoP-bound token from the fake AS.
   */
  async addAccount(
    repo: SignedRepo,
    o: { handle?: string | null; token?: string; auth?: PdsAuthMode } = {},
  ): Promise<PdsAccount> {
    if (this.accounts.has(repo.did)) throw new Error(`${repo.did} already on ${this.host}`);
    if (!repo.head) await repo.commit();
    const account: PdsAccount = {
      repo,
      handle: o.handle ?? null,
      token: o.token ?? fixtureToken(repo.did),
      auth: o.auth ?? 'fixture',
      status: 'active',
      staleHead: null,
    };
    this.accounts.set(repo.did, account);
    return account;
  }

  /** Remove an account (e.g. migrated away); its DID then answers RepoNotFound. */
  removeAccount(did: string): void {
    this.accounts.delete(did);
  }

  account(did: string): PdsAccount {
    const a = this.accounts.get(did);
    if (!a) throw new Error(`${did} is not on ${this.host}`);
    return a;
  }

  dids(): string[] {
    return [...this.accounts.keys()];
  }

  /** Accept DPoP-bound tokens from `as` (for `auth: 'dpop'` accounts) and name it as this PDS's authorization server. */
  useAuthorizationServer(as: FakeOAuthAs): void {
    this.as = as;
  }

  /** Points left in the tightest rate-limit window for `did` (Infinity without limits). */
  pointsRemaining(did: string): number {
    const now = this.clock.nowMs();
    let min = Number.POSITIVE_INFINITY;
    for (const spec of this.rateLimits) {
      const w = this.ledger.get(did)?.get(spec.name);
      const consumed = w && now < w.startMs + spec.windowSec * 1000 ? w.consumed : 0;
      min = Math.min(min, Math.max(0, spec.points - consumed));
    }
    return min;
  }

  /** Subscribe to commits made through this PDS's write endpoints. */
  onCommit(listener: CommitListener): void {
    this.listeners.push(listener);
  }

  // ---- fault controls ---------------------------------------------------

  setStatus(did: string, status: AccountStatus): void {
    this.account(did).status = status;
  }
  deactivate(did: string): void {
    this.setStatus(did, 'deactivated');
  }
  takedown(did: string): void {
    this.setStatus(did, 'takendown');
  }
  reactivate(did: string): void {
    this.setStatus(did, 'active');
  }

  /** Serve `commitCid` (an older commit of the repo) as the head: a stale PDS. */
  serveStaleHead(did: string, commitCid: string): void {
    const a = this.account(did);
    a.repo.commitInfo(commitCid);
    a.staleHead = commitCid;
  }
  clearStaleHead(did: string): void {
    this.account(did).staleHead = null;
  }

  /** Garbage-collect the repo: blocks of older heads then answer BlockNotFound. */
  gc(did: string): Promise<string[]> {
    return this.account(did).repo.gc();
  }

  /**
   * Rotate the repo signing key. With `resign` (default) the PDS immediately
   * re-signs the current tree with the new key as a new commit. Runs on the
   * repo's write lock, so a write already in flight is signed by the old key.
   */
  rotateKey(did: string, key: TestKey, o: { resign?: boolean } = {}): Promise<CommitResult | null> {
    return this.account(did).repo.transact(async (tx) => {
      tx.rotateKey(key);
      return o.resign === false ? null : tx.commit();
    });
  }

  /** Inject a fault for the next `times` calls matching `match` (before processing). */
  fail(match: FaultMatch, fault: Fault, times = 1): Fault {
    return this.faults.add(match, fault, times);
  }
  /** 429 with `Retry-After: retryAfter` seconds. */
  rateLimit(nsid: string, retryAfter: number, times = 1, rateLimitReset?: number): Fault {
    return this.fail({ nsid }, { kind: 'status', status: 429, retryAfter, rateLimitReset }, times);
  }
  serverError(nsid: string, status = 500, times = 1): Fault {
    return this.fail({ nsid }, { kind: 'status', status }, times);
  }
  redirect(nsid: string, location: string, times = 1, status: 301 | 302 | 303 | 307 | 308 = 302): Fault {
    return this.fail({ nsid }, { kind: 'redirect', location, status }, times);
  }
  oversize(nsid: string, bytes: number, times = 1): Fault {
    return this.fail({ nsid }, { kind: 'oversize', bytes, contentType: 'application/vnd.ipld.car' }, times);
  }

  /** Total calls, optionally for one XRPC method and/or DID. */
  count(nsid?: string, did?: string): number {
    return this.calls.count({ nsid, did });
  }

  // ---- the handler ------------------------------------------------------

  readonly fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const nsid = nsidOf(url);
    let body: Record<string, unknown> | null = null;
    let bodyBytes = 0;
    if (req.method === 'POST') {
      try {
        const raw = new Uint8Array(await req.arrayBuffer());
        bodyBytes = raw.length;
        const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
        body =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
      } catch {
        body = null;
      }
    }
    const didParam =
      url.searchParams.get('did') ??
      url.searchParams.get('repo') ??
      (typeof body?.repo === 'string' ? (body.repo as string) : null);
    const did = didParam ? (this.resolveRepo(didParam) ?? didParam) : null;
    const log = (status: number, fault: Fault | null) =>
      this.calls.record({
        service: 'pds',
        host: this.host,
        method: req.method,
        path: url.pathname,
        nsid,
        params: paramsOf(url),
        did,
        status,
        fault: fault ? faultName(fault) : null,
      });

    const before = this.faults.take({ nsid, did, path: url.pathname });
    if (before) {
      if (before.kind === 'hang') log(0, before); // the call arrived; it just never answers
      const res = await faultResponse(before, req);
      log(res.status, before);
      return res;
    }
    let res: Response;
    try {
      res = await this.dispatch(req, url, nsid, body, bodyBytes);
    } catch (e) {
      if (!(e instanceof XrpcFailure)) throw e;
      res = xrpcError(e.status, e.error, e.message, e.headers);
    }
    const after = this.faultsAfter.take({ nsid, did, path: url.pathname });
    if (after) {
      const faulted = await faultResponse(after, req);
      log(faulted.status, after);
      return faulted;
    }
    log(res.status, null);
    return res;
  };

  private resolveRepo(id: string): string | null {
    if (this.accounts.has(id)) return id;
    for (const [did, a] of this.accounts) if (a.handle === id) return did;
    return null;
  }

  private async dispatch(
    req: Request,
    url: URL,
    nsid: string | null,
    body: Record<string, unknown> | null,
    bodyBytes: number,
  ) {
    const q = url.searchParams;
    if (nsid === null && this.as && req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      return new Response(
        JSON.stringify({
          resource: this.origin,
          authorization_servers: [this.as.issuer],
          scopes_supported: [],
          bearer_methods_supported: ['header'],
          resource_documentation: 'https://atproto.com',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const GET = req.method === 'GET';
    const POST = req.method === 'POST';
    switch (nsid) {
      case 'com.atproto.sync.getRecord':
        if (GET) return this.syncGetRecord(req0(q, 'did'), req0(q, 'collection'), req0(q, 'rkey'));
        break;
      case 'com.atproto.sync.getBlocks':
        if (GET) return this.syncGetBlocks(req0(q, 'did'), q.getAll('cids'));
        break;
      case 'com.atproto.sync.getRepo':
        if (GET) return this.syncGetRepo(req0(q, 'did'));
        break;
      case 'com.atproto.sync.getLatestCommit':
        if (GET) {
          const a = this.syncAccount(req0(q, 'did'));
          const head = this.head(a);
          return xrpcJson({ cid: head.cid, rev: head.rev });
        }
        break;
      case 'com.atproto.sync.getRepoStatus':
        if (GET) return this.repoStatus(req0(q, 'did'));
        break;
      case 'com.atproto.repo.getRecord':
        if (GET) return this.repoGetRecord(req0(q, 'repo'), req0(q, 'collection'), req0(q, 'rkey'), q.get('cid'));
        break;
      case 'com.atproto.repo.listRecords':
        if (GET) return this.listRecords(q);
        break;
      case 'com.atproto.repo.createRecord':
      case 'com.atproto.repo.putRecord':
      case 'com.atproto.repo.deleteRecord':
      case APPLY_WRITES:
        if (POST) return this.write(nsid, req, body, bodyBytes);
        break;
      default:
        return xrpcError(501, 'MethodNotImplemented', `Method Not Implemented: ${nsid ?? url.pathname}`);
    }
    return xrpcError(405, 'InvalidRequest', `wrong HTTP method ${req.method} for ${nsid}`);
  }

  // ---- reads ------------------------------------------------------------

  private known(did: string): PdsAccount {
    const a = this.accounts.get(this.resolveRepo(did) ?? did);
    if (!a || a.status === 'deleted') return fail(400, 'RepoNotFound', `Could not find repo for DID: ${did}`);
    return a;
  }

  /** An account whose repository may be served (sync and repo reads). */
  private syncAccount(did: string): PdsAccount {
    const a = this.known(did);
    if (a.status !== 'active') fail(400, STATUS_ERROR[a.status], `Repo is ${a.status}: ${a.repo.did}`);
    return a;
  }

  private head(a: PdsAccount) {
    return a.repo.commitInfo(a.staleHead ?? a.repo.head!.cid);
  }

  private repoStatus(did: string): Response {
    const a = this.known(did);
    if (a.status !== 'active') return xrpcJson({ did: a.repo.did, active: false, status: a.status });
    return xrpcJson({ did: a.repo.did, active: true, rev: this.head(a).rev });
  }

  private async syncGetRecord(did: string, collection: string, rkey: string): Promise<Response> {
    const a = this.syncAccount(did);
    const head = this.head(a);
    if (this.noExclusionProof && !(await a.repo.getRecord(collection, rkey, { at: head.cid }))) {
      fail(400, 'RecordNotFound', `Could not locate record: at://${a.repo.did}/${collection}/${rkey}`);
    }
    return carResponse(await a.repo.getRecordCar(collection, rkey, { at: head.cid }));
  }

  private async syncGetBlocks(did: string, cids: string[]): Promise<Response> {
    const a = this.syncAccount(did);
    if (!this.getBlocksSupported) return xrpcError(501, 'MethodNotImplemented', 'Method Not Implemented');
    if (cids.length === 0) fail(400, 'InvalidRequest', 'Error: Params must have the property "cids"');
    const { blocks, missing } = await a.repo.getBlocks(cids);
    if (missing.length > 0) fail(400, 'BlockNotFound', `Could not find cids: ${missing.join(',')}`);
    return carResponse(encodeCar([], blocks));
  }

  private async syncGetRepo(did: string): Promise<Response> {
    const a = this.syncAccount(did);
    return carResponse(await a.repo.fullCar({ at: this.head(a).cid }));
  }

  private async repoGetRecord(repo: string, collection: string, rkey: string, cid: string | null) {
    const a = this.syncAccount(repo);
    const rec = await a.repo.getRecord(collection, rkey, { at: this.head(a).cid });
    if (!rec || (cid !== null && rec.cid !== cid)) {
      fail(400, 'RecordNotFound', `Could not locate record: at://${a.repo.did}/${collection}/${rkey}`);
    }
    return xrpcJson({ uri: `at://${a.repo.did}/${collection}/${rkey}`, cid: rec!.cid, value: rec!.value });
  }

  private async listRecords(q: URLSearchParams): Promise<Response> {
    const a = this.syncAccount(req0(q, 'repo'));
    const collection = req0(q, 'collection');
    const limitRaw = q.get('limit') ?? '50';
    const limit = /^[0-9]+$/.test(limitRaw) ? Number(limitRaw) : Number.NaN;
    if (!(limit >= 1 && limit <= 100)) fail(400, 'InvalidRequest', 'limit must be an integer in 1..100');
    const reverse = q.get('reverse') === 'true';
    const cursor = q.get('cursor');
    // The reference PDS lists newest rkey first unless reverse=true.
    let rows = await a.repo.list(collection, { at: this.head(a).cid });
    if (!reverse) rows = rows.reverse();
    if (cursor !== null) rows = rows.filter((r) => (reverse ? r.rkey > cursor : r.rkey < cursor));
    const page = rows.slice(0, limit);
    const out: Record<string, unknown> = {
      records: page.map((r) => ({ uri: `at://${a.repo.did}/${collection}/${r.rkey}`, cid: r.cid, value: r.value })),
    };
    if (rows.length > limit) out.cursor = page.at(-1)!.rkey;
    return xrpcJson(out);
  }

  // ---- writes -----------------------------------------------------------

  private async authenticate(req: Request): Promise<Authn> {
    const header = req.headers.get('authorization');
    if (!header) return fail(401, 'AuthenticationRequired', 'Authentication Required');
    const m = /^(Bearer|DPoP) (.+)$/.exec(header);
    const scheme = m?.[1];
    const token = m?.[2];
    if (token !== undefined) {
      for (const [did, a] of this.accounts) {
        if (a.auth === 'fixture' && a.token === token) return { did, headers: {}, scopes: null };
      }
      if (scheme === 'DPoP' && this.as) {
        const info = this.as.introspect(token);
        if (info) return this.authenticateDpop(req, token, info);
      }
      for (const [did, a] of this.accounts) {
        if (a.auth === 'dpop' && a.token === token) {
          fail(401, 'InvalidToken', `${did} accepts only DPoP-bound OAuth access tokens`);
        }
      }
    }
    return fail(401, 'InvalidToken', 'Token could not be verified');
  }

  /** An OAuth access token from the fake AS: proof first (with this PDS's nonce), then the token and its binding. */
  private async authenticateDpop(
    req: Request,
    token: string,
    info: NonNullable<ReturnType<FakeOAuthAs['introspect']>>,
  ): Promise<Authn> {
    const nonce = { 'DPoP-Nonce': await this.dpopNonces.next() };
    const wwwAuth = (error: string, description: string) => ({
      ...nonce,
      'WWW-Authenticate': `DPoP error="${error}", error_description="${quoted(description)}"`,
    });
    const proof = await checkDpopProof(req, {
      nowMs: this.clock.nowMs(),
      nonces: this.dpopNonces,
      seenJtis: this.dpopJtis,
      accessToken: token,
    });
    if (!proof.ok) fail(401, proof.error, proof.description, wwwAuth(proof.error, proof.description));
    if (!info.active) {
      const why = info.reason === 'expired' ? 'Token has expired' : `Token is ${info.reason}`;
      fail(401, info.reason === 'expired' ? 'ExpiredToken' : 'InvalidToken', why, wwwAuth('invalid_token', why));
    }
    if (proof.ok && proof.jkt !== info.jkt) {
      const why = 'DPoP proof key does not match the access token binding';
      fail(401, 'InvalidToken', why, wwwAuth('invalid_token', why));
    }
    return { did: info.sub, headers: nonce, scopes: info.scope.split(' ').filter((s) => s !== '') };
  }

  private requireScope(authn: Authn, collection: string, action: WriteAction): void {
    if (authn.scopes === null || repoScopeAllows(authn.scopes, collection, action)) return;
    fail(403, 'ScopeMissingError', `Missing required scope "repo:${collection}?action=${action}"`);
  }

  /** Consume `points` from every window of `did`'s ledger; the headers describe the tightest (or the exceeded) one. */
  private consumePoints(did: string, points: number): { headers: Record<string, string>; exceeded: boolean } {
    if (this.rateLimits.length === 0 || points === 0) return { headers: {}, exceeded: false };
    const now = this.clock.nowMs();
    let windows = this.ledger.get(did);
    if (!windows) {
      windows = new Map();
      this.ledger.set(did, windows);
    }
    let pick: { spec: RateLimitSpec; remaining: number; resetSec: number; exceeded: boolean } | null = null;
    for (const spec of this.rateLimits) {
      let w = windows.get(spec.name);
      if (!w || now >= w.startMs + spec.windowSec * 1000) {
        w = { startMs: now, consumed: 0 };
        windows.set(spec.name, w);
      }
      w.consumed += points;
      const exceeded = w.consumed > spec.points;
      const state = {
        spec,
        remaining: Math.max(0, spec.points - w.consumed),
        resetSec: Math.floor((w.startMs + spec.windowSec * 1000) / 1000),
        exceeded,
      };
      if (!pick || (exceeded && !pick.exceeded) || (exceeded === pick.exceeded && state.remaining < pick.remaining)) {
        pick = state;
      }
    }
    const { spec, remaining, resetSec, exceeded } = pick!;
    return {
      exceeded,
      headers: {
        'RateLimit-Limit': String(spec.points),
        'RateLimit-Remaining': String(remaining),
        'RateLimit-Reset': String(resetSec),
        'RateLimit-Policy': `${spec.points};w=${spec.windowSec}`,
      },
    };
  }

  private nextTid(): string {
    this.lastTidMicros = Math.max(this.clock.nowMs() * 1000, this.lastTidMicros + 1);
    return tidFromMicros(this.lastTidMicros);
  }

  /**
   * The swap/existence checks and the commit run in one `SignedRepo.transact`,
   * on the repo's own write lock. Every writer of the repo (this PDS, direct
   * `repo.put`/`delete`, the kit's external writers, key rotation, gc) shares
   * that one chain, so no commit can land between a check and its write.
   *
   * Order, as the reference PDS: body size (413), authentication (401), the
   * points ledger (429; points are spent even when the handler then refuses
   * the write), then the handler. The ledger is charged inside the repo's
   * write lock, so its clock read is ordered with the repo's other writers
   * exactly as the handler's own (fixture-kit's concurrency test relies on the
   * first clock read of a write happening inside the lock).
   */
  private async write(
    nsid: string,
    req: Request,
    body: Record<string, unknown> | null,
    bodyBytes: number,
  ): Promise<Response> {
    if (bodyBytes > MAX_WRITE_BODY_BYTES) return xrpcError(413, 'PayloadTooLarge', 'request entity too large');
    const authn = await this.authenticate(req);
    const a = this.accounts.get(authn.did);
    if (!a) return fail(400, 'RepoNotFound', `Could not find repo for DID: ${authn.did}`, authn.headers);
    let headers = authn.headers;
    let res: Response;
    try {
      res = await a.repo.transact((tx) => {
        const limit = this.consumePoints(authn.did, writePoints(nsid, body));
        headers = { ...authn.headers, ...limit.headers };
        if (limit.exceeded) return Promise.resolve(xrpcError(429, 'RateLimitExceeded', 'Rate Limit Exceeded'));
        return nsid === APPLY_WRITES
          ? this.applyWritesLocked(authn, a, tx, body)
          : this.writeLocked(nsid, authn, a, tx, body);
      });
    } catch (e) {
      if (!(e instanceof XrpcFailure)) throw e;
      res = xrpcError(e.status, e.error, e.message, e.headers);
    }
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  }

  /** The checks every write handler starts with; returns the body's repo DID. */
  private checkRepo(authed: string, a: PdsAccount, body: Record<string, unknown> | null): Record<string, unknown> {
    if (!body) return fail(400, 'InvalidRequest', 'Request body must be a JSON object');
    const repoId = typeof body.repo === 'string' ? body.repo : fail(400, 'InvalidRequest', 'repo is required');
    const did = this.resolveRepo(repoId);
    if (did !== authed) fail(403, 'Forbidden', 'repo does not belong to the authenticated account');
    if (this.accounts.get(authed) !== a) fail(400, 'RepoNotFound', `Could not find repo for DID: ${authed}`);
    if (a.status !== 'active') fail(400, 'AccountDeactivated', `Account is ${a.status}`);
    return body;
  }

  private async writeLocked(
    nsid: string,
    authn: Authn,
    a: PdsAccount,
    tx: RepoTransaction,
    rawBody: Record<string, unknown> | null,
  ): Promise<Response> {
    const authed = authn.did;
    const body = this.checkRepo(authed, a, rawBody);
    const collection =
      typeof body.collection === 'string' && body.collection.length > 0
        ? body.collection
        : fail(400, 'InvalidRequest', 'collection is required');
    const head = tx.head!;
    if (body.swapCommit !== undefined && body.swapCommit !== head.cid) {
      fail(400, 'InvalidSwap', `Commit was at ${head.cid}`);
    }

    let rkey: string;
    if (nsid === 'com.atproto.repo.createRecord') {
      rkey = body.rkey === undefined ? this.nextTid() : typeof body.rkey === 'string' ? body.rkey : '';
    } else {
      rkey = typeof body.rkey === 'string' ? body.rkey : '';
    }
    if (!validRkey(rkey)) fail(400, 'InvalidRequest', `invalid rkey: ${String(body.rkey)}`);
    const uri = `at://${authed}/${collection}/${rkey}`;
    const current = await tx.getRecord(collection, rkey);

    if (nsid === 'com.atproto.repo.deleteRecord') {
      this.requireScope(authn, collection, 'delete');
      if (body.swapRecord !== undefined && body.swapRecord !== (current?.cid ?? null)) {
        fail(400, 'InvalidSwap', `Record was at ${current?.cid ?? 'null'}`);
      }
      if (!current) return xrpcJson({});
      const result = await tx.delete(collection, rkey);
      this.emit(authed, result);
      return xrpcJson({ commit: { cid: result.cid, rev: result.rev } });
    }

    this.requireScope(authn, collection, current ? 'update' : 'create');
    const record = body.record;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      fail(400, 'InvalidRequest', 'record must be an object');
    }
    const type = (record as { $type?: unknown }).$type;
    if (type !== undefined && type !== collection) {
      fail(400, 'InvalidRequest', `Invalid $type: expected ${collection}, got ${String(type)}`);
    }
    if (nsid === 'com.atproto.repo.createRecord') {
      if (current) fail(400, 'RecordAlreadyExists', `Record already exists: ${uri}`);
    } else if (body.swapRecord !== undefined && body.swapRecord !== (current?.cid ?? null)) {
      fail(400, 'InvalidSwap', `Record was at ${current?.cid ?? 'null'}`);
    }
    const result = await tx.put(collection, rkey, record);
    this.emit(authed, result);
    const cid = result.ops[0]?.cid ?? current!.cid;
    return xrpcJson({ uri, cid, commit: { cid: result.cid, rev: result.rev }, validationStatus: 'unknown' });
  }

  /**
   * com.atproto.repo.applyWrites: every write is validated against the head
   * (and the earlier writes of the batch) before anything is written, then all
   * of them go into one signed commit. Any failure writes nothing. A create
   * whose rkey exists is 400 RecordAlreadyExists (as this fake's createRecord;
   * the reference PDS surfaces the MST error as a 500), an update or delete of
   * an absent record is 400 RecordNotFound.
   */
  private async applyWritesLocked(
    authn: Authn,
    a: PdsAccount,
    tx: RepoTransaction,
    rawBody: Record<string, unknown> | null,
  ): Promise<Response> {
    const authed = authn.did;
    const body = this.checkRepo(authed, a, rawBody);
    const writes = Array.isArray(body.writes)
      ? (body.writes as unknown[])
      : fail(400, 'InvalidRequest', 'writes must be an array');
    if (writes.length > MAX_APPLY_WRITES) fail(400, 'InvalidRequest', `Too many writes. Max: ${MAX_APPLY_WRITES}`);
    const head = tx.head!;
    if (body.swapCommit !== undefined && body.swapCommit !== head.cid) {
      fail(400, 'InvalidSwap', `Commit was at ${head.cid}`);
    }
    /** path → the record CID after the batch's earlier writes (null: absent). */
    const pending = new Map<string, string | null>();
    const ops: WriteOp[] = [];
    const results: Record<string, unknown>[] = [];
    for (const [i, raw] of writes.entries()) {
      const w =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const action = applyWritesAction(w?.$type);
      if (!w || !action) {
        return fail(400, 'InvalidRequest', `Action not supported: writes/${i} has $type ${String(w?.$type)}`);
      }
      const collection =
        typeof w.collection === 'string' && w.collection.length > 0
          ? w.collection
          : fail(400, 'InvalidRequest', `writes/${i}/collection is required`);
      const rkey =
        action === 'create' && w.rkey === undefined ? this.nextTid() : typeof w.rkey === 'string' ? w.rkey : '';
      if (!validRkey(rkey)) fail(400, 'InvalidRequest', `invalid rkey: ${String(w.rkey)}`);
      this.requireScope(authn, collection, action);
      const path = `${collection}/${rkey}`;
      const uri = `at://${authed}/${path}`;
      const current = pending.has(path)
        ? (pending.get(path) ?? null)
        : ((await tx.getRecord(collection, rkey))?.cid ?? null);
      if (action === 'create' && current !== null) fail(400, 'RecordAlreadyExists', `Record already exists: ${uri}`);
      if (action !== 'create' && current === null) fail(400, 'RecordNotFound', `Could not locate record: ${uri}`);
      if (action === 'delete') {
        ops.push({ action: 'delete', collection, rkey });
        pending.set(path, null);
        results.push({ $type: 'com.atproto.repo.applyWrites#deleteResult' });
        continue;
      }
      const value = w.value;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(400, 'InvalidRequest', `writes/${i}/value must be an object`);
      }
      const type = (value as { $type?: unknown }).$type;
      if (type !== undefined && type !== collection) {
        fail(400, 'InvalidRequest', `Invalid $type: expected ${collection}, got ${String(type)}`);
      }
      const cid = cidOf(value);
      ops.push({ action: 'put', collection, rkey, record: value });
      pending.set(path, cid);
      results.push({ $type: `com.atproto.repo.applyWrites#${action}Result`, uri, cid, validationStatus: 'unknown' });
    }
    const result = await tx.writes(ops);
    this.emit(authed, result);
    return xrpcJson({ commit: { cid: result.cid, rev: result.rev }, results });
  }

  private emit(did: string, result: CommitResult): void {
    for (const l of this.listeners) l(did, result);
  }
}

function req0(q: URLSearchParams, name: string): string {
  const v = q.get(name);
  if (v === null || v === '') return fail(400, 'InvalidRequest', `Error: Params must have the property "${name}"`);
  return v;
}

export function fakePds(host: string, opts?: FakePdsOptions): FakePds {
  return new FakePds(host, opts);
}

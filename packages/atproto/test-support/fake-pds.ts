// A fake atproto PDS: one XRPC handler (Request → Response) per host, backed by
// real SignedRepos. TEST-ONLY.
//
// Reads:  com.atproto.sync.{getRecord,getBlocks,getRepo,getLatestCommit,getRepoStatus},
//         com.atproto.repo.{getRecord,listRecords}
// Writes: com.atproto.repo.{createRecord,putRecord,deleteRecord}, with swapRecord /
//         swapCommit semantics and RecordAlreadyExists / InvalidSwap errors.
//
// Authentication is a fixture bearer token per account (`Authorization: Bearer
// <token>` or `DPoP <token>`); DPoP proofs are not validated.
//
// Fault injection (all through this object, never through production code):
// account status (deactivate/takedown/suspend/delete), key rotation, 429 with
// Retry-After, 5xx, redirects, oversize bodies, hangs, a stale head (serving
// an older commit), getBlocks unsupported (501), BlockNotFound after GC, and
// RecordNotFound instead of an exclusion proof. Every call is logged.

import type { Clock } from '@atmusic/core/deps';
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
import { type CommitResult, encodeCar, type SignedRepo, tidFromMicros } from './signed-repo';

export type AccountStatus = 'active' | 'deactivated' | 'takendown' | 'suspended' | 'deleted';

const STATUS_ERROR: Record<Exclude<AccountStatus, 'active'>, string> = {
  deactivated: 'RepoDeactivated',
  takendown: 'RepoTakendown',
  suspended: 'RepoSuspended',
  deleted: 'RepoNotFound',
};

export interface PdsAccount {
  repo: SignedRepo;
  handle: string | null;
  token: string;
  status: AccountStatus;
  /** When set, head-view reads serve this older commit (stale PDS). */
  staleHead: string | null;
}

export interface FakePdsOptions {
  /** Used for createRecord TID rkeys. Defaults to a fixed 2026-01-15T12:00:00Z. */
  clock?: Clock;
}

export type CommitListener = (did: string, commit: CommitResult) => void;

const FIXTURE_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

class XrpcFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    message: string,
  ) {
    super(message);
  }
}

const fail = (status: number, error: string, message: string): never => {
  throw new XrpcFailure(status, error, message);
};

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
  /** Per-DID tail of the write chain: a write's swap/existence check and its commit are atomic. */
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  constructor(
    readonly host: string,
    opts: FakePdsOptions = {},
  ) {
    this.origin = `https://${host}`;
    this.clock = opts.clock ?? { nowMs: () => FIXTURE_NOW_MS };
  }

  // ---- accounts ---------------------------------------------------------

  /** Host `repo` here. An account without a commit gets its initial (empty) commit. */
  async addAccount(repo: SignedRepo, o: { handle?: string | null; token?: string } = {}): Promise<PdsAccount> {
    if (this.accounts.has(repo.did)) throw new Error(`${repo.did} already on ${this.host}`);
    if (!repo.head) await repo.commit();
    const account: PdsAccount = {
      repo,
      handle: o.handle ?? null,
      token: o.token ?? fixtureToken(repo.did),
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
   * re-signs the current tree with the new key as a new commit.
   */
  async rotateKey(did: string, key: TestKey, o: { resign?: boolean } = {}): Promise<CommitResult | null> {
    const repo = this.account(did).repo;
    repo.rotateKey(key);
    return o.resign === false ? null : repo.commit();
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
    if (req.method === 'POST') {
      try {
        const parsed: unknown = JSON.parse(await req.text());
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
      res = await this.dispatch(req, url, nsid, body);
    } catch (e) {
      if (!(e instanceof XrpcFailure)) throw e;
      res = xrpcError(e.status, e.error, e.message);
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

  private async dispatch(req: Request, url: URL, nsid: string | null, body: Record<string, unknown> | null) {
    const q = url.searchParams;
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
        if (POST) return this.write(nsid, req, body);
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

  private authenticate(req: Request): string {
    const header = req.headers.get('authorization');
    if (!header) return fail(401, 'AuthenticationRequired', 'Authentication Required');
    const m = /^(?:Bearer|DPoP) (.+)$/.exec(header);
    const token = m?.[1];
    for (const [did, a] of this.accounts) if (token !== undefined && a.token === token) return did;
    return fail(401, 'InvalidToken', 'Token could not be verified');
  }

  private nextTid(): string {
    this.lastTidMicros = Math.max(this.clock.nowMs() * 1000, this.lastTidMicros + 1);
    return tidFromMicros(this.lastTidMicros);
  }

  /** Run `fn` after every earlier write to `did` through this PDS has settled. */
  private exclusive<T>(did: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.writeLocks.get(did) ?? Promise.resolve()).then(fn);
    this.writeLocks.set(
      did,
      run.catch(() => {}),
    );
    return run;
  }

  private write(nsid: string, req: Request, body: Record<string, unknown> | null): Promise<Response> {
    const authed = this.authenticate(req);
    return this.exclusive(authed, () => this.writeLocked(nsid, authed, body));
  }

  private async writeLocked(nsid: string, authed: string, body: Record<string, unknown> | null): Promise<Response> {
    if (!body) return fail(400, 'InvalidRequest', 'Request body must be a JSON object');
    const repoId = typeof body.repo === 'string' ? body.repo : fail(400, 'InvalidRequest', 'repo is required');
    const did = this.resolveRepo(repoId);
    if (did !== authed) fail(403, 'Forbidden', 'repo does not belong to the authenticated account');
    const a = this.account(authed);
    if (a.status !== 'active') fail(400, 'AccountDeactivated', `Account is ${a.status}`);
    const collection =
      typeof body.collection === 'string' && body.collection.length > 0
        ? body.collection
        : fail(400, 'InvalidRequest', 'collection is required');
    const head = a.repo.head!;
    if (body.swapCommit !== undefined && body.swapCommit !== head.cid) {
      fail(400, 'InvalidSwap', `Commit was at ${head.cid}`);
    }

    let rkey: string;
    if (nsid === 'com.atproto.repo.createRecord') {
      rkey = body.rkey === undefined ? this.nextTid() : typeof body.rkey === 'string' ? body.rkey : '';
    } else {
      rkey = typeof body.rkey === 'string' ? body.rkey : '';
    }
    if (!/^[A-Za-z0-9._:~-]{1,512}$/.test(rkey) || rkey === '.' || rkey === '..') {
      fail(400, 'InvalidRequest', `invalid rkey: ${String(body.rkey)}`);
    }
    const uri = `at://${authed}/${collection}/${rkey}`;
    const current = await a.repo.getRecord(collection, rkey);

    if (nsid === 'com.atproto.repo.deleteRecord') {
      if (body.swapRecord !== undefined && body.swapRecord !== (current?.cid ?? null)) {
        fail(400, 'InvalidSwap', `Record was at ${current?.cid ?? 'null'}`);
      }
      if (!current) return xrpcJson({});
      const result = await a.repo.delete(collection, rkey);
      this.emit(authed, result);
      return xrpcJson({ commit: { cid: result.cid, rev: result.rev } });
    }

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
    const result = await a.repo.put(collection, rkey, record);
    this.emit(authed, result);
    const cid = result.ops[0]?.cid ?? current!.cid;
    return xrpcJson({ uri, cid, commit: { cid: result.cid, rev: result.rev }, validationStatus: 'unknown' });
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

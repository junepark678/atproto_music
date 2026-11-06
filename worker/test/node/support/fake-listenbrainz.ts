// A fake ListenBrainz API (ADR 0005 §15.2, N1-13). TEST-ONLY.
//
// It plays the upstream that imports (§11, `listenbrainz_api`), linking
// (§12.1) and forwarding (§12.3) talk to. It is a routerTransport endpoint
// (`routerTransport({hosts: {'listenbrainz.test': fake}})`) and can also be
// served on a local HTTP listener for the e2e stacks (`serveFake` from
// ./fake-lastfm). Time comes only from the injected clock.
//
// Implemented under /1/:
//
//   GET  /1/validate-token                     header `Token|token|Bearer <t>` or ?token=
//   POST /1/submit-listens                     token; single | import | playing_now; bodies recorded
//   GET  /1/user/{user}/listens                count (default 25, cap 1000), max_ts / min_ts (exclusive)
//   POST /1/feedback/recording-feedback        token; recorded
//
// Every response carries X-RateLimit-Limit, -Remaining, -Reset, -Reset-In and
// Access-Control-Expose-Headers from a fixed window per token (or per anonymous
// caller). Scripted faults answer 401, 429 (with the rate-limit headers) or 503.

import { createHash } from 'node:crypto';
import { CallLog, type Routable } from '@atmusic/atproto/test-support/router-transport';
import type { Clock } from '@atmusic/core/deps';

export const LISTENBRAINZ_HOST = 'listenbrainz.test';

export const LB_MESSAGES = {
  missingHeader: 'You need to provide an Authorization header.',
  invalidHeader: 'Provided Authorization header is invalid.',
  invalidToken: 'Invalid authorization token.',
  noToken: 'You need to provide an Authorization token.',
  rateLimited:
    'You have exceeded your rate limit. See the X-RateLimit-* response headers for more information on your current rate limit.',
  unavailable: 'Cannot submit listens to queue, please try again later.',
  maxMin: 'max_ts should be greater than min_ts',
} as const;

const RATE_LIMIT_HEADERS = ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-RateLimit-Reset-In'];

export interface LbTrackMetadata {
  artist_name: string;
  track_name: string;
  release_name?: string;
  additional_info?: Record<string, unknown>;
}

export interface LbListen {
  /** UNIX seconds. */
  listened_at: number;
  track_metadata: LbTrackMetadata;
  /** UNIX seconds; defaults to `listened_at`. */
  inserted_at?: number;
  recording_msid?: string;
}

export interface LbSubmission {
  user: string;
  token: string;
  /** The Authorization scheme exactly as sent (`Token`, `token`, `Bearer`, …). */
  scheme: string;
  listenType: string;
  /** The raw request body. */
  body: string;
  /** The parsed body. */
  json: unknown;
}

export interface LbFeedback {
  user: string;
  token: string;
  json: unknown;
}

export type LbFault =
  | { status: 401; path?: string }
  | { status: 429; resetIn?: number; path?: string }
  | { status: 503; path?: string; error?: string };

export interface FakeListenBrainzOptions {
  clock: Clock;
  host?: string;
  /** Requests per window per token (or per anonymous caller). Default 100. */
  rateLimit?: number;
  /** Window length in seconds. Default 10. */
  rateWindowS?: number;
}

interface UserState {
  name: string;
  listens: Required<LbListen>[];
  playingNow: LbTrackMetadata | null;
}

interface Bucket {
  windowEndS: number;
  used: number;
}

/** A stable UUID-shaped MSID for test listens (md5 of the metadata). */
export function fakeMsid(artist: string, track: string): string {
  const h = createHash('md5').update(`${artist}\u0000${track}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

class LbError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Auth = { token: string; scheme: string; user: string };

export class FakeListenBrainz implements Routable {
  readonly host: string;
  readonly calls = new CallLog();
  /** Every accepted submit-listens request, in order. */
  readonly submissions: LbSubmission[] = [];
  readonly feedback: LbFeedback[] = [];

  private readonly clock: Clock;
  private readonly rateLimit: number;
  private readonly rateWindowS: number;
  private readonly users = new Map<string, UserState>();
  private readonly tokens = new Map<string, string>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly faults: LbFault[] = [];

  constructor(opts: FakeListenBrainzOptions) {
    this.clock = opts.clock;
    this.host = opts.host ?? LISTENBRAINZ_HOST;
    this.rateLimit = opts.rateLimit ?? 100;
    this.rateWindowS = opts.rateWindowS ?? 10;
  }

  // -- setup ----------------------------------------------------------------

  addUser(name: string): void {
    if (!this.users.has(name.toLowerCase())) {
      this.users.set(name.toLowerCase(), { name, listens: [], playingNow: null });
    }
  }

  /** Register a user token. */
  addToken(user: string, token: string): void {
    this.addUser(user);
    this.tokens.set(token, this.state(user)!.name);
  }

  /** Revoke a token (the user reset it): later calls with it get 401. */
  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  seedListens(user: string, listens: readonly LbListen[]): void {
    this.addUser(user);
    this.state(user)!.listens.push(...listens.map((l) => this.complete(l)));
  }

  /** The user's listens, newest first. */
  listens(user: string): Required<LbListen>[] {
    return this.sorted(this.state(user));
  }

  playingNow(user: string): LbTrackMetadata | null {
    return this.state(user)?.playingNow ?? null;
  }

  /** Queue faults; each answers the next request (to `path`, when given). */
  fail(...faults: LbFault[]): void {
    this.faults.push(...faults);
  }

  get pendingFaults(): number {
    return this.faults.length;
  }

  // -- transport ------------------------------------------------------------

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const nowS = Math.floor(this.clock.nowMs() / 1000);
    const header = req.headers.get('authorization');
    const auth = this.authOf(header);
    const bucket = this.take(auth.ok ? `token:${auth.value.token}` : 'anonymous', nowS);
    const i = this.faults.findIndex((f) => f.path === undefined || f.path === url.pathname);
    const fault = i >= 0 ? this.faults.splice(i, 1)[0]! : null;

    let res: Response;
    let faultName: string | null = null;
    if (fault) {
      faultName = `status:${fault.status}`;
      if (fault.status === 401) res = this.error(401, LB_MESSAGES.invalidToken, bucket, nowS);
      else if (fault.status === 503) res = this.error(503, fault.error ?? LB_MESSAGES.unavailable, bucket, nowS);
      else {
        const resetIn = fault.resetIn ?? bucket.windowEndS - nowS;
        res = this.error(429, LB_MESSAGES.rateLimited, { windowEndS: nowS + resetIn, used: this.rateLimit }, nowS);
      }
    } else if (bucket.used > this.rateLimit) {
      res = this.error(429, LB_MESSAGES.rateLimited, bucket, nowS);
    } else {
      try {
        res = this.json(await this.route(req, url, header, auth, nowS), 200, bucket, nowS);
      } catch (e) {
        if (!(e instanceof LbError)) throw e;
        res = this.error(e.status, e.message, bucket, nowS);
      }
    }
    this.calls.record({
      service: 'listenbrainz',
      host: url.hostname,
      method: req.method,
      path: url.pathname,
      nsid: null,
      params: Object.fromEntries([...url.searchParams.keys()].map((k) => [k, url.searchParams.getAll(k)])),
      did: null,
      status: res.status,
      fault: faultName,
    });
    return res;
  }

  // -- routing --------------------------------------------------------------

  private async route(
    req: Request,
    url: URL,
    header: string | null,
    auth: ReturnType<FakeListenBrainz['authOf']>,
    nowS: number,
  ): Promise<unknown> {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/1/validate-token') return this.validateToken(url, header);
    if (req.method === 'POST' && path === '/1/submit-listens') {
      return this.submitListens(this.require(auth), await req.text(), nowS);
    }
    if (req.method === 'POST' && path === '/1/feedback/recording-feedback') {
      const a = this.require(auth);
      const json = this.parseJson(await req.text());
      this.feedback.push({ user: a.user, token: a.token, json });
      return { status: 'ok' };
    }
    const m = /^\/1\/user\/([^/]+)\/listens$/.exec(path);
    if (req.method === 'GET' && m) return this.getListens(decodeURIComponent(m[1]!), url);
    throw new LbError(404, 'Not found');
  }

  private validateToken(url: URL, header: string | null): unknown {
    let token: string | null = null;
    if (header !== null && /^token /i.test(header)) token = header.slice('token '.length).trim();
    else token = url.searchParams.get('token');
    if (!token) throw new LbError(400, LB_MESSAGES.noToken);
    const user = this.tokens.get(token);
    if (user === undefined) return { code: 200, message: 'Token invalid.', valid: false };
    return { code: 200, message: 'Token valid.', valid: true, user_name: user };
  }

  private submitListens(auth: Auth, body: string, nowS: number): unknown {
    const doc = this.parseJson(body);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new LbError(400, 'Invalid JSON document submitted.');
    }
    const { listen_type: listenType, payload } = doc as { listen_type?: unknown; payload?: unknown };
    if (!Array.isArray(payload)) throw new LbError(400, 'The payload needs to be a list of listens.');
    if (payload.length === 0) throw new LbError(400, 'Payload is empty.');
    if (listenType !== 'single' && listenType !== 'import' && listenType !== 'playing_now') {
      throw new LbError(400, 'Invalid listen_type in JSON document.');
    }
    if (listenType !== 'import' && payload.length > 1) {
      throw new LbError(400, 'JSON document should contain exactly one listen for single and playing_now.');
    }
    const listens = payload.map((p): LbListen => {
      const item = p as { listened_at?: unknown; track_metadata?: Partial<LbTrackMetadata> };
      const meta = item?.track_metadata;
      if (!meta || typeof meta.artist_name !== 'string' || typeof meta.track_name !== 'string') {
        throw new LbError(400, 'Invalid JSON document submitted.');
      }
      if (listenType === 'playing_now') return { listened_at: 0, track_metadata: meta as LbTrackMetadata };
      if (typeof item.listened_at !== 'number' || !Number.isFinite(item.listened_at)) {
        throw new LbError(400, 'Invalid JSON document submitted.');
      }
      return { listened_at: Math.floor(item.listened_at), track_metadata: meta as LbTrackMetadata, inserted_at: nowS };
    });
    const state = this.state(auth.user)!;
    if (listenType === 'playing_now') state.playingNow = listens[0]!.track_metadata;
    else state.listens.push(...listens.map((l) => this.complete(l)));
    this.submissions.push({ user: auth.user, token: auth.token, scheme: auth.scheme, listenType, body, json: doc });
    return { status: 'ok' };
  }

  private getListens(name: string, url: URL): unknown {
    const state = this.state(name);
    if (!state) throw new LbError(404, `Cannot find user: ${name}`);
    const int = (key: string): number | null => {
      const v = url.searchParams.get(key);
      if (v === null) return null;
      if (!/^-?\d{1,15}$/.test(v)) throw new LbError(400, `Invalid value for ${key}`);
      return Number(v);
    };
    const count = int('count') ?? 25;
    if (count < 0) throw new LbError(400, 'Number of items requested should be positive');
    const maxTs = int('max_ts');
    const minTs = int('min_ts');
    if (maxTs !== null && minTs !== null && maxTs <= minTs) throw new LbError(400, LB_MESSAGES.maxMin);
    const capped = Math.min(count, 1000);
    const all = this.sorted(state);
    const bounded = all.filter(
      (l) => (maxTs === null || l.listened_at < maxTs) && (minTs === null || l.listened_at > minTs),
    );
    // With min_ts only: the oldest `count` after it, returned newest first.
    const page = maxTs === null && minTs !== null ? bounded.slice(-capped) : bounded.slice(0, capped);
    return {
      payload: {
        count: page.length,
        listens: page.map((l) => ({
          listened_at: l.listened_at,
          inserted_at: l.inserted_at,
          recording_msid: l.recording_msid,
          user_name: state.name,
          track_metadata: l.track_metadata,
        })),
        latest_listen_ts: all[0]?.listened_at ?? 0,
        oldest_listen_ts: all.at(-1)?.listened_at ?? 0,
        user_id: name,
      },
    };
  }

  // -- helpers --------------------------------------------------------------

  private authOf(header: string | null): { ok: true; value: Auth } | { ok: false; message: string } {
    if (header === null) return { ok: false, message: LB_MESSAGES.missingHeader };
    const space = header.indexOf(' ');
    if (space < 0) return { ok: false, message: LB_MESSAGES.invalidHeader };
    const scheme = header.slice(0, space);
    const token = header.slice(space + 1).trim();
    if (!/^(token|bearer)$/i.test(scheme)) return { ok: false, message: LB_MESSAGES.invalidHeader };
    const user = this.tokens.get(token);
    if (user === undefined) return { ok: false, message: LB_MESSAGES.invalidToken };
    return { ok: true, value: { token, scheme, user } };
  }

  private require(auth: ReturnType<FakeListenBrainz['authOf']>): Auth {
    if (!auth.ok) throw new LbError(401, auth.message);
    return auth.value;
  }

  private parseJson(body: string): unknown {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new LbError(400, 'Cannot parse JSON document.');
    }
  }

  /** Count one request against the caller's fixed window. */
  private take(key: string, nowS: number): Bucket {
    let b = this.buckets.get(key);
    if (!b || nowS >= b.windowEndS) {
      b = { windowEndS: nowS + this.rateWindowS, used: 0 };
      this.buckets.set(key, b);
    }
    b.used += 1;
    return b;
  }

  private rateHeaders(bucket: Bucket, nowS: number): Record<string, string> {
    return {
      'X-RateLimit-Limit': String(this.rateLimit),
      'X-RateLimit-Remaining': String(Math.max(0, this.rateLimit - bucket.used)),
      'X-RateLimit-Reset': String(bucket.windowEndS),
      'X-RateLimit-Reset-In': String(Math.max(0, bucket.windowEndS - nowS)),
      'Access-Control-Expose-Headers': RATE_LIMIT_HEADERS.join(', '),
    };
  }

  private json(body: unknown, status: number, bucket: Bucket, nowS: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...this.rateHeaders(bucket, nowS) },
    });
  }

  private error(status: number, error: string, bucket: Bucket, nowS: number): Response {
    return this.json({ code: status, error }, status, bucket, nowS);
  }

  private state(name: string): UserState | undefined {
    return this.users.get(name.toLowerCase());
  }

  private complete(l: LbListen): Required<LbListen> {
    return {
      listened_at: l.listened_at,
      track_metadata: l.track_metadata,
      inserted_at: l.inserted_at ?? l.listened_at,
      recording_msid: l.recording_msid ?? fakeMsid(l.track_metadata.artist_name, l.track_metadata.track_name),
    };
  }

  private sorted(state: UserState | undefined): Required<LbListen>[] {
    if (!state) return [];
    return state.listens
      .map((l, i) => [l, i] as const)
      .sort(([a, ai], [b, bi]) => b.listened_at - a.listened_at || bi - ai)
      .map(([l]) => l);
  }
}

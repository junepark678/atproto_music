// The fixture network (ADR 0004 §10.2 "No network"). TEST-ONLY.
//
// `routerTransport({...})` is a Transport (packages/atproto/src/transport.ts)
// that maps reserved fixture hostnames to in-memory fakes. It is marked
// `fixture: true`, which is the only thing that lets SafeFetch's URL policy
// accept `.test` hosts; the policy itself stays on. An unrouted host rejects
// like a failed DNS lookup, so a test can never reach the real network.
//
// Redirects are never followed here: a fake's 3xx is returned as is, exactly
// as `fetch(req, {redirect: 'manual'})` would.
//
// This module also holds the helpers every fake shares: the call log (so
// tests can count remote calls), the fault queue (429/5xx/redirect/oversize/
// hang injection) and XRPC response builders.

import type { Transport } from '../src/transport';

// ---------------------------------------------------------------------------
// Call log
// ---------------------------------------------------------------------------

export interface FixtureCall {
  /** Which fake answered: `pds`, `plc`, `doh`, `relay`, `jetstream`, `handle`, `host` or `router`. */
  service: string;
  host: string;
  method: string;
  path: string;
  /** XRPC method id for `/xrpc/<nsid>` paths, else null. */
  nsid: string | null;
  params: Record<string, string[]>;
  /** The DID the call concerns (`did`/`repo` param or body), when known. */
  did: string | null;
  status: number;
  /** Name of the injected fault that produced the response, if any. */
  fault: string | null;
}

export type CallFilter = Partial<Pick<FixtureCall, 'service' | 'host' | 'method' | 'nsid' | 'did' | 'status' | 'path'>>;

export class CallLog {
  readonly entries: FixtureCall[] = [];

  record(call: FixtureCall): void {
    this.entries.push(call);
  }

  /** Calls matching every given field. */
  filter(f: CallFilter = {}): FixtureCall[] {
    return this.entries.filter((c) =>
      (Object.keys(f) as Array<keyof CallFilter>).every((k) => f[k] === undefined || c[k] === f[k]),
    );
  }

  count(f: CallFilter = {}): number {
    return this.filter(f).length;
  }

  reset(): void {
    this.entries.length = 0;
  }
}

export function paramsOf(url: URL): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of url.searchParams) {
    const list = out[k] ?? [];
    list.push(v);
    out[k] = list;
  }
  return out;
}

export function nsidOf(url: URL): string | null {
  return url.pathname.startsWith('/xrpc/') ? url.pathname.slice('/xrpc/'.length) || null : null;
}

// ---------------------------------------------------------------------------
// Faults
// ---------------------------------------------------------------------------

export type Fault =
  /** An XRPC error (`{error, message}`) with optional Retry-After / RateLimit-Reset headers. */
  | {
      kind: 'status';
      status: number;
      error?: string;
      message?: string;
      /** Seconds (number) or an HTTP date (string). */
      retryAfter?: number | string;
      /** RateLimit-Reset, epoch seconds. */
      rateLimitReset?: number;
      headers?: Record<string, string>;
    }
  /** A 3xx with a Location header (never followed by the router). */
  | { kind: 'redirect'; location: string; status?: 301 | 302 | 303 | 307 | 308 }
  /** A 200 whose body streams `bytes` zero bytes lazily; `emitted` counts what was actually pulled. */
  | { kind: 'oversize'; bytes: number; contentType?: string; emitted?: number }
  /** Never answers; rejects with the request signal's reason when it aborts. */
  | { kind: 'hang' }
  /** Anything else. */
  | { kind: 'respond'; respond(req: Request): Response | Promise<Response> };

export interface FaultMatch {
  nsid?: string;
  did?: string;
  path?: string;
}

interface FaultRule {
  match: FaultMatch;
  fault: Fault;
  remaining: number;
}

/** Ordered fault rules; the first rule that matches a call is consumed. */
export class FaultQueue {
  private readonly rules: FaultRule[] = [];

  /** Inject `fault` for the next `times` matching calls (`Infinity` = until cleared). */
  add(match: FaultMatch, fault: Fault, times = 1): Fault {
    if (!(times >= 1)) throw new RangeError('times must be >= 1');
    this.rules.push({ match, fault, remaining: times });
    return fault;
  }

  take(call: { nsid: string | null; did: string | null; path: string }): Fault | null {
    const i = this.rules.findIndex(
      (r) =>
        (r.match.nsid === undefined || r.match.nsid === call.nsid) &&
        (r.match.did === undefined || r.match.did === call.did) &&
        (r.match.path === undefined || r.match.path === call.path),
    );
    if (i < 0) return null;
    const rule = this.rules[i]!;
    rule.remaining -= 1;
    if (rule.remaining <= 0) this.rules.splice(i, 1);
    return rule.fault;
  }

  get pending(): number {
    return this.rules.length;
  }

  clear(): void {
    this.rules.length = 0;
  }
}

const OVERSIZE_CHUNK = 64 * 1024;

export function faultName(f: Fault): string {
  return f.kind === 'status' ? `status:${f.status}` : f.kind;
}

export function faultResponse(f: Fault, req: Request): Promise<Response> {
  switch (f.kind) {
    case 'status': {
      const headers: Record<string, string> = { ...f.headers };
      if (f.retryAfter !== undefined) headers['retry-after'] = String(f.retryAfter);
      if (f.rateLimitReset !== undefined) headers['ratelimit-reset'] = String(f.rateLimitReset);
      const error =
        f.error ??
        (f.status === 429 ? 'RateLimitExceeded' : f.status >= 500 ? 'InternalServerError' : 'InvalidRequest');
      return Promise.resolve(xrpcError(f.status, error, f.message ?? `fixture fault ${f.status}`, headers));
    }
    case 'redirect':
      return Promise.resolve(new Response(null, { status: f.status ?? 302, headers: { location: f.location } }));
    case 'oversize': {
      f.emitted = 0;
      let left = f.bytes;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (left <= 0) {
            controller.close();
            return;
          }
          const n = Math.min(OVERSIZE_CHUNK, left);
          left -= n;
          f.emitted = (f.emitted ?? 0) + n;
          controller.enqueue(new Uint8Array(n));
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': f.contentType ?? 'application/octet-stream' } }),
      );
    }
    case 'hang':
      return new Promise<Response>((_, reject) => {
        const signal = req.signal;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    case 'respond':
      return Promise.resolve(f.respond(req));
  }
}

// ---------------------------------------------------------------------------
// XRPC response helpers
// ---------------------------------------------------------------------------

export function xrpcJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function xrpcError(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return xrpcJson({ error, message }, status, headers);
}

export const CAR_CONTENT_TYPE = 'application/vnd.ipld.car';

export function carResponse(bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': CAR_CONTENT_TYPE } });
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export type Handler = (req: Request) => Response | Promise<Response>;

export interface Routable {
  fetch(req: Request): Response | Promise<Response>;
}

export interface HostedRoutable extends Routable {
  readonly host: string;
}

export type Endpoint = Handler | Routable;

/** The fake PLC: plc.directory plus any did:web hosts it holds documents for. */
export interface PlcRoutable extends HostedRoutable {
  servesWebHost(host: string): boolean;
}

export interface RouterConfig {
  /** PDS host → fake (or a list of fakes that know their own host). */
  pds?: Record<string, Endpoint> | readonly HostedRoutable[];
  plc?: PlcRoutable;
  doh?: HostedRoutable;
  relay?: HostedRoutable | readonly HostedRoutable[];
  jetstream?: HostedRoutable | readonly HostedRoutable[];
  /** handle → DID, served as text at `https://<handle>/.well-known/atproto-did`. Mutable maps stay live. */
  handles?: Map<string, string> | Record<string, string>;
  /** Any other host → handler. Checked first. */
  hosts?: Record<string, Endpoint>;
}

export type FixtureTransport = Transport & {
  /** SafeFetch accepts fixture TLDs only for a transport carrying this mark. */
  readonly fixture: true;
  /** Every request that reached the router, routed or not. */
  readonly calls: CallLog;
  /** Hosts this router answers for. */
  hostnames(): string[];
};

function asHandler(e: Endpoint): Handler {
  return typeof e === 'function' ? e : (req) => e.fetch(req);
}

function list<T>(v: T | readonly T[] | undefined): readonly T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? (v as readonly T[]) : [v as T];
}

export function routerTransport(cfg: RouterConfig): FixtureTransport {
  const routes = new Map<string, { service: string; handler: Handler }>();
  const add = (host: string, service: string, e: Endpoint) => {
    const h = host.toLowerCase();
    if (routes.has(h)) throw new Error(`fixture host ${h} routed twice`);
    routes.set(h, { service, handler: asHandler(e) });
  };
  for (const [host, e] of Object.entries(cfg.hosts ?? {})) add(host, 'host', e);
  if (Array.isArray(cfg.pds)) for (const p of cfg.pds as readonly HostedRoutable[]) add(p.host, 'pds', p);
  else for (const [host, e] of Object.entries((cfg.pds ?? {}) as Record<string, Endpoint>)) add(host, 'pds', e);
  if (cfg.plc) add(cfg.plc.host, 'plc', cfg.plc);
  if (cfg.doh) add(cfg.doh.host, 'doh', cfg.doh);
  for (const r of list(cfg.relay)) add(r.host, 'relay', r);
  for (const j of list(cfg.jetstream)) add(j.host, 'jetstream', j);

  const handleDid = (host: string): string | undefined => {
    const h = cfg.handles;
    if (!h) return undefined;
    return h instanceof Map ? h.get(host) : Object.hasOwn(h, host) ? h[host] : undefined;
  };

  const calls = new CallLog();
  const transport = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();
    const log = (service: string, status: number) =>
      calls.record({
        service,
        host,
        method: req.method,
        path: url.pathname,
        nsid: nsidOf(url),
        params: paramsOf(url),
        did: url.searchParams.get('did') ?? url.searchParams.get('repo'),
        status,
        fault: null,
      });

    const route = routes.get(host);
    if (route) {
      let res: Response;
      try {
        res = await route.handler(req);
      } catch (e) {
        log(route.service, 0); // aborted or failed: logged with status 0, then rethrown
        throw e;
      }
      log(route.service, res.status);
      return res;
    }
    if (url.pathname === '/.well-known/did.json' && cfg.plc?.servesWebHost(host)) {
      const res = await cfg.plc.fetch(req);
      log('plc', res.status);
      return res;
    }
    if (url.pathname === '/.well-known/atproto-did') {
      const did = handleDid(host);
      if (did !== undefined) {
        log('handle', 200);
        return new Response(did, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
    }
    log('router', 0);
    throw new TypeError(`fixture network: no route to host ${host}`);
  };
  return Object.assign(transport, {
    fixture: true as const,
    calls,
    hostnames: () => [...routes.keys()],
  });
}

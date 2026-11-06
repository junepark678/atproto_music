// A fake relay serving com.atproto.sync.listReposByCollection with cursor
// paging (DIDs in ascending order; the cursor is the last DID returned).
// TEST-ONLY. Every call is logged; faults use the shared FaultQueue.

import {
  CallLog,
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

export const RELAY_HOST = 'relay.example.test';
export const LIST_REPOS_BY_COLLECTION = 'com.atproto.sync.listReposByCollection';

export class FakeRelay {
  readonly calls = new CallLog();
  readonly faults = new FaultQueue();
  /** Default and maximum page sizes of the reference relay. */
  defaultLimit = 500;
  maxLimit = 2000;
  private readonly byCollection = new Map<string, Set<string>>();

  constructor(readonly host = RELAY_HOST) {}

  add(collection: string, ...dids: string[]): void {
    let set = this.byCollection.get(collection);
    if (!set) {
      set = new Set();
      this.byCollection.set(collection, set);
    }
    for (const d of dids) set.add(d);
  }

  remove(collection: string, did: string): void {
    this.byCollection.get(collection)?.delete(did);
  }

  repos(collection: string): string[] {
    return [...(this.byCollection.get(collection) ?? [])].sort();
  }

  fail(match: FaultMatch, fault: Fault, times = 1): Fault {
    return this.faults.add(match, fault, times);
  }

  count(collection?: string): number {
    return this.calls.entries.filter((c) => collection === undefined || c.params.collection?.[0] === collection).length;
  }

  readonly fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const nsid = nsidOf(url);
    const log = (status: number, fault: Fault | null) =>
      this.calls.record({
        service: 'relay',
        host: this.host,
        method: req.method,
        path: url.pathname,
        nsid,
        params: paramsOf(url),
        did: null,
        status,
        fault: fault ? faultName(fault) : null,
      });
    const fault = this.faults.take({ nsid, did: null, path: url.pathname });
    if (fault) {
      if (fault.kind === 'hang') log(0, fault); // the call arrived; it just never answers
      const res = await faultResponse(fault, req);
      log(res.status, fault);
      return res;
    }
    const res = this.handle(req, url, nsid);
    log(res.status, null);
    return res;
  };

  private handle(req: Request, url: URL, nsid: string | null): Response {
    if (nsid !== LIST_REPOS_BY_COLLECTION) {
      return xrpcError(501, 'MethodNotImplemented', `Method Not Implemented: ${nsid ?? url.pathname}`);
    }
    if (req.method !== 'GET') return xrpcError(405, 'InvalidRequest', 'GET only');
    const collection = url.searchParams.get('collection');
    if (!collection) return xrpcError(400, 'InvalidRequest', 'Error: Params must have the property "collection"');
    const limitRaw = url.searchParams.get('limit') ?? String(this.defaultLimit);
    const limit = /^[0-9]+$/.test(limitRaw) ? Number(limitRaw) : Number.NaN;
    if (!(limit >= 1 && limit <= this.maxLimit)) {
      return xrpcError(400, 'InvalidRequest', `limit must be an integer in 1..${this.maxLimit}`);
    }
    const cursor = url.searchParams.get('cursor');
    const all = this.repos(collection).filter((d) => cursor === null || d > cursor);
    const page = all.slice(0, limit);
    const body: Record<string, unknown> = { repos: page.map((did) => ({ did })) };
    if (all.length > limit) body.cursor = page.at(-1);
    return xrpcJson(body);
  }
}

export function fakeRelay(host?: string): FakeRelay {
  return new FakeRelay(host);
}

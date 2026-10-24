// A fake DNS-over-HTTPS JSON resolver (https://cloudflare-dns.com/dns-query,
// `accept: application/dns-json`). TEST-ONLY.
//
// By default every name resolves to deterministic, globally routable public
// addresses (A in 104.16.0.0/13, AAAA in 2606:4700::/32), so the production
// SafeFetch DoH pre-check passes for fixture hosts. The RFC 5737 / RFC 3849
// TEST-NET ranges are documentation space, which the policy must reject (ADR
// 0004 §8), so they are only ever served through explicit injection, like
// private, loopback or link-local answers.

import {
  CallLog,
  type Fault,
  type FaultMatch,
  FaultQueue,
  faultName,
  faultResponse,
  paramsOf,
} from './router-transport';

export const DOH_HOST = 'cloudflare-dns.com';

export type RecordType = 'A' | 'AAAA' | 'TXT';

const TYPE_CODE: Record<RecordType, number> = { A: 1, AAAA: 28, TXT: 16 };
const CODE_TYPE = new Map<number, RecordType>([
  [1, 'A'],
  [28, 'AAAA'],
  [16, 'TXT'],
]);

interface Override {
  values: string[];
  ttl: number;
}

function norm(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The default public A answer for `name`. */
export function defaultA(name: string): string {
  const h = fnv1a(norm(name));
  return `104.${16 + (h & 7)}.${(h >>> 3) & 0xff}.${1 + ((h >>> 11) % 254)}`;
}

/** The default public AAAA answer for `name`. */
export function defaultAAAA(name: string): string {
  const h = fnv1a(`v6:${norm(name)}`);
  return `2606:4700:${(h & 0xffff).toString(16)}::${(1 + ((h >>> 16) % 0xfffe)).toString(16)}`;
}

export class FakeDoh {
  readonly host = DOH_HOST;
  readonly calls = new CallLog();
  readonly faults = new FaultQueue();
  /** TTL for default answers. */
  defaultTtl = 300;
  private readonly overrides = new Map<string, Override>();
  private readonly nx = new Set<string>();

  private key(name: string, type: RecordType) {
    return `${norm(name)}|${type}`;
  }

  /** Replace the answer set for `name`/`type` (an empty list gives NOERROR with no answers). */
  setAnswers(name: string, type: RecordType, values: string[], ttl = this.defaultTtl): void {
    this.nx.delete(norm(name));
    this.overrides.set(this.key(name, type), { values: [...values], ttl });
  }

  /** Add a private (or any injected) address to the default answers: a mixed answer set. */
  injectAddress(name: string, address: string, ttl = this.defaultTtl): void {
    const type: RecordType = address.includes(':') ? 'AAAA' : 'A';
    const cur = this.answers(name, type);
    this.setAnswers(name, type, [...cur.values, address], ttl);
  }

  /** Answer only `addresses` (e.g. `['10.0.0.1']` or `['::1']`) for `name`, both families. */
  setPrivate(name: string, addresses: string[], ttl = this.defaultTtl): void {
    this.setAnswers(
      name,
      'A',
      addresses.filter((a) => !a.includes(':')),
      ttl,
    );
    this.setAnswers(
      name,
      'AAAA',
      addresses.filter((a) => a.includes(':')),
      ttl,
    );
  }

  setTxt(name: string, values: string[], ttl = this.defaultTtl): void {
    this.setAnswers(name, 'TXT', values, ttl);
  }

  /** NXDOMAIN (Status 3, no answers) for every type of `name`. */
  nxdomain(name: string): void {
    this.nx.add(norm(name));
  }

  clear(name: string): void {
    this.nx.delete(norm(name));
    for (const t of Object.keys(TYPE_CODE) as RecordType[]) this.overrides.delete(this.key(name, t));
  }

  fail(match: FaultMatch, fault: Fault, times = 1): Fault {
    return this.faults.add(match, fault, times);
  }

  /** Calls for `name` (any type when `type` is omitted). */
  count(name?: string, type?: RecordType): number {
    return this.calls.entries.filter(
      (c) =>
        (name === undefined || norm(c.params.name?.[0] ?? '') === norm(name)) &&
        (type === undefined || c.params.type?.[0] === type || c.params.type?.[0] === String(TYPE_CODE[type])),
    ).length;
  }

  answers(name: string, type: RecordType): Override {
    const o = this.overrides.get(this.key(name, type));
    if (o) return o;
    if (type === 'A') return { values: [defaultA(name)], ttl: this.defaultTtl };
    if (type === 'AAAA') return { values: [defaultAAAA(name)], ttl: this.defaultTtl };
    return { values: [], ttl: this.defaultTtl };
  }

  readonly fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const log = (status: number, fault: Fault | null) =>
      this.calls.record({
        service: 'doh',
        host: url.hostname,
        method: req.method,
        path: url.pathname,
        nsid: null,
        params: paramsOf(url),
        did: null,
        status,
        fault: fault ? faultName(fault) : null,
      });
    const fault = this.faults.take({ nsid: null, did: null, path: url.searchParams.get('name') ?? '' });
    if (fault) {
      if (fault.kind === 'hang') log(0, fault); // the call arrived; it just never answers
      const res = await faultResponse(fault, req);
      log(res.status, fault);
      return res;
    }
    const name = url.searchParams.get('name');
    const rawType = url.searchParams.get('type') ?? 'A';
    const type: RecordType | undefined = /^[0-9]+$/.test(rawType)
      ? CODE_TYPE.get(Number(rawType))
      : (Object.keys(TYPE_CODE) as RecordType[]).find((t) => t === rawType.toUpperCase());
    if (req.method !== 'GET' || url.pathname !== '/dns-query' || !name || !type) {
      log(400, null);
      return new Response(JSON.stringify({ error: 'Invalid query' }), { status: 400 });
    }
    const qname = norm(name);
    const code = TYPE_CODE[type];
    const isNx = this.nx.has(qname);
    const set = isNx ? { values: [], ttl: 0 } : this.answers(qname, type);
    const body: Record<string, unknown> = {
      Status: isNx ? 3 : 0,
      TC: false,
      RD: true,
      RA: true,
      AD: false,
      CD: false,
      Question: [{ name: `${qname}.`, type: code }],
    };
    if (set.values.length > 0) {
      body.Answer = set.values.map((v) => ({
        name: `${qname}.`,
        type: code,
        TTL: set.ttl,
        data: type === 'TXT' ? JSON.stringify(v) : v,
      }));
    }
    log(200, null);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/dns-json' } });
  };
}

export function fakeDoh(): FakeDoh {
  return new FakeDoh();
}

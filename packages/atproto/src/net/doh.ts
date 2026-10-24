// DoH A/AAAA pre-check (ADR 0004 §8, amendment A5).
//
// Before SafeFetch contacts a hostname it asks Cloudflare's JSON DoH endpoint
// for the host's A and AAAA records, through the same injected Transport, and
// refuses the destination when there are no answers or when ANY answer is not
// a public unicast address. Workers `fetch` then resolves the name again on
// its own, so this narrows but cannot close the rebinding window (documented
// residual, live-probed by W6-05). Results are cached per host for
// min(TTL, 300 s) against the injected Clock.
//
// The DoH endpoint is a pinned constant; it is the one host exempt from the
// pre-check (checking it would recurse).

import type { Clock } from '@atmusic/core/deps';
import type { Transport } from '../transport';
import { raceDeadline, readCapped, SafeFetchError } from './body';
import { isAllowedAddress, isFixtureTransport } from './url-policy';

export const DOH_HOST = 'cloudflare-dns.com';
export const DOH_ENDPOINT = `https://${DOH_HOST}/dns-query`;
export const DOH_ACCEPT = 'application/dns-json';
/** Upper bound on how long a positive pre-check result is reused. */
export const DOH_MAX_CACHE_SECONDS = 300;
/** A dns-json answer set is tiny; anything larger is hostile. */
export const DOH_MAX_BYTES = 65_536;
export const DOH_DEADLINE_MS = 10_000;

export const RR_A = 1;
export const RR_CNAME = 5;
export const RR_TXT = 16;
export const RR_AAAA = 28;

export interface DohAnswer {
  name: string;
  type: number;
  ttl: number;
  data: string;
}

export interface DohOptions {
  /** Deadline for the lookup; defaults to AbortSignal.timeout(10 s). */
  signal?: AbortSignal;
}

interface CacheEntry {
  addresses: readonly string[];
  expiresAtMs: number;
}

// One cache per Transport, so independent fixture networks never share answers.
const caches = new WeakMap<Transport, Map<string, CacheEntry>>();

function cacheFor(transport: Transport): Map<string, CacheEntry> {
  let cache = caches.get(transport);
  if (!cache) {
    cache = new Map();
    caches.set(transport, cache);
  }
  return cache;
}

function dnsFailed(reason: string, message?: string): SafeFetchError {
  return new SafeFetchError('dns_failed', message ?? `DoH lookup failed: ${reason}`, { reason });
}

function blocked(reason: string, message: string): SafeFetchError {
  return new SafeFetchError('blocked_destination', message, { reason });
}

/**
 * One dns-json query against the pinned endpoint. Returns the answer section
 * (empty for NOERROR/NODATA and NXDOMAIN); other DNS statuses are `dns_failed`.
 */
export async function queryDoh(
  name: string,
  type: number,
  transport: Transport,
  options: DohOptions = {},
): Promise<DohAnswer[]> {
  const signal = options.signal ?? AbortSignal.timeout(DOH_DEADLINE_MS);
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  const request = new Request(url, { headers: { accept: DOH_ACCEPT }, redirect: 'manual', signal });

  let response: Response;
  try {
    response = await raceDeadline(transport(request), signal);
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    throw dnsFailed('transport', `DoH request failed: ${String(error)}`);
  }
  if (response.status !== 200) {
    if (response.body) response.body.cancel().catch(() => {});
    throw dnsFailed(`http_${response.status}`);
  }
  // A failure reading the DoH body is a failed lookup, never a property of the
  // target: only the deadline keeps its own code.
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(response, DOH_MAX_BYTES, signal);
  } catch (error) {
    if (error instanceof SafeFetchError && error.code === 'timeout') throw error;
    if (error instanceof SafeFetchError && error.code === 'body_too_large') {
      throw dnsFailed('doh_body_too_large', `DoH response exceeds ${DOH_MAX_BYTES} bytes`);
    }
    throw dnsFailed('doh_body', `DoH response body failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw dnsFailed('malformed_json');
  }
  if (typeof doc !== 'object' || doc === null) throw dnsFailed('malformed_json');
  const { Status, Answer } = doc as { Status?: unknown; Answer?: unknown };
  if (Status === 3) return []; // NXDOMAIN: no answers
  if (Status !== 0) throw dnsFailed(`rcode_${String(Status)}`);
  if (Answer === undefined) return [];
  if (!Array.isArray(Answer)) throw dnsFailed('malformed_answer');

  const answers: DohAnswer[] = [];
  for (const raw of Answer) {
    if (typeof raw !== 'object' || raw === null) throw dnsFailed('malformed_answer');
    const rr = raw as { name?: unknown; type?: unknown; TTL?: unknown; data?: unknown };
    if (typeof rr.type !== 'number' || typeof rr.data !== 'string') throw dnsFailed('malformed_answer');
    const ttl = typeof rr.TTL === 'number' && Number.isSafeInteger(rr.TTL) && rr.TTL > 0 ? rr.TTL : 0;
    answers.push({ name: typeof rr.name === 'string' ? rr.name : '', type: rr.type, ttl, data: rr.data });
  }
  return answers;
}

/**
 * Resolve `host` through DoH and return its addresses only when every A/AAAA
 * answer is public. Throws `blocked_destination` on an empty or non-public
 * answer set, `dns_failed` when the lookup itself fails. The DoH host is
 * returned as-is (pinned and exempt).
 */
export async function resolvePublic(
  host: string,
  transport: Transport,
  clock: Clock,
  options: DohOptions = {},
): Promise<readonly string[]> {
  const name = host.toLowerCase();
  if (name === DOH_HOST) return [];

  const cache = cacheFor(transport);
  const now = clock.nowMs();
  const hit = cache.get(name);
  if (hit && now < hit.expiresAtMs) return hit.addresses;
  if (hit) cache.delete(name);

  const signal = options.signal ?? AbortSignal.timeout(DOH_DEADLINE_MS);
  const [a, aaaa] = await Promise.all([
    queryDoh(name, RR_A, transport, { signal }),
    queryDoh(name, RR_AAAA, transport, { signal }),
  ]);

  const fixture = isFixtureTransport(transport);
  const addresses: string[] = [];
  let ttl = DOH_MAX_CACHE_SECONDS;
  for (const rr of [...a, ...aaaa]) {
    if (rr.type !== RR_A && rr.type !== RR_AAAA && rr.type !== RR_CNAME) continue;
    ttl = Math.min(ttl, rr.ttl);
    if (rr.type === RR_CNAME) continue;
    if (!isAllowedAddress(rr.data, { fixture })) {
      throw blocked('private_answer', `${name} resolves to a non-public address`);
    }
    addresses.push(rr.data);
  }
  if (addresses.length === 0) throw blocked('no_answers', `${name} has no A/AAAA answers`);

  if (ttl > 0) cache.set(name, { addresses, expiresAtMs: clock.nowMs() + ttl * 1000 });
  return addresses;
}

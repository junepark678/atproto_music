// Outbound URL and host policy (ADR 0004 §8, amendment A5).
//
// Workers `fetch` resolves DNS itself, so we cannot pin addresses. Instead the
// destination must be an https URL on the default port, without credentials
// or a fragment, naming a public DNS hostname (never an IP literal, never a
// local/reserved name). The DoH pre-check in doh.ts then rejects hostnames
// that resolve to non-public addresses; the address classification for that
// check lives here too so there is one definition of "public".
//
// Fixture mode (a Transport marked `fixture: true`, test-support only) admits
// the reserved fixture TLDs `.test` and `.example` and the documentation
// address ranges the fixture DoH answers with. Nothing else is relaxed.

import type { Transport } from '../transport';
import { SafeFetchError } from './body';

/** A Transport that routes to in-memory fixtures. Only test-support creates one. */
export type FixtureTransport = Transport & { readonly fixture: true };

export function isFixtureTransport(transport: Transport): transport is FixtureTransport {
  return (transport as Partial<FixtureTransport>).fixture === true;
}

export interface UrlPolicyOptions {
  /** True only for a fixture transport; admits `.test` / `.example` hosts. */
  fixture?: boolean;
}

export type UrlCheck = { ok: true; url: URL; host: string } | { ok: false; reason: string };

/** TLDs that never resolve publicly (RFC 6761, RFC 6762, RFC 7686, RFC 9476, ICANN .internal). */
const RESERVED_TLDS: ReadonlySet<string> = new Set([
  'alt',
  'arpa',
  'example',
  'internal',
  'invalid',
  'local',
  'localhost',
  'onion',
  'test',
]);

/** Reserved TLDs the fixture transport serves (TESTING.md handles are `*.test`). */
const FIXTURE_TLDS: ReadonlySet<string> = new Set(['test', 'example']);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Check `input` against the policy. Never throws; see `assertUrl` for the
 * throwing form used by SafeFetch.
 */
export function checkUrl(input: string | URL, options: UrlPolicyOptions = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(typeof input === 'string' ? input : input.href);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  // WHATWG URL drops an explicit default port, so any remaining port is non-default.
  if (url.port !== '') return { ok: false, reason: 'non_default_port' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  // `hash` is empty for a bare trailing '#', but the serialisation keeps it.
  if (url.hash !== '' || url.href.includes('#')) return { ok: false, reason: 'fragment' };

  const host = url.hostname;
  if (host === '') return { ok: false, reason: 'no_host' };
  // The URL parser canonicalises decimal (2130706433), octal (0177.0.0.1), hex
  // (0x7f.1) and short (127.1) IPv4 forms to a dotted quad, and IPv6 (including
  // ::ffff:a.b.c.d mapped forms) to a bracketed literal; both are refused.
  if (host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'ip_literal' };
  if (DOTTED_QUAD.test(host) || parseIpv4(host) !== null) return { ok: false, reason: 'ip_literal' };
  if (host.endsWith('.')) return { ok: false, reason: 'trailing_dot' };
  if (host.length > 253) return { ok: false, reason: 'host_too_long' };

  const labels = host.split('.');
  if (labels[labels.length - 1] === 'localhost') return { ok: false, reason: 'localhost' };
  if (labels.length < 2) return { ok: false, reason: 'single_label' };
  if (!labels.every((label) => LABEL.test(label))) return { ok: false, reason: 'bad_label' };
  const tld = labels[labels.length - 1] as string;
  if (/^\d+$/.test(tld)) return { ok: false, reason: 'ip_literal' };
  if (RESERVED_TLDS.has(tld) && !(options.fixture === true && FIXTURE_TLDS.has(tld))) {
    return { ok: false, reason: 'reserved_tld' };
  }
  return { ok: true, url, host };
}

/** `checkUrl`, throwing `blocked_destination` on refusal. */
export function assertUrl(input: string | URL, options: UrlPolicyOptions = {}): { url: URL; host: string } {
  const result = checkUrl(input, options);
  if (!result.ok) {
    throw new SafeFetchError('blocked_destination', `destination refused: ${result.reason}`, {
      reason: result.reason,
    });
  }
  return { url: result.url, host: result.host };
}

// ---------------------------------------------------------------------------
// Address parsing and classification (strict textual forms, as DoH returns).

/** Strict dotted-decimal IPv4 (no leading zeros, no short forms) → 4 octets. */
export function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i] as string;
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

/** RFC 4291 textual IPv6 (with optional trailing dotted IPv4) → 8 groups. */
export function parseIpv6(text: string): Uint16Array | null {
  if (text.length === 0 || text.length > 45 || text.includes('%')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string, allowV4Tail: boolean): number[] | null => {
    if (side === '') return [];
    const groups = side.split(':');
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] as string;
      if (allowV4Tail && i === groups.length - 1 && g.includes('.')) {
        const v4 = parseIpv4(g);
        if (!v4) return null;
        out.push(((v4[0] as number) << 8) | (v4[1] as number), ((v4[2] as number) << 8) | (v4[3] as number));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const compressed = halves.length === 2;
  const head = parseSide(halves[0] as string, !compressed);
  const tail = compressed ? parseSide(halves[1] as string, true) : [];
  if (!head || !tail) return null;
  const present = head.length + tail.length;
  if (compressed ? present > 7 : present !== 8) return null;
  const groups = new Uint16Array(8);
  groups.set(head, 0);
  groups.set(tail, 8 - tail.length);
  return groups;
}

export type AddressClass = 'public' | 'documentation' | 'blocked';

/**
 * Port of the Rust oracle's `public_v4` (crates/atproto/src/http/safe_client.rs),
 * with the documentation ranges reported separately so fixture mode can admit them.
 */
export function classifyIpv4(o: Uint8Array): AddressClass {
  const a = o[0] as number;
  const b = o[1] as number;
  const c = o[2] as number;
  if (
    a === 0 || // 0.0.0.0/8 "this network", including 0.0.0.0
    a === 10 || // RFC 1918
    a === 127 || // loopback
    a >= 224 || // multicast 224/4, reserved 240/4, broadcast
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local, including 169.254.169.254 metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 168) || // RFC 1918
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments 192.0.0/24
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) // benchmarking 198.18/15
  ) {
    return 'blocked';
  }
  if (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return 'documentation'; // TEST-NET-1/2/3
  }
  return 'public';
}

/** Port of the Rust oracle's `public_v6`: only 2000::/3 global unicast, minus special ranges. */
export function classifyIpv6(s: Uint16Array): AddressClass {
  const s0 = s[0] as number;
  const s1 = s[1] as number;
  // IPv4-mapped ::ffff:a.b.c.d is judged by its IPv4 address.
  if (s0 === 0 && s1 === 0 && s[2] === 0 && s[3] === 0 && s[4] === 0 && s[5] === 0xffff) {
    const v4 = new Uint8Array([
      (s[6] as number) >> 8,
      (s[6] as number) & 0xff,
      (s[7] as number) >> 8,
      (s[7] as number) & 0xff,
    ]);
    return classifyIpv4(v4);
  }
  // Everything outside 2000::/3 (::, ::1, fc00::/7 ULA, fe80::/10, ff00::/8, NAT64, IPv4-compatible) is blocked.
  if ((s0 & 0xe000) !== 0x2000) return 'blocked';
  if (s0 === 0x2001 && s1 === 0x0db8) return 'documentation'; // 2001:db8::/32
  if (s0 === 0x3fff && s1 <= 0x0fff) return 'documentation'; // 3fff::/20 (RFC 9637)
  if (s0 === 0x2001 && s1 <= 0x01ff) return 'blocked'; // 2001::/23 IETF protocol assignments (Teredo, ORCHID…)
  if (s0 === 0x2002) return 'blocked'; // 6to4
  return 'public';
}

/** Classify a textual address; unparseable text is `blocked` (fail closed). */
export function classifyAddress(text: string): AddressClass {
  const v4 = parseIpv4(text);
  if (v4) return classifyIpv4(v4);
  const v6 = parseIpv6(text);
  if (v6) return classifyIpv6(v6);
  return 'blocked';
}

/** True when `text` is an address SafeFetch may reach (documentation ranges only in fixture mode). */
export function isAllowedAddress(text: string, options: UrlPolicyOptions = {}): boolean {
  const cls = classifyAddress(text);
  return cls === 'public' || (cls === 'documentation' && options.fixture === true);
}

// The trusted client address of a request on the Node host (ADR 0005 §3.6,
// §13, §14.6; N1-06), and the key the per-IP rate buckets use.
//
// The rule, ported from the Rust oracle `client_ip`
// (crates/server/src/http/limits.rs:138-191):
// - the socket peer is the answer unless the peer is in ATMUSIC_TRUSTED_PROXIES
//   (default `127.0.0.0/8,::1`);
// - from a trusted peer, only the header named by ATMUSIC_CLIENT_IP_HEADER is
//   read, and every other client-IP header is ignored, so a client-supplied
//   `CF-Connecting-IP` relayed by a same-host Caddy or nginx never counts unless
//   the operator chose `cf-connecting-ip` (exposure option A, a tunnel whose
//   edge overwrites the header);
//   - `cf-connecting-ip` and `x-real-ip`: the header must hold exactly one IP
//     literal (a repeated header, which Headers joins with ", ", does not);
//   - `x-forwarded-for`: at most 16 IP literals; the **rightmost untrusted**
//     entry wins, never the leftmost, which the client controls; when every
//     entry is a trusted proxy the first one is used (as the oracle does);
//   - `none`: the peer, always;
// - anything malformed (an unparsable entry, more than 16 entries, a value over
//   1,024 bytes, a zone id, a port) falls back to the peer.
//
// The oracle additionally required `X-Forwarded-Proto: https` and an
// `X-Forwarded-Host` equal to the public host before reading the chain. ADR
// 0005 §3.6 instead names exactly one header per mode and never reads Host or
// X-Forwarded-* for a security decision (§13), and cloudflared sets no
// X-Forwarded-Host, so those two checks are not ported.
//
// The mode has no default: a default fails open under some exposure option
// (§3.6), so `createClientIpPolicy` refuses a missing or unknown mode and
// N1-07 makes ATMUSIC_CLIENT_IP_HEADER a required variable.
//
// Addresses are compared and returned in canonical form: IPv4 dotted quads and
// RFC 5952 IPv6 text, with IPv4-mapped IPv6 (`::ffff:a.b.c.d`, the form a
// dual-stack socket reports for an IPv4 peer) read as the IPv4 address.
//
// `rateKeyOf(ip)` is the IPv4 address itself, or the /64 prefix of an IPv6
// address (`2001:db8:1:2::/64`): one IPv6 host normally controls a whole /64
// and would otherwise mint 2^64 fresh buckets.

/** The values of ATMUSIC_CLIENT_IP_HEADER (ADR 0005 §3.6). */
export const CLIENT_IP_MODES = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'none'] as const;
export type ClientIpMode = (typeof CLIENT_IP_MODES)[number];

/** ATMUSIC_TRUSTED_PROXIES when it is unset (ADR 0005 §3.8). */
export const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,::1';

/** The oracle's bounds on a forwarded chain. */
export const MAX_FORWARDED_ENTRIES = 16;
export const MAX_CLIENT_IP_HEADER_BYTES = 1024;

/** The address used when the socket reports no peer (as the oracle's 0.0.0.0). */
export const UNKNOWN_PEER = '0.0.0.0';

/** A parsed address: 4 bytes for IPv4, 16 for IPv6. */
export interface IpAddress {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
}

export interface Cidr {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

/** The only part of a request's headers the resolver touches. */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface ClientIpPolicy {
  readonly mode: ClientIpMode;
  readonly trustedProxies: readonly Cidr[];
}

export class ClientIpConfigError extends Error {
  override readonly name = 'ClientIpConfigError';
  constructor(
    readonly variable: 'ATMUSIC_CLIENT_IP_HEADER' | 'ATMUSIC_TRUSTED_PROXIES',
    message: string,
  ) {
    super(`${variable}: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Parsing and formatting

const DECIMAL_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;
const HEXTET = /^[0-9A-Fa-f]{1,4}$/;

function parseIpv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i] as string;
    // No leading zeros, as Rust's Ipv4Addr::from_str: `010` is not octal 8.
    if (!DECIMAL_OCTET.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out[i] = value;
  }
  return out;
}

function parseIpv6(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > 45) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): string[] | null => {
    if (part === '') return [];
    const list = part.split(':');
    return list.some((g) => g === '') ? null : list;
  };
  const head = groups(halves[0] as string);
  const tail = halves.length === 2 ? groups(halves[1] as string) : [];
  if (head === null || tail === null) return null;

  const words: number[] = [];
  const pushGroups = (list: string[], allowV4Last: boolean): boolean => {
    for (let i = 0; i < list.length; i++) {
      const g = list[i] as string;
      if (allowV4Last && i === list.length - 1 && g.includes('.')) {
        const v4 = parseIpv4(g);
        if (v4 === null) return false;
        words.push(((v4[0] as number) << 8) | (v4[1] as number), ((v4[2] as number) << 8) | (v4[3] as number));
        continue;
      }
      if (!HEXTET.test(g)) return false;
      words.push(Number.parseInt(g, 16));
    }
    return true;
  };

  const headWords: number[] = [];
  const tailWords: number[] = [];
  // An embedded IPv4 is allowed only in the last group of the whole address.
  if (!pushGroups(head, halves.length === 1)) return null;
  headWords.push(...words.splice(0));
  if (!pushGroups(tail, true)) return null;
  tailWords.push(...words.splice(0));

  let all: number[];
  if (halves.length === 1) {
    if (headWords.length !== 8) return null;
    all = headWords;
  } else {
    const missing = 8 - headWords.length - tailWords.length;
    if (missing < 1) return null;
    all = [...headWords, ...new Array<number>(missing).fill(0), ...tailWords];
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[2 * i] = (all[i] as number) >> 8;
    out[2 * i + 1] = (all[i] as number) & 0xff;
  }
  return out;
}

function isV4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * An IP literal, or null. No zone ids, ports, brackets or surrounding space.
 * IPv4-mapped IPv6 is returned as the IPv4 address.
 */
export function parseIp(text: string): IpAddress | null {
  if (text.includes(':')) {
    const bytes = parseIpv6(text);
    if (bytes === null) return null;
    if (isV4Mapped(bytes)) return { family: 4, bytes: bytes.slice(12) };
    return { family: 6, bytes };
  }
  const bytes = parseIpv4(text);
  return bytes === null ? null : { family: 4, bytes };
}

/** Canonical text: a dotted quad, or RFC 5952 IPv6 (lowercase, longest zero run compressed). */
export function formatIp(ip: IpAddress): string {
  const b = ip.bytes;
  if (ip.family === 4) return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  const words: number[] = [];
  for (let i = 0; i < 8; i++) words.push(((b[2 * i] as number) << 8) | (b[2 * i + 1] as number));
  // The longest run of two or more zero words; the first one on a tie.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (ws: number[]) => ws.map((w) => w.toString(16)).join(':');
  if (bestLen < 2) return hex(words);
  return `${hex(words.slice(0, bestStart))}::${hex(words.slice(bestStart + bestLen))}`;
}

/** The canonical text of an IP literal, or null. */
export function canonicalIp(text: string): string | null {
  const ip = parseIp(text);
  return ip === null ? null : formatIp(ip);
}

function maskBytes(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = bytes.slice();
  for (let i = 0; i < out.length; i++) {
    const bits = Math.max(0, Math.min(8, prefix - 8 * i));
    out[i] = (out[i] as number) & ((0xff << (8 - bits)) & 0xff);
  }
  return out;
}

/** `a.b.c.d/n`, `x::y/n`, or a bare address (a /32 or /128). Host bits are cleared. */
export function parseCidr(text: string): Cidr | null {
  const slash = text.indexOf('/');
  const addr = parseIp(slash === -1 ? text : text.slice(0, slash));
  if (addr === null) return null;
  const max = addr.family === 4 ? 32 : 128;
  let prefix = max;
  if (slash !== -1) {
    const p = text.slice(slash + 1);
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(p)) return null;
    prefix = Number(p);
    // An IPv4-mapped IPv6 network is written over 128 bits; read it over the IPv4 bits.
    if (addr.family === 4 && text.slice(0, slash).includes(':')) prefix -= 96;
    if (prefix < 0 || prefix > max) return null;
  }
  return { family: addr.family, bytes: maskBytes(addr.bytes, prefix), prefix };
}

export function cidrContains(cidr: Cidr, ip: IpAddress): boolean {
  if (cidr.family !== ip.family) return false;
  const masked = maskBytes(ip.bytes, cidr.prefix);
  for (let i = 0; i < masked.length; i++) if (masked[i] !== cidr.bytes[i]) return false;
  return true;
}

/**
 * ATMUSIC_TRUSTED_PROXIES: comma-separated CIDRs or addresses. An empty value
 * trusts no peer. A malformed entry is a ClientIpConfigError naming it.
 */
export function parseTrustedProxies(text: string = DEFAULT_TRUSTED_PROXIES): Cidr[] {
  if (text.trim() === '') return [];
  return text.split(',').map((raw) => {
    const entry = raw.trim();
    const cidr = parseCidr(entry);
    if (cidr === null)
      throw new ClientIpConfigError('ATMUSIC_TRUSTED_PROXIES', `invalid CIDR ${JSON.stringify(entry)}`);
    return cidr;
  });
}

export function isClientIpMode(value: unknown): value is ClientIpMode {
  return typeof value === 'string' && (CLIENT_IP_MODES as readonly string[]).includes(value);
}

/**
 * Validates a mode and trusted-proxy list. There is no default mode: an
 * absent or unknown one is a ClientIpConfigError naming ATMUSIC_CLIENT_IP_HEADER.
 */
export function createClientIpPolicy(options: {
  mode: ClientIpMode | string | undefined;
  trustedProxies?: string | readonly Cidr[];
}): ClientIpPolicy {
  const { mode } = options;
  if (!isClientIpMode(mode)) {
    throw new ClientIpConfigError(
      'ATMUSIC_CLIENT_IP_HEADER',
      mode === undefined || mode === ''
        ? `required; one of ${CLIENT_IP_MODES.join(', ')}`
        : `must be one of ${CLIENT_IP_MODES.join(', ')}`,
    );
  }
  const trusted = options.trustedProxies;
  const trustedProxies =
    trusted === undefined || typeof trusted === 'string' ? parseTrustedProxies(trusted) : [...trusted];
  return Object.freeze({ mode, trustedProxies: Object.freeze(trustedProxies) });
}

// ---------------------------------------------------------------------------
// The rule

function isTrusted(policy: ClientIpPolicy, ip: IpAddress): boolean {
  return policy.trustedProxies.some((cidr) => cidrContains(cidr, ip));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A header that must hold exactly one IP literal. */
function singleAddress(value: string | null): IpAddress | null {
  if (value === null || byteLength(value) > MAX_CLIENT_IP_HEADER_BYTES) return null;
  return parseIp(value.trim());
}

/** The rightmost untrusted entry of an X-Forwarded-For chain (module comment). */
function forwardedFor(policy: ClientIpPolicy, value: string | null): IpAddress | null {
  if (value === null || byteLength(value) > MAX_CLIENT_IP_HEADER_BYTES) return null;
  const parsed: IpAddress[] = [];
  for (const entry of value.split(',')) {
    if (parsed.length === MAX_FORWARDED_ENTRIES) return null;
    const ip = parseIp(entry.trim());
    if (ip === null) return null;
    parsed.push(ip);
  }
  for (let i = parsed.length - 1; i >= 0; i--) {
    const ip = parsed[i] as IpAddress;
    if (!isTrusted(policy, ip)) return ip;
  }
  return parsed[0] ?? null;
}

/**
 * The client address of a request whose TCP peer is `peer`, in canonical form.
 * Reads at most one header: the one `policy.mode` names, and only from a
 * trusted peer.
 */
export function resolveClientIp(policy: ClientIpPolicy, peer: string | undefined, headers: HeaderReader): string {
  const peerIp = peer === undefined ? null : parseIp(peer);
  if (peerIp === null) return UNKNOWN_PEER;
  const peerText = formatIp(peerIp);
  if (policy.mode === 'none' || !isTrusted(policy, peerIp)) return peerText;

  let found: IpAddress | null;
  switch (policy.mode) {
    case 'cf-connecting-ip':
      found = singleAddress(headers.get('cf-connecting-ip'));
      break;
    case 'x-real-ip':
      found = singleAddress(headers.get('x-real-ip'));
      break;
    case 'x-forwarded-for':
      found = forwardedFor(policy, headers.get('x-forwarded-for'));
      break;
  }
  return found === null ? peerText : formatIp(found);
}

/**
 * The per-IP rate-limit key (ADR 0005 §3.6, §8.7, §13): the IPv4 address, or
 * the /64 prefix of an IPv6 address as `<prefix>::/64`. A value that is not an
 * IP literal (never produced by `resolveClientIp`) is its own key.
 */
export function rateKeyOf(ip: string): string {
  const parsed = parseIp(ip);
  if (parsed === null) return ip;
  if (parsed.family === 4) return formatIp(parsed);
  return `${formatIp({ family: 6, bytes: maskBytes(parsed.bytes, 64) })}/64`;
}

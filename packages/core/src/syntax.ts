// AT Protocol identifier syntax (https://atproto.com/specs/did, /handle, /nsid,
// /at-uri-scheme, /tid, /record-key). Pure syntax only: none of these checks
// resolve an identity, prove control of a domain or replace repository
// verification.
//
// `isDid` is the generic DID syntax the Rust oracle applies to follow subjects
// (`validate_did_syntax`, crates/core/src/follow.rs): it accepts any lowercase
// method, so the follow goldens (did:example:…) keep their Rust verdicts.
// `isSupportedDid` narrows that to the two methods atproto supports.

/** Maximum DID length (bytes; DIDs are ASCII). */
export const MAX_DID_LENGTH = 2048;
export const MAX_HANDLE_LENGTH = 253;
export const MAX_NSID_LENGTH = 317;
export const MAX_RKEY_LENGTH = 512;
export const MAX_AT_URI_LENGTH = 8192;
export const TID_LENGTH = 13;

const B32_SORTABLE = '234567abcdefghijklmnopqrstuvwxyz';

/** `did:<method>:<identifier>` with percent escapes checked, as validate_did_syntax. */
export function isDid(value: string): boolean {
  if (typeof value !== 'string' || value.length > MAX_DID_LENGTH) return false;
  // Identifier: [A-Za-z0-9._:-] or %XX, not ending in ':'.
  return /^did:[a-z]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})+$/.test(value) && !value.endsWith(':');
}

/** did:plc: exactly 24 base32 (lowercase a–z, 2–7) characters. */
export function isDidPlc(value: string): boolean {
  return typeof value === 'string' && /^did:plc:[a-z2-7]{24}$/.test(value);
}

/**
 * did:web, hostname level only (atproto does not support path-based did:web).
 * A port is allowed, percent-encoded as `%3A`, only for `localhost` (development).
 */
export function isDidWeb(value: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('did:web:') || value.length > MAX_DID_LENGTH) return false;
  const rest = value.slice('did:web:'.length);
  const port = /^localhost%3[Aa]([0-9]{1,5})$/.exec(rest);
  if (port) return Number(port[1]) >= 1 && Number(port[1]) <= 65_535;
  return rest === 'localhost' || isHandle(rest);
}

/** The DID methods this AppView resolves: did:plc and did:web. */
export function isSupportedDid(value: string): boolean {
  return isDidPlc(value) || isDidWeb(value);
}

/**
 * Handle syntax: two or more DNS labels (1–63 chars of [A-Za-z0-9-], no leading
 * or trailing hyphen), total ≤ 253, and a final label that starts with a letter.
 * Case-insensitive; compare with `normalizeHandle`.
 */
export function isHandle(value: string): boolean {
  if (typeof value !== 'string' || value.length > MAX_HANDLE_LENGTH) return false;
  return /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value);
}

/** TLDs the handle spec reserves; syntactically valid but never resolvable handles. */
const DISALLOWED_HANDLE_TLDS = new Set([
  'alt',
  'arpa',
  'example',
  'internal',
  'invalid',
  'local',
  'localhost',
  'onion',
]);

export function isDisallowedHandleTld(handle: string): boolean {
  const tld = handle.slice(handle.lastIndexOf('.') + 1).toLowerCase();
  return DISALLOWED_HANDLE_TLDS.has(tld);
}

export function normalizeHandle(handle: string): string {
  return handle.toLowerCase();
}

/**
 * NSID: a reversed domain authority (≥ 2 labels, ≤ 253 chars, first label
 * starting with a letter) plus a name segment of ASCII letters and digits that
 * starts with a letter. Total ≤ 317 chars.
 */
export function isNsid(value: string): boolean {
  if (typeof value !== 'string' || value.length > MAX_NSID_LENGTH) return false;
  if (
    !/^[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\.[A-Za-z][A-Za-z0-9]{0,62}$/.test(
      value,
    )
  ) {
    return false;
  }
  return value.lastIndexOf('.') <= 253;
}

/** TID: 13 base32-sortable chars; the first is limited so the top bit is 0. */
export function isTid(value: string): boolean {
  return typeof value === 'string' && /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(value);
}

/** Microsecond timestamp of a TID (the high 53 bits), as a safe integer. */
export function tidTimestampUs(tid: string): number {
  if (!isTid(tid)) throw new RangeError(`not a TID: ${tid}`);
  let n = 0n;
  for (const ch of tid) n = (n << 5n) | BigInt(B32_SORTABLE.indexOf(ch));
  return Number(n >> 10n);
}

/** Record key: 1–512 chars of [A-Za-z0-9._:~-], excluding "." and "..". */
export function isRecordKey(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_RKEY_LENGTH &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9._:~-]+$/.test(value)
  );
}

export interface AtUri {
  /** A DID or a handle. */
  authority: string;
  collection: string | null;
  rkey: string | null;
}

/**
 * Parse the restricted AT URI form `at://<did|handle>[/<nsid>[/<rkey>]]`: no
 * query, fragment, trailing slash or percent-encoding. Returns null otherwise.
 */
export function parseAtUri(value: string): AtUri | null {
  if (typeof value !== 'string' || value.length > MAX_AT_URI_LENGTH || !value.startsWith('at://')) return null;
  const parts = value.slice('at://'.length).split('/');
  if (parts.length > 3) return null;
  const [authority = '', collection, rkey] = parts;
  if (!isDid(authority) && !isHandle(authority)) return null;
  if (collection !== undefined && !isNsid(collection)) return null;
  if (rkey !== undefined && !isRecordKey(rkey)) return null;
  return { authority, collection: collection ?? null, rkey: rkey ?? null };
}

/** A record AT URI whose authority is a DID: `at://<did>/<collection>/<rkey>`. */
export interface RecordUri {
  did: string;
  collection: string;
  rkey: string;
}

export function parseRecordUri(value: string): RecordUri | null {
  const uri = parseAtUri(value);
  if (uri === null || uri.collection === null || uri.rkey === null || !isDid(uri.authority)) return null;
  return { did: uri.authority, collection: uri.collection, rkey: uri.rkey };
}

export function formatAtUri(did: string, collection: string, rkey: string): string {
  if (!isDid(did)) throw new RangeError(`not a DID: ${did}`);
  if (!isNsid(collection)) throw new RangeError(`not an NSID: ${collection}`);
  if (!isRecordKey(rkey)) throw new RangeError(`not a record key: ${rkey}`);
  return `at://${did}/${collection}/${rkey}`;
}

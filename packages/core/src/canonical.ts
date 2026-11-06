// Canonical JSON and its digest (ADR 0004 §5.2 steps 2–3).
//
// The outbox stores `digest = hex(sha256(canonicalJson(record)))` when it
// persists a create, and on an ambiguous create compares it with the digest of
// the remote getRecord `value`. Equal means our write landed; different means
// terminal `remote_record_conflict` (the record is never overwritten).
//
// Matches crates/atproto/src/pds/reconcile.rs `canonical_digest`, which is
// sha256(serde_json::to_vec(value)) over a BTreeMap-ordered Value:
// - object keys sorted by Unicode code point (= UTF-8 byte order, not UTF-16);
// - no insignificant whitespace;
// - strings escaped as JSON.stringify / serde_json do (", \, \b \f \n \r \t,
//   other C0 controls as \u00xx; everything else literal);
// - `$type` and every other key included.
//
// Only values of the atproto data model's JSON form are accepted: null,
// booleans, safe integers (the data model has no floats), well-formed strings,
// arrays and plain objects. Anything else throws TypeError rather than produce
// a digest that could never match a PDS round trip. An object property whose
// value is `undefined` is omitted, as JSON.stringify (and so the PDS) does.

import { sha256Hex } from './record-key';

/** Code-point (UTF-8 byte) order; differs from `<` only for astral vs U+E000–U+FFFF. */
function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    // A surrogate (astral code point) sorts after every BMP unit at or above U+E000.
    if (xs !== ys) return xs ? (y >= 0xe000 ? 1 : x - y) : x >= 0xe000 ? -1 : x - y;
    return x - y;
  }
  return a.length - b.length;
}

function encodeString(s: string, path: string): string {
  if (!s.isWellFormed()) throw new TypeError(`canonicalJson: lone surrogate in string at ${path}`);
  return JSON.stringify(s);
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return encodeString(value, path);
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonicalJson: ${value} at ${path} is not a safe integer`);
      }
      return Object.is(value, -0) ? '0' : String(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: ${typeof value} at ${path} is not JSON`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new TypeError(`canonicalJson: cycle at ${path}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj) || obj[i] === undefined) {
          throw new TypeError(`canonicalJson: hole or undefined at ${path}[${i}]`);
        }
        parts.push(encode(obj[i], `${path}[${i}]`, seen));
      }
      return `[${parts.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJson: ${path} is not a plain object`);
    }
    if (Object.getOwnPropertySymbols(obj).length > 0) {
      throw new TypeError(`canonicalJson: symbol key at ${path}`);
    }
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort(compareKeys);
    const parts = keys.map((k) => `${encodeString(k, `${path} key`)}:${encode(record[k], `${path}.${k}`, seen)}`);
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Sorted-key, whitespace-free JSON of an atproto data-model value. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$', new Set());
}

/** Lowercase hex SHA-256 of the UTF-8 canonical JSON. */
export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

/** True when both values have the same canonical form (the ambiguous-create check). */
export async function sameCanonicalRecord(local: unknown, remote: unknown): Promise<boolean> {
  return (await canonicalDigest(local)) === (await canonicalDigest(remote));
}

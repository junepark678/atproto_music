// Last.fm 2.0 request parameters (ADR 0005 §7.1, §7.7; N2-07).
//
// - Parameters come from the query string and an
//   `application/x-www-form-urlencoded` UTF-8 body, merged. Names are
//   case-sensitive. A name that appears twice ANYWHERE (twice in the query,
//   twice in the body, or once in each) is error 6: a duplicate would make the
//   signed value ambiguous (signature.ts signs exactly what was received).
// - Decoding is strict: `+` is a space, `%XX` are bytes, and the bytes must be
//   well-formed UTF-8; malformed percent escapes or invalid UTF-8 are error 6
//   instead of being replaced with U+FFFD (which would change what is signed).
// - Segments with an empty name (`&&`, `=x`) are skipped, as PHP's parse_str
//   (GNU FM) and Last.fm do.
// - Bodies are capped at 1 MiB (MAX_BODY_BYTES).
// - Indexed arrays (`artist[0]` … `artist[49]`) or a single unindexed set;
//   mixing the forms, an index ≥ 50, more than 50 entries or a non-canonical
//   index (`artist[01]`, `artist[]`) is error 6.
// - Format negotiation: `format=json` (query or body) → JSON; an explicit
//   `format=xml` → XML; otherwise an Accept header containing
//   `application/json` → JSON; otherwise XML. `callback` (JSONP) is never
//   honoured (encode.ts). `raw=true` drops the XML `<lfm>` wrapper.

import { LastfmError } from './errors';

/** ADR §7.1: request bodies are capped at 1 MiB. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** ADR §7.7: at most 50 entries, indices 0–49. */
export const MAX_INDEXED_ENTRIES = 50;

export type LastfmFormat = 'json' | 'xml';

/** The merged, de-duplicated parameters of one request, in received order (query first). */
export class LastfmParams {
  readonly #pairs: ReadonlyArray<readonly [string, string]>;
  readonly #map: ReadonlyMap<string, string>;

  constructor(pairs: Iterable<readonly [string, string]>) {
    const list: Array<readonly [string, string]> = [];
    const map = new Map<string, string>();
    for (const [name, value] of pairs) {
      if (map.has(name)) throw new LastfmError(6, `Invalid parameters - duplicate parameter ${quoteName(name)}`);
      map.set(name, value);
      list.push([name, value]);
    }
    this.#pairs = list;
    this.#map = map;
  }

  get(name: string): string | undefined {
    return this.#map.get(name);
  }

  has(name: string): boolean {
    return this.#map.has(name);
  }

  /** Every received (name, value) pair, in received order. */
  entries(): ReadonlyArray<readonly [string, string]> {
    return this.#pairs;
  }

  names(): string[] {
    return this.#pairs.map(([name]) => name);
  }

  get size(): number {
    return this.#pairs.length;
  }
}

/** A parameter name for an error message: bounded, never a value. */
function quoteName(name: string): string {
  const shown = name.length > 64 ? `${name.slice(0, 64)}…` : name;
  return JSON.stringify(shown);
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

const encoder = new TextEncoder();

/** Strict x-www-form-urlencoded component decoding (`+` → space, `%XX` → byte, UTF-8 fatal). */
function decodeComponent(raw: string): string {
  if (!raw.includes('%') && !raw.includes('+')) return raw;
  // The raw text is a JS string; its non-ASCII characters (if a client sent them
  // unencoded) are taken as their UTF-8 bytes.
  const source = encoder.encode(raw);
  const out = new Uint8Array(source.length);
  let n = 0;
  for (let i = 0; i < source.length; i++) {
    const b = source[i] as number;
    if (b === 0x2b) {
      out[n++] = 0x20;
    } else if (b === 0x25) {
      const hi = i + 1 < source.length ? hexValue(source[i + 1] as number) : -1;
      const lo = i + 2 < source.length ? hexValue(source[i + 2] as number) : -1;
      if (hi < 0 || lo < 0) throw new LastfmError(6, 'Invalid parameters - malformed percent-encoding');
      out[n++] = (hi << 4) | lo;
      i += 2;
    } else {
      out[n++] = b;
    }
  }
  try {
    return utf8.decode(out.subarray(0, n));
  } catch (cause) {
    throw new LastfmError(6, 'Invalid parameters - parameters must be UTF-8', { cause });
  }
}

/** Splits `a=1&b=2` into decoded pairs, skipping segments with an empty name. */
export function parseUrlEncoded(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  if (text === '') return pairs;
  for (const segment of text.split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('=');
    const rawName = eq < 0 ? segment : segment.slice(0, eq);
    const rawValue = eq < 0 ? '' : segment.slice(eq + 1);
    const name = decodeComponent(rawName);
    if (name === '') continue;
    pairs.push([name, decodeComponent(rawValue)]);
  }
  return pairs;
}

export interface LastfmRequestInput {
  /** The request URL; only its query string is read. */
  url: string | URL;
  /** The Content-Type header, if any. */
  contentType?: string | null;
  /** The raw body (absent for GET). */
  body?: string | Uint8Array | null;
}

/** True when a Content-Type admits a form body (form-urlencoded, or none at all). */
function isFormBody(contentType: string | null | undefined): boolean {
  if (contentType === null || contentType === undefined || contentType.trim() === '') return true;
  const mediaType = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return mediaType === 'application/x-www-form-urlencoded';
}

/**
 * Parses and merges the query string and the form body. Throws LastfmError 6
 * on a duplicate name, malformed encoding, a body over 1 MiB or a body of
 * another content type.
 */
export function parseLastfmParams(input: LastfmRequestInput): LastfmParams {
  const url = typeof input.url === 'string' ? new URL(input.url, 'http://localhost') : input.url;
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const pairs = parseUrlEncoded(query);
  const body = input.body;
  if (body !== null && body !== undefined) {
    const bytes = typeof body === 'string' ? encoder.encode(body) : body;
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new LastfmError(6, 'Invalid parameters - request body exceeds 1 MiB');
    }
    if (bytes.byteLength > 0) {
      if (!isFormBody(input.contentType)) {
        throw new LastfmError(6, 'Invalid parameters - the body must be application/x-www-form-urlencoded');
      }
      let text: string;
      try {
        text = utf8.decode(bytes);
      } catch (cause) {
        throw new LastfmError(6, 'Invalid parameters - parameters must be UTF-8', { cause });
      }
      pairs.push(...parseUrlEncoded(text));
    }
  }
  return new LastfmParams(pairs);
}

/**
 * Reads a Request's parameters, refusing a body over `maxBytes` (default
 * 1 MiB) without buffering more than `maxBytes + 1` bytes of it.
 */
export async function readLastfmParams(req: Request, maxBytes: number = MAX_BODY_BYTES): Promise<LastfmParams> {
  const contentType = req.headers.get('content-type');
  if (req.body === null || req.method === 'GET' || req.method === 'HEAD') {
    return parseLastfmParams({ url: req.url, contentType });
  }
  const declared = req.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new LastfmError(6, 'Invalid parameters - request body exceeds 1 MiB');
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new LastfmError(6, 'Invalid parameters - request body exceeds 1 MiB');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseLastfmParams({ url: req.url, contentType, body });
}

/**
 * ADR §7.1 format negotiation: `format=json` → JSON, `format=xml` → XML,
 * otherwise an Accept header containing `application/json` → JSON, otherwise
 * XML. The `callback` parameter plays no part (JSONP is never served).
 */
export function negotiateFormat(params: LastfmParams, accept: string | null | undefined): LastfmFormat {
  const format = params.get('format')?.trim().toLowerCase();
  if (format === 'json') return 'json';
  if (format === 'xml') return 'xml';
  if (accept?.toLowerCase().includes('application/json')) return 'json';
  return 'xml';
}

/** `raw=true` drops the `<lfm>` wrapper in XML (ADR §7.1). */
export function wantsRawXml(params: LastfmParams): boolean {
  return params.get('raw')?.trim().toLowerCase() === 'true';
}

export interface IndexedEntriesOptions {
  /** Maximum number of entries and the exclusive index bound (default 50). */
  max?: number;
  /** Fields every entry must carry; a missing one is error 6, and so is zero entries. */
  required?: readonly string[];
}

const INDEXED_NAME = /^([^[\]]+)\[([^\]]*)\]$/;
const CANONICAL_INDEX = /^(0|[1-9][0-9]{0,8})$/;

/**
 * The entries of an array-valued method (track.scrobble, ADR §7.7): `field[i]`
 * parameters with i from 0 to max-1, grouped by index in ascending order, or a
 * single entry from the unindexed `field` parameters. Parameters whose base
 * name is not in `fields` are ignored. Error 6 for: mixing the two forms, an
 * index ≥ max, more than max entries, a non-canonical index (`[01]`, `[]`,
 * `[-1]`, `[x]`), a missing required field, or no entry when fields are
 * required.
 */
export function parseIndexedEntries(
  params: LastfmParams,
  fields: readonly string[],
  options: IndexedEntriesOptions = {},
): Array<Record<string, string>> {
  const max = options.max ?? MAX_INDEXED_ENTRIES;
  const fieldSet = new Set(fields);
  const indexed = new Map<number, Record<string, string>>();
  const single: Record<string, string> = {};
  let sawSingle = false;

  for (const [name, value] of params.entries()) {
    if (fieldSet.has(name)) {
      single[name] = value;
      sawSingle = true;
      continue;
    }
    const m = INDEXED_NAME.exec(name);
    if (m === null) continue;
    const base = m[1] as string;
    if (!fieldSet.has(base)) continue;
    const rawIndex = m[2] as string;
    if (!CANONICAL_INDEX.test(rawIndex)) {
      throw new LastfmError(6, `Invalid parameters - invalid index in ${quoteName(name)}`);
    }
    const index = Number(rawIndex);
    if (index >= max) {
      throw new LastfmError(6, `Invalid parameters - at most ${max} entries (indices 0 to ${max - 1})`);
    }
    let entry = indexed.get(index);
    if (entry === undefined) {
      entry = {};
      indexed.set(index, entry);
    }
    entry[base] = value;
  }

  if (sawSingle && indexed.size > 0) {
    throw new LastfmError(6, 'Invalid parameters - indexed and unindexed parameters cannot be mixed');
  }
  if (indexed.size > max) {
    throw new LastfmError(6, `Invalid parameters - at most ${max} entries`);
  }

  const entries = sawSingle ? [single] : [...indexed.keys()].sort((a, b) => a - b).map((i) => indexed.get(i)!);
  const required = options.required ?? [];
  if (required.length > 0) {
    if (entries.length === 0) {
      throw new LastfmError(6, `Invalid parameters - missing required parameter ${quoteName(required[0] as string)}`);
    }
    for (const entry of entries) {
      for (const field of required) {
        if (!Object.hasOwn(entry, field)) {
          throw new LastfmError(6, `Invalid parameters - missing required parameter ${quoteName(field)}`);
        }
      }
    }
  }
  return entries;
}

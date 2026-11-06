// Last.fm 2.0 response encoding: a neutral element tree serialised to XML or
// JSON (ADR 0005 §7.1, §7.2; N2-07).
//
// Tree. A response is an LfmDocument: the children of `<lfm status="ok">`.
// Each node is either an element (a leaf with optional text, or a container
// with children; both may carry attributes) or a LIST node — the `list` flag
// of ADR §7.2 — holding zero or more same-named elements.
//
// JSON rules (ADR §7.2):
//   - a leaf without attributes is its text (`"mbid": ""`); a leaf with
//     attributes is `{attr…, "#text": text}`, so an empty text is still
//     `"#text":""` (Pano requires it);
//   - a container is an object of its children, its attributes under "@attr";
//   - a list node is ALWAYS an array: `[]` for none, `[x]` for one;
//   - only `scrobbles.scrobble` keeps Last.fm's single-child-becomes-object
//     quirk (one input → object, several → array); every other repeated child
//     must be a list node, and the encoder refuses a tree that breaks this;
//   - every number is a string, except `scrobbles.@attr.accepted`/`ignored`,
//     `user.registered.#text` (user.getInfo) and `session.subscriber`, which
//     are JSON numbers (JSON_NUMBER_PATHS); the encoder enforces it whatever
//     type the builder used.
//
// XML rules: `& < > " '` are escaped (and CR, TAB, LF in attributes, CR in
// text, as character references so they survive XML normalisation);
// characters XML 1.0 does not allow (U+0000–U+0008, U+000B, U+000C,
// U+000E–U+001F, lone surrogates, U+FFFE, U+FFFF) are removed. `raw=true`
// drops the `<lfm>` wrapper when there is one root element. An empty
// document is `<lfm status="ok"/>` (XML) and `{}` (JSON), the track.love
// answer.
//
// Structural guard (validateDocument, run by every serialiser): the list
// containers of ADR §7.2 (LIST_CONTAINERS, and `image` anywhere) must hold a
// list node, never a bare element, and every paged container (PAGED_CONTAINERS)
// must carry @attr {user, page, perPage, totalPages, total}. A violation is a
// programming error and throws LfmTreeError; it never reaches a client as a
// silently wrong shape.
//
// JSONP: a `callback` parameter is never honoured. The JSON body is plain JSON
// with `X-Content-Type-Options: nosniff` and the JSON content type.

import type { LastfmError } from './errors';
import type { LastfmFormat } from './params';

export type LfmValue = string | number;

export interface LfmElement {
  readonly name: string;
  readonly attrs?: Readonly<Record<string, LfmValue>>;
  /** Leaf text; absent means "". An element with `children` has no text. */
  readonly text?: LfmValue;
  /** Present (even empty) for a container. */
  readonly children?: readonly LfmNode[];
}

/** A flagged list (ADR §7.2): always a JSON array, repeated elements in XML. */
export interface LfmList {
  readonly name: string;
  readonly list: true;
  readonly items: readonly LfmElement[];
}

export type LfmNode = LfmElement | LfmList;

/** The children of `<lfm status="ok">`. */
export interface LfmDocument {
  readonly children: readonly LfmNode[];
}

export class LfmTreeError extends Error {
  override readonly name = 'LfmTreeError';
}

export const XML_CONTENT_TYPE = 'text/xml; charset=utf-8';
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

/** ADR §7.2: the only JSON values that are numbers, as root-relative paths. */
export const JSON_NUMBER_PATHS: ReadonlySet<string> = new Set([
  'scrobbles/@attr/accepted',
  'scrobbles/@attr/ignored',
  'user/registered/#text',
  'session/subscriber',
]);

/** ADR §7.2 list containers: parent element name → its list child's name. */
export const LIST_CONTAINERS: ReadonlyMap<string, string> = new Map([
  ['recenttracks', 'track'],
  ['trackscrobbles', 'track'],
  ['lovedtracks', 'track'],
  ['toptracks', 'track'],
  ['topartists', 'artist'],
  ['topalbums', 'album'],
  ['weeklychartlist', 'chart'],
  ['weeklyartistchart', 'artist'],
  ['weeklyalbumchart', 'album'],
  ['weeklytrackchart', 'track'],
  ['friends', 'user'],
  ['artists', 'artist'],
  ['toptags', 'tag'],
  ['tracks', 'track'],
  ['similar', 'artist'],
]);

/** An element of this name is always a list item, whatever its parent. */
export const ALWAYS_LIST: ReadonlySet<string> = new Set(['image']);

/** ADR §7.2 paged root containers; each carries @attr {user, page, perPage, totalPages, total}. */
export const PAGED_CONTAINERS: ReadonlySet<string> = new Set([
  'recenttracks',
  'trackscrobbles',
  'lovedtracks',
  'toptracks',
  'topartists',
  'topalbums',
  'friends',
  'artists',
]);

export const PAGE_ATTRS = ['user', 'page', 'perPage', 'totalPages', 'total'] as const;

/** The one parent/child pair that keeps the single-child-becomes-object quirk. */
const QUIRK_PARENT = 'scrobbles';
const QUIRK_CHILD = 'scrobble';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** A leaf element (`<name attrs>text</name>`). */
export function leaf(name: string, text: LfmValue = '', attrs?: Record<string, LfmValue>): LfmElement {
  return attrs === undefined ? { name, text } : { name, text, attrs };
}

/** A container element. */
export function node(name: string, children: readonly LfmNode[], attrs?: Record<string, LfmValue>): LfmElement {
  return attrs === undefined ? { name, children } : { name, children, attrs };
}

/** A flagged list of `name` elements. */
export function list(name: string, items: readonly LfmElement[]): LfmList {
  return { name, list: true, items };
}

export interface PageAttr {
  user: string;
  page: number;
  perPage: number;
  totalPages: number;
  total: number;
}

/** A paged container: the item list plus @attr {user, page, perPage, totalPages, total} (strings). */
export function paged(
  name: string,
  page: PageAttr,
  itemName: string,
  items: readonly LfmElement[],
  extraAttrs: Record<string, LfmValue> = {},
): LfmElement {
  return node(name, [list(itemName, items)], {
    user: page.user,
    page: String(page.page),
    perPage: String(page.perPage),
    totalPages: String(page.totalPages),
    total: String(page.total),
    ...extraAttrs,
  });
}

export const IMAGE_SIZES = ['small', 'medium', 'large', 'extralarge'] as const;

/** ADR §7.9: the four image sizes, each with empty text. */
export function images(): LfmList {
  return list(
    'image',
    IMAGE_SIZES.map((size) => leaf('image', '', { size })),
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `DD Mon YYYY, HH:MM` in UTC (ADR §7.9). */
export function formatLastfmDate(seconds: number): string {
  const d = new Date(Math.floor(seconds) * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** `<date uts="S">DD Mon YYYY, HH:MM</date>` (ADR §7.9). */
export function lastfmDate(seconds: number, name = 'date'): LfmElement {
  const s = Math.floor(seconds);
  return leaf(name, formatLastfmDate(s), { uts: String(s) });
}

export function lfmOk(...children: LfmNode[]): LfmDocument {
  return { children };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isList(n: LfmNode): n is LfmList {
  return (n as LfmList).list === true;
}

function checkName(name: string, where: string): void {
  if (!NAME.test(name)) throw new LfmTreeError(`invalid ${where} name ${JSON.stringify(name)}`);
}

function checkValue(value: LfmValue, where: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new LfmTreeError(`non-finite number at ${where}`);
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new LfmTreeError(`value at ${where} must be a string or a number`);
  }
}

function validateElement(e: LfmElement, path: string, depth: number): void {
  checkName(e.name, 'element');
  for (const [k, v] of Object.entries(e.attrs ?? {})) {
    checkName(k, 'attribute');
    checkValue(v, `${path}@${k}`);
  }
  if (e.children === undefined) {
    if (e.text !== undefined) checkValue(e.text, path);
    if (LIST_CONTAINERS.has(e.name)) {
      throw new LfmTreeError(`${path} is a list container and must hold its ${LIST_CONTAINERS.get(e.name)} list`);
    }
    return;
  }
  if (e.text !== undefined) throw new LfmTreeError(`${path} has both children and text`);
  validateChildren(e.name, e.children, path, depth + 1);
  if (depth === 0 && PAGED_CONTAINERS.has(e.name)) {
    for (const a of PAGE_ATTRS) {
      if (e.attrs?.[a] === undefined) throw new LfmTreeError(`paged ${path} lacks @attr.${a}`);
    }
  }
}

function validateChildren(parent: string | null, children: readonly LfmNode[], path: string, depth: number): void {
  const seen = new Map<string, 'list' | 'element' | 'repeated'>();
  for (const child of children) {
    const childPath = path === '' ? child.name : `${path}/${child.name}`;
    checkName(child.name, isList(child) ? 'list' : 'element');
    if (isList(child)) {
      if (parent === null) throw new LfmTreeError(`a list (${child.name}) cannot be a root element`);
      if (parent === QUIRK_PARENT && child.name === QUIRK_CHILD) {
        throw new LfmTreeError('scrobbles.scrobble keeps the single-object quirk and must not be a list');
      }
      if (seen.has(child.name)) throw new LfmTreeError(`${childPath} appears more than once`);
      seen.set(child.name, 'list');
      for (const item of child.items) {
        if (isList(item as LfmNode)) throw new LfmTreeError(`list ${childPath} holds a list`);
        if (item.name !== child.name) {
          throw new LfmTreeError(`list ${childPath} holds an element named ${JSON.stringify(item.name)}`);
        }
        validateElement(item, childPath, depth);
      }
      continue;
    }
    if (ALWAYS_LIST.has(child.name) || (parent !== null && LIST_CONTAINERS.get(parent) === child.name)) {
      throw new LfmTreeError(`${childPath} must be a list node (ADR 0005 §7.2 list flag)`);
    }
    const before = seen.get(child.name);
    if (before !== undefined) {
      if (before === 'list' || parent !== QUIRK_PARENT || child.name !== QUIRK_CHILD) {
        throw new LfmTreeError(`${childPath} is repeated without the list flag`);
      }
      seen.set(child.name, 'repeated');
    } else {
      seen.set(child.name, 'element');
    }
    validateElement(child, childPath, depth);
  }
  if (parent !== null) {
    const required = LIST_CONTAINERS.get(parent);
    if (required !== undefined && seen.get(required) !== 'list') {
      throw new LfmTreeError(`${path} must hold a ${required} list`);
    }
  }
}

/** Throws LfmTreeError when `doc` breaks the §7.2 structure rules. */
export function validateDocument(doc: LfmDocument): void {
  validateChildren(null, doc.children, '', 0);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

type Json = string | number | Json[] | { [key: string]: Json };

function jsonScalar(value: LfmValue, path: string): string | number {
  if (JSON_NUMBER_PATHS.has(path)) {
    if (typeof value === 'number') return value;
    if (/^-?(0|[1-9][0-9]*)$/.test(value)) return Number(value);
    throw new LfmTreeError(`${path} must be an integer`);
  }
  return typeof value === 'number' ? String(value) : value;
}

function elementJson(e: LfmElement, path: string): Json {
  const attrs = Object.entries(e.attrs ?? {});
  if (e.children === undefined) {
    if (attrs.length === 0) return jsonScalar(e.text ?? '', path);
    const out: { [key: string]: Json } = {};
    for (const [k, v] of attrs) out[k] = jsonScalar(v, `${path}/${k}`);
    out['#text'] = jsonScalar(e.text ?? '', `${path}/#text`);
    return out;
  }
  const out: { [key: string]: Json } = childrenJson(e.children, path);
  if (attrs.length > 0) {
    const attr: { [key: string]: Json } = {};
    for (const [k, v] of attrs) attr[k] = jsonScalar(v, `${path}/@attr/${k}`);
    out['@attr'] = attr;
  }
  return out;
}

function childrenJson(children: readonly LfmNode[], path: string): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  const counts = new Map<string, number>();
  for (const c of children) if (!isList(c)) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  for (const c of children) {
    const childPath = path === '' ? c.name : `${path}/${c.name}`;
    if (isList(c)) {
      out[c.name] = c.items.map((item) => elementJson(item, childPath));
    } else if ((counts.get(c.name) ?? 0) > 1) {
      const existing = out[c.name];
      const value = elementJson(c, childPath);
      if (Array.isArray(existing)) existing.push(value);
      else out[c.name] = [value];
    } else {
      out[c.name] = elementJson(c, childPath);
    }
  }
  return out;
}

/** The JSON body of a success document (`{}` for an empty one). */
export function toJson(doc: LfmDocument): string {
  validateDocument(doc);
  return JSON.stringify(childrenJson(doc.children, ''));
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/** Characters XML 1.0 does not allow (including lone surrogates, U+FFFE and U+FFFF). */
const XML_INVALID = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** Removes every character XML 1.0 does not allow. */
export function stripInvalidXmlChars(text: string): string {
  return text.replace(XML_INVALID, '');
}

const TEXT_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\r': '&#13;',
};
const ATTR_ESCAPES: Readonly<Record<string, string>> = { ...TEXT_ESCAPES, '\t': '&#9;', '\n': '&#10;' };

/** XML text content: invalid characters removed, `& < > " '` and CR escaped. */
export function escapeXmlText(value: LfmValue): string {
  return stripInvalidXmlChars(String(value)).replace(/[&<>"'\r]/g, (c) => TEXT_ESCAPES[c] as string);
}

/** An XML attribute value: as escapeXmlText, plus TAB and LF. */
export function escapeXmlAttr(value: LfmValue): string {
  return stripInvalidXmlChars(String(value)).replace(/[&<>"'\r\t\n]/g, (c) => ATTR_ESCAPES[c] as string);
}

function attrsXml(attrs: Readonly<Record<string, LfmValue>> | undefined): string {
  let s = '';
  for (const [k, v] of Object.entries(attrs ?? {})) s += ` ${k}="${escapeXmlAttr(v)}"`;
  return s;
}

function expand(children: readonly LfmNode[]): LfmElement[] {
  const out: LfmElement[] = [];
  for (const c of children) {
    if (isList(c)) out.push(...c.items);
    else out.push(c);
  }
  return out;
}

function elementXml(e: LfmElement, indent: string, lines: string[]): void {
  const open = `${indent}<${e.name}${attrsXml(e.attrs)}`;
  if (e.children === undefined) {
    const text = escapeXmlText(e.text ?? '');
    lines.push(text === '' ? `${open}/>` : `${open}>${text}</${e.name}>`);
    return;
  }
  const kids = expand(e.children);
  if (kids.length === 0) {
    lines.push(`${open}/>`);
    return;
  }
  lines.push(`${open}>`);
  for (const k of kids) elementXml(k, `${indent}  `, lines);
  lines.push(`${indent}</${e.name}>`);
}

export interface XmlOptions {
  /** `raw=true`: drop the `<lfm>` wrapper when the document has one root element. */
  raw?: boolean;
}

/** The XML body of a success document. */
export function toXml(doc: LfmDocument, options: XmlOptions = {}): string {
  validateDocument(doc);
  const roots = expand(doc.children);
  const lines = [XML_DECLARATION];
  if (options.raw === true && roots.length === 1) {
    elementXml(roots[0] as LfmElement, '', lines);
  } else if (roots.length === 0) {
    lines.push('<lfm status="ok"/>');
  } else {
    lines.push('<lfm status="ok">');
    for (const r of roots) elementXml(r, '  ', lines);
    lines.push('</lfm>');
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** `{"error": N, "message": "..."}` (ADR §7.2). */
export function errorJson(err: LastfmError): string {
  return JSON.stringify({ error: err.code, message: err.message });
}

/** `<lfm status="failed"><error code="N">text</error></lfm>` (ADR §7.2). */
export function errorXml(err: LastfmError): string {
  return `${XML_DECLARATION}\n<lfm status="failed"><error code="${err.code}">${escapeXmlText(err.message)}</error></lfm>\n`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface EncodedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function baseHeaders(format: LastfmFormat): Record<string, string> {
  return {
    'content-type': format === 'json' ? JSON_CONTENT_TYPE : XML_CONTENT_TYPE,
    'x-content-type-options': 'nosniff',
  };
}

/** A 200 with the document in `format`. JSONP `callback` is never applied. */
export function encodeSuccess(doc: LfmDocument, format: LastfmFormat, options: XmlOptions = {}): EncodedResponse {
  const body = format === 'json' ? toJson(doc) : toXml(doc, options);
  return { status: 200, headers: baseHeaders(format), body };
}

/** The error envelope with the ADR §7.6 status, and Retry-After for 29. */
export function encodeError(err: LastfmError, format: LastfmFormat): EncodedResponse {
  const headers = baseHeaders(format);
  if (err.retryAfterSeconds !== undefined) headers['retry-after'] = String(err.retryAfterSeconds);
  return { status: err.status, headers, body: format === 'json' ? errorJson(err) : errorXml(err) };
}

/** encodeSuccess / encodeError as a Response. */
export function lastfmResponse(
  result: LfmDocument | LastfmError,
  format: LastfmFormat,
  options: XmlOptions = {},
): Response {
  const encoded = result instanceof Error ? encodeError(result, format) : encodeSuccess(result, format, options);
  return new Response(encoded.body, { status: encoded.status, headers: encoded.headers });
}

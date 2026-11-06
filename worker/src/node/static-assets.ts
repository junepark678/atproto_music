// The Node host's static web server (ADR 0005 §3.7; N1-06): the behaviour of
// ADR 0004's Static Assets binding over `web/dist`, kept.
//
// - Files are read into memory once, at startup (`dist` is small), by walking
//   the directory with lstat: only regular files are loaded, and a symbolic
//   link (which could point outside dist) is never followed. A request never
//   touches the filesystem.
// - `_headers` (written by scripts/gen-config.ts) is parsed once with the
//   Cloudflare rules: an unindented line is a path pattern (`*` matches any
//   run of characters, `:name` one segment), each indented `Name: value` line
//   is a header of the pattern above it, `! Name` detaches a header an earlier
//   rule set, `#` starts a comment. A header several matching rules set is
//   joined with ", " as Static Assets do. `_headers` and `_redirects` are
//   never served: a request for either is the JSON 404.
// - `/` serves `/index.html`; `/index.html` is a 301 to `/` (query kept).
// - The ETag is the SHA-256 of the content (strong, quoted hex); an
//   `If-None-Match` that matches (weak comparison, or `*`) gets a 304.
// - MIME types come from a fixed table; anything else is
//   application/octet-stream (with `nosniff` from `_headers`).
// - GET and HEAD are served (HEAD without a body). Any other method on an
//   existing file is 405 with `Allow: GET, HEAD` and the JSON error envelope.
// - The path is checked before any lookup with the Rust oracle's `safe_path`
//   (crates/server/src/http/assets.rs): percent-decoded once; an encoded `/`,
//   `\` or `%`, a raw `\`, a control character (NUL included), invalid UTF-8
//   or a `.`/`..` segment (`%2e%2e` included) is refused with the JSON 404.
//   The check runs on the raw request target the HTTP bridge received
//   (`rawTarget`), because WHATWG URL parsing has already resolved `%2e%2e`
//   segments in `request.url`.
// - A path that is not a file returns null: the dispatcher (N2-01) then runs
//   `assetMiss` (index.html for SPA routes, else the JSON 404).

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { cryptoRandom, type Random } from '@atmusic/core/deps';
import { errorResponse } from '../http/error';
import { newRequestId } from '../http/request-id';

/** The part of node:fs the loader uses; injected by tests to record every access. */
export interface StaticFs {
  readdirSync(path: string): string[];
  lstatSync(path: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
  readFileSync(path: string): Uint8Array;
}

export interface StaticAssetsOptions {
  /** Request ids of the error envelopes; cryptoRandom in production. */
  random?: Random;
  fs?: StaticFs;
}

export interface HeaderRule {
  readonly pattern: string;
  readonly set: readonly (readonly [string, string])[];
  readonly detach: readonly string[];
}

interface StaticFile {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
}

export class StaticAssetsError extends Error {
  override readonly name = 'StaticAssetsError';
}

/** Files of dist the server never serves (Static Assets configuration files). */
export const UNSERVED_FILES: ReadonlySet<string> = new Set(['/_headers', '/_redirects']);

/** Extension → Content-Type. */
export const MIME_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
};
const OCTET_STREAM = 'application/octet-stream';

export function mimeTypeOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return OCTET_STREAM;
  return MIME_TYPES[name.slice(dot + 1).toLowerCase()] ?? OCTET_STREAM;
}

// ---------------------------------------------------------------------------
// _headers

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Parses a `_headers` file (module comment). A malformed line throws StaticAssetsError. */
export function parseHeadersFile(text: string): HeaderRule[] {
  const rules: { pattern: string; set: [string, string][]; detach: string[] }[] = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] as string;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indented = /^\s/.test(line);
    if (!indented) {
      if (!trimmed.startsWith('/')) throw new StaticAssetsError(`_headers line ${n + 1}: a pattern must start with /`);
      rules.push({ pattern: trimmed, set: [], detach: [] });
      continue;
    }
    const rule = rules[rules.length - 1];
    if (rule === undefined) throw new StaticAssetsError(`_headers line ${n + 1}: a header before any pattern`);
    if (trimmed.startsWith('!')) {
      const name = trimmed.slice(1).trim();
      if (!HEADER_NAME.test(name)) throw new StaticAssetsError(`_headers line ${n + 1}: invalid header name`);
      rule.detach.push(name.toLowerCase());
      continue;
    }
    const colon = trimmed.indexOf(':');
    const name = colon === -1 ? '' : trimmed.slice(0, colon).trim();
    if (!HEADER_NAME.test(name)) throw new StaticAssetsError(`_headers line ${n + 1}: expected "Name: value"`);
    rule.set.push([name.toLowerCase(), trimmed.slice(colon + 1).trim()]);
  }
  return rules;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A `_headers` pattern as an anchored RegExp: `*` any run, `:name` one segment. */
export function patternRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; ) {
    const c = pattern[i] as string;
    if (c === '*') {
      source += '.*';
      i++;
    } else if (c === ':' && /[A-Za-z]/.test(pattern[i + 1] ?? '')) {
      let j = i + 1;
      while (j < pattern.length && /\w/.test(pattern[j] as string)) j++;
      source += '[^/]+';
      i = j;
    } else {
      source += escapeRegExp(c);
      i++;
    }
  }
  return new RegExp(`^${source}$`);
}

/** The headers every rule matching `path` sets, in rule order, joined per name. */
export function headersFor(rules: readonly { regexp: RegExp; rule: HeaderRule }[], path: string): Headers {
  const values = new Map<string, string[]>();
  for (const { regexp, rule } of rules) {
    if (!regexp.test(path)) continue;
    for (const name of rule.detach) values.delete(name);
    for (const [name, value] of rule.set) {
      const list = values.get(name) ?? [];
      list.push(value);
      values.set(name, list);
    }
  }
  const headers = new Headers();
  for (const [name, list] of values) headers.set(name, list.join(', '));
  return headers;
}

// ---------------------------------------------------------------------------
// Paths

const HEX = /^[0-9A-Fa-f]{2}$/;
// fatal: invalid UTF-8 is rejected; ignoreBOM: a BOM is kept, as Rust's from_utf8 keeps it.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The oracle's `safe_path` (crates/server/src/http/assets.rs), also ported in
 * worker/src/router.ts for the Workers entry: `rawPath` percent-decoded once,
 * or null when it encodes `/`, `\` or `%`, holds a control character or `\`,
 * has a malformed escape, does not decode to UTF-8, or has a `.` or `..`
 * segment.
 */
export function safeStaticPath(rawPath: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < rawPath.length; ) {
    let byte: number;
    if (rawPath[i] === '%') {
      const hex = rawPath.slice(i + 1, i + 3);
      if (!HEX.test(hex)) return null;
      byte = Number.parseInt(hex, 16);
      if (byte === 0x2f || byte === 0x5c || byte === 0x25) return null;
      i += 3;
    } else {
      byte = rawPath.charCodeAt(i);
      // A request target is ASCII; anything else did not come from the HTTP parser.
      if (byte > 0x7f) return null;
      i += 1;
    }
    if (byte < 0x20 || byte === 0x7f || byte === 0x5c) return null;
    bytes.push(byte);
  }
  let path: string;
  try {
    path = UTF8.decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
  if (!path.startsWith('/')) return null;
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return path;
}

/** The path part of a raw request target (`/a/b?x` → `/a/b`). */
function targetPath(rawTarget: string): string {
  const q = rawTarget.indexOf('?');
  const hash = rawTarget.indexOf('#');
  let end = rawTarget.length;
  if (q !== -1) end = q;
  if (hash !== -1 && hash < end) end = hash;
  return rawTarget.slice(0, end);
}

// ---------------------------------------------------------------------------
// Loading

function loadFiles(dir: string, fs: StaticFs): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (absolute: string, path: string): void => {
    for (const name of fs.readdirSync(absolute).sort()) {
      const child = join(absolute, name);
      const stat = fs.lstatSync(child);
      // Never follow a link: it could point anywhere on the filesystem.
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(child, `${path}${name}/`);
      else if (stat.isFile()) files.set(`${path}${name}`, fs.readFileSync(child));
    }
  };
  let root: ReturnType<StaticFs['lstatSync']>;
  try {
    root = fs.lstatSync(dir);
  } catch {
    throw new StaticAssetsError(`assets directory ${dir} does not exist`);
  }
  if (!root.isDirectory()) throw new StaticAssetsError(`assets directory ${dir} is not a directory`);
  walk(dir, '/');
  return files;
}

function etagOf(body: Uint8Array): string {
  return `"${createHash('sha256').update(body).digest('hex')}"`;
}

/** RFC 9110 §13.1.2: weak comparison against each listed tag, or `*`. */
function noneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const trimmed = header.trim();
  if (trimmed === '*') return true;
  const opaque = (tag: string) => (tag.startsWith('W/') ? tag.slice(2) : tag);
  const ours = opaque(etag);
  return trimmed.split(',').some((tag) => opaque(tag.trim()) === ours);
}

export interface StaticAssets {
  /** Served paths (`/index.html`, `/assets/x.js`, ...), sorted. */
  readonly paths: readonly string[];
  /** Whether `path` (decoded, `/`-rooted) is a served file. `/` is index.html. */
  has(path: string): boolean;
  /**
   * The answer for `request`, or null when its path is not a file (the
   * dispatcher's `assetMiss` then decides). `rawTarget` is the request target
   * as received; without it the path of `request.url` is used.
   */
  serve(request: Request, rawTarget?: string): Response | null;
}

/** Reads `dir` (web/dist) into memory and parses its `_headers`. */
export function loadStaticAssets(dir: string, options: StaticAssetsOptions = {}): StaticAssets {
  const fs = options.fs ?? (nodeFs as unknown as StaticFs);
  const random = options.random ?? cryptoRandom;
  const raw = loadFiles(dir, fs);

  const headersText = raw.get('/_headers');
  const rules = (headersText === undefined ? [] : parseHeadersFile(new TextDecoder().decode(headersText))).map(
    (rule) => ({ regexp: patternRegExp(rule.pattern), rule }),
  );

  const files = new Map<string, StaticFile>();
  for (const [path, body] of raw) {
    if (UNSERVED_FILES.has(path)) continue;
    files.set(path, { body, contentType: mimeTypeOf(path), etag: etagOf(body) });
  }
  const paths = [...files.keys()].sort();

  const fileAt = (path: string): StaticFile | undefined => files.get(path === '/' ? '/index.html' : path);

  const withRequestId = (response: Response, requestId: string): Response => {
    response.headers.set('x-request-id', requestId);
    return response;
  };

  return {
    paths,
    has: (path) => fileAt(path) !== undefined,
    serve(request, rawTarget) {
      const url = new URL(request.url);
      const rawPath = rawTarget === undefined ? url.pathname : targetPath(rawTarget);
      const path = safeStaticPath(rawPath);
      // Refused before any lookup; `_headers` is answered the same way, never served.
      if (path === null || UNSERVED_FILES.has(path)) {
        const requestId = newRequestId(random);
        return withRequestId(errorResponse('not_found', 404, requestId), requestId);
      }
      const file = fileAt(path);
      if (file === undefined) return null;

      const method = request.method.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        const requestId = newRequestId(random);
        return withRequestId(
          errorResponse('method_not_allowed', 405, requestId, undefined, { headers: { allow: 'GET, HEAD' } }),
          requestId,
        );
      }
      if (path === '/index.html') {
        return new Response(null, { status: 301, headers: { location: `/${url.search}` } });
      }

      const headers = headersFor(rules, path);
      headers.set('etag', file.etag);
      if (noneMatch(request.headers.get('if-none-match'), file.etag)) {
        return new Response(null, { status: 304, headers });
      }
      headers.set('content-type', file.contentType);
      headers.set('content-length', String(file.body.byteLength));
      // A copy per response: a consumer can never alter the cached bytes.
      return new Response(method === 'HEAD' ? null : file.body.slice(), { status: 200, headers });
    },
  };
}

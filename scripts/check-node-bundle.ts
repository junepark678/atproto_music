// The Node bundle guard (ADR 0005 §3.5 rule 3, §3.9, §20.4 #26, B11; N3-07).
//
// Usage:
//   npx tsx scripts/check-node-bundle.ts [--dist worker/dist/node]
//
// Reads the esbuild metafiles that scripts/build-server.ts writes
// (main.meta.json, main.inputs.json and, when e2e.mjs exists, the e2e pair)
// and the sources they list, and fails (exit 1, one line per finding) on:
//
// 1. Inputs. A main.mjs input under `test-support/`, `worker/test/` or any
//    `router-transport` module; an input worker/src/do/index-do.ts,
//    worker/src/scheduled.ts, worker/src/env.ts, worker/src/index.ts or
//    worker/src/router.ts (host-neutral code reaches only http/routes.ts and
//    app/index-core.ts); a `cloudflare:` import (in the metafile or the bundle
//    text).
// 2. Fixture options, at call sites (not in bundle text: the production
//    sources legitimately hold fixture-mode code, `isFixtureTransport`, the
//    `fixture` transport mark and the `fixtureOrigins?: boolean` parameter).
//    Like worker/test/acceptance/security.test.ts:392-407, every worker/src
//    and packages/*/src input is scanned with comments removed (and, for the
//    identifier rules, string contents blanked) for `fixtureOrigins: true`,
//    `fixture: true` passed as a value (a type position such as
//    `{ readonly fixture: true }` is not one), `allowFixturePrefix: true`,
//    `routerTransport`, `fixtureTransport`, `fixedClock`, `seededRandom` and
//    an import from a `test-support` path. `com.example.atmusic` handling is
//    any occurrence of the fixture prefix other than its two definitions
//    (`export const FIXTURE_PREFIX = 'com.example.atmusic';` in
//    worker/src/config.ts and packages/core/src/namespace.ts). The scan is not
//    vacuous: it must cover at least 60 files and find the one opt-in
//    parameter `fixtureOrigins?: boolean` in worker/src/node/config.ts.
// 3. The crypto build. The bundle's `@atcute/crypto` secp256k1 build (its
//    `#keypairs/secp256k1` subpath import, ADR §3.9) must be the file the
//    worker-node vitest project resolves: Node's own resolution (vitest runs
//    node_modules dependencies externalised, in Node), with the conditions
//    `node`, `import`, `default` plus any `conditions: [...]` that
//    worker/vitest.node.config.ts sets.
// 4. Unpinned fetch paths (§3.5 rule 3). In the worker/src and packages/*/src
//    inputs, only these may reference `globalThis.fetch`, a bare `fetch(`
//    call or `fetchTransport`:
//      worker/src/node/pinned-transport.ts, worker/src/node/policy-fetch.ts;
//      the fallback sites createIdentityResolver
//      (packages/atproto/src/identity/resolver.ts), createHandleResolver
//      (identity/handle.ts) and createSafeFetch (net/safe-fetch.ts), and
//      fetchTransport's own definition (packages/atproto/src/transport.ts);
//      the Workers Jetstream connector's default fetch
//      (worker/src/do/ingest/jetstream-socket.ts, `createJetstreamConnector`,
//      which the Node host never calls: run() passes the ws connector),
//      until N7-01 removes the Workers host. IndexDO.buildDeps, the fourth
//      site of §3.5, is in worker/src/do/index-do.ts, which rule 1 already
//      keeps out of main.mjs;
//      run.ts's single statement installing the stub,
//      `globalThis.fetch = unpinnedFetchStub as typeof fetch;`.
//    A method named fetch (`async fetch(request) {`, `fetch(did): Promise<…>;`)
//    is a definition, not a call. Every production call of
//    createIdentityResolver, createHandleResolver or createSafeFetch must pass
//    a `transport` property, and every `new NodeOAuthClient(…)` a `fetch`
//    property, in an object literal at the call or in the `const` it names.
//    node_modules inputs (undici implements fetch) are not ours to scan.
// 5. The e2e bundle, when e2e.mjs exists: every worker/src and packages/*/src
//    input of main.mjs except worker/src/node/main.ts must be an input of
//    e2e.mjs with the same SHA-256 (recorded at build time), and e2e.mjs may
//    add only worker/test/e2e/, worker/test/node/support/ and test-support
//    inputs. The feature code under test is byte-identical to production, and
//    the e2e bundle never executes the production entry.
//
// On success it prints the git sha `main.mjs --version` reports and the
// bundle SHA-256 (the release identity of B11) and exits 0.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DIST = join(REPO_ROOT, 'worker', 'dist', 'node');
export const MIN_SCANNED_FILES = 60;

export const FORBIDDEN_INPUTS: readonly string[] = [
  'worker/src/do/index-do.ts',
  'worker/src/scheduled.ts',
  'worker/src/env.ts',
  'worker/src/index.ts',
  'worker/src/router.ts',
];

/** Inputs that may reference the global fetch or fetchTransport (rule 4). */
export const FETCH_ALLOWED: readonly string[] = [
  'worker/src/node/pinned-transport.ts',
  'worker/src/node/policy-fetch.ts',
  'packages/atproto/src/identity/resolver.ts',
  'packages/atproto/src/identity/handle.ts',
  'packages/atproto/src/net/safe-fetch.ts',
  'packages/atproto/src/transport.ts',
  'worker/src/do/ingest/jetstream-socket.ts',
];

/** The one statement installing the throwing stub (run.ts). */
export const STUB_INSTALL = /globalThis\.fetch\s*=\s*unpinnedFetchStub(?:\s+as\s+typeof\s+fetch)?\s*;/g;
export const STUB_INSTALL_FILE = 'worker/src/node/run.ts';

export const FIXTURE_PREFIX_DEFINITION = /export const FIXTURE_PREFIX = 'com\.example\.atmusic';/g;
export const FIXTURE_PREFIX_FILES: readonly string[] = ['worker/src/config.ts', 'packages/core/src/namespace.ts'];

/** The esbuild metafile fields the guard reads. */
export interface Metafile {
  inputs: Record<string, { bytes?: number; imports?: Array<{ path: string; external?: boolean; kind?: string }> }>;
  outputs?: Record<string, unknown>;
}

export interface BundleFacts {
  metafile: Metafile;
  /** SHA-256 of each worker/src and packages/*\/src input as built (build-server's <name>.inputs.json). */
  inputHashes: Record<string, string>;
  /** The bundle text (for the cloudflare: check). */
  text: string;
}

export interface AnalyzeOptions {
  main: BundleFacts;
  e2e?: BundleFacts | null;
  /** The source of a repository-relative input path. */
  readSource(path: string): string;
  /** The repository-relative path of the secp256k1 build the worker-node project resolves. */
  expectedCryptoBuild: string;
  /**
   * Whether two repository-relative paths name the same file; default string
   * equality. The CLI compares real paths, so a node_modules reached through a
   * symbolic link (the gate's disposable copies) still matches.
   */
  samePath?: (a: string, b: string) => boolean;
}

// ---------------------------------------------------------------------------
// Source scanning

/**
 * Comments removed (`code`), and comments removed with the contents of
 * string, template and regular-expression literals blanked (`bare`). A small
 * tokenizer: template substitutions stay code; a `/` starts a regular
 * expression where an expression can begin.
 */
export function stripSource(text: string): { code: string; bare: string } {
  let code = '';
  let bare = '';
  const emit = (c: string, b: string = c) => {
    code += c;
    bare += b;
  };
  const templateDepth: number[] = [];
  let braceDepth = 0;
  let lastSignificant = '';
  let lastWord = '';
  const regexAllowedAfterWord = new Set([
    'return',
    'typeof',
    'case',
    'do',
    'else',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'yield',
    'await',
    'instanceof',
  ]);
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  let i = 0;
  const n = text.length;
  const readString = (quote: string): void => {
    let j = i + 1;
    while (j < n && text[j] !== quote && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
    const literal = text.slice(i, Math.min(j + 1, n));
    emit(literal, quote + blank(literal.slice(1, -1)) + (literal.length > 1 ? quote : ''));
    i = j + 1;
    lastSignificant = quote;
    lastWord = '';
  };
  const readTemplateChunk = (): void => {
    // i is just after ` or }; read until ` or ${
    let j = i;
    while (j < n) {
      if (text[j] === '\\') {
        j += 2;
        continue;
      }
      if (text[j] === '`') break;
      if (text[j] === '$' && text[j + 1] === '{') break;
      j++;
    }
    const chunk = text.slice(i, j);
    emit(chunk, blank(chunk));
    i = j;
    if (text[i] === '`') {
      emit('`');
      i++;
      lastSignificant = '`';
    } else if (text[i] === '$') {
      emit('${');
      i += 2;
      templateDepth.push(braceDepth);
      braceDepth++;
      lastSignificant = '{';
    }
    lastWord = '';
  };
  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      const comment = text.slice(i, stop);
      const newlines = comment.replace(/[^\n]/g, '');
      emit(newlines.length > 0 ? newlines : ' ');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      readString(c);
      continue;
    }
    if (c === '`') {
      emit('`');
      i++;
      readTemplateChunk();
      continue;
    }
    if (c === '}' && templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braceDepth - 1) {
      templateDepth.pop();
      braceDepth--;
      emit('}');
      i++;
      readTemplateChunk();
      continue;
    }
    if (c === '/') {
      const regexAllowed =
        lastSignificant === '' ||
        '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant) ||
        regexAllowedAfterWord.has(lastWord);
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < n && text[j] !== '\n') {
          const d = text[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(text[j] as string)) j++;
        const literal = text.slice(i, j);
        emit(literal, `/${blank(literal.slice(1))}`);
        i = j;
        lastSignificant = '/';
        lastWord = '';
        continue;
      }
    }
    if (c === '{') braceDepth++;
    if (c === '}') braceDepth--;
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j] as string)) j++;
      const word = text.slice(i, j);
      emit(word);
      i = j;
      lastWord = word;
      lastSignificant = 'a';
      continue;
    }
    emit(c);
    if (!/\s/.test(c)) {
      lastSignificant = c;
      lastWord = '';
    }
    i++;
  }
  return { code, bare };
}

/** The text between the parenthesis at `open` and its match (exclusive), or null. */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Top-level property names of an object literal's inner text (shorthand included); null when `...` spreads. */
function topLevelKeys(inner: string): string[] | null {
  const keys: string[] = [];
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  let spread = false;
  for (const part of parts) {
    const p = part.trim();
    if (p === '') continue;
    if (p.startsWith('...')) {
      spread = true;
      continue;
    }
    const m = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::|\(|$)/.exec(p);
    if (m) keys.push(m[1] as string);
  }
  return spread && keys.length === 0 ? null : keys;
}

/** Whether the call argument text `args` passes `property` (object literal, or a `const` of one in `bare`). */
export function passesProperty(args: string, property: string, bare: string): boolean {
  const first = args.trim();
  let literal: string | null = null;
  if (first.startsWith('{')) {
    literal = balanced(first, 0);
  } else {
    const id = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(first)?.[1];
    if (id !== undefined) {
      const decl = new RegExp(`\\b(?:const|let)\\s+${id.replace(/\$/g, '\\$')}\\b[^=;]*=\\s*\\{`).exec(bare);
      if (decl) literal = balanced(bare, decl.index + decl[0].length - 1);
    }
  }
  if (literal === null) return false;
  return (topLevelKeys(literal) ?? []).includes(property);
}

export interface Finding {
  rule: string;
  file: string;
  message: string;
}

const isOurSource = (path: string): boolean => path.startsWith('worker/src/') || /^packages\/[^/]+\/src\//.test(path);

/** `fetch(` occurrences in `bare` that are calls (not method definitions or signatures). */
export function bareFetchCalls(bare: string): number[] {
  const out: number[] = [];
  const re = /(?<![\w$.])fetch\s*\(/g;
  for (let m = re.exec(bare); m !== null; m = re.exec(bare)) {
    const open = m.index + m[0].length - 1;
    const before = bare.slice(0, m.index).replace(/\s+$/, '');
    const prev = before.slice(-1);
    const prevWord = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1] ?? '';
    const inner = balanced(bare, open);
    const after = inner === null ? '' : bare.slice(open + inner.length + 2).replace(/^\s+/, '');
    const definitionStart = prev === '' || '{};,'.includes(prev) || prevWord === 'async';
    const definitionEnd = after.startsWith('{') || after.startsWith(':');
    if (definitionStart && definitionEnd) continue;
    if (prevWord === 'function') continue;
    out.push(m.index);
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Rule 2 and 4 over one source file. */
export function scanSource(path: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, message: string) => findings.push({ rule, file: path, message });
  const { code, bare } = stripSource(source);

  // Rule 2: fixture options at call sites.
  if (/from\s+['"][^'"]*test-support[^'"]*['"]|import\s*\(\s*['"][^'"]*test-support/.test(code)) {
    add('fixture', 'imports from a test-support path');
  }
  for (const [name, re] of [
    ['fixtureOrigins: true', /\bfixtureOrigins\s*:\s*true\b/],
    ['allowFixturePrefix: true', /\ballowFixturePrefix\s*:\s*true\b/],
    ['routerTransport', /\brouterTransport\b/],
    ['fixtureTransport', /\bfixtureTransport\b/],
    ['fixedClock', /\bfixedClock\b/],
    ['seededRandom', /\bseededRandom\b/],
  ] as const) {
    const m = re.exec(bare);
    if (m) add('fixture', `${name} at line ${lineOf(bare, m.index)}`);
  }
  const fixtureValue = /\bfixture\s*:\s*true\b/g;
  for (let m = fixtureValue.exec(bare); m !== null; m = fixtureValue.exec(bare)) {
    const lineStart = bare.lastIndexOf('\n', m.index) + 1;
    const head = bare.slice(lineStart, m.index);
    const typePosition = /\breadonly\s+$/.test(head) || /^\s*(?:export\s+)?(?:type|interface)\b/.test(head);
    if (!typePosition) add('fixture', `fixture: true passed as a value at line ${lineOf(bare, m.index)}`);
  }
  let prefixCode = code;
  if (FIXTURE_PREFIX_FILES.includes(path)) prefixCode = prefixCode.replace(FIXTURE_PREFIX_DEFINITION, '');
  const prefix = /com\.example\.atmusic/.exec(prefixCode);
  if (prefix) add('fixture', `com.example.atmusic handled at line ${lineOf(prefixCode, prefix.index)}`);

  // Rule 4: unpinned fetch paths.
  if (!FETCH_ALLOWED.includes(path)) {
    const scanned = path === STUB_INSTALL_FILE ? bare.replace(STUB_INSTALL, ' ') : bare;
    const global = /\bglobalThis\s*\.\s*fetch\b/.exec(scanned);
    if (global) add('unpinned_fetch', `references globalThis.fetch at line ${lineOf(scanned, global.index)}`);
    for (const at of bareFetchCalls(scanned))
      add('unpinned_fetch', `calls the global fetch at line ${lineOf(scanned, at)}`);
    const transport = /\bfetchTransport\b/.exec(scanned);
    if (transport) add('unpinned_fetch', `references fetchTransport at line ${lineOf(scanned, transport.index)}`);
  }
  for (const [callee, property] of [
    ['createIdentityResolver', 'transport'],
    ['createHandleResolver', 'transport'],
    ['createSafeFetch', 'transport'],
    ['new NodeOAuthClient', 'fetch'],
  ] as const) {
    const re = new RegExp(`(?<![\\w$.])${callee.replace(' ', '\\s+')}\\s*(?:<[^>()]*>)?\\s*\\(`, 'g');
    for (let m = re.exec(bare); m !== null; m = re.exec(bare)) {
      const before = bare.slice(0, m.index).replace(/\s+$/, '');
      if (/\bfunction$/.test(before)) continue;
      const open = m.index + m[0].length - 1;
      const args = balanced(bare, open);
      if (args === null || !passesProperty(args, property, bare)) {
        add(
          'unpinned_fetch',
          `${callee}(…) at line ${lineOf(bare, m.index)} does not pass its ${property} property (ADR 0005 §3.5)`,
        );
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The analysis

export interface Analysis {
  findings: Finding[];
  scannedFiles: number;
}

const TEST_SUPPORT = /(^|\/)test-support\//;
const ROUTER_TRANSPORT = /(^|\/)router-transport(\.[a-z]+)?$/;

export function analyzeNodeBundle(options: AnalyzeOptions): Analysis {
  const findings: Finding[] = [];
  const add = (rule: string, file: string, message: string) => findings.push({ rule, file, message });
  const mainInputs = Object.keys(options.main.metafile.inputs);

  // Rule 1.
  for (const input of mainInputs) {
    if (TEST_SUPPORT.test(input)) add('input', input, 'main.mjs bundles a test-support module');
    if (input.startsWith('worker/test/')) add('input', input, 'main.mjs bundles a worker/test module');
    if (ROUTER_TRANSPORT.test(input)) add('input', input, 'main.mjs bundles the fixture router transport');
    if (FORBIDDEN_INPUTS.includes(input)) add('input', input, 'main.mjs bundles a Workers-only module');
    for (const imported of options.main.metafile.inputs[input]?.imports ?? []) {
      if (imported.path.startsWith('cloudflare:')) add('input', input, `imports ${imported.path}`);
    }
  }
  const cloudflare = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']cloudflare:[a-z-]*["']/.exec(options.main.text);
  if (cloudflare)
    add('input', 'main.mjs', `the bundle imports ${cloudflare[0].replace(/^.*["'](cloudflare:[a-z-]*)["']$/, '$1')}`);

  // Rules 2 and 4.
  const sources = mainInputs.filter(isOurSource);
  let optInFound = false;
  for (const input of sources) {
    let text: string;
    try {
      text = options.readSource(input);
    } catch {
      add('input', input, 'source listed in the metafile cannot be read');
      continue;
    }
    for (const f of scanSource(input, text)) findings.push(f);
    if (input === 'worker/src/node/config.ts' && /\bfixtureOrigins\?\s*:\s*boolean\b/.test(stripSource(text).code)) {
      optInFound = true;
    }
  }
  if (sources.length < MIN_SCANNED_FILES) {
    add('vacuous', 'main.mjs', `the call-site scan covered ${sources.length} files, fewer than ${MIN_SCANNED_FILES}`);
  }
  if (!optInFound) {
    add('vacuous', 'worker/src/node/config.ts', 'the opt-in parameter `fixtureOrigins?: boolean` was not found');
  }

  // Rule 3.
  const cryptoBuilds = mainInputs.filter((p) =>
    /node_modules\/@atcute\/crypto\/dist\/keypairs\/secp256k1-[^/]*\.js$/.test(p),
  );
  if (cryptoBuilds.length !== 1) {
    add('crypto', 'main.mjs', `expected one @atcute/crypto secp256k1 build input, found ${cryptoBuilds.length}`);
  } else if (!(options.samePath ?? ((a, b) => a === b))(cryptoBuilds[0] as string, options.expectedCryptoBuild)) {
    add(
      'crypto',
      'main.mjs',
      `the bundle's @atcute/crypto build is ${cryptoBuilds[0]}, the worker-node project resolves ${options.expectedCryptoBuild}`,
    );
  }

  // Rule 5.
  const e2e = options.e2e;
  if (e2e !== undefined && e2e !== null) {
    const e2eInputs = new Set(Object.keys(e2e.metafile.inputs));
    for (const input of sources) {
      if (input === 'worker/src/node/main.ts') continue;
      if (!e2eInputs.has(input)) {
        add('e2e', input, 'is a main.mjs input missing from e2e.mjs');
        continue;
      }
      const a = options.main.inputHashes[input];
      const b = e2e.inputHashes[input];
      if (a === undefined || b === undefined || a !== b) {
        add('e2e', input, 'differs between main.mjs and e2e.mjs');
      }
    }
    const mainSet = new Set(mainInputs);
    for (const input of e2eInputs) {
      if (mainSet.has(input)) continue;
      const allowed =
        input.startsWith('worker/test/e2e/') ||
        input.startsWith('worker/test/node/support/') ||
        TEST_SUPPORT.test(input);
      if (!allowed)
        add('e2e', input, 'e2e.mjs adds an input outside worker/test/e2e, worker/test/node/support and test-support');
    }
    if (e2eInputs.has('worker/src/node/main.ts'))
      add('e2e', 'worker/src/node/main.ts', 'e2e.mjs bundles the production entry');
  }
  return { findings, scannedFiles: sources.length };
}

// ---------------------------------------------------------------------------
// The crypto build the worker-node project resolves

type Target = string | null | { [condition: string]: Target } | Target[];

/** Node's PACKAGE_TARGET_RESOLVE condition matching over a conditional target. */
function resolveConditional(target: Target, conditions: ReadonlySet<string>): string | null {
  if (typeof target === 'string') return target;
  if (target === null) return null;
  if (Array.isArray(target)) {
    for (const t of target) {
      const r = resolveConditional(t, conditions);
      if (r !== null) return r;
    }
    return null;
  }
  for (const [key, value] of Object.entries(target)) {
    if (conditions.has(key)) {
      const r = resolveConditional(value, conditions);
      if (r !== null) return r;
    }
  }
  return null;
}

/** The `conditions: [...]` strings set in a vitest config text. */
export function configuredConditions(configText: string): string[] {
  const { code } = stripSource(configText);
  const m = /\bconditions\s*:\s*\[([^\]]*)\]/.exec(code);
  if (m === null) return [];
  return [...(m[1] as string).matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1] as string);
}

/** The repository-relative secp256k1 build file Node resolves for the worker package. */
export function workerNodeCryptoBuild(root = REPO_ROOT): string {
  let dir = join(root, 'worker');
  let pkgDir: string | null = null;
  for (;;) {
    const candidate = join(dir, 'node_modules', '@atcute', 'crypto');
    if (existsSync(join(candidate, 'package.json'))) {
      pkgDir = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (pkgDir === null) throw new Error('@atcute/crypto is not installed (run npm ci)');
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { imports?: Record<string, Target> };
  const target = pkg.imports?.['#keypairs/secp256k1'];
  if (target === undefined) throw new Error('@atcute/crypto has no #keypairs/secp256k1 import map entry');
  let extra: string[] = [];
  const configPath = join(root, 'worker', 'vitest.node.config.ts');
  if (existsSync(configPath)) extra = configuredConditions(readFileSync(configPath, 'utf8'));
  const resolved = resolveConditional(target, new Set(['node', 'import', 'default', ...extra]));
  if (resolved === null) throw new Error('no condition of #keypairs/secp256k1 matches the worker-node project');
  return relative(root, join(pkgDir, resolved)).split(sep).join('/');
}

// ---------------------------------------------------------------------------
// CLI

function readFacts(dist: string, name: 'main' | 'e2e'): BundleFacts | null {
  const bundle = join(dist, `${name}.mjs`);
  if (!existsSync(bundle)) return null;
  const metafile = JSON.parse(readFileSync(join(dist, `${name}.meta.json`), 'utf8')) as Metafile;
  const hashesPath = join(dist, `${name}.inputs.json`);
  const inputHashes = existsSync(hashesPath)
    ? (JSON.parse(readFileSync(hashesPath, 'utf8')) as Record<string, string>)
    : {};
  return { metafile, inputHashes, text: readFileSync(bundle, 'utf8') };
}

export interface GuardIo {
  out(line: string): void;
  err(line: string): void;
}

export interface GuardOptions {
  dist?: string;
  root?: string;
  /** Default: workerNodeCryptoBuild(root). */
  expectedCryptoBuild?: string;
}

/** Runs the guard over a built dist directory; returns the exit status. */
export function runGuard(options: GuardOptions = {}, io: GuardIo = { out: console.log, err: console.error }): number {
  const root = options.root ?? REPO_ROOT;
  const dist = options.dist ?? DEFAULT_DIST;
  let main: BundleFacts | null;
  let e2e: BundleFacts | null;
  try {
    main = readFacts(dist, 'main');
    e2e = readFacts(dist, 'e2e');
  } catch (error) {
    io.err(`check-node-bundle: cannot read the build in ${dist}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  if (main === null) {
    io.err(`check-node-bundle: ${join(dist, 'main.mjs')} does not exist; run scripts/build-server.ts first`);
    return 1;
  }
  let expectedCryptoBuild: string;
  try {
    expectedCryptoBuild = options.expectedCryptoBuild ?? workerNodeCryptoBuild(root);
  } catch (error) {
    io.err(`check-node-bundle: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  const analysis = analyzeNodeBundle({
    main,
    e2e,
    expectedCryptoBuild,
    readSource: (path) => readFileSync(isAbsolute(path) ? path : join(root, path), 'utf8'),
    samePath: (a, b) => {
      const real = (p: string): string => {
        try {
          return realpathSync(isAbsolute(p) ? p : join(root, p));
        } catch {
          return `missing:${p}`;
        }
      };
      return real(a) === real(b);
    },
  });
  if (analysis.findings.length > 0) {
    for (const f of analysis.findings) io.err(`FAIL [${f.rule}] ${f.file}: ${f.message}`);
    io.err(`check-node-bundle: ${analysis.findings.length} finding(s) in ${join(dist, 'main.mjs')}`);
    return 1;
  }
  const bundlePath = join(dist, 'main.mjs');
  const version = spawnSync(process.execPath, [bundlePath, '--version'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
    timeout: 60_000,
  });
  const sha = version.stdout?.trim() ?? '';
  if (version.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    io.err(`check-node-bundle: \`node main.mjs --version\` exited ${version.status} printing ${JSON.stringify(sha)}`);
    return 1;
  }
  const bundleSha = createHash('sha256').update(readFileSync(bundlePath)).digest('hex');
  io.out(
    `PASS check-node-bundle: ${analysis.scannedFiles} sources scanned, crypto build ${expectedCryptoBuild}` +
      (e2e === null ? ', no e2e.mjs' : ', e2e.mjs inputs match'),
  );
  io.out(`git sha ${sha}`);
  io.out(`bundle sha256 ${bundleSha}  main.mjs`);
  return 0;
}

function parseCli(argv: readonly string[]): GuardOptions | null {
  const options: GuardOptions = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist' && argv[i + 1] !== undefined) {
      options.dist = resolve(argv[i + 1] as string);
      i++;
    } else {
      return null;
    }
  }
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCli(process.argv.slice(2));
  if (options === null) {
    console.error('usage: check-node-bundle.ts [--dist DIR]');
    process.exitCode = 2;
  } else {
    process.exitCode = runGuard(options);
  }
}

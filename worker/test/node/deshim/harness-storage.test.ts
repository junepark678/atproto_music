// The de-shim of the harness and storage suites and of the shared test helpers
// (ADR 0005 §15.1 step 2, N4-04), checked statically and at runtime:
//
// - no listed file imports `cloudflare:test` or `cloudflare:workers` (static,
//   dynamic, `typeof import()` or mocked), or one of the files those resolve
//   to in worker-modules (the shim, its storage facade, the harness DO and
//   the shimmed LocalIndex) by path, directly or through any module it
//   evaluates (relative imports and the @atmusic/* packages are resolved and
//   walked); the one allowed edge is worker/test/write/support.ts's stubFor
//   import of the workers shim, kept for the N4-05/N4-06 suites until N7-01
//   and asserted to be used exactly there; and no listed file references
//   `WebSocketPair` in code;
// - every test id node-port-inventory.json marks kept (or names as a
//   replacement) under worker/test/storage and worker/test/harness, and every
//   one node-waves.json declares there, is still declared with that exact
//   title in its file;
// - worker/test/write/support.ts and worker/test/fixtures/jetstream-server.ts
//   export the same names, with the same kinds and function arities, as at the
//   start of wave 4 (commit e309f52, recorded below; when that commit is in the
//   repository the record is checked against its sources too).
//
// "Declared" means the first argument of a describe/it/test call is a string
// literal with that value, found by a scanner that skips comments, strings and
// regular expression literals. Each detector also runs against a source that
// must fail it, so none of the checks is vacuous.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config';
import type { Db } from '../../../src/do/db';
import * as jetstreamServerModule from '../../fixtures/jetstream-server';
import * as writeSupportModule from '../../write/support';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SEP = ' › ';
/** The integration commit at which wave 4 started (feat/mvp-complete "wave 3: integrate"). */
const WAVE_START = 'e309f52c0c8fba3cb0949edf7284d932b09edb4f';

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const THIS_FILE = relative(ROOT, fileURLToPath(import.meta.url))
  .split(sep)
  .join('/');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = `${dir}/${entry}`;
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(path);
  }
  return out.sort();
}

const HARNESS_TESTS = [
  'worker/test/harness/local-index.test.ts',
  'worker/test/harness/isolation.test.ts',
  'worker/test/harness/isolation-peer.test.ts',
  'worker/test/harness/isolation-probe.ts',
];
const SHARED_HELPERS = ['worker/test/write/support.ts', 'worker/test/fixtures/jetstream-server.ts'];
/** The Node harness that replaces the shim for these suites. */
const NODE_HARNESS = 'worker/test/node/support/with-index.ts';

// ---------------------------------------------------------------------------
// A small JS/TS scanner: code with comments removed, string literals and
// regular expression literals kept intact (so a quote inside a regex or a
// `//` inside a string is never mistaken for anything else).

interface Literal {
  kind: 'string';
  quote: string;
  body: string;
  dynamic: boolean;
  start: number;
  end: number;
}

/** Reads the string literal starting at `src[i]` (a quote). */
function readString(src: string, i: number): Literal {
  const quote = src[i] as string;
  let j = i + 1;
  let dynamic = false;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (quote === '`' && depth === 0 && c === '$' && src[j + 1] === '{') {
      dynamic = true;
      depth = 1;
      j += 2;
      continue;
    }
    if (depth > 0) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      j++;
      continue;
    }
    if (c === quote) break;
    j++;
  }
  return { kind: 'string', quote, body: src.slice(i + 1, j), dynamic, start: i, end: j + 1 };
}

const BEFORE_REGEX = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'else',
  'do',
  'yield',
  'await',
]);

function regexEnd(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== '\n') {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
    } else if (c === '[') inClass = true;
    else if (c === '/') break;
    j++;
  }
  j++;
  while (j < src.length && /[a-z]/i.test(src[j] as string)) j++;
  return j;
}

interface Scan {
  /** The source with every comment replaced by a space. */
  code: string;
  /** Every string literal, with its offset in `code`. */
  strings: Literal[];
}

function scan(src: string): Scan {
  let code = '';
  const strings: Literal[] = [];
  let i = 0;
  let prev = '';
  let word = '';
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const eol = src.indexOf('\n', i);
      i = eol === -1 ? src.length : eol;
      code += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      code += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const s = readString(src, i);
      strings.push({ ...s, start: code.length, end: code.length + (s.end - s.start) });
      code += src.slice(s.start, s.end);
      i = s.end;
      prev = c;
      word = '';
      continue;
    }
    if (c === '/' && (prev === '' || BEFORE_REGEX.has(prev) || KEYWORDS_BEFORE_REGEX.has(word))) {
      const end = regexEnd(src, i);
      code += src.slice(i, end);
      i = end;
      prev = '/';
      word = '';
      continue;
    }
    if (/\s/.test(c)) {
      code += c;
      i++;
      continue;
    }
    const ident = /[\w$]+/y;
    ident.lastIndex = i;
    const w = ident.exec(src);
    if (w !== null) {
      word = w[0];
      prev = word.at(-1) as string;
      code += word;
      i += word.length;
      continue;
    }
    prev = c;
    word = '';
    code += c;
    i++;
  }
  return { code, strings };
}

/** The value of a JS string literal body. */
function unescapeJs(body: string): string {
  return body.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|\n|\r)|(.))/gs,
    (_m, cp, u4, x2, newline, ch) => {
      if (cp !== undefined) return String.fromCodePoint(Number.parseInt(cp, 16));
      if (u4 !== undefined) return String.fromCharCode(Number.parseInt(u4, 16));
      if (x2 !== undefined) return String.fromCharCode(Number.parseInt(x2, 16));
      if (newline !== undefined) return '';
      return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' } as Record<string, string>)[ch] ?? ch;
    },
  );
}

// ---------------------------------------------------------------------------
// Detectors

const FORBIDDEN_MODULES = new Set(['cloudflare:test', 'cloudflare:workers']);

/**
 * The shim and the shimmed harness by file: what `cloudflare:test` and
 * `cloudflare:workers` resolve to in worker-modules (worker/vitest.modules.
 * config.ts aliases), the storage facade under them, the harness DO, its
 * entry and setup, and the shimmed LocalIndex. Importing one of these by
 * path is the same reach as importing the specifier.
 */
const FORBIDDEN_FILES = new Set([
  'worker/test/node/support/cloudflare-test-shim.ts',
  'worker/test/node/support/cloudflare-workers-shim.ts',
  'worker/test/node/support/do-storage-facade.ts',
  'worker/test/node/support/workerd-globals.ts',
  'worker/test/harness/harness-do.ts',
  'worker/test/harness/entry.ts',
  'worker/test/harness/local-index.ts',
]);

/**
 * The one allowed edge: worker/test/write/support.ts keeps `stubFor(name)`
 * (its exported API is frozen for this wave), which returns the shim's
 * harness DO stub, for the suites N4-05 (worker/test/ingest/) and N4-06
 * (worker/test/read/, write/*.test.ts, http/) de-shim. The walk does not
 * cross it, and the test asserts it is used exactly here and that every
 * caller of stubFor through support.ts belongs to N4-05 or N4-06. N7-01
 * deletes the shim and this allowance.
 */
const ALLOWED_EDGE = {
  from: 'worker/test/write/support.ts',
  to: 'worker/test/node/support/cloudflare-workers-shim.ts',
} as const;

const CODE_FILE = /\.(ts|mts|js|mjs)$/;

interface ImportRef {
  spec: string;
  line: number;
}

/** Every module specifier `src` imports (`from`, side-effect, dynamic, `typeof import()`, require, vi.mock). */
function importsOf(src: string): ImportRef[] {
  const { code, strings } = scan(src);
  const out: ImportRef[] = [];
  for (const s of strings) {
    if (s.dynamic) continue;
    const before = code.slice(0, s.start);
    if (
      /\bfrom\s*$/.test(before) ||
      /\bimport\s*$/.test(before) ||
      /\b(?:import|require|vi\s*\.\s*(?:mock|doMock|importActual|importMock))\s*\(\s*$/.test(before)
    ) {
      out.push({ spec: unescapeJs(s.body), line: code.slice(0, s.start).split('\n').length });
    }
  }
  return out;
}

type Target =
  | { kind: 'file'; path: string }
  | { kind: 'module'; name: string }
  | { kind: 'asset'; path: string }
  | { kind: 'unresolved'; spec: string };

/** Posix-normalizes a repository-relative path; null when it climbs out of the repository. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Resolves `spec` imported by `from` the way the worker projects do: relative
 * paths (extensionless, `.js` for `.ts`, `/index`), the `@atmusic/*` workspace
 * packages (their `exports`: `./test-support/*` and `./*` -> `./src/*`), and
 * everything else as a bare module name. `?raw` and non-code files are assets
 * (read as data, never evaluated).
 */
function resolveImport(from: string, spec: string, exists: (path: string) => boolean): Target {
  const query = spec.indexOf('?');
  const bare = query === -1 ? spec : spec.slice(0, query);
  let base: string | null;
  if (bare.startsWith('./') || bare.startsWith('../')) base = normalize(`${dirname(from)}/${bare}`);
  else {
    const m = /^@atmusic\/(core|atproto)\/(.+)$/.exec(bare);
    if (m === null) return { kind: 'module', name: bare };
    const sub = m[2] as string;
    base = `packages/${m[1]}/${sub.startsWith('test-support/') ? sub : `src/${sub}`}`;
  }
  if (base === null) return { kind: 'unresolved', spec };
  const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}/index.ts`];
  if (/\.m?js$/.test(base)) candidates.unshift(base.replace(/\.(m?)js$/, '.$1ts'));
  const path = candidates.find((c) => exists(c) && (c === base ? !c.endsWith('/') : true));
  if (path === undefined) return { kind: 'unresolved', spec };
  if (query !== -1 || !CODE_FILE.test(path)) return { kind: 'asset', path };
  return { kind: 'file', path };
}

interface Reach {
  violations: string[];
  /** `file:line` of every use of ALLOWED_EDGE met on the walk. */
  allowed: string[];
  /** Every repository module evaluated by importing the roots (the roots included). */
  closure: string[];
}

interface Sources {
  read: (file: string) => string;
  exists: (file: string) => boolean;
}

const REPO: Sources = {
  read,
  exists: (file) => {
    try {
      return statSync(join(ROOT, file)).isFile();
    } catch {
      return false;
    }
  },
};

/** The parsed imports of repository files, shared by the walks of this file. */
const REPO_IMPORTS = new Map<string, ImportRef[]>();

/**
 * Walks every module `roots` import, directly or transitively, and reports
 * each import of a forbidden specifier or a forbidden file (other than
 * ALLOWED_EDGE, which is recorded and not crossed), and each relative import
 * that does not resolve, with the import chain that reaches it.
 */
function shimReach(roots: string[], sources: Sources = REPO): Reach {
  const parsed = sources === REPO ? REPO_IMPORTS : new Map<string, ImportRef[]>();
  const importsIn = (file: string): ImportRef[] => {
    const cached = parsed.get(file);
    if (cached !== undefined) return cached;
    const refs = importsOf(sources.read(file));
    parsed.set(file, refs);
    return refs;
  };
  const violations: string[] = [];
  const allowed: string[] = [];
  const via = new Map<string, string>();
  const queue = [...roots];
  for (const root of roots) via.set(root, '');
  const chain = (file: string): string => {
    const steps: string[] = [];
    for (let f: string | undefined = file; f !== undefined && f !== ''; f = via.get(f)) steps.unshift(f);
    return steps.join(' -> ');
  };
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const { spec, line } of importsIn(file)) {
      const at = `${chain(file)}:${line}`;
      const target = resolveImport(file, spec, sources.exists);
      if (target.kind === 'module') {
        if (FORBIDDEN_MODULES.has(target.name)) violations.push(`${at} imports ${target.name}`);
      } else if (target.kind === 'unresolved') {
        if (spec.startsWith('.')) violations.push(`${at} imports ${spec}, which does not resolve`);
      } else if (FORBIDDEN_FILES.has(target.path)) {
        if (file === ALLOWED_EDGE.from && target.path === ALLOWED_EDGE.to) allowed.push(`${file}:${line}`);
        else violations.push(`${at} imports ${target.path}`);
      } else if (target.kind === 'file' && !via.has(target.path)) {
        via.set(target.path, file);
        queue.push(target.path);
      }
    }
  }
  return { violations, allowed: [...new Set(allowed)].sort(), closure: [...via.keys()].sort() };
}

/** The source with comments and string literals blanked (line structure kept). */
function codeOnly(src: string): string {
  const { code, strings } = scan(src);
  let masked = code;
  for (const s of [...strings].reverse())
    masked = masked.slice(0, s.start) + code.slice(s.start, s.end).replace(/[^\n]/g, ' ') + masked.slice(s.end);
  return masked;
}

/** Every `WebSocketPair` identifier in code (comments and strings skipped; MemoryWebSocketPair is another name). */
function webSocketPairRefs(file: string, src: string): string[] {
  const masked = codeOnly(src);
  return [...masked.matchAll(/(?<![\w$])WebSocketPair(?![\w$])/g)].map(
    (m) => `${file}:${masked.slice(0, m.index ?? 0).split('\n').length} references WebSocketPair`,
  );
}

/** The direct form of the check, on one source: its forbidden imports (by specifier or by path) and WebSocketPair references. */
function shimViolations(file: string, src: string): string[] {
  const out: string[] = [];
  for (const { spec, line } of importsOf(src)) {
    const target = resolveImport(file, spec, REPO.exists);
    if (target.kind === 'module' && FORBIDDEN_MODULES.has(target.name))
      out.push(`${file}:${line} imports ${target.name}`);
    if ((target.kind === 'file' || target.kind === 'asset') && FORBIDDEN_FILES.has(target.path))
      out.push(`${file}:${line} imports ${target.path}`);
  }
  return [...out, ...webSocketPairRefs(file, src)];
}

/** Virtual sources over the repository, for the negative controls. */
function overlay(files: Record<string, string>): Sources {
  return {
    read: (file) => files[file] ?? read(file),
    exists: (file) => file in files || REPO.exists(file),
  };
}

interface Declaration {
  kind: 'describe' | 'test';
  title: string;
}

const CALL = /(?<![\w$.])(describe|it|test)((?:\s*\.\s*\w+(?:\s*\([^()]*\))?)*)\s*\(\s*$/;

/** Every describe/it/test call whose first argument is a fixed string literal. */
function declarations(src: string): Declaration[] {
  const { code, strings } = scan(src);
  const out: Declaration[] = [];
  for (const s of strings) {
    if (s.dynamic) continue;
    const m = CALL.exec(code.slice(Math.max(0, s.start - 200), s.start));
    if (m === null) continue;
    out.push({ kind: m[1] === 'describe' ? 'describe' : 'test', title: unescapeJs(s.body) });
  }
  return out;
}

/** What is missing for `id` (file › describes › title) in the repository; [] when declared. */
function idProblems(id: string, source: (file: string) => string): string[] {
  const parts = id.split(SEP);
  const file = parts[0] as string;
  const title = parts.at(-1) as string;
  const ancestors = parts.slice(1, -1);
  let src: string;
  try {
    src = source(file);
  } catch {
    return [`${id}: file missing`];
  }
  const declared = declarations(src);
  const problems: string[] = [];
  for (const name of ancestors) {
    if (!declared.some((d) => d.kind === 'describe' && d.title === name)) problems.push(`${id}: describe not declared`);
  }
  if (!declared.some((d) => d.kind === 'test' && d.title === title)) problems.push(`${id}: test not declared`);
  return problems;
}

/** Top-level `export` declarations: value and type names (no re-exports in these modules). */
function exportedNames(src: string): { values: string[]; types: string[] } {
  const { code } = scan(src);
  const values: string[] = [];
  const types: string[] = [];
  for (const m of code.matchAll(
    /^export\s+(?:declare\s+)?(async\s+function\*?|function\*?|const|let|var|class|interface|type|enum)\s+([\w$]+)/gm,
  )) {
    const kind = m[1] as string;
    (kind === 'interface' || kind === 'type' ? types : values).push(m[2] as string);
  }
  if (/^export\s*(?:\{|\*|default)/m.test(code)) values.push('<unsupported export form>');
  return { values: values.sort(), types: types.sort() };
}

function git(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** The file at the wave-start commit, or null when that commit is not in this repository (a disposable copy). */
function atWaveStart(file: string): string | null {
  if (!git('cat-file', '-e', `${WAVE_START}^{commit}`).ok) return null;
  const r = git('show', `${WAVE_START}:${file}`);
  if (!r.ok) throw new Error(`git show ${WAVE_START}:${file} failed`);
  return r.out;
}

// ---------------------------------------------------------------------------
// The wave-start record (e309f52): [name, typeof, Function.length] of every
// runtime export, and the exported type names.

type RuntimeExport = [name: string, kind: string, arity: number | null];

const WAVE_START_EXPORTS: Record<string, { runtime: RuntimeExport[]; types: string[] }> = {
  'worker/test/write/support.ts': {
    runtime: [
      ['ALICE', 'string', null],
      ['BOB', 'string', null],
      ['CAROL', 'string', null],
      ['FOLLOW', 'string', null],
      ['NOW_MS', 'number', null],
      ['NOW_NS', 'bigint', null],
      ['NOW_STORAGE', 'string', null],
      ['OPTS', 'object', null],
      ['PREFIX', 'string', null],
      ['PROJECTION_TABLES', 'object', null],
      ['SCROBBLE', 'string', null],
      ['SETTINGS', 'string', null],
      ['deleteProof', 'function', 3],
      ['dump', 'function', 1],
      ['fixtureScrobble', 'function', 1],
      ['follow', 'function', 1],
      ['proofAt', 'function', 3],
      ['putProof', 'function', 4],
      ['recordState', 'function', 2],
      ['repoFor', 'function', 1],
      ['scrobble', 'function', 1],
      ['seedSnapshotJob', 'function', 3],
      ['seedUser', 'function', 2],
      ['settings', 'function', 1],
      ['stubFor', 'function', 1],
      ['uriOf', 'function', 3],
      ['userRow', 'function', 2],
    ],
    types: [],
  },
  'worker/test/fixtures/jetstream-server.ts': {
    runtime: [
      ['HARNESS_JETSTREAM_HOST', 'string', null],
      ['checkpointRow', 'function', 1],
      ['flush', 'function', 0],
      ['ingestDeps', 'function', 2],
      ['jetstreamServer', 'function', 1],
      ['zeroJitter', 'object', null],
    ],
    types: ['ConnectAttempt', 'IngestDepsOptions', 'IngestTestDeps', 'JetstreamServer', 'JetstreamServerOptions'],
  },
};

function runtimeExports(module: Record<string, unknown>): RuntimeExport[] {
  return Object.keys(module)
    .sort()
    .map((name) => {
      const value = module[name];
      return [name, typeof value, typeof value === 'function' ? (value as (...a: unknown[]) => unknown).length : null];
    });
}

// ---------------------------------------------------------------------------

describe('N4-04 de-shim: harness, storage and shared helpers', () => {
  it('no file under worker/test/storage, the listed harness tests, worker/test/write/support.ts or worker/test/fixtures/jetstream-server.ts imports cloudflare:test or cloudflare:workers or references WebSocketPair', () => {
    const storage = filesUnder('worker/test/storage');
    expect(storage).toEqual(
      expect.arrayContaining([
        'worker/test/storage/db.test.ts',
        'worker/test/storage/migrate.test.ts',
        'worker/test/storage/no-async-tx.test.ts',
        'worker/test/storage/schema-v2.test.ts',
        'worker/test/storage/sql-conformance.test.ts',
        'worker/test/storage/status.test.ts',
        'worker/test/storage/timers-extensions.test.ts',
        'worker/test/storage/timers.test.ts',
      ]),
    );
    const files = [...storage, ...HARNESS_TESTS, ...SHARED_HELPERS, NODE_HARNESS];
    // Directly: no forbidden specifier or shim file in the listed files' own
    // imports (ALLOWED_EDGE aside) and no WebSocketPair in their code.
    expect(
      files.flatMap((file) =>
        shimViolations(file, read(file)).filter(
          (v) => !(file === ALLOWED_EDGE.from && v.endsWith(` imports ${ALLOWED_EDGE.to}`)),
        ),
      ),
    ).toEqual([]);
    // Transitively: nothing any listed file evaluates imports either, by
    // specifier or by path, except through ALLOWED_EDGE.
    const reach = shimReach(files);
    expect(reach.violations).toEqual([]);
    expect(reach.closure).toEqual(
      expect.arrayContaining([...files, 'worker/src/do/migrate.ts', 'worker/src/node/sqlite-db.ts']),
    );
    expect(reach.closure.filter((f) => FORBIDDEN_FILES.has(f))).toEqual([]);
    expect(reach.closure.filter((f) => /^worker\/test\/(read|ingest|http)\//.test(f))).toEqual([]);

    // ALLOWED_EDGE is used exactly at support.ts's stubFor shim import (the
    // type of the shim's env and the import that loads it), and of the listed
    // files only the storage suites that take seedUser from support.ts reach it.
    expect(reach.allowed).toEqual([`${ALLOWED_EDGE.from}:46`, `${ALLOWED_EDGE.from}:52`]);
    expect(files.filter((f) => f !== ALLOWED_EDGE.from && shimReach([f]).closure.includes(ALLOWED_EDGE.from))).toEqual([
      'worker/test/storage/schema-v2.test.ts',
      'worker/test/storage/timers-extensions.test.ts',
    ]);
    // Any remaining caller of stubFor through support.ts must be a suite of
    // N4-05 or N4-06 (node-waves.json owners), never a listed file. With all
    // three de-shim packages of wave 4 integrated, none is left.
    const waves = JSON.parse(read('docs/planning/node-waves.json')) as Array<{
      packages: Array<{ id: string; files: string[] }>;
    }>;
    const owned = (id: string) => waves.flatMap((w) => w.packages).find((p) => p.id === id)?.files ?? [];
    const remaining = [...owned('N4-05'), ...owned('N4-06')];
    expect(remaining).toEqual(expect.arrayContaining(['worker/test/ingest/', 'worker/test/read/']));
    const ownedByRemaining = (file: string) =>
      remaining.some((o) => (o.endsWith('/') ? file.startsWith(o) : file === o));
    const callsStubForViaSupport = (f: string, src: string) => {
      const importsSupport = importsOf(src).some((i) => {
        const t = resolveImport(f, i.spec, REPO.exists);
        return t.kind === 'file' && t.path === ALLOWED_EDGE.from;
      });
      return importsSupport && /(?<![\w$.])stubFor(?![\w$])/.test(codeOnly(src));
    };
    // Positive and negative controls, so the empty result below is not vacuous.
    expect(
      callsStubForViaSupport(
        'worker/test/ingest/accounts.test.ts',
        "import { stubFor } from '../write/support';\nconst s = stubFor('x');",
      ),
    ).toBe(true);
    expect(
      callsStubForViaSupport(
        'worker/test/ingest/accounts.test.ts',
        "import { stubFor } from '../harness/isolation-probe';\nconst s = stubFor('x');",
      ),
    ).toBe(false);
    expect(
      callsStubForViaSupport(
        'worker/test/ingest/accounts.test.ts',
        "import { ALICE } from '../write/support';\n// stubFor('x') only in a comment",
      ),
    ).toBe(false);
    const callers = filesUnder('worker/test')
      // This file names stubFor in its own regular expression; it never calls it.
      .filter((f) => !f.includes('/.tsbuild/') && f !== ALLOWED_EDGE.from && f !== THIS_FILE)
      .filter((f) => callsStubForViaSupport(f, read(f)));
    expect(callers).toEqual([]);
    expect(callers.filter((f) => !ownedByRemaining(f))).toEqual([]);
    expect(callers.filter((f) => files.includes(f))).toEqual([]);

    // The detector finds every form, and nothing in comments, strings or other names.
    const bad = [
      "import { runInDurableObject } from 'cloudflare:test';",
      'import { env } from "cloudflare:workers";',
      "import 'cloudflare:test';",
      "const m = await import('cloudflare:workers');",
      "vi.mock('cloudflare:workers', async () => ({}));",
      'const pair = new WebSocketPair();',
      'const P = (globalThis as { WebSocketPair?: unknown }).WebSocketPair;',
    ].join('\n');
    expect(shimViolations('bad.ts', bad)).toEqual([
      'bad.ts:1 imports cloudflare:test',
      'bad.ts:2 imports cloudflare:workers',
      'bad.ts:3 imports cloudflare:test',
      'bad.ts:4 imports cloudflare:workers',
      'bad.ts:5 imports cloudflare:workers',
      'bad.ts:6 references WebSocketPair',
      'bad.ts:7 references WebSocketPair',
      'bad.ts:7 references WebSocketPair',
    ]);
    const fine = [
      "// import { env } from 'cloudflare:workers'; and new WebSocketPair() in a comment",
      "/* import 'cloudflare:test' */ const s = 'cloudflare:test';",
      "const t = `new WebSocketPair()`; const pair = new MemoryWebSocketPair(); const r = /'cloudflare:test'/;",
      "import { withIndex } from '../node/support/with-index';",
    ].join('\n');
    expect(shimViolations('fine.ts', fine)).toEqual([]);

    // By path: the shim files and the shimmed harness are reported however the
    // path is spelled, and from any file other than support.ts the allowed
    // target is as forbidden as the rest.
    const byPath = [
      "import { env } from '../node/support/cloudflare-workers-shim';",
      "import { runInDurableObject } from '../node/support/cloudflare-test-shim.ts';",
      "type E = typeof import('../node/support/cloudflare-workers-shim.js')['env'];",
      "const { makeLocalIndex } = await import('../harness/local-index');",
      "import type { HarnessDO } from '../harness/harness-do';",
      "import { openDoStorage } from '../node/support/do-storage-facade';",
      "import { withIndex } from '../node/support/with-index';",
    ].join('\n');
    const at = 'worker/test/storage/by-path.test.ts';
    expect(shimViolations(at, byPath)).toEqual([
      `${at}:1 imports worker/test/node/support/cloudflare-workers-shim.ts`,
      `${at}:2 imports worker/test/node/support/cloudflare-test-shim.ts`,
      `${at}:3 imports worker/test/node/support/cloudflare-workers-shim.ts`,
      `${at}:4 imports worker/test/harness/local-index.ts`,
      `${at}:5 imports worker/test/harness/harness-do.ts`,
      `${at}:6 imports worker/test/node/support/do-storage-facade.ts`,
    ]);
    expect(shimReach([at], overlay({ [at]: byPath })).violations).toHaveLength(6);

    // Transitively: a file that reaches the shim through helpers, by specifier
    // or by path, is reported with the chain, and a relative import that does
    // not resolve is reported rather than skipped.
    const virtual = overlay({
      'worker/test/storage/v-root.test.ts':
        "import { a } from './v-a';\nimport { b } from '../write/v-b.js';\nimport { c } from './v-missing';",
      'worker/test/storage/v-a.ts': "export { x } from './v-c';",
      'worker/test/storage/v-c.ts': "import { env } from 'cloudflare:workers';",
      'worker/test/write/v-b.ts': "\nimport { SELF } from '../node/support/cloudflare-test-shim';",
    });
    expect(shimReach(['worker/test/storage/v-root.test.ts'], virtual).violations).toEqual([
      'worker/test/storage/v-root.test.ts:3 imports ./v-missing, which does not resolve',
      'worker/test/storage/v-root.test.ts -> worker/test/write/v-b.ts:2 imports worker/test/node/support/cloudflare-test-shim.ts',
      'worker/test/storage/v-root.test.ts -> worker/test/storage/v-a.ts -> worker/test/storage/v-c.ts:1 imports cloudflare:workers',
    ]);
    // ALLOWED_EDGE is one edge, not a whitelisted file: support.ts's own shim
    // import is recorded, not reported, and the shim is never walked into.
    const viaSupport = overlay({
      'worker/test/storage/v-support.test.ts': "import { seedUser } from '../write/support';",
    });
    const supportReach = shimReach(['worker/test/storage/v-support.test.ts'], viaSupport);
    expect(supportReach.violations).toEqual([]);
    expect(supportReach.allowed).toEqual([`${ALLOWED_EDGE.from}:46`, `${ALLOWED_EDGE.from}:52`]);
    expect(supportReach.closure).toContain(ALLOWED_EDGE.from);
    expect(supportReach.closure).not.toContain(ALLOWED_EDGE.to);
    // The workspace packages resolve through their exports and are walked too.
    const pkg = overlay({
      'worker/test/storage/v-pkg.test.ts':
        "import { fixedClock } from '@atmusic/core/test-support/clock';\nimport { x } from '@atmusic/core/v-pkg-shim';",
      'packages/core/src/v-pkg-shim.ts': "import 'cloudflare:test';",
    });
    const pkgReach = shimReach(['worker/test/storage/v-pkg.test.ts'], pkg);
    expect(pkgReach.violations).toEqual([
      'worker/test/storage/v-pkg.test.ts -> packages/core/src/v-pkg-shim.ts:1 imports cloudflare:test',
    ]);
    expect(pkgReach.closure).toContain('packages/core/test-support/clock.ts');
    // Before review round 1, schema-v2.test.ts imported readFixture from
    // worker/test/read/scrobble-read-support.ts, which reaches the shim
    // (shimmed until N4-06): that import is reported.
    const schemaV2Before = overlay({
      'worker/test/storage/v-schema-v2.test.ts': "import { readFixture } from '../read/scrobble-read-support';",
    });
    const readSupport = shimReach(['worker/test/storage/v-schema-v2.test.ts'], schemaV2Before);
    if (/from 'cloudflare:test'/.test(read('worker/test/read/scrobble-read-support.ts'))) {
      expect(readSupport.violations).toContain(
        'worker/test/storage/v-schema-v2.test.ts -> worker/test/read/scrobble-read-support.ts:17 imports cloudflare:test',
      );
    }

    // Before this package the same files did import the shim modules and use WebSocketPair.
    const before = atWaveStart('worker/test/storage/migrate.test.ts');
    if (before !== null) {
      expect(shimViolations('migrate.test.ts', before)).toEqual([
        'migrate.test.ts:1 imports cloudflare:test',
        'migrate.test.ts:2 imports cloudflare:workers',
      ]);
      expect(shimViolations('support.ts', atWaveStart('worker/test/write/support.ts') ?? '')).toEqual([
        'support.ts:9 imports cloudflare:workers',
      ]);
    }
  });

  it('every title node-port-inventory.json marks kept for worker/test/storage and worker/test/harness is still declared byte-identical in its file', () => {
    const inventory = JSON.parse(read('docs/verification/node-port-inventory.json')) as {
      tests: Array<{ id: string; file: string; kept?: true; replaced?: string }>;
    };
    const inDirs = (file: string) => file.startsWith('worker/test/storage/') || file.startsWith('worker/test/harness/');
    const kept = inventory.tests.filter((e) => e.kept === true && inDirs(e.file)).map((e) => e.id);
    const replacements = inventory.tests
      .filter((e) => typeof e.replaced === 'string' && inDirs(e.file))
      .map((e) => e.replaced as string);
    // The ids the node-wave packages declare in these directories (N1-02, N1-10, N2-02 and this package).
    const waves = JSON.parse(read('docs/planning/node-waves.json')) as Array<{
      packages: Array<{ id: string; tests: string[] }>;
    }>;
    const declaredByWaves = waves
      .flatMap((w) => w.packages.flatMap((p) => p.tests))
      .filter((t) => inDirs(t.split(SEP)[0] as string));

    expect(kept.length).toBeGreaterThanOrEqual(40);
    expect(replacements.length).toBeGreaterThanOrEqual(3);
    expect(declaredByWaves).toContain(
      'worker/test/harness/local-index.test.ts › withIndex, runAlarmNow and reopen replace runInDurableObject, runDurableObjectAlarm and evictDurableObject, and reopen preserves every table',
    );
    const problems = [...kept, ...replacements, ...declaredByWaves].flatMap((id) => idProblems(id, read));
    expect(problems).toEqual([]);

    // Negative controls: a title changed by one character, a renamed describe,
    // and a title that only appears in a comment are all reported.
    const sample = kept.find((id) => id.startsWith('worker/test/storage/migrate.test.ts')) as string;
    expect(sample).toBeDefined();
    expect(idProblems(`${sample}.`, read)).toEqual([`${sample}.: test not declared`]);
    const parts = sample.split(SEP);
    const renamed = [parts[0], `${parts[1]}!`, ...parts.slice(2)].join(SEP);
    expect(idProblems(renamed, read)).toEqual([`${renamed}: describe not declared`]);
    const commented = (file: string) =>
      file === 'x.test.ts'
        ? "// it('only in a comment', () => {});\nconst s = \"it('only in a string')\";"
        : read(file);
    expect(idProblems('x.test.ts › only in a comment', commented)).toEqual([
      'x.test.ts › only in a comment: test not declared',
    ]);
    expect(idProblems('x.test.ts › only in a string', commented)).toEqual([
      'x.test.ts › only in a string: test not declared',
    ]);
    expect(idProblems('worker/test/storage/nope.test.ts › t', read)).toEqual([
      'worker/test/storage/nope.test.ts › t: file missing',
    ]);
  });

  it('write/support.ts and fixtures/jetstream-server.ts export the same names with the same arity as at the start of this wave', () => {
    const modules: Record<string, Record<string, unknown>> = {
      'worker/test/write/support.ts': writeSupportModule as unknown as Record<string, unknown>,
      'worker/test/fixtures/jetstream-server.ts': jetstreamServerModule as unknown as Record<string, unknown>,
    };
    for (const [file, module] of Object.entries(modules)) {
      const recorded = WAVE_START_EXPORTS[file];
      expect(recorded, file).toBeDefined();
      // Runtime: the same names, kinds and Function.length as at the wave start.
      expect([file, runtimeExports(module)]).toEqual([file, recorded?.runtime]);
      // Source: the same value and type declarations.
      const now = exportedNames(read(file));
      expect([file, now.values]).toEqual([file, recorded?.runtime.map(([name]) => name).sort()]);
      expect([file, now.types]).toEqual([file, recorded?.types]);
      // The record is the wave start's own source, when that commit is available.
      const before = atWaveStart(file);
      if (before !== null) expect([file, exportedNames(before)]).toEqual([file, now]);
    }

    // The helpers still work: the fixture serves a fake and its connector is a function of one URL.
    const server = jetstreamServerModule.jetstreamServer({ clock: { nowMs: () => writeSupportModule.NOW_MS } });
    expect(server.fakes.map((f) => f.host)).toEqual([jetstreamServerModule.HARNESS_JETSTREAM_HOST]);
    expect(server.connect.length).toBe(1);
    expect(writeSupportModule.uriOf('did:plc:a', writeSupportModule.SCROBBLE, 'r1')).toBe(
      'at://did:plc:a/com.example.atmusic.scrobble/r1',
    );

    // ingestDeps parses the harness config the shimmed suites read from `env`:
    // the vars of wrangler.harness.jsonc, while that file exists (N7-01 deletes it).
    const harnessFile = 'worker/test/harness/wrangler.harness.jsonc';
    if (existsSync(join(ROOT, harnessFile))) {
      const { vars } = JSON.parse(scan(read(harnessFile)).code.replace(/,(\s*[}\]])/g, '$1')) as {
        vars: Record<string, string>;
      };
      const db = {} as Db;
      const clock = { nowMs: () => writeSupportModule.NOW_MS };
      for (const o of [{}, { mode: 'socket' as const, hosts: ['east.example.test', 'west.example.test'] }]) {
        const deps = jetstreamServerModule.ingestDeps(db, clock, o);
        const expected = parseConfig(
          {
            ...(vars as unknown as Parameters<typeof parseConfig>[0]),
            ADMIN_TOKEN: '',
            ...('mode' in o
              ? { INGEST_MODE: o.mode, JETSTREAM_URLS: 'wss://east.example.test,wss://west.example.test' }
              : {}),
          },
          { allowFixturePrefix: true },
        );
        expect(deps.config).toEqual(expected);
        expect(deps.db).toBe(db);
      }
    }

    // Negative controls: a dropped export, a changed arity and a new type export are all visible.
    const changed = { ...modules['worker/test/fixtures/jetstream-server.ts'], flush: (_a: number, _b: number) => {} };
    delete (changed as Record<string, unknown>).zeroJitter;
    expect(runtimeExports(changed)).not.toEqual(
      WAVE_START_EXPORTS['worker/test/fixtures/jetstream-server.ts']?.runtime,
    );
    expect(runtimeExports(changed).find(([name]) => name === 'flush')).toEqual(['flush', 'function', 2]);
    expect(exportedNames('export interface Extra {}\nexport const x = 1;\nexport { y };')).toEqual({
      values: ['<unsupported export form>', 'x'],
      types: ['Extra'],
    });
  });
});

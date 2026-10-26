// The de-shim of the harness and storage suites and of the shared test helpers
// (ADR 0005 §15.1 step 2, N4-04), checked statically and at runtime:
//
// - no listed file imports `cloudflare:test` or `cloudflare:workers` (static,
//   dynamic or mocked) or references `WebSocketPair` in code;
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
import { dirname, join, resolve } from 'node:path';
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

/** Every import of a forbidden module (`from`, side-effect, dynamic, require, vi.mock) and every WebSocketPair reference. */
function shimViolations(file: string, src: string): string[] {
  const { code, strings } = scan(src);
  const out: string[] = [];
  const lineOf = (offset: number) => code.slice(0, offset).split('\n').length;
  for (const s of strings) {
    if (s.dynamic || !FORBIDDEN_MODULES.has(unescapeJs(s.body))) continue;
    const before = code.slice(0, s.start);
    if (
      /\bfrom\s*$/.test(before) ||
      /\bimport\s*$/.test(before) ||
      /\b(?:import|require|vi\s*\.\s*(?:mock|doMock|importActual|importMock))\s*\(\s*$/.test(before)
    ) {
      out.push(`${file}:${lineOf(s.start)} imports ${unescapeJs(s.body)}`);
    }
  }
  // Code outside string literals: an identifier WebSocketPair (MemoryWebSocketPair is another name).
  let masked = code;
  for (const s of [...strings].reverse())
    masked = masked.slice(0, s.start) + ' '.repeat(s.end - s.start) + masked.slice(s.end);
  for (const m of masked.matchAll(/(?<![\w$])WebSocketPair(?![\w$])/g)) {
    out.push(`${file}:${lineOf(m.index ?? 0)} references WebSocketPair`);
  }
  return out;
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
    expect(files.flatMap((file) => shimViolations(file, read(file)))).toEqual([]);

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

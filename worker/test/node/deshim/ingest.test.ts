// De-shim of the ingest suites (ADR 0005 §15.1 step 2, N4-05).
//
// worker/test/ingest/** ran inside the harness Durable Object through the
// `cloudflare:*` test shim (N2-02). After N4-05 it runs over the Node harness
// (worker/test/ingest/node-index.ts over withMigratedDb and reopen from
// worker/test/node/support/node-db.ts). This file checks that statically:
//
// - no file under worker/test/ingest imports `cloudflare:test` or
//   `cloudflare:workers` (static, dynamic or re-export), imports the shim or
//   the harness DO directly, uses the Durable Object test helpers or Workers
//   DO types in code, or mentions `WebSocketPair` at all;
// - every test docs/verification/node-port-inventory.json marks kept for
//   worker/test/ingest is still declared, byte-identical (its describe titles
//   and its title as string literals of describe/it/test calls, comments
//   skipped), in its file, and the N3-11 replacement of the subscribe-URL test
//   is declared under its new title while the old one is gone.
//
// Each check also runs against corrupted sources, so it is not vacuous.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const INGEST_DIR = 'worker/test/ingest';
const INVENTORY = 'docs/verification/node-port-inventory.json';

// ---------------------------------------------------------------------------
// A small JavaScript/TypeScript lexer: comments, string and template literals
// and regular expression literals, enough to tell code from comments and to
// read the first argument of describe/it/test calls.

interface Literal {
  /** Index of the opening quote. */
  start: number;
  /** Index after the closing quote. */
  end: number;
  /** The decoded value (for a template, its raw text). */
  value: string;
  /** A template literal with `${…}`. */
  dynamic: boolean;
}

interface Lexed {
  /** The source with every comment replaced by spaces (strings kept). */
  code: string;
  /** Every string and template literal outside comments, in order. */
  literals: Literal[];
}

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

/** After these characters, or these keywords, a `/` starts a regular expression literal. */
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

function lex(src: string): Lexed {
  const literals: Literal[] = [];
  let code = '';
  let i = 0;
  let prev = '';
  let word = '';
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const eol = src.indexOf('\n', i);
      const end = eol === -1 ? src.length : eol;
      code += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      code += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let dynamic = false;
      let depth = 0;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (c === '`' && depth === 0 && d === '$' && src[j + 1] === '{') {
          dynamic = true;
          depth = 1;
          j += 2;
          continue;
        }
        if (depth > 0) {
          if (d === '{') depth++;
          else if (d === '}') depth--;
          j++;
          continue;
        }
        if (d === c) break;
        j++;
      }
      const body = src.slice(i + 1, j);
      literals.push({ start: i, end: j + 1, value: c === '`' ? body : unescapeJs(body), dynamic });
      code += src.slice(i, j + 1);
      i = j + 1;
      prev = c;
      word = '';
      continue;
    }
    if (c === '/' && (prev === '' || BEFORE_REGEX.has(prev) || KEYWORDS_BEFORE_REGEX.has(word))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (inClass) {
          if (d === ']') inClass = false;
        } else if (d === '[') inClass = true;
        else if (d === '/') break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/i.test(src[j] as string)) j++;
      code += src.slice(i, j);
      i = j;
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
    code += c;
    prev = c;
    word = '';
    i++;
  }
  return { code, literals };
}

// ---------------------------------------------------------------------------
// Check 1: no Workers test runtime under worker/test/ingest

const WORKERS_MODULES = new Set(['cloudflare:test', 'cloudflare:workers']);
/** Modules that are the shim, or load it, imported by a relative specifier ending like this. */
const SHIM_MODULES = [
  'node/support/cloudflare-test-shim',
  'node/support/cloudflare-workers-shim',
  'harness/harness-do',
  'harness/local-index',
  'harness/entry',
];
/** Shim helpers and Workers Durable Object types that must not appear in code. */
const SHIM_IDENTIFIERS = [
  'runInDurableObject',
  'runDurableObjectAlarm',
  'evictDurableObject',
  'evictAllDurableObjects',
  'listDurableObjectIds',
  'SELF',
  'HarnessDO',
  'DurableObjectState',
  'DurableObjectStorage',
  'DurableObjectStub',
  'DurableObjectNamespace',
];

/** What in `src` still depends on the Workers test runtime; [] when nothing does. */
function shimReferences(src: string): string[] {
  const found: string[] = [];
  const { code, literals } = lex(src);
  for (const lit of literals) {
    const value = lit.value.replace(/\.(?:ts|js)$/, '');
    if (WORKERS_MODULES.has(lit.value)) found.push(`imports ${lit.value}`);
    else if (!lit.dynamic && /^\.\.?\//.test(value) && SHIM_MODULES.some((m) => value.endsWith(m))) {
      found.push(`imports ${lit.value}`);
    }
  }
  for (const name of SHIM_IDENTIFIERS) {
    if (new RegExp(`(?<![\\w$])${name.replace('$', '\\$')}(?![\\w$])`).test(code)) found.push(`uses ${name}`);
  }
  // WebSocketPair is workerd's; it may not be mentioned at all, comments included.
  if (/WebSocketPair/.test(src)) found.push('references WebSocketPair');
  return found;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Check 2: kept titles still declared

interface Declaration {
  kind: 'describe' | 'test';
  title: string;
  dynamic: boolean;
}

const CALL = /(?<![\w$.])(describe|it|test)((?:\s*\.\s*\w+(?:\s*\([^()]*\))?)*)\s*\(\s*$/;

/** Every describe/it/test call whose first argument is a string literal (comments skipped). */
function declarations(src: string): Declaration[] {
  const { code, literals } = lex(src);
  const out: Declaration[] = [];
  for (const lit of literals) {
    const m = CALL.exec(code.slice(Math.max(0, lit.start - 200), lit.start));
    if (m === null) continue;
    out.push({ kind: m[1] === 'describe' ? 'describe' : 'test', title: lit.value, dynamic: lit.dynamic });
  }
  return out;
}

interface InventoryEntry {
  id: string;
  file: string;
  ancestors: string[];
  title: string;
  kept?: true;
  replaced?: string;
}

/** What of a test id is not declared in `src`; [] when its describes and title all are. */
function undeclared(src: string, id: { ancestors: string[]; title: string }): string[] {
  const declared = declarations(src).filter((d) => !d.dynamic);
  const missing: string[] = [];
  for (const name of id.ancestors) {
    if (!declared.some((d) => d.kind === 'describe' && d.title === name)) missing.push(`describe ${name}`);
  }
  if (!declared.some((d) => d.kind === 'test' && d.title === id.title)) missing.push(`test ${id.title}`);
  return missing;
}

function ingestEntries(): InventoryEntry[] {
  const doc = JSON.parse(readFileSync(join(ROOT, INVENTORY), 'utf8')) as { tests: InventoryEntry[] };
  return doc.tests.filter((e) => e.file.startsWith(`${INGEST_DIR}/`));
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

// ---------------------------------------------------------------------------

describe('ingest de-shim', () => {
  it('no file under worker/test/ingest imports cloudflare:test or cloudflare:workers or references WebSocketPair', () => {
    const files = filesUnder(INGEST_DIR);
    // The whole directory is scanned: the 15 suites and their two helper modules.
    expect(files.map((f) => relative(INGEST_DIR, f))).toEqual([
      'accounts.test.ts',
      'admission.test.ts',
      'discovery.test.ts',
      'drain-support.ts',
      'gap-recovery.test.ts',
      'hints.test.ts',
      'identity-cache.test.ts',
      'ingest-mode.test.ts',
      'jetstream-socket.test.ts',
      'jetstream.test.ts',
      'node-index.ts',
      'notify.test.ts',
      'reactivation.test.ts',
      'rejection-matrix.test.ts',
      'snapshot-job.test.ts',
      'sweeps.test.ts',
      'verify-drain.test.ts',
    ]);
    const problems = files.flatMap((f) => shimReferences(read(f)).map((p) => `${f}: ${p}`));
    expect(problems).toEqual([]);
    // The suites run over the Node harness instead: every DB-backed suite opens node-index.ts.
    const suites = files.filter((f) => f.endsWith('.test.ts'));
    const harnessed = suites.filter((f) => /from '\.\/node-index'/.test(read(f)));
    expect(harnessed.length).toBe(15);
    expect(read(`${INGEST_DIR}/node-index.ts`)).toMatch(
      /import \{ reopen, withMigratedDb \} from '\.\.\/node\/support\/node-db';/,
    );

    // Negative controls: each form of dependency is caught; comments and look-alikes are not.
    expect(shimReferences("import { env } from 'cloudflare:workers';\n")).toEqual(['imports cloudflare:workers']);
    expect(shimReferences('import { runInDurableObject as r } from "cloudflare:test";')).toEqual([
      'imports cloudflare:test',
      'uses runInDurableObject',
    ]);
    expect(shimReferences("const t = await import('cloudflare:test');")).toEqual(['imports cloudflare:test']);
    expect(shimReferences("export { env } from 'cloudflare:workers';")).toEqual(['imports cloudflare:workers']);
    expect(shimReferences("import type { HarnessDO } from '../harness/harness-do';")).toEqual([
      'imports ../harness/harness-do',
      'uses HarnessDO',
    ]);
    expect(shimReferences("import { env } from '../node/support/cloudflare-workers-shim.ts';")).toEqual([
      'imports ../node/support/cloudflare-workers-shim.ts',
    ]);
    expect(shimReferences('function f(s: DurableObjectStorage) {}')).toEqual(['uses DurableObjectStorage']);
    expect(shimReferences('const [a, b] = Object.values(new WebSocketPair());')).toEqual(['references WebSocketPair']);
    expect(shimReferences('// served through a WebSocketPair\nconst x = 1;')).toEqual(['references WebSocketPair']);
    expect(shimReferences("// was: import { env } from 'cloudflare:workers'; runInDurableObject(stub)\n")).toEqual([]);
    expect(shimReferences("const note = 'cloudflare:test is gone'; const runInDurableObjectX = 1;")).toEqual([]);
    expect(shimReferences("const re = /'cloudflare:test'/;")).toEqual([]);
  });

  it('every title node-port-inventory.json marks kept for worker/test/ingest is still declared byte-identical in its file', () => {
    const entries = ingestEntries();
    const kept = entries.filter((e) => e.kept === true);
    // The ADR 0004 baseline's ingest tests: 77 kept in 15 files, 1 replaced (N3-11).
    expect(kept).toHaveLength(77);
    expect(new Set(kept.map((e) => e.file)).size).toBe(15);
    const problems = kept.flatMap((e) => undeclared(read(e.file), e).map((p) => `${e.id}: ${p} not declared`));
    expect(problems).toEqual([]);

    // N3-11's replacement is declared under its new title, in the same file, and the old title is gone.
    const replaced = entries.filter((e) => e.replaced !== undefined);
    expect(replaced.map((e) => [e.id, e.replaced])).toEqual([
      [
        'worker/test/ingest/jetstream-socket.test.ts › jetstream socket › subscribe URL has kinds=commit and the three collections only',
        'worker/test/ingest/jetstream-socket.test.ts › jetstream socket › subscribe URL has kinds=commit and the four collections only',
      ],
    ]);
    const socket = read(`${INGEST_DIR}/jetstream-socket.test.ts`);
    expect(
      undeclared(socket, {
        ancestors: ['jetstream socket'],
        title: 'subscribe URL has kinds=commit and the four collections only',
      }),
    ).toEqual([]);
    expect(
      undeclared(socket, { ancestors: [], title: 'subscribe URL has kinds=commit and the three collections only' }),
    ).toEqual(['test subscribe URL has kinds=commit and the three collections only']);

    // Negative controls on a real suite: a one-character change, a title moved into a comment,
    // a renamed describe and a template title with a substitution are each reported.
    const target = kept.find((e) => e.file.endsWith('/notify.test.ts') && e.title.startsWith('61st request'))!;
    const src = read(target.file);
    const quoted = `'${target.title}'`;
    expect(src.split(quoted)).toHaveLength(2);
    expect(undeclared(src, target)).toEqual([]);
    expect(undeclared(src.replace(quoted, `'${target.title.replace('61st', '62nd')}'`), target)).toEqual([
      `test ${target.title}`,
    ]);
    expect(undeclared(src.replace(`it(${quoted}`, `// it(${quoted}\n  it('x'`), target)).toEqual([
      `test ${target.title}`,
    ]);
    expect(undeclared(src.replace("describe('notify'", "describe('notify route'"), target)).toEqual([
      'describe notify',
    ]);
    const templated = ['it(`61st $', "{'request'}`, () => {});"].join('');
    expect(undeclared(templated, { ancestors: [], title: '61st request' })).toEqual(['test 61st request']);
    // Titles with escapes and chained modifiers decode to their value.
    expect(declarations("describe.skip('a \\u203a b', () => { it.each([1])('x\\'s', () => {}); });")).toEqual([
      { kind: 'describe', title: 'a › b', dynamic: false },
      { kind: 'test', title: "x's", dynamic: false },
    ]);
  });
});

// De-shim of the read, write and http suites (ADR 0005 §15.1 step 2, N4-06).
//
// The listed files (every module under worker/test/read/, and the write and
// http suites N4-06 owns) run on the Node harness: node-db's withMigratedDb
// and reopen (worker/test/node/support/node-db.ts, N1-01), through
// worker/test/read/node-harness.ts. This file checks statically that
//
// - none of them imports `cloudflare:test` or `cloudflare:workers` in any form
//   (static, type-only, side-effect, re-export, dynamic import, vi.mock,
//   require), nor the shim modules those ids are aliased to, nor the harness
//   Durable Object they drove; and no code in them still names a shimmed
//   helper (runInDurableObject, runDurableObjectAlarm, evictDurableObject,
//   env.HARNESS) or a Durable Object type;
// - every test node-port-inventory.json marks kept for those files is still
//   declared there with its describe and test titles byte-identical.
//
// Both checks scan code, not mentions: comments are skipped, and a string
// counts only where it is a module specifier or a describe/it/test title.
// Each check also runs against corrupted sources, so it is not vacuous.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const INVENTORY = 'docs/verification/node-port-inventory.json';
const SEP = ' › ';

const READ_DIR = 'worker/test/read/';
const OWNED_FILES = [
  'worker/test/write/account-state.test.ts',
  'worker/test/write/apply-record.test.ts',
  'worker/test/write/apply-snapshot.test.ts',
  'worker/test/write/suppression.test.ts',
  'worker/test/http/error.test.ts',
  'worker/test/http/limits.test.ts',
  'worker/test/http/params.test.ts',
  'worker/test/http/record-status.test.ts',
];

/** The listed files: every module under worker/test/read/ plus the owned write and http suites. */
function listedFiles(): string[] {
  const read = readdirSync(join(ROOT, READ_DIR))
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => `${READ_DIR}${name}`);
  return [...read, ...OWNED_FILES];
}

const readRepo = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

// ---------------------------------------------------------------------------
// Scanner: code tokens of a TypeScript source, comments skipped

type Token =
  | { kind: 'string'; value: string; dynamic: boolean; at: number }
  | { kind: 'word'; value: string; at: number }
  | { kind: 'punct'; value: string; at: number };

/** The value of a JS string literal body (between its quotes). */
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

/** After these punctuators, or these keywords, a `/` starts a regular expression literal. */
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

/** Every code token of `src`: string literals (decoded), identifiers/keywords and punctuators. */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const last = () => out.at(-1);
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const eol = src.indexOf('\n', i);
      i = eol === -1 ? src.length : eol + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
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
      out.push({ kind: 'string', value: unescapeJs(src.slice(i + 1, j)), dynamic, at: i });
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const prev = last();
      const regex =
        prev === undefined ||
        (prev.kind === 'punct' && BEFORE_REGEX.has(prev.value)) ||
        (prev.kind === 'word' && KEYWORDS_BEFORE_REGEX.has(prev.value));
      if (regex) {
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
        out.push({ kind: 'punct', value: '/regex/', at: i });
        i = j;
        continue;
      }
    }
    const word = /[\w$]+/y;
    word.lastIndex = i;
    const w = word.exec(src);
    if (w !== null) {
      out.push({ kind: 'word', value: w[0], at: i });
      i += w[0].length;
      continue;
    }
    out.push({ kind: 'punct', value: c, at: i });
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Imports

/** Every module specifier of `src`, with the form it appears in. */
function moduleSpecifiers(src: string): Array<{ form: string; specifier: string }> {
  const t = tokenize(src);
  const out: Array<{ form: string; specifier: string }> = [];
  const isWord = (k: number, v: string) => t[k]?.kind === 'word' && t[k]?.value === v;
  const isPunct = (k: number, v: string) => t[k]?.kind === 'punct' && t[k]?.value === v;
  const stringAt = (k: number) => {
    const tok = t[k];
    return tok?.kind === 'string' ? tok.value : null;
  };
  for (let k = 0; k < t.length; k++) {
    const tok = t[k] as Token;
    if (tok.kind !== 'word') continue;
    const memberAccess = isPunct(k - 1, '.');
    if (tok.value === 'import' && !memberAccess && !isPunct(k + 1, '.')) {
      // import('x') / import 'x'
      if (isPunct(k + 1, '(')) {
        const s = stringAt(k + 2);
        if (s !== null) out.push({ form: 'dynamic import', specifier: s });
        continue;
      }
      const direct = stringAt(k + 1);
      if (direct !== null) {
        out.push({ form: 'side-effect import', specifier: direct });
        continue;
      }
      // import [type] <bindings> from 'x' (up to the statement's `from`)
      for (let j = k + 1; j < t.length && !isPunct(j, ';'); j++) {
        if (isWord(j, 'from')) {
          const s = stringAt(j + 1);
          if (s !== null) out.push({ form: 'import', specifier: s });
          break;
        }
      }
      continue;
    }
    if (tok.value === 'export' && !memberAccess) {
      // export { a } from 'x' / export * from 'x' / export type { A } from 'x'
      for (let j = k + 1; j < t.length && !isPunct(j, ';') && !isPunct(j, '='); j++) {
        if (isWord(j, 'function') || isWord(j, 'class') || isWord(j, 'const') || isWord(j, 'let')) break;
        if (isWord(j, 'from')) {
          const s = stringAt(j + 1);
          if (s !== null) out.push({ form: 're-export', specifier: s });
          break;
        }
      }
      continue;
    }
    if (tok.value === 'require' && !memberAccess && isPunct(k + 1, '(')) {
      const s = stringAt(k + 2);
      if (s !== null) out.push({ form: 'require', specifier: s });
      continue;
    }
    if (
      tok.value === 'vi' &&
      isPunct(k + 1, '.') &&
      ['mock', 'doMock', 'importActual', 'importMock'].includes(t[k + 2]?.value ?? '') &&
      isPunct(k + 3, '(')
    ) {
      const s = stringAt(k + 4);
      if (s !== null) out.push({ form: `vi.${t[k + 2]?.value}`, specifier: s });
    }
  }
  return out;
}

/** The modules a de-shimmed suite must not reach: the cloudflare:* ids, their shim aliases, the harness DO. */
const FORBIDDEN_MODULE = [
  /^cloudflare:/,
  /(^|\/)cloudflare-test-shim(\.ts)?$/,
  /(^|\/)cloudflare-workers-shim(\.ts)?$/,
  /(^|\/)do-storage-facade(\.ts)?$/,
  /(^|\/)workerd-globals(\.ts)?$/,
  /(^|\/)harness\/(harness-do|local-index|entry)(\.ts)?$/,
];

/** Code (not comments or strings) that only the shim or the Workers runtime gives meaning to. */
const SHIMMED_WORDS = new Set([
  'runInDurableObject',
  'runDurableObjectAlarm',
  'evictDurableObject',
  'evictAllDurableObjects',
  'listDurableObjectIds',
  'DurableObjectStub',
  'DurableObjectState',
  'DurableObjectStorage',
  'DurableObjectNamespace',
  'HarnessDO',
]);

/** Every reason `src` still depends on the shim; [] for a de-shimmed file. */
function shimProblems(file: string, src: string): string[] {
  const problems: string[] = [];
  for (const { form, specifier } of moduleSpecifiers(src)) {
    if (FORBIDDEN_MODULE.some((re) => re.test(specifier))) problems.push(`${file}: ${form} of ${specifier}`);
  }
  const t = tokenize(src);
  for (let k = 0; k < t.length; k++) {
    const tok = t[k] as Token;
    if (tok.kind !== 'word') continue;
    if (SHIMMED_WORDS.has(tok.value)) problems.push(`${file}: names ${tok.value}`);
    if (
      tok.value === 'env' &&
      t[k - 1]?.value !== '.' &&
      t[k + 1]?.value === '.' &&
      t[k + 2]?.kind === 'word' &&
      t[k + 2]?.value === 'HARNESS'
    ) {
      problems.push(`${file}: names env.HARNESS`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Declared titles

interface Declaration {
  kind: 'describe' | 'test';
  title: string;
  /** A template literal with `${…}`: its title is not a fixed string. */
  dynamic: boolean;
}

/** Every describe/it/test call whose first argument is a string literal, in source order. */
function declarations(src: string): Declaration[] {
  const t = tokenize(src);
  const out: Declaration[] = [];
  for (let k = 0; k < t.length; k++) {
    const tok = t[k] as Token;
    if (tok.kind !== 'word' || !['describe', 'it', 'test'].includes(tok.value) || t[k - 1]?.value === '.') continue;
    // Skip a modifier chain: .skip / .only / .each([...]) / .skipIf(x) ...
    const isPunct = (n: number, v: string) => t[n]?.kind === 'punct' && t[n]?.value === v;
    let j = k + 1;
    while (isPunct(j, '.') && t[j + 1]?.kind === 'word') {
      j += 2;
      if (!isPunct(j, '(')) continue;
      // A chain call (`.each([...])`) is followed by the title call's `(`.
      let depth = 0;
      let m = j;
      for (; m < t.length; m++) {
        if (isPunct(m, '(')) depth++;
        else if (isPunct(m, ')') && --depth === 0) break;
      }
      if (!isPunct(m + 1, '(')) break;
      j = m + 1;
    }
    if (!isPunct(j, '(')) continue;
    const title = t[j + 1];
    if (title?.kind !== 'string') continue;
    out.push({ kind: tok.value === 'describe' ? 'describe' : 'test', title: title.value, dynamic: title.dynamic });
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

/** Problems with one kept entry against its file's declarations; [] when declared byte-identical. */
function titleProblems(e: InventoryEntry, read: (file: string) => string | null): string[] {
  const src = read(e.file);
  if (src === null) return [`${e.file}: file missing`];
  const declared = declarations(src);
  const problems: string[] = [];
  for (const name of e.ancestors) {
    if (!declared.some((d) => d.kind === 'describe' && !d.dynamic && d.title === name)) {
      problems.push(`${e.id}: describe ${JSON.stringify(name)} not declared`);
    }
  }
  if (!declared.some((d) => d.kind === 'test' && !d.dynamic && d.title === e.title)) {
    problems.push(`${e.id}: test ${JSON.stringify(e.title)} not declared`);
  }
  return problems;
}

function keptEntries(files: readonly string[]): InventoryEntry[] {
  const doc = JSON.parse(readRepo(INVENTORY)) as { tests: InventoryEntry[] };
  const listed = new Set(files);
  return doc.tests.filter((e) => e.kept === true && listed.has(e.file));
}

// ---------------------------------------------------------------------------

describe('de-shim of worker/test/{read,write,http} (N4-06)', () => {
  it('no listed file under worker/test/read, worker/test/write or worker/test/http imports cloudflare:test or cloudflare:workers', () => {
    const files = listedFiles();
    // The listing is the package's: the read directory (its test suites and
    // helpers, the new Node harness among them) and the eight owned suites.
    expect(files).toEqual(
      expect.arrayContaining([
        'worker/test/read/scrobble-read-support.ts',
        'worker/test/read/node-harness.ts',
        'worker/test/read/keyset.test.ts',
        'worker/test/read/stats.test.ts',
        ...OWNED_FILES,
      ]),
    );
    expect(files.filter((f) => f.startsWith(READ_DIR))).toHaveLength(14);
    for (const f of files) expect(existsSync(join(ROOT, f)), f).toBe(true);

    expect(files.flatMap((f) => shimProblems(f, readRepo(f)))).toEqual([]);

    // The files run on node-db: the suites that used a Durable Object now
    // reach the database through the Node harness (or node-db directly).
    const harnessUsers = files.filter((f) =>
      moduleSpecifiers(readRepo(f)).some(
        ({ specifier }) => /(^|\/)node-harness$/.test(specifier) || /(^|\/)node\/support\/node-db$/.test(specifier),
      ),
    );
    expect(harnessUsers).toEqual(
      expect.arrayContaining([
        'worker/test/read/export.test.ts',
        'worker/test/read/follows.test.ts',
        'worker/test/read/keyset.test.ts',
        'worker/test/read/profile.test.ts',
        'worker/test/read/resolve.test.ts',
        'worker/test/read/scrobble-read-support.ts',
        'worker/test/read/stats-boundaries.test.ts',
        'worker/test/read/stats-cache.test.ts',
        'worker/test/read/stats-plan.test.ts',
        'worker/test/read/stats.test.ts',
        'worker/test/write/account-state.test.ts',
        'worker/test/write/apply-record.test.ts',
        'worker/test/write/apply-snapshot.test.ts',
        'worker/test/write/suppression.test.ts',
        'worker/test/http/record-status.test.ts',
      ]),
    );
    const harness = moduleSpecifiers(readRepo('worker/test/read/node-harness.ts')).map((s) => s.specifier);
    expect(harness).toContain('../node/support/node-db');

    // Not vacuous: every import form of the shim is reported, a mention in a
    // comment or an ordinary string is not, and the shimmed helpers are named.
    const clean = "// import { env } from 'cloudflare:workers';\nconst s = \"from 'cloudflare:test'\";\n";
    expect(shimProblems('clean.ts', clean)).toEqual([]);
    const forms: Array<[string, string]> = [
      ["import { env } from 'cloudflare:workers';", 'import of cloudflare:workers'],
      ["import type { ProvidedEnv } from 'cloudflare:test';", 'import of cloudflare:test'],
      ["import * as t from 'cloudflare:test';", 'import of cloudflare:test'],
      ["import 'cloudflare:test';", 'side-effect import of cloudflare:test'],
      ["export { env } from 'cloudflare:workers';", 're-export of cloudflare:workers'],
      ["const m = await import('cloudflare:test');", 'dynamic import of cloudflare:test'],
      ["vi.mock('cloudflare:workers');", 'vi.mock of cloudflare:workers'],
      ["const m = require('cloudflare:test');", 'require of cloudflare:test'],
      [
        "import { env } from '../node/support/cloudflare-workers-shim';",
        'import of ../node/support/cloudflare-workers-shim',
      ],
      ["import type { HarnessDO } from '../harness/harness-do';", 'import of ../harness/harness-do'],
      ["import { makeLocalIndex } from '../harness/local-index';", 'import of ../harness/local-index'],
    ];
    for (const [line, problem] of forms) {
      expect(shimProblems('x.ts', `${clean}${line}\n`), line).toEqual(expect.arrayContaining([`x.ts: ${problem}`]));
    }
    expect(
      shimProblems('x.ts', 'await runInDurableObject(stub, (i) => i.db);\nawait evictDurableObject(stub);\n'),
    ).toEqual(['x.ts: names runInDurableObject', 'x.ts: names evictDurableObject']);
    expect(shimProblems('x.ts', 'const stub = env.HARNESS.get(id) as DurableObjectStub;')).toEqual([
      'x.ts: names env.HARNESS',
      'x.ts: names DurableObjectStub',
    ]);
    // A real pre-de-shim file is caught: the version of export.test.ts that
    // used the shim imported both ids and drove the harness DO.
    const shimmed = [
      "import { runInDurableObject } from 'cloudflare:test';",
      "import { env } from 'cloudflare:workers';",
      "const stub = env.HARNESS.get(env.HARNESS.idFromName('export'));",
      'await runInDurableObject(stub, (_i, s) => s.storage);',
    ].join('\n');
    expect(shimProblems('old.ts', shimmed)).toEqual([
      'old.ts: import of cloudflare:test',
      'old.ts: import of cloudflare:workers',
      'old.ts: names runInDurableObject',
      'old.ts: names env.HARNESS',
      'old.ts: names env.HARNESS',
      'old.ts: names runInDurableObject',
    ]);
  });

  it('every title node-port-inventory.json marks kept for the listed files is still declared byte-identical in its file', () => {
    const files = listedFiles();
    const kept = keptEntries(files);
    // The baseline's kept tests of these files (ADR 0005 §15.3): 36 read,
    // 17 write and 7 http tests (error 1, limits 2, params 3, record-status 1).
    expect(kept).toHaveLength(60);
    const perDir = (dir: string) => kept.filter((e) => e.file.startsWith(`worker/test/${dir}/`)).length;
    expect({ read: perDir('read'), write: perDir('write'), http: perDir('http') }).toEqual({
      read: 36,
      write: 17,
      http: 7,
    });
    // Every listed test suite has kept titles (none was dropped from the check).
    const suites = files.filter((f) => f.endsWith('.test.ts'));
    expect(suites.filter((f) => !kept.some((e) => e.file === f))).toEqual([]);

    const read = (file: string): string | null => (existsSync(join(ROOT, file)) ? readRepo(file) : null);
    expect(kept.flatMap((e) => titleProblems(e, read))).toEqual([]);

    // Every id is the file › describes › title the vitest reporter prints.
    for (const e of kept) expect([e.file, ...e.ancestors, e.title].join(SEP)).toBe(e.id);

    // Not vacuous: one changed character in a test title or a describe title,
    // a title turned into a template with a placeholder, or a title only left
    // in a comment is reported.
    const target = kept.find((e) => e.file === 'worker/test/write/apply-record.test.ts' && e.ancestors.length === 1);
    expect(target).toBeDefined();
    const entry = target as InventoryEntry;
    const original = readRepo(entry.file);
    const quoted = `'${entry.title.replaceAll("'", "\\'")}'`;
    expect(original).toContain(quoted);
    const withSource = (src: string) => (file: string) => (file === entry.file ? src : read(file));
    expect(titleProblems(entry, withSource(original.replace(quoted, `'${entry.title} '`)))).toEqual([
      `${entry.id}: test ${JSON.stringify(entry.title)} not declared`,
    ]);
    expect(titleProblems(entry, withSource(original.replace(quoted, `\`${entry.title}\${''}\``)))).toEqual([
      `${entry.id}: test ${JSON.stringify(entry.title)} not declared`,
    ]);
    expect(titleProblems(entry, withSource(original.replace(`it(${quoted}`, `// it(${quoted}\nit('x'`)))).toEqual([
      `${entry.id}: test ${JSON.stringify(entry.title)} not declared`,
    ]);
    const describeTitle = entry.ancestors[0] as string;
    expect(
      titleProblems(entry, withSource(original.replace(`describe('${describeTitle}'`, `describe('${describeTitle}s'`))),
    ).toEqual([`${entry.id}: describe ${JSON.stringify(describeTitle)} not declared`]);
    expect(titleProblems(entry, () => null)).toEqual([`${entry.file}: file missing`]);

    // The scanner reads declarations: escapes are decoded, modifier chains
    // are followed, and a regular expression with a quote is not a string.
    const placeholder = `$${'{n}'}`;
    expect(
      declarations(
        [
          "describe('outer', () => {",
          "  it.each([1])('each %s', () => {});",
          "  it('can\\'t \\u2192 stop', () => {});",
          `  test.skipIf(x)(\`tmpl ${placeholder}\`, () => {});`,
          "  const quote = /'/.test(s) ? 1 : 2 / 3;",
          '  it(`plain template`, () => {});',
          '});',
        ].join('\n'),
      ),
    ).toEqual([
      { kind: 'describe', title: 'outer', dynamic: false },
      { kind: 'test', title: 'each %s', dynamic: false },
      { kind: 'test', title: "can't → stop", dynamic: false },
      { kind: 'test', title: `tmpl ${placeholder}`, dynamic: true },
      { kind: 'test', title: 'plain template', dynamic: false },
    ]);
  });
});

// The Node-port test inventory (ADR 0005 §15.3, N2-02):
// docs/verification/node-port-inventory.json lists every vitest test id
// executed at 3d953a9 (the 406-test ADR 0004 baseline) as `kept` (file and
// title unchanged, a named expectation change recorded in `change`) or
// `replaced` by a new id with a reason. This file checks it statically:
//
// - every kept id's describe and test titles are still declared, byte-identical,
//   in its file, and every replacement id is declared in its file;
// - every test title declared at 3d953a9 under worker/test/{harness, storage,
//   ingest, read, write, http} (read from git) is in the inventory, and the
//   kept ones are still declared in the same file.
//
// "Declared" means the first argument of a `describe(`, `it(` or `test(` call
// (with any `.skip`/`.only`/`.each(...)` chain) is a string literal with that
// exact value, found by a scanner that skips comments, so a title quoted in a
// comment never counts. Each check also runs against a corrupted inventory or
// source, so it is not vacuous.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INVENTORY = 'docs/verification/node-port-inventory.json';
const BASELINE = '3d953a9';
const SEP = ' › ';
/** The worker-modules suites the shim runs (ADR 0005 §15.1). */
const MODULE_DIRS = ['harness', 'storage', 'ingest', 'read', 'write', 'http'].map((d) => `worker/test/${d}/`);

interface Entry {
  id: string;
  file: string;
  ancestors: string[];
  title: string;
  kept?: true;
  change?: string;
  replaced?: string;
  reason?: string;
  package?: string;
}

interface Inventory {
  schemaVersion: number;
  baseline: { commit: string; executed: number };
  tests: Entry[];
}

// ---------------------------------------------------------------------------
// Declared titles

interface Declaration {
  kind: 'describe' | 'test';
  title: string;
  /** A template literal with `${…}`: its title is not a fixed string. */
  dynamic: boolean;
}

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

/** Reads the string literal starting at `src[i]` (a quote); returns its end and decoded value. */
function readString(src: string, i: number): { end: number; body: string; dynamic: boolean } {
  const quote = src[i];
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
  return { end: j + 1, body: src.slice(i + 1, j), dynamic };
}

const CALL = /(?<![\w$.])(describe|it|test)((?:\s*\.\s*\w+(?:\s*\([^()]*\))?)*)\s*\(\s*/y;
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

/** The end of the regular expression literal starting at `src[i]` (a `/`), flags included. */
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

/** Every describe/it/test declaration whose title is a string literal, in source order. */
function declarations(src: string): Declaration[] {
  const out: Declaration[] = [];
  let i = 0;
  // The last significant character and word outside comments, to tell a
  // regular expression literal from a division.
  let prev = '';
  let word = '';
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
      i = readString(src, i).end;
      prev = c;
      word = '';
      continue;
    }
    if (c === '/' && (prev === '' || BEFORE_REGEX.has(prev) || KEYWORDS_BEFORE_REGEX.has(word))) {
      i = regexEnd(src, i);
      prev = '/';
      word = '';
      continue;
    }
    CALL.lastIndex = i;
    const m = CALL.exec(src);
    if (m !== null) {
      const at = i + m[0].length;
      const q = src[at];
      if (q === "'" || q === '"' || q === '`') {
        const s = readString(src, at);
        out.push({ kind: m[1] === 'describe' ? 'describe' : 'test', title: unescapeJs(s.body), dynamic: s.dynamic });
        i = s.end;
        prev = q;
        word = '';
        continue;
      }
      i = at;
      prev = '(';
      word = '';
      continue;
    }
    const ident = /[\w$]+/y;
    ident.lastIndex = i;
    const w = ident.exec(src);
    if (w !== null) {
      word = w[0];
      prev = word.at(-1) as string;
      i += word.length;
      continue;
    }
    prev = c;
    word = '';
    i++;
  }
  return out;
}

/** Problems with one id (file, describe titles, test title) against the file's declarations; [] when declared. */
function idProblems(
  id: { file: string; ancestors: string[]; title: string },
  read: (file: string) => string | null,
): string[] {
  const src = read(id.file);
  if (src === null) return [`${id.file}: file missing`];
  const declared = declarations(src);
  const problems: string[] = [];
  for (const name of id.ancestors) {
    if (!declared.some((d) => d.kind === 'describe' && !d.dynamic && d.title === name)) {
      problems.push(`${id.file}: describe ${JSON.stringify(name)} not declared`);
    }
  }
  if (!declared.some((d) => d.kind === 'test' && !d.dynamic && d.title === id.title)) {
    problems.push(`${id.file}: test ${JSON.stringify(id.title)} not declared`);
  }
  return problems;
}

function parseId(id: string): { file: string; ancestors: string[]; title: string } | null {
  const parts = id.split(SEP);
  if (parts.length < 2) return null;
  return { file: parts[0] as string, ancestors: parts.slice(1, -1), title: parts.at(-1) as string };
}

/** Every problem of an inventory against the files `read` returns; [] for a valid one. */
function inventoryProblems(doc: Inventory, read: (file: string) => string | null): string[] {
  const problems: string[] = [];
  if (doc.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (doc.tests.length !== doc.baseline.executed) {
    problems.push(`${doc.tests.length} entries for ${doc.baseline.executed} executed baseline tests`);
  }
  const ids = new Set<string>();
  for (const e of doc.tests) {
    if (ids.has(e.id)) problems.push(`${e.id}: listed twice`);
    ids.add(e.id);
    if ([e.file, ...e.ancestors, e.title].join(SEP) !== e.id)
      problems.push(`${e.id}: id is not file › describes › title`);
    const kept = e.kept === true;
    const replaced = typeof e.replaced === 'string';
    if (kept === replaced) {
      problems.push(`${e.id}: must be exactly one of kept or replaced`);
      continue;
    }
    if (kept) {
      if ('reason' in e) problems.push(`${e.id}: a kept entry has no reason (use change)`);
      if ('change' in e && (typeof e.change !== 'string' || e.change.trim() === '')) {
        problems.push(`${e.id}: change must be a nonempty text`);
      }
      problems.push(...idProblems(e, read).map((p) => `${e.id}: kept, but ${p}`));
      continue;
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') problems.push(`${e.id}: replaced without a reason`);
    const target = parseId(e.replaced as string);
    if (target === null) {
      problems.push(`${e.id}: replacement ${JSON.stringify(e.replaced)} is not a test id`);
      continue;
    }
    if (e.replaced === e.id) problems.push(`${e.id}: replaced by itself`);
    problems.push(...idProblems(target, read).map((p) => `${e.id}: replacement ${e.replaced}: ${p}`));
  }
  for (const e of doc.tests) {
    if (typeof e.replaced === 'string' && doc.tests.some((o) => o.id === e.replaced && o.replaced !== undefined)) {
      problems.push(`${e.id}: replaced by ${e.replaced}, which is itself replaced`);
    }
  }
  return problems;
}

const readRepo = (file: string): string | null => {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

function loadInventory(): Inventory {
  return JSON.parse(readFileSync(join(ROOT, INVENTORY), 'utf8')) as Inventory;
}

function git(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}

/** Test titles (file › describes are not needed: titles are unique per file here) declared at a commit. */
function declaredAt(commit: string, file: string): Declaration[] {
  const r = git('show', `${commit}:${file}`);
  if (!r.ok) throw new Error(`git show ${commit}:${file} failed`);
  return declarations(r.out);
}

// ---------------------------------------------------------------------------

describe('node-port test inventory', () => {
  it('every id in node-port-inventory.json is kept with its title declared in its file or replaced by an existing id with a reason', () => {
    const doc = loadInventory();
    expect(doc.baseline.commit).toMatch(/^3d953a9[0-9a-f]{33}$/);
    expect(doc.baseline.executed).toBe(406);
    expect(doc.tests).toHaveLength(406);
    expect(inventoryProblems(doc, readRepo)).toEqual([]);

    // The named changes ADR 0005 §15.3 assigns are recorded.
    const byId = new Map(doc.tests.map((e) => [e.id, e]));
    for (const [id, pkg] of [
      ['packages/core/test/unicode-runtime.test.ts › workerd ICU NFKC matches oracle corpus', 'N0-01'],
      [
        'packages/atproto/test/scaffold.test.ts › workerd runtime › workerd runtime has WebCrypto ECDSA P-256 and String.prototype.normalize NFKC',
        'N1-04',
      ],
      ['worker/test/storage/db.test.ts › doDb › all/one/run map rows, nulls and rowsWritten', 'N2-02'],
    ] as const) {
      expect(byId.get(id), id).toMatchObject({ kept: true, package: pkg, change: expect.stringMatching(/§15\.3/) });
    }
    const replaced = doc.tests.filter((e) => e.replaced !== undefined);
    expect(replaced.map((e) => e.package)).toEqual(replaced.map(() => expect.any(String)));
    expect(replaced.length).toBeGreaterThan(0);

    // The checker is not vacuous: each corruption is reported.
    const kept = doc.tests.find((e) => e.kept && e.file.startsWith('worker/test/storage/'));
    const firstReplaced = replaced[0];
    expect(kept).toBeDefined();
    expect(firstReplaced).toBeDefined();
    const corrupt = (edit: (tests: Entry[]) => void): string[] => {
      const copy = structuredClone(doc);
      edit(copy.tests);
      return inventoryProblems(copy, readRepo);
    };
    const keptAt = doc.tests.indexOf(kept as Entry);
    const replacedAt = doc.tests.indexOf(firstReplaced as Entry);
    const renamed = `${(kept as Entry).title} (renamed)`;
    expect(
      corrupt((t) => {
        t[keptAt] = {
          ...(t[keptAt] as Entry),
          title: renamed,
          id: [kept!.file, ...kept!.ancestors, renamed].join(SEP),
        };
      }),
    ).toEqual([
      `${[kept!.file, ...kept!.ancestors, renamed].join(SEP)}: kept, but ${kept!.file}: test ${JSON.stringify(renamed)} not declared`,
    ]);
    expect(corrupt((t) => delete (t[replacedAt] as Entry).reason)).toEqual([
      `${firstReplaced!.id}: replaced without a reason`,
    ]);
    expect(
      corrupt((t) => {
        (t[replacedAt] as Entry).replaced = `${firstReplaced!.file}${SEP}a test that does not exist`;
      }),
    ).toEqual([
      `${firstReplaced!.id}: replacement ${firstReplaced!.file}${SEP}a test that does not exist: ${firstReplaced!.file}: test "a test that does not exist" not declared`,
    ]);
    expect(corrupt((t) => void t.pop())).toEqual(['405 entries for 406 executed baseline tests']);
    expect(
      corrupt((t) => {
        (t[keptAt] as Entry).replaced = firstReplaced!.replaced as string;
      }),
    ).toEqual([`${kept!.id}: must be exactly one of kept or replaced`]);

    // The scanner reads declarations, not mentions: a title in a comment, a
    // plain string or after a regular expression with a quote does not count
    // twice, escapes are decoded, templates with a placeholder are dynamic.
    const placeholder = `$${'{n}'}`;
    expect(
      declarations(
        [
          "// it('in a comment')",
          "/* test('in a block comment') */",
          'const s = "it(\'in a string\')";',
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

  it('every test title declared at 3d953a9 under worker/test/{harness,storage,ingest,read,write,http} that the inventory marks kept is still declared, byte-identical, in the same file', () => {
    const doc = loadInventory();
    const inModules = doc.tests.filter((e) => MODULE_DIRS.some((d) => e.file.startsWith(d)));
    expect(inModules.length).toBeGreaterThan(150);

    // The baseline declarations, from git when the history holds 3d953a9 (a
    // shallow clone does not; the inventory, recorded from the executed run at
    // 3d953a9, is then the baseline).
    const history = git('cat-file', '-e', `${BASELINE}^{commit}`).ok;
    let baseline: Array<{ file: string; title: string }>;
    if (history) {
      const files = git('ls-tree', '-r', '--name-only', BASELINE, '--', ...MODULE_DIRS)
        .out.split('\n')
        .filter((f) => f.endsWith('.test.ts'));
      expect(files.length).toBeGreaterThan(40);
      baseline = files.flatMap((file) =>
        declaredAt(BASELINE, file)
          .filter((d) => d.kind === 'test')
          .map((d) => {
            // Every baseline title under these directories is a fixed string.
            expect([file, d.title, d.dynamic]).toEqual([file, d.title, false]);
            return { file, title: d.title };
          }),
      );
      // Every declared title is in the inventory, and the inventory has no other entry there.
      const listed = (file: string, title: string) => inModules.filter((e) => e.file === file && e.title === title);
      expect(baseline.filter((b) => listed(b.file, b.title).length !== 1)).toEqual([]);
      expect(inModules.length).toBe(baseline.length);
    } else {
      baseline = inModules.map((e) => ({ file: e.file, title: e.title }));
    }

    // Each kept one is declared, byte-identical, in the same file today.
    const current = new Map<string, Declaration[]>();
    const declaredNow = (file: string) => {
      if (!current.has(file)) {
        const src = readRepo(file);
        current.set(file, src === null ? [] : declarations(src));
      }
      return current.get(file) as Declaration[];
    };
    const missing: string[] = [];
    let kept = 0;
    for (const b of baseline) {
      const entry = inModules.find((e) => e.file === b.file && e.title === b.title) as Entry;
      if (entry.kept !== true) continue;
      kept++;
      if (!declaredNow(b.file).some((d) => d.kind === 'test' && !d.dynamic && d.title === b.title)) {
        missing.push(`${b.file}${SEP}${b.title}`);
      }
    }
    expect(missing).toEqual([]);
    expect(kept).toBe(inModules.filter((e) => e.kept).length);

    // Not vacuous: a one-character change to a kept title in a copy of its
    // source is no longer the same declaration.
    const sample = inModules.find((e) => e.kept && e.file === 'worker/test/storage/migrate.test.ts') as Entry;
    const src = readRepo(sample.file) as string;
    const altered = src.replace(sample.title, `${sample.title} `);
    expect(altered).not.toBe(src);
    expect(declarations(src).some((d) => d.title === sample.title)).toBe(true);
    expect(declarations(altered).some((d) => d.title === sample.title)).toBe(false);
  });
});

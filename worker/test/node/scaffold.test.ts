// worker-node scaffold (ADR 0005 §3.1, §3.2, §3.5, §15.1; N0-01). The Node host
// runs on the owner's Node 26.12.1 with the system SQLite 3.54.1 and OpenSSL; this
// file pins the runtime facts the Node adapter packages build on: node:sqlite is
// available with WAL, STRICT tables and JSON functions, there are no workerd
// globals, Node's ICU passes the music-key NFKC probes, and the undici the
// pinned transport imports is the copy Node bundles. Plan case
// M1.2.1/sqlite_tls_features (ADR 0005 §20.2).

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { createSecureContext, getCiphers } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { nfkcRuntimeSupportsGroupingVersion, normalizeMusic } from '@atmusic/core/music-key';
import { afterEach, describe, expect, it } from 'vitest';

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * node:sqlite's `Database` class. Node 26 exports it with `DatabaseSync` as a
 * deprecated alias (DEP0210, ADR 0005 §3.2); @types/node 26.6.5 declares only
 * `DatabaseSync`, so `Database` is read structurally with the same type.
 */
const nodeSqlite = sqlite as typeof sqlite & { Database?: typeof sqlite.DatabaseSync };

/** "26.12.1" -> [26, 12, 1]. */
const versionParts = (version: string): number[] => version.split('.').map((part) => Number.parseInt(part, 10));

/** a >= b, comparing dotted numeric versions part by part. */
function versionAtLeast(actual: string, minimum: string): boolean {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('worker-node scaffold', () => {
  it('worker-node project runs under Node >= 26.12 with node:sqlite Database available and no workerd globals (WebSocketPair, caches) defined', () => {
    expect(process.release.name).toBe('node');
    expect(process.versions.node).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionAtLeast(process.versions.node, '26.12.0'), process.versions.node).toBe(true);
    expect(navigator.userAgent).toMatch(/^Node\.js\/26\b/);

    // The repository pins that toolchain: .nvmrc for CI and engines for npm.
    const nvmrc = readFileSync(join(WORKER_ROOT, '../.nvmrc'), 'utf8').trim();
    expect(nvmrc).toBe('26.12.1');
    const root = JSON.parse(readFileSync(join(WORKER_ROOT, '../package.json'), 'utf8')) as {
      engines: { node: string };
    };
    expect(root.engines.node).toBe('>=26.12.0');

    // node:sqlite's Database class (DatabaseSync is its deprecated alias) opens
    // and answers a query.
    const Database = nodeSqlite.Database;
    expect(typeof Database).toBe('function');
    expect(Database).toBe(sqlite.DatabaseSync);
    const db = new Database!(':memory:');
    try {
      expect(db.prepare('SELECT 1 + 1 AS two').get()).toEqual({ two: 2 });
      expect(db.isOpen).toBe(true);
    } finally {
      db.close();
    }
    expect(db.isOpen).toBe(false);

    // None of the workerd globals the Workers adapter relied on exist here.
    const globals = globalThis as Record<string, unknown>;
    for (const name of ['WebSocketPair', 'caches', 'HTMLRewriter']) {
      expect(name in globals, name).toBe(false);
      expect(typeof globals[name], name).toBe('undefined');
    }
  });

  it('String.prototype.normalize passes the Unicode 17 NFKC probe of packages/core/src/music-key.ts under Node ICU', () => {
    // Node's ICU implements Unicode 17 (Node 26.12.1: ICU 78.3, Unicode 17.0).
    expect(process.versions.icu).toMatch(/^\d+\.\d+/);
    expect(process.versions.unicode).toMatch(/^\d+\.\d+/);
    expect(versionAtLeast(process.versions.unicode!, '17.0'), process.versions.unicode).toBe(true);

    // music-key.ts's runtime probe: the Unicode 16.0.0 additions (U+1CCD6 -> A,
    // Kirat Rai U+16D63 U+16D67 -> U+16D69) that the assigned-only guard needs.
    expect(nfkcRuntimeSupportsGroupingVersion()).toBe(true);
    expect('\u{1CCD6}'.normalize('NFKC')).toBe('A');
    expect('\u{16D63}\u{16D67}'.normalize('NFKC')).toBe('\u{16D69}');

    // Unicode 17 itself: U+A7F1 MODIFIER LETTER CAPITAL S, unassigned in 16.0.0,
    // has its compatibility mapping to "S" in Node's ICU ...
    expect('\u{A7F1}'.normalize('NFKC')).toBe('S');
    // ... and normalizeMusic keeps it inert, as the Unicode 16.0.0 Rust oracle
    // does (music_key::normalize("\u{A7F1}") == "\u{A7F1}").
    expect(normalizeMusic('\u{A7F1}')).toBe('\u{A7F1}');
    expect(normalizeMusic('S\u{A7F1}s')).toBe('s\u{A7F1}s');
    // The grouping pipeline itself (tests/goldens/music_keys.json entries).
    expect(normalizeMusic('  BJÖRK  ')).toBe('björk');
    expect(normalizeMusic('Ｓｔｒａßｅ')).toBe('strasse');
  });

  it('the installed undici version equals process.versions.undici', async () => {
    // The undici that @atmusic/worker resolves (the pinned transport's Agent,
    // ADR 0005 §3.5) is the version Node bundles for its own fetch.
    const require = createRequire(join(WORKER_ROOT, 'package.json'));
    let dir = dirname(require.resolve('undici'));
    while (!statSync(join(dir, 'package.json'), { throwIfNoEntry: false })) dir = dirname(dir);
    const installed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string };
    expect(installed.name).toBe('undici');
    expect(process.versions.undici).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installed.version).toBe(process.versions.undici);

    // The workspace pins it exactly, to that same version.
    const manifest = JSON.parse(readFileSync(join(WORKER_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies.undici).toBe(installed.version);

    // It loads, and its Agent has the connect hook the pinning transport uses.
    const undici = await import('undici');
    expect(typeof undici.Agent).toBe('function');
    const agent = new undici.Agent({ connect: { rejectUnauthorized: true } });
    await agent.close();
  });

  it('process.versions.sqlite is 3.45 or newer with WAL, STRICT tables and JSON functions working, and process.versions.openssl is present for TLS', () => {
    expect(process.versions.sqlite).toMatch(/^\d+\.\d+\.\d+$/);
    expect(versionAtLeast(process.versions.sqlite!, '3.45.0'), process.versions.sqlite).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), 'atmusic-scaffold-'));
    tempDirs.push(dir);
    const file = join(dir, 'probe.db');
    const db = new sqlite.DatabaseSync(file);
    try {
      // The linked library reports the same version Node does.
      expect(db.prepare('SELECT sqlite_version() AS v').get()).toEqual({ v: process.versions.sqlite });

      // WAL on a file database: the mode sticks and a commit lands in the -wal file.
      expect(db.prepare('PRAGMA journal_mode=WAL').get()).toEqual({ journal_mode: 'wal' });
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });

      // STRICT tables enforce column types.
      db.exec('CREATE TABLE plays (id INTEGER PRIMARY KEY, n INTEGER NOT NULL, doc TEXT NOT NULL) STRICT');
      expect(() => db.prepare('INSERT INTO plays (n, doc) VALUES (?, ?)').run('not a number', '{}')).toThrow(
        /cannot store TEXT value in INTEGER column plays\.n/,
      );
      const insert = db.prepare('INSERT INTO plays (n, doc) VALUES (?, ?)');
      expect(insert.run(1, '{"artist":"Björk","tags":["a","b"]}').changes).toBe(1);
      expect(insert.run(2, '{"artist":"Kate Bush","tags":[]}').changes).toBe(1);
      expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);

      // JSON functions and the ->> operator.
      expect(
        db
          .prepare(
            "SELECT json_extract(doc, '$.artist') AS artist, json_array_length(doc, '$.tags') AS tags, doc ->> '$.tags[0]' AS first FROM plays ORDER BY n",
          )
          .all(),
      ).toEqual([
        { artist: 'Björk', tags: 2, first: 'a' },
        { artist: 'Kate Bush', tags: 0, first: null },
      ]);
      expect(db.prepare('SELECT json_group_array(n) AS ns FROM plays').get()).toEqual({ ns: '[1,2]' });
      expect(db.prepare("SELECT json_valid('{') AS ok").get()).toEqual({ ok: 0 });
    } finally {
      db.close();
    }

    // OpenSSL is linked for TLS: version reported, TLS 1.3 suites, a context builds.
    expect(process.versions.openssl).toMatch(/^\d+\.\d+\.\d+/);
    expect(getCiphers()).toContain('tls_aes_256_gcm_sha384');
    expect(() => createSecureContext({ minVersion: 'TLSv1.2' })).not.toThrow();
  });
});

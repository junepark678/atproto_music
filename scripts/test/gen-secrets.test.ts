// scripts/admin/gen-secrets.ts (ADR 0005 §3.8, §5.4, §14.2; N1-07): the
// generator's files are 0600, accepted by worker/src/node/secrets.ts, and fresh
// on every run. The script runs under Node's own type stripping, so the test
// spawns `node` directly (no tsx).

import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { loadSecrets } from '../../worker/src/node/secrets.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'admin', 'gen-secrets.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], stdout: 'pipe' | number = 'pipe') {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', stdout, 'pipe'],
    // No inherited NODE_OPTIONS or proxies; the generator needs nothing from the environment.
    env: { PATH: process.env.PATH ?? '/usr/bin' },
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const mode = (path: string) => statSync(path).mode & 0o777;

test('gen-secrets writes a 0600 file that secrets.ts accepts, and two runs produce different keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-gen-secrets-'));
  dirs.push(dir);
  const a = join(dir, 'a.json');
  const b = join(dir, 'b.json');

  const ra = run(['--out', a]);
  expect(ra.stderr).toBe('');
  expect(ra.status).toBe(0);
  expect(ra.stdout).toBe('');
  const rb = run(['--out', b]);
  expect(rb.status).toBe(0);
  expect(mode(a)).toBe(0o600);
  expect(mode(b)).toBe(0o600);

  // secrets.ts accepts both through ATMUSIC_SECRETS_FILE (which enforces 0600).
  const sa = loadSecrets({ ATMUSIC_SECRETS_FILE: a });
  const sb = loadSecrets({ ATMUSIC_SECRETS_FILE: b });
  expect(sa.cursorKey).toHaveLength(32);
  expect(sa.encryptionKeys.map((k) => [k.id, k.key.length])).toEqual([['e1', 32]]);
  expect(sa.oauthSigningKeys.map((k) => [k.kid, k.alg, k.crv])).toEqual([['k1', 'ES256', 'P-256']]);
  expect(sa.oauthAnnouncedKeys).toEqual([]);
  expect(sa.lastfm).toBeNull();

  // Two runs: every key differs.
  expect(Buffer.from(sa.cursorKey).equals(Buffer.from(sb.cursorKey))).toBe(false);
  expect(Buffer.from(sa.encryptionKeys[0]!.key).equals(Buffer.from(sb.encryptionKeys[0]!.key))).toBe(false);
  expect(sa.oauthSigningKeys[0]!.d).not.toBe(sb.oauthSigningKeys[0]!.d);
  expect(sa.oauthSigningKeys[0]!.x).not.toBe(sb.oauthSigningKeys[0]!.x);

  // --out never overwrites: exit 1, file unchanged.
  const before = readFileSync(a, 'utf8');
  const again = run(['--out', a]);
  expect(again.status).toBe(1);
  expect(again.stderr).toMatch(/must not exist/);
  expect(readFileSync(a, 'utf8')).toBe(before);

  // --oauth-key k2: a rotation key whose halves secrets.ts accepts as a signing
  // key and as an announced key next to the first file's keyset.
  const rot = run(['--oauth-key', 'k2']);
  expect(rot.status).toBe(0);
  const { oauthSigningKey, oauthAnnouncedKey } = JSON.parse(rot.stdout) as {
    oauthSigningKey: { kid: string; d: string; x: string; y: string };
    oauthAnnouncedKey: Record<string, string>;
  };
  expect(oauthSigningKey.kid).toBe('k2');
  expect(oauthAnnouncedKey).toEqual({
    kty: 'EC',
    crv: 'P-256',
    kid: 'k2',
    alg: 'ES256',
    x: oauthSigningKey.x,
    y: oauthSigningKey.y,
  });
  const doc = JSON.parse(before) as Record<string, unknown[]>;
  const announced = join(dir, 'announced.json');
  writeFileSync(announced, JSON.stringify({ ...doc, oauthAnnouncedKeys: [oauthAnnouncedKey] }), { mode: 0o600 });
  expect(loadSecrets({ ATMUSIC_SECRETS_FILE: announced }).oauthAnnouncedKeys.map((k) => k.kid)).toEqual(['k2']);
  const rotated = join(dir, 'rotated.json');
  writeFileSync(
    rotated,
    JSON.stringify({
      ...doc,
      oauthSigningKeys: [oauthSigningKey, ...(doc.oauthSigningKeys ?? [])],
      oauthAnnouncedKeys: [oauthAnnouncedKey],
    }),
    { mode: 0o600 },
  );
  expect(loadSecrets({ ATMUSIC_SECRETS_FILE: rotated }).oauthSigningKeys.map((k) => k.kid)).toEqual(['k2', 'k1']);

  // `> secrets.json`: the shell created the file with the umask (0644 here);
  // the generator narrows it to 0600 before writing.
  const redirected = join(dir, 'redirected.json');
  const fd = openSync(redirected, 'w', 0o644);
  try {
    chmodSync(redirected, 0o644); // whatever this process's umask is
    expect(mode(redirected)).toBe(0o644);
    const viaStdout = run([], fd);
    expect(viaStdout.status).toBe(0);
  } finally {
    closeSync(fd);
  }
  expect(mode(redirected)).toBe(0o600);
  expect(loadSecrets({ ATMUSIC_SECRETS_FILE: redirected }).oauthSigningKeys[0]?.kid).toBe('k1');

  // Usage errors exit 2 and write nothing.
  expect(run(['--oauth-key', 'bad kid']).status).toBe(2);
  expect(run(['--bogus']).status).toBe(2);
});

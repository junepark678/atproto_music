// Node host secrets (ADR 0005 §3.8, §5.4, §14.2; N1-07): where the document is
// read from, the 0600 rule for ATMUSIC_SECRETS_FILE, field validation, and that
// no secret value leaks into process.env, serialised config or error text.
//
// Keys are deterministic: every P-256 key is derived from a fixed seed with
// node:crypto ECDH, and the symmetric keys are fixed byte patterns.

import { createECDH, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, type ConfigIssue, FIXTURE_PREFIX } from '../../src/config';
import { parseNodeConfig } from '../../src/node/config';
import { loadSecrets, parseSecrets } from '../../src/node/secrets';

interface Jwk {
  kty: string;
  crv: string;
  kid: string;
  d?: string;
  x: string;
  y: string;
  [member: string]: unknown;
}

/** A P-256 private JWK derived from `seed` (deterministic). */
function jwkFromSeed(kid: string, seed: string): Jwk {
  const d = createHash('sha256').update(seed).digest();
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  return {
    kty: 'EC',
    crv: 'P-256',
    kid,
    d: d.toString('base64url'),
    x: point.subarray(1, 33).toString('base64url'),
    y: point.subarray(33, 65).toString('base64url'),
  };
}

const publicOf = ({ d: _d, ...pub }: Jwk): Jwk => pub;
const bytes = (n: number, fill: number) => Buffer.alloc(n, fill);
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

const K1 = jwkFromSeed('k1', 'signing key one');
const K2 = jwkFromSeed('k2', 'signing key two');
const CURSOR = bytes(32, 0x5a);
const ENC = bytes(32, 0x3c);
const LASTFM = { apiKey: '0123456789abcdef0123456789abcdef', sharedSecret: 'fedcba9876543210fedcba9876543210' };

function validDoc(): Record<string, unknown> {
  return {
    cursorKey: b64(CURSOR),
    encryptionKeys: [
      { id: 'e2', key: b64(ENC) },
      { id: 'e1', key: b64(bytes(32, 0x11)) },
    ],
    oauthSigningKeys: [K1],
    oauthAnnouncedKeys: [publicOf(K2)],
    lastfm: { ...LASTFM },
  };
}

/** Every secret string a valid document carries, in the encodings that could leak. */
function secretStrings(): string[] {
  const out = [b64(CURSOR), b64(ENC), b64(bytes(32, 0x11)), K1.d as string, LASTFM.apiKey, LASTFM.sharedSecret];
  out.push(CURSOR.toString('hex'), ENC.toString('hex'), Buffer.from(K1.d as string, 'base64url').toString('hex'));
  return out;
}

function issuesOf(fn: () => unknown): ConfigIssue[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return [...(err as ConfigError).issues];
  }
  throw new Error('expected a ConfigError');
}

const fields = (issues: readonly ConfigIssue[]) => issues.map((i) => i.field);

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atmusic-secrets-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeSecrets(path: string, doc: unknown, mode: number): string {
  writeFileSync(path, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

describe('loadSecrets', () => {
  it('secrets load from $CREDENTIALS_DIRECTORY/secrets; ATMUSIC_SECRETS_FILE with mode 0640 is refused', () => {
    // systemd's credential directory holds the file read-only (0400).
    const creds = tempDir();
    writeSecrets(join(creds, 'secrets'), validDoc(), 0o400);
    const s = loadSecrets({ CREDENTIALS_DIRECTORY: creds });
    expect(Buffer.from(s.cursorKey).equals(CURSOR)).toBe(true);
    expect(s.encryptionKeys.map((k) => k.id)).toEqual(['e2', 'e1']);
    expect(Buffer.from(s.encryptionKeys[0]?.key ?? []).equals(ENC)).toBe(true);
    expect(s.oauthSigningKeys).toEqual([{ ...K1, alg: 'ES256' }]);
    expect(s.oauthAnnouncedKeys).toEqual([{ ...publicOf(K2), alg: 'ES256' }]);
    expect(s.lastfm).toEqual(LASTFM);
    // lastfm and oauthAnnouncedKeys are optional.
    const { lastfm: _l, oauthAnnouncedKeys: _a, ...minimal } = validDoc();
    const min = parseSecrets(minimal);
    expect(min.lastfm).toBeNull();
    expect(min.oauthAnnouncedKeys).toEqual([]);

    // A missing credential file names the directory variable.
    expect(fields(issuesOf(() => loadSecrets({ CREDENTIALS_DIRECTORY: tempDir() })))).toEqual([
      'CREDENTIALS_DIRECTORY',
    ]);

    // ATMUSIC_SECRETS_FILE: 0640 (and any group/other or exec bit) is refused before reading.
    const dev = tempDir();
    for (const mode of [0o640, 0o644, 0o604, 0o660, 0o700, 0o666]) {
      const path = writeSecrets(join(dev, `s-${mode.toString(8)}.json`), validDoc(), mode);
      const issues = issuesOf(() => loadSecrets({ ATMUSIC_SECRETS_FILE: path }));
      expect(fields(issues), mode.toString(8)).toEqual(['ATMUSIC_SECRETS_FILE']);
      expect(issues[0]?.message, mode.toString(8)).toContain(`0${mode.toString(8)}`);
      expect(issues[0]?.message).toMatch(/0600 or stricter/);
    }
    // 0600 and stricter are accepted.
    for (const mode of [0o600, 0o400]) {
      const path = writeSecrets(join(dev, `ok-${mode.toString(8)}.json`), validDoc(), mode);
      expect(loadSecrets({ ATMUSIC_SECRETS_FILE: path }).oauthSigningKeys[0]?.kid).toBe('k1');
    }
    // Owned by another user, a symlink, a directory: refused.
    const owned = writeSecrets(join(dev, 'owned.json'), validDoc(), 0o600);
    expect(
      fields(issuesOf(() => loadSecrets({ ATMUSIC_SECRETS_FILE: owned }, { uid: (process.getuid?.() ?? 0) + 1 }))),
    ).toEqual(['ATMUSIC_SECRETS_FILE']);
    const link = join(dev, 'link.json');
    symlinkSync(owned, link);
    expect(fields(issuesOf(() => loadSecrets({ ATMUSIC_SECRETS_FILE: link })))).toEqual(['ATMUSIC_SECRETS_FILE']);
    const sub = join(dev, 'dir');
    mkdirSync(sub, { mode: 0o700 });
    expect(fields(issuesOf(() => loadSecrets({ ATMUSIC_SECRETS_FILE: sub })))).toEqual(['ATMUSIC_SECRETS_FILE']);

    // Both sources at once, or neither: refused.
    expect(fields(issuesOf(() => loadSecrets({ CREDENTIALS_DIRECTORY: creds, ATMUSIC_SECRETS_FILE: owned })))).toEqual([
      'ATMUSIC_SECRETS_FILE',
    ]);
    expect(fields(issuesOf(() => loadSecrets({})))).toEqual(['CREDENTIALS_DIRECTORY']);
  });

  it('duplicate kids, a public-only signing key, a 16-byte cursorKey or a 31-byte encryption key are each a ConfigError naming the field', () => {
    expect(() => parseSecrets(validDoc())).not.toThrow();
    const cases: [string, (doc: Record<string, unknown>) => void][] = [
      ['oauthSigningKeys', (d) => (d.oauthSigningKeys = [K1, { ...K2, kid: 'k1' }])], // duplicate kid
      ['oauthSigningKeys', (d) => (d.oauthSigningKeys = [publicOf(K1)])], // public-only
      ['oauthSigningKeys', (d) => (d.oauthSigningKeys = [{ ...K1, x: K2.x, y: K2.y }])], // d does not match x/y
      ['oauthSigningKeys', (d) => (d.oauthSigningKeys = [{ ...K1, alg: 'ES256K' }])],
      ['oauthSigningKeys', (d) => (d.oauthSigningKeys = [{ ...K1, crv: 'P-384' }])],
      ['oauthSigningKeys', (d) => (d.oauthSigningKeys = [])],
      ['oauthAnnouncedKeys', (d) => (d.oauthAnnouncedKeys = [publicOf(K2), { ...publicOf(K2) }])], // duplicate kid
      ['oauthAnnouncedKeys', (d) => (d.oauthAnnouncedKeys = [K2])], // private material
      ['oauthAnnouncedKeys', (d) => (d.oauthAnnouncedKeys = [{ ...publicOf(K2), kid: 'k1' }])], // kid of another key
      ['cursorKey', (d) => (d.cursorKey = b64(bytes(16, 0x5a)))],
      ['cursorKey', (d) => (d.cursorKey = b64(bytes(31, 0x5a)))],
      ['cursorKey', (d) => (d.cursorKey = b64(bytes(32, 0)))],
      ['cursorKey', (d) => (d.cursorKey = `${b64(CURSOR)}\n`)], // not strict base64
      ['cursorKey', (d) => (d.cursorKey = CURSOR.toString('base64url').replace(/=+$/, '').slice(0, 42))], // unpadded
      ['encryptionKeys', (d) => (d.encryptionKeys = [{ id: 'e1', key: b64(bytes(31, 1)) }])],
      ['encryptionKeys', (d) => (d.encryptionKeys = [{ id: 'e1', key: b64(bytes(33, 1)) }])],
      [
        'encryptionKeys',
        (d) =>
          (d.encryptionKeys = [
            { id: 'e1', key: b64(ENC) },
            { id: 'e1', key: b64(ENC) },
          ]),
      ],
      ['encryptionKeys', (d) => (d.encryptionKeys = [])],
      ['lastfm', (d) => (d.lastfm = { apiKey: LASTFM.apiKey })],
      ['secrets', (d) => (d.cursorkey = d.cursorKey)], // unknown member (typo)
    ];
    for (const [field, mutate] of cases) {
      const doc = validDoc();
      mutate(doc);
      const issues = issuesOf(() => parseSecrets(doc));
      expect(fields(issues), `${field}: ${mutate.toString()}`).toEqual([field]);
    }
    // A key both announced and in the keyset (rotation step 3) is accepted when it is the same key.
    const both = parseSecrets({ ...validDoc(), oauthSigningKeys: [K2, K1], oauthAnnouncedKeys: [publicOf(K2)] });
    expect(both.oauthSigningKeys.map((k) => k.kid)).toEqual(['k2', 'k1']);
    // Several bad fields are all named.
    const many = issuesOf(() =>
      parseSecrets({
        ...validDoc(),
        cursorKey: b64(bytes(16, 1)),
        encryptionKeys: [{ id: 'e1', key: b64(bytes(31, 1)) }],
      }),
    );
    expect(fields(many)).toEqual(['cursorKey', 'encryptionKeys']);
  });

  it('no secret value appears in process.env, JSON.stringify(config) or any thrown error text', () => {
    const dir = tempDir();
    const path = writeSecrets(join(dir, 'secrets.json'), validDoc(), 0o600);
    vi.stubEnv('ATMUSIC_SECRETS_FILE', path);
    const envKeysBefore = Object.keys(process.env).sort();
    const secrets = loadSecrets(process.env);
    expect(secrets.lastfm).toEqual(LASTFM); // loaded for real

    const leaks = (text: string) => secretStrings().filter((s) => text.includes(s));
    // process.env gained nothing and holds no secret.
    expect(Object.keys(process.env).sort()).toEqual(envKeysBefore);
    expect(leaks(Object.values(process.env).join('\n'))).toEqual([]);

    // The parsed config and the secrets object serialise without secrets.
    const config = parseNodeConfig(
      {
        ...process.env,
        ATMUSIC_PUBLIC_ORIGIN: 'https://music.example.org',
        ATMUSIC_CLIENT_IP_HEADER: 'none',
        ATMUSIC_SIGNIN_DIDS: 'did:plc:abcdefghijklmnopqrstuvwx',
        STATE_DIRECTORY: dir,
        XDG_RUNTIME_DIR: dir,
        LEXICON_PREFIX: FIXTURE_PREFIX,
        INGEST_MODE: 'off',
        JETSTREAM_LOOKBACK_HOURS: '24',
        RELAY_URL: 'https://relay.example.org',
        PLAN: undefined,
        DO_LOCATION_HINT: undefined,
      },
      { allowFixturePrefix: true },
    );
    expect(leaks(JSON.stringify(config))).toEqual([]);
    const serialised = JSON.stringify(secrets);
    expect(leaks(serialised)).toEqual([]);
    expect(JSON.parse(serialised)).toEqual({
      cursorKey: '[redacted]',
      encryptionKeys: [
        { id: 'e2', key: '[redacted]' },
        { id: 'e1', key: '[redacted]' },
      ],
      oauthSigningKeys: [{ kid: 'k1', d: '[redacted]' }],
      oauthAnnouncedKeys: [{ kid: 'k2' }],
      lastfm: '[redacted]',
    });
    expect(leaks(inspect(secrets, { depth: 10 }))).toEqual([]);
    expect(leaks(JSON.stringify({ config, secrets }))).toEqual([]);

    // Errors: every rejected document that carries secret values, including
    // malformed JSON (whose SyntaxError would quote the input).
    const valid = JSON.stringify(validDoc());
    const bad: unknown[] = [
      `${valid.slice(0, -1)},`, // truncated JSON
      `{"cursorKey": "${b64(CURSOR)}", oops}`,
      { ...validDoc(), cursorKey: b64(CURSOR.subarray(0, 16)) },
      { ...validDoc(), encryptionKeys: [{ id: 'e1', key: ENC.toString('hex') }] },
      { ...validDoc(), encryptionKeys: [{ id: b64(ENC), key: b64(ENC) }] }, // secret where an id belongs
      { ...validDoc(), oauthSigningKeys: [{ ...K1, kid: `${K1.d}!` }] }, // a secret where a kid belongs
      { ...validDoc(), oauthSigningKeys: [{ ...K1, x: K2.x }] },
      { ...validDoc(), oauthAnnouncedKeys: [K1] },
      { ...validDoc(), lastfm: { apiKey: LASTFM.apiKey, sharedSecret: `${LASTFM.sharedSecret} x` } },
      { ...validDoc(), lastfm: LASTFM.sharedSecret },
      { ...validDoc(), [LASTFM.sharedSecret]: 1 },
    ];
    for (const [i, doc] of bad.entries()) {
      const file = writeSecrets(join(dir, `bad-${i}.json`), doc, 0o600);
      let caught: unknown = null;
      try {
        loadSecrets({ ATMUSIC_SECRETS_FILE: file });
      } catch (err) {
        caught = err;
      }
      expect(caught, `case ${i}`).toBeInstanceOf(ConfigError);
      const err = caught as ConfigError;
      const text = [String(err), err.message, err.stack ?? '', JSON.stringify(err.issues), inspect(err)].join('\n');
      expect(leaks(text), `case ${i}`).toEqual([]);
    }
    // And the 0640 refusal does not read (or quote) the file.
    const wide = writeSecrets(join(dir, 'wide.json'), validDoc(), 0o640);
    const wideIssues = issuesOf(() => loadSecrets({ ATMUSIC_SECRETS_FILE: wide }));
    expect(leaks(JSON.stringify(wideIssues))).toEqual([]);
  });
});

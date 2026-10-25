// Node host configuration (ADR 0005 §3.8, §3.6, §5.7, §11.1, §14.1; N1-07):
// parseNodeConfig's defaults and refusals, the forbidden runtime environment,
// the fixed process timings and the disk-space predicate.
//
// parseConfig (worker/src/config.ts) is wrapped in a recording spy, so the test
// can see exactly what the Node configuration hands the embedded ADR 0004
// parser; its behaviour is the real one.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUDGETS, ConfigError, type ConfigIssue, FIXTURE_PREFIX, parseConfig } from '../../src/config';
import {
  checkRuntimeEnv,
  FORBIDDEN_RUNTIME_ENV,
  type NodeEnv,
  type ParseNodeConfigOptions,
  parseNodeConfig,
} from '../../src/node/config';
import { diskLow, diskLowProbe, freeBytes, type StatfsFn } from '../../src/node/disk';

vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>();
  return { ...actual, parseConfig: vi.fn(actual.parseConfig) };
});

const parseConfigSpy = vi.mocked(parseConfig);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';

/** A complete, valid unit environment (as atmusic.env plus systemd's directories). */
function baseEnv(): Record<string, string | undefined> {
  return {
    ATMUSIC_PUBLIC_ORIGIN: 'https://music.example.org',
    ATMUSIC_CLIENT_IP_HEADER: 'cf-connecting-ip',
    ATMUSIC_SIGNIN_DIDS: DID,
    STATE_DIRECTORY: '/home/owner/.local/state/atmusic',
    XDG_RUNTIME_DIR: '/run/user/1000',
    LEXICON_PREFIX: FIXTURE_PREFIX,
    NAMESPACE_OWNERSHIP_REF: '',
    JETSTREAM_URLS: 'wss://jetstream.example.org',
    JETSTREAM_LOOKBACK_HOURS: '24',
    RELAY_URL: 'https://relay.example.org',
  };
}

const TEST_OPTS: ParseNodeConfigOptions = { allowFixturePrefix: true, releaseRoot: '/opt/atmusic/release' };

function parse(env: NodeEnv, opts: ParseNodeConfigOptions = {}) {
  return parseNodeConfig(env, { ...TEST_OPTS, ...opts });
}

/** The issues of the ConfigError `fn` throws (failing the test if it does not throw one). */
function issuesOf(fn: () => unknown): ConfigIssue[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return [...(err as ConfigError).issues];
  }
  throw new Error('expected a ConfigError, but parsing succeeded');
}

const fields = (issues: readonly ConfigIssue[]) => issues.map((i) => i.field);

/**
 * Variables a reader might expect to relax a rule. None does: the only
 * relaxation is the fixtureOrigins option.
 */
const WOULD_BE_RELAXERS: Record<string, string> = {
  NODE_ENV: 'development',
  ATMUSIC_FIXTURE_ORIGINS: '1',
  ATMUSIC_FIXTURES: 'true',
  FIXTURE_ORIGINS: 'true',
  ATMUSIC_ALLOW_HTTP: '1',
  ATMUSIC_INSECURE: '1',
  ATMUSIC_DEV: '1',
  ATMUSIC_TEST: '1',
  ATMUSIC_E2E: '1',
  VITEST: 'true',
  CI: 'true',
  DEBUG: '*',
  ALLOW_FIXTURE_PREFIX: '1',
};

beforeEach(() => {
  parseConfigSpy.mockClear();
});

describe('parseNodeConfig', () => {
  it('ATMUSIC_DB defaults to $STATE_DIRECTORY/atmusic.db; with neither set the ConfigError names ATMUSIC_DB', () => {
    const cfg = parse(baseEnv());
    expect(cfg.dbPath).toBe('/home/owner/.local/state/atmusic/atmusic.db');
    // The other STATE_DIRECTORY defaults of the §3.8 table, and the release-relative assets.
    expect(cfg.backupDir).toBe('/home/owner/.local/state/atmusic/backups');
    expect(cfg.uploadDir).toBe('/home/owner/.local/state/atmusic/imports');
    expect(cfg.adminSocket).toBe('/run/user/1000/atmusic/admin.sock');
    expect(cfg.assetsDir).toBe('/opt/atmusic/release/web/dist');
    expect(cfg.listen).toEqual({ host: '127.2.0.1', port: 8888 });

    // systemd lists several state directories colon-separated; the first is ours.
    expect(parse({ ...baseEnv(), STATE_DIRECTORY: '/srv/a:/srv/b' }).dbPath).toBe('/srv/a/atmusic.db');
    // An explicit ATMUSIC_DB wins over STATE_DIRECTORY, and works without it.
    expect(parse({ ...baseEnv(), ATMUSIC_DB: '/data/music.db' }).dbPath).toBe('/data/music.db');
    const noState = parse({
      ...baseEnv(),
      STATE_DIRECTORY: undefined,
      ATMUSIC_DB: '/data/music.db',
      ATMUSIC_BACKUP_DIR: '/data/backups',
      ATMUSIC_UPLOAD_DIR: '/data/imports',
    });
    expect(noState.dbPath).toBe('/data/music.db');

    // Neither: a ConfigError naming ATMUSIC_DB (and nothing about the value).
    const neither = issuesOf(() =>
      parse({ ...baseEnv(), STATE_DIRECTORY: undefined, ATMUSIC_BACKUP_DIR: '/b', ATMUSIC_UPLOAD_DIR: '/u' }),
    );
    expect(fields(neither)).toEqual(['ATMUSIC_DB']);
    expect(neither[0]?.message).toMatch(/STATE_DIRECTORY/);
    // Empty values count as unset; a relative path is refused.
    expect(
      fields(
        issuesOf(() =>
          parse({ ...baseEnv(), STATE_DIRECTORY: '', ATMUSIC_BACKUP_DIR: '/b', ATMUSIC_UPLOAD_DIR: '/u' }),
        ),
      ),
    ).toEqual(['ATMUSIC_DB']);
    expect(fields(issuesOf(() => parse({ ...baseEnv(), ATMUSIC_DB: 'atmusic.db' })))).toEqual(['ATMUSIC_DB']);
  });

  it('without the fixtureOrigins option an http PUBLIC_ORIGIN, and an upstream root that is http, an IP literal, a loopback name or a non-default port, are rejected whatever other environment variables are set', () => {
    const env = { ...baseEnv(), ...WOULD_BE_RELAXERS };
    // Control: the environment itself parses.
    expect(parse(env).publicOrigin).toBe('https://music.example.org');

    for (const origin of ['http://music.example.org', 'http://127.0.0.1:8888', 'http://localhost:5173']) {
      const issues = issuesOf(() =>
        parse({ ...env, ATMUSIC_PUBLIC_ORIGIN: origin, PUBLIC_ORIGIN: 'https://music.example.org' }),
      );
      expect(fields(issues), origin).toEqual(['ATMUSIC_PUBLIC_ORIGIN']);
    }

    const badRoots: Record<string, string> = {
      http: 'http://ws.audioscrobbler.com/2.0/',
      ipv4: 'https://203.0.113.7/2.0/',
      ipv4Decimal: 'https://3405803783/',
      ipv6: 'https://[2001:db8::1]/',
      loopbackIp: 'https://127.0.0.1/',
      localhost: 'https://localhost/2.0/',
      subLocalhost: 'https://lastfm.localhost/2.0/',
      localdomain: 'https://localhost.localdomain/',
      port: 'https://ws.audioscrobbler.com:8443/2.0/',
      fixtureTld: 'https://lastfm.test/2.0/',
    };
    for (const name of ['LASTFM_API_ROOT', 'LASTFM_AUTH_URL', 'LISTENBRAINZ_API_ROOT']) {
      for (const [kind, root] of Object.entries(badRoots)) {
        const issues = issuesOf(() => parse({ ...env, [name]: root }));
        expect(fields(issues), `${name} ${kind}`).toEqual([name]);
      }
    }

    // The defaults are the real upstreams; an explicit :443 is the default port.
    const cfg = parse({ ...env, LISTENBRAINZ_API_ROOT: 'https://api.listenbrainz.org:443/' });
    expect(cfg.lastfmApiRoot).toBe('https://ws.audioscrobbler.com/2.0/');
    expect(cfg.lastfmAuthUrl).toBe('https://www.last.fm/api/auth/');
    expect(cfg.fixtureOrigins).toBe(false);

    // Non-vacuity: the test-only option is what admits the e2e stack's values,
    // and it still refuses http upstreams, IP literals and loopback names.
    const fixture = parse(
      {
        ...env,
        ATMUSIC_PUBLIC_ORIGIN: 'http://127.0.0.1:41234',
        ATMUSIC_LISTEN: '127.0.0.1:0',
        LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
        LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
      },
      { fixtureOrigins: true },
    );
    expect(fixture.publicOrigin).toBe('http://127.0.0.1:41234');
    expect(fixture.app.publicOrigin).toBe('http://127.0.0.1:41234');
    expect(fixture.listen).toEqual({ host: '127.0.0.1', port: 0 });
    expect(fixture.fixtureOrigins).toBe(true);
    for (const kind of ['http', 'ipv4', 'loopbackIp', 'localhost', 'port'] as const) {
      const issues = issuesOf(() => parse({ ...env, LASTFM_API_ROOT: badRoots[kind] }, { fixtureOrigins: true }));
      expect(fields(issues), kind).toEqual(['LASTFM_API_ROOT']);
    }
    // Even in fixture mode an http origin must be loopback.
    expect(
      fields(
        issuesOf(() => parse({ ...env, ATMUSIC_PUBLIC_ORIGIN: 'http://music.example.org' }, { fixtureOrigins: true })),
      ),
    ).toEqual(['ATMUSIC_PUBLIC_ORIGIN']);
    // And the listener is loopback-only whatever the option.
    expect(fields(issuesOf(() => parse({ ...env, ATMUSIC_LISTEN: '0.0.0.0:8888' }, { fixtureOrigins: true })))).toEqual(
      ['ATMUSIC_LISTEN'],
    );
    expect(fields(issuesOf(() => parse({ ...env, ATMUSIC_LISTEN: '127.0.0.1:0' })))).toEqual(['ATMUSIC_LISTEN']);
  });

  it('INGEST_MODE=pulse, an operator-set PLAN (paid or free) and DO_LOCATION_HINT are each rejected with a message citing ADR 0005, and the embedded parseConfig receives PLAN paid and an empty DO_LOCATION_HINT', () => {
    const cases: [string, Record<string, string>][] = [
      ['INGEST_MODE', { INGEST_MODE: 'pulse' }],
      ['PLAN', { PLAN: 'paid' }],
      ['PLAN', { PLAN: 'free' }],
      ['PLAN', { PLAN: '' }],
      ['DO_LOCATION_HINT', { DO_LOCATION_HINT: 'weur' }],
      ['DO_LOCATION_HINT', { DO_LOCATION_HINT: '' }],
    ];
    for (const [field, extra] of cases) {
      const issues = issuesOf(() => parse({ ...baseEnv(), ...extra }));
      expect(fields(issues), JSON.stringify(extra)).toEqual([field]);
      expect(issues[0]?.message, JSON.stringify(extra)).toMatch(/ADR 0005/);
    }
    // Any other mode is refused too; socket is the default and off stays.
    expect(fields(issuesOf(() => parse({ ...baseEnv(), INGEST_MODE: 'poll' })))).toEqual(['INGEST_MODE']);
    expect(parse(baseEnv()).ingestMode).toBe('socket');
    expect(parse({ ...baseEnv(), INGEST_MODE: 'off', JETSTREAM_URLS: '' }).ingestMode).toBe('off');

    parseConfigSpy.mockClear();
    const cfg = parse(baseEnv());
    expect(parseConfigSpy).toHaveBeenCalledTimes(1);
    const [handed, options] = parseConfigSpy.mock.calls[0] ?? [];
    expect(handed?.PLAN).toBe('paid');
    expect(handed?.DO_LOCATION_HINT).toBe('');
    expect(handed?.INGEST_MODE).toBe('socket');
    expect(handed?.PUBLIC_ORIGIN).toBe('https://music.example.org');
    expect(handed?.ADMIN_TOKEN).toBeUndefined();
    expect(options).toEqual({ allowFixturePrefix: true });
    // So the embedded config carries the paid budget and no location hint.
    expect(cfg.app.plan).toBe('paid');
    expect(cfg.app.budget).toEqual(BUDGETS.paid);
    expect(cfg.app.doLocationHint).toBeNull();
    expect(cfg.app.collections?.scrobble).toBe(`${FIXTURE_PREFIX}.scrobble`);
  });

  it('ATMUSIC_CLIENT_IP_HEADER unset is a ConfigError naming it, and the allowlist sign-in policy with an empty ATMUSIC_SIGNIN_DIDS is a ConfigError naming ATMUSIC_SIGNIN_DIDS', () => {
    for (const value of [undefined, '']) {
      const issues = issuesOf(() => parse({ ...baseEnv(), ATMUSIC_CLIENT_IP_HEADER: value }));
      expect(fields(issues)).toEqual(['ATMUSIC_CLIENT_IP_HEADER']);
      expect(issues[0]?.message).toMatch(/no default/);
    }
    expect(fields(issuesOf(() => parse({ ...baseEnv(), ATMUSIC_CLIENT_IP_HEADER: 'forwarded' })))).toEqual([
      'ATMUSIC_CLIENT_IP_HEADER',
    ]);
    for (const mode of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'none'] as const) {
      expect(parse({ ...baseEnv(), ATMUSIC_CLIENT_IP_HEADER: mode }).clientIpHeader).toBe(mode);
    }

    for (const dids of [undefined, '', ' , ']) {
      const issues = issuesOf(() => parse({ ...baseEnv(), ATMUSIC_SIGNIN_DIDS: dids }));
      expect(fields(issues), String(dids)).toEqual(['ATMUSIC_SIGNIN_DIDS']);
    }
    // Explicit allowlist, the same; a malformed DID is refused under either policy.
    expect(
      fields(issuesOf(() => parse({ ...baseEnv(), ATMUSIC_SIGNIN_POLICY: 'allowlist', ATMUSIC_SIGNIN_DIDS: '' }))),
    ).toEqual(['ATMUSIC_SIGNIN_DIDS']);
    expect(
      fields(issuesOf(() => parse({ ...baseEnv(), ATMUSIC_SIGNIN_POLICY: 'open', ATMUSIC_SIGNIN_DIDS: 'alice' }))),
    ).toEqual(['ATMUSIC_SIGNIN_DIDS']);
    // The open policy needs no list; a list is parsed and trimmed.
    expect(parse({ ...baseEnv(), ATMUSIC_SIGNIN_POLICY: 'open', ATMUSIC_SIGNIN_DIDS: undefined }).signinDids).toEqual(
      [],
    );
    expect(parse({ ...baseEnv(), ATMUSIC_SIGNIN_DIDS: `${DID}, did:web:music.example.org` }).signinDids).toEqual([
      DID,
      'did:web:music.example.org',
    ]);
    // Both missing at once: both are named.
    expect(
      fields(
        issuesOf(() => parse({ ...baseEnv(), ATMUSIC_CLIENT_IP_HEADER: undefined, ATMUSIC_SIGNIN_DIDS: undefined })),
      ),
    ).toEqual(['ATMUSIC_CLIENT_IP_HEADER', 'ATMUSIC_SIGNIN_DIDS']);
  });

  it('ATMUSIC_UPLOAD_MAX_BYTES defaults to 1 GiB, ATMUSIC_MIN_FREE_BYTES to 2 GiB and ATMUSIC_SIGNIN_POLICY to allowlist', () => {
    const cfg = parse(baseEnv());
    expect(cfg.uploadMaxBytes).toBe(1_073_741_824);
    expect(cfg.uploadMaxBytes).toBe(1024 ** 3);
    expect(cfg.minFreeBytes).toBe(2 * 1024 ** 3);
    expect(cfg.signinPolicy).toBe('allowlist');
    expect(cfg.signinDids).toEqual([DID]);
    // The rest of the §3.8 defaults.
    expect(cfg.trustedProxies).toEqual(['127.0.0.0/8', '::1']);
    expect(cfg.lastfmKnownClients).toEqual([
      { apiKey: 'panoScrobbler', sharedSecret: 'panoScrobbler', name: 'Pano Scrobbler' },
    ]);
    expect(cfg.listenbrainzApiRoot).toBe('https://api.listenbrainz.org/');
    expect(cfg.oauthTransitionGeneric).toBe(false);

    const set = parse({
      ...baseEnv(),
      ATMUSIC_UPLOAD_MAX_BYTES: '5000',
      ATMUSIC_MIN_FREE_BYTES: '7000',
      ATMUSIC_SIGNIN_POLICY: 'open',
      ATMUSIC_OAUTH_TRANSITION_GENERIC: '1',
    });
    expect([set.uploadMaxBytes, set.minFreeBytes, set.signinPolicy, set.oauthTransitionGeneric]).toEqual([
      5000,
      7000,
      'open',
      true,
    ]);
    for (const [name, value] of [
      ['ATMUSIC_UPLOAD_MAX_BYTES', '0'],
      ['ATMUSIC_UPLOAD_MAX_BYTES', '-1'],
      ['ATMUSIC_MIN_FREE_BYTES', '2GiB'],
      ['ATMUSIC_MIN_FREE_BYTES', '9007199254740993'],
      ['ATMUSIC_SIGNIN_POLICY', 'closed'],
      ['ATMUSIC_TRUSTED_PROXIES', '127.0.0.0/33'],
    ] as const) {
      expect(fields(issuesOf(() => parse({ ...baseEnv(), [name]: value }))), `${name}=${value}`).toEqual([name]);
    }

    // config/atmusic.env.example documents these defaults: setting each
    // commented default explicitly changes nothing, and the template with its
    // required blanks filled parses as the production configuration.
    const example = readFileSync(join(REPO, 'config', 'atmusic.env.example'), 'utf8');
    const [required = '', defaults = ''] = example.split(/^# --- Defaults.*$/m);
    const assignmentsIn = (text: string) =>
      [...text.matchAll(/^#([A-Z_][A-Z0-9_]*)=(.*)$/gm)].map((m) => [m[1] as string, m[2] as string] as const);
    const documented = assignmentsIn(defaults).filter(([, value]) => value !== '');
    expect(documented.map(([name]) => name)).toEqual(
      expect.arrayContaining(['ATMUSIC_UPLOAD_MAX_BYTES', 'ATMUSIC_MIN_FREE_BYTES', 'ATMUSIC_SIGNIN_POLICY']),
    );
    for (const [name, value] of documented) {
      expect(parse({ ...baseEnv(), [name]: value }), name).toEqual(cfg);
    }
    const template: Record<string, string> = Object.fromEntries(assignmentsIn(required));
    const production = parseNodeConfig({
      ...template,
      ATMUSIC_CLIENT_IP_HEADER: 'cf-connecting-ip',
      ATMUSIC_SIGNIN_DIDS: DID,
      STATE_DIRECTORY: '/home/owner/.local/state/atmusic',
      XDG_RUNTIME_DIR: '/run/user/1000',
    });
    expect(production.publicOrigin).toBe('https://music.214510.xyz');
    expect(production.app.prefix).toBe('dev.pythonplayer123.music');
    expect(production.app.publication).toBe(false);
    expect([production.uploadMaxBytes, production.minFreeBytes, production.signinPolicy]).toEqual([
      1024 ** 3,
      2 * 1024 ** 3,
      'allowlist',
    ]);
  });

  it('the production NodeConfig has busyTimeoutMs 5000 and drainMs 25000, and no environment variable changes either', () => {
    const cfg = parse(baseEnv());
    expect(cfg.busyTimeoutMs).toBe(5000);
    expect(cfg.drainMs).toBe(25_000);

    const attempts: Record<string, string> = {
      ...WOULD_BE_RELAXERS,
      ATMUSIC_BUSY_TIMEOUT_MS: '1',
      ATMUSIC_DRAIN_MS: '1',
      BUSY_TIMEOUT_MS: '1',
      DRAIN_MS: '1',
      ATMUSIC_BUSY_TIMEOUT: '1',
      ATMUSIC_DRAIN: '1',
      SQLITE_BUSY_TIMEOUT: '1',
      TimeoutStopSec: '1',
      WATCHDOG_USEC: '1000',
    };
    for (const [name, value] of Object.entries(attempts)) {
      const one = parse({ ...baseEnv(), [name]: value });
      expect([one.busyTimeoutMs, one.drainMs], name).toEqual([5000, 25_000]);
    }
    const all = parse({ ...baseEnv(), ...attempts });
    expect([all.busyTimeoutMs, all.drainMs]).toEqual([5000, 25_000]);
    // The fixture option does not change them either; tests set smaller ones on the object.
    const fixture = parse(baseEnv(), { fixtureOrigins: true });
    expect([fixture.busyTimeoutMs, fixture.drainMs]).toEqual([5000, 25_000]);
  });
});

describe('checkRuntimeEnv', () => {
  it('checkRuntimeEnv names NODE_OPTIONS, NODE_TLS_REJECT_UNAUTHORIZED, NODE_EXTRA_CA_CERTS, https_proxy or SSL_CERT_FILE when any is set and passes an environment without them', () => {
    const clean: NodeEnv = {
      ...baseEnv(),
      PATH: '/usr/bin',
      HOME: '/home/owner',
      NODE_ENV: 'production',
      LANG: 'C.UTF-8',
      CREDENTIALS_DIRECTORY: '/run/user/1000/credentials/atmusic.service',
    };
    expect(checkRuntimeEnv(clean)).toBeNull();
    expect(checkRuntimeEnv({})).toBeNull();

    const value = '--require=/tmp/evil-hook.js';
    for (const name of [
      'NODE_OPTIONS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'NODE_EXTRA_CA_CERTS',
      'https_proxy',
      'SSL_CERT_FILE',
    ]) {
      const err = checkRuntimeEnv({ ...clean, [name]: value });
      expect(err, name).toBeInstanceOf(ConfigError);
      expect(fields(err?.issues ?? []), name).toEqual([name]);
      expect(err?.message, name).toContain(name);
      expect(err?.message, name).not.toContain(value);
      // Set but empty is still set: Node reads NODE_TLS_REJECT_UNAUTHORIZED='' too.
      expect(fields(checkRuntimeEnv({ ...clean, [name]: '' })?.issues ?? []), `${name} empty`).toEqual([name]);
    }
    // Every listed variable is caught, and the first present one is named.
    expect(FORBIDDEN_RUNTIME_ENV).toHaveLength(15);
    for (const name of FORBIDDEN_RUNTIME_ENV) {
      expect(fields(checkRuntimeEnv({ [name]: '1' })?.issues ?? []), name).toEqual([name]);
    }
    expect(fields(checkRuntimeEnv({ SSL_CERT_FILE: '/x', NODE_OPTIONS: '--inspect' })?.issues ?? [])).toEqual([
      'NODE_OPTIONS',
    ]);
  });
});

describe('disk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('diskLow is true exactly when the injected statfs reports fewer free bytes than ATMUSIC_MIN_FREE_BYTES', () => {
    const calls: string[] = [];
    const statfsReporting =
      (bavail: number | bigint, bsize: number | bigint): StatfsFn =>
      (path) => {
        calls.push(path);
        return { bavail, bsize };
      };
    const state = '/home/owner/.local/state/atmusic';

    // A configured floor of 40,960 bytes = ten 4 KiB blocks.
    const floor = parse({ ...baseEnv(), ATMUSIC_MIN_FREE_BYTES: '40960' }).minFreeBytes;
    expect(floor).toBe(40_960);
    expect(diskLow(state, floor, statfsReporting(9, 4096))).toBe(true); // 36,864 < 40,960
    expect(diskLow(state, floor, statfsReporting(10, 4096))).toBe(false); // equal is not low
    expect(diskLow(state, floor, statfsReporting(11, 4096))).toBe(false);
    expect(diskLow(state, floor, statfsReporting(40_959, 1))).toBe(true); // one byte short
    expect(diskLow(state, floor, statfsReporting(40_960, 1))).toBe(false);
    expect(calls).toEqual(Array(5).fill(state));

    // The 2 GiB default, with bigint fields as node:fs reports them.
    const dflt = parse(baseEnv()).minFreeBytes;
    expect(diskLow(state, dflt, statfsReporting(524_287n, 4096n))).toBe(true);
    expect(diskLow(state, dflt, statfsReporting(524_288n, 4096n))).toBe(false);
    expect(freeBytes(state, statfsReporting(524_288n, 4096n))).toBe(2_147_483_648n);
    // Products beyond 2^53 are exact.
    expect(freeBytes(state, statfsReporting(2n ** 50n, 4096n))).toBe(2n ** 62n);

    // The predicate form the keepalive and import writer take re-reads each time.
    let blocks = 11;
    const probe = diskLowProbe(state, floor, () => ({ bavail: blocks, bsize: 4096 }));
    expect(probe()).toBe(false);
    blocks = 9;
    expect(probe()).toBe(true);

    // A statfs failure counts as low (writers pause); freeBytes throws it.
    const failing: StatfsFn = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    expect(diskLow(state, floor, failing)).toBe(true);
    expect(() => freeBytes(state, failing)).toThrow('ENOENT');

    // The default statfs reads the real filesystem.
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-disk-'));
    dirs.push(dir);
    const real = freeBytes(dir);
    expect(real).toBeGreaterThan(0n);
    expect(diskLow(dir, 0)).toBe(false);
    expect(diskLow(dir, real + 2n ** 60n)).toBe(true);
    expect(diskLow(join(dir, 'missing'), 0)).toBe(true);
  });
});

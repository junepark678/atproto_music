import { describe, expect, it } from 'vitest';
import { ConfigError, FIXTURE_PREFIX, parseConfig, parseCursorKey } from '../src/config';
import type { EnvVars } from '../src/env';
import wranglerJsonc from '../wrangler.jsonc?raw';

/** Strips JSONC comments outside string literals (wrangler.jsonc has no trailing commas). */
function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

interface WranglerEnv {
  vars: EnvVars;
  routes: { pattern: string; custom_domain: boolean }[];
}
type WranglerConfig = WranglerEnv & { env: Record<string, WranglerEnv> };

/** The owner's decision, ADR 0004 §15 Q3. */
const DECIDED_ORIGIN = 'https://music.214510.xyz';
const DECIDED_PREFIX = 'dev.pythonplayer123.music';

const BASE: EnvVars = {
  PUBLIC_ORIGIN: 'https://music.example.org',
  LEXICON_PREFIX: '',
  NAMESPACE_OWNERSHIP_REF: '',
  INGEST_MODE: 'socket',
  JETSTREAM_URLS: 'wss://jetstream.us-east.bsky.network,wss://jetstream.us-west.bsky.network',
  JETSTREAM_LOOKBACK_HOURS: '24',
  RELAY_URL: 'https://relay1.us-east.bsky.network',
  PLAN: 'paid',
  DO_LOCATION_HINT: 'enam',
};

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.map((i) => i.field);
    throw err;
  }
  return [];
}

describe('parseConfig namespace gate', () => {
  it('empty prefix closes the gate: prefix null, ingestion off, no publication', () => {
    const config = parseConfig(BASE);
    expect(config).toMatchObject({
      prefix: null,
      collections: null,
      publication: false,
      fixturePrefix: false,
      configuredIngestMode: 'socket',
      ingestMode: 'off',
      plan: 'paid',
      doLocationHint: 'enam',
      adminEnabled: false,
      jetstreamUrls: ['wss://jetstream.us-east.bsky.network', 'wss://jetstream.us-west.bsky.network'],
      jetstreamLookbackHours: 24,
    });
    expect(config.budget).toEqual({
      drainHints: 200,
      subrequestsPerSlice: 200,
      maxEntriesPerSlice: 2000,
      concurrentFetches: 4,
      perHostConcurrency: 2,
    });
  });

  it('fixture prefix is refused unless allowFixturePrefix, and never publishes', () => {
    expect(issuesOf(() => parseConfig({ ...BASE, LEXICON_PREFIX: FIXTURE_PREFIX }))).toEqual(['LEXICON_PREFIX']);
    expect(
      issuesOf(() => parseConfig({ ...BASE, LEXICON_PREFIX: FIXTURE_PREFIX }, { allowFixturePrefix: false })),
    ).toEqual(['LEXICON_PREFIX']);
    const fixture = parseConfig({ ...BASE, LEXICON_PREFIX: FIXTURE_PREFIX }, { allowFixturePrefix: true });
    expect(fixture).toMatchObject({
      prefix: 'com.example.atmusic',
      fixturePrefix: true,
      publication: false,
      ingestMode: 'socket',
      collections: {
        scrobble: 'com.example.atmusic.scrobble',
        follow: 'com.example.atmusic.follow',
        settings: 'com.example.atmusic.settings',
      },
    });
    // Ownership evidence cannot make the fixture prefix publishable.
    expect(
      issuesOf(() =>
        parseConfig(
          { ...BASE, LEXICON_PREFIX: FIXTURE_PREFIX, NAMESPACE_OWNERSHIP_REF: 'x' },
          { allowFixturePrefix: true },
        ),
      ),
    ).toEqual(['NAMESPACE_OWNERSHIP_REF']);
  });

  it('owned prefix publishes only with ownership evidence', () => {
    expect(parseConfig({ ...BASE, LEXICON_PREFIX: 'org.example.music' }).publication).toBe(false);
    const owned = parseConfig({
      ...BASE,
      LEXICON_PREFIX: 'org.example.music',
      NAMESPACE_OWNERSHIP_REF: 'docs/adr/0001-namespace.md#evidence',
    });
    expect(owned).toMatchObject({ prefix: 'org.example.music', publication: true, ingestMode: 'socket' });
    expect(issuesOf(() => parseConfig({ ...BASE, NAMESPACE_OWNERSHIP_REF: 'ref' }))).toEqual([
      'NAMESPACE_OWNERSHIP_REF',
    ]);
  });

  // ADR 0005 §6.3, B12 (N3-11): a valid prefix derives exactly four
  // collections, love included, and nothing else; a closed gate derives none.
  it('collections for an owned prefix are exactly scrobble, follow, settings and love', () => {
    for (const [prefix, options] of [
      ['org.example.music', {}],
      [DECIDED_PREFIX, {}],
      [FIXTURE_PREFIX, { allowFixturePrefix: true }],
    ] as const) {
      const collections = parseConfig({ ...BASE, LEXICON_PREFIX: prefix }, options).collections;
      // Exact equality: no fifth key, each value the prefix plus one segment.
      expect(collections, prefix).toEqual({
        scrobble: `${prefix}.scrobble`,
        follow: `${prefix}.follow`,
        settings: `${prefix}.settings`,
        love: `${prefix}.love`,
      });
      expect(Object.keys(collections ?? {}), prefix).toEqual(['scrobble', 'follow', 'settings', 'love']);
    }
    // Publication evidence does not change the set.
    const owned = parseConfig({
      ...BASE,
      LEXICON_PREFIX: DECIDED_PREFIX,
      NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.music.pythonplayer123.dev TXT',
    });
    expect(owned.publication).toBe(true);
    expect(owned.collections?.love).toBe('dev.pythonplayer123.music.love');
    // The closed gate has no collections at all.
    expect(parseConfig(BASE).collections).toBeNull();
  });

  it('decided prefix dev.pythonplayer123.music is valid, non-fixture, and publishes only with NAMESPACE_OWNERSHIP_REF', () => {
    const decided = { ...BASE, PUBLIC_ORIGIN: DECIDED_ORIGIN, LEXICON_PREFIX: DECIDED_PREFIX };
    // Accepted without allowFixturePrefix: it is not the fixture prefix.
    const gated = parseConfig(decided);
    expect(gated).toMatchObject({
      publicOrigin: DECIDED_ORIGIN,
      prefix: DECIDED_PREFIX,
      fixturePrefix: false,
      namespaceOwnershipRef: null,
      publication: false,
      ingestMode: 'socket',
      collections: {
        scrobble: 'dev.pythonplayer123.music.scrobble',
        follow: 'dev.pythonplayer123.music.follow',
        settings: 'dev.pythonplayer123.music.settings',
      },
    });
    const ref = 'dns:_lexicon.music.pythonplayer123.dev TXT';
    const published = parseConfig({ ...decided, NAMESPACE_OWNERSHIP_REF: ref });
    expect(published).toMatchObject({ prefix: DECIDED_PREFIX, namespaceOwnershipRef: ref, publication: true });
    // Whitespace-only evidence is no evidence.
    expect(parseConfig({ ...decided, NAMESPACE_OWNERSHIP_REF: '   ' }).publication).toBe(false);
  });

  it('shipped wrangler.jsonc carries the decided origin and prefix in every env and passes parseConfig', () => {
    expect(wranglerJsonc).not.toContain('example.org');
    const config = parseJsonc(wranglerJsonc) as WranglerConfig;
    expect(Object.keys(config.env).sort()).toEqual(['free', 'staging']);
    expect(config.vars.PUBLIC_ORIGIN).toBe(DECIDED_ORIGIN);
    expect(config.routes).toEqual([{ pattern: 'music.214510.xyz', custom_domain: true }]);
    const envs: [string, WranglerEnv][] = [['production', config], ...Object.entries(config.env)];
    const origins = new Set<string>();
    for (const [name, env] of envs) {
      const parsed = parseConfig(env.vars);
      expect(parsed, name).toMatchObject({ prefix: DECIDED_PREFIX, fixturePrefix: false, publication: false });
      const host = new URL(parsed.publicOrigin).host;
      expect(host === '214510.xyz' || host.endsWith('.214510.xyz'), name).toBe(true);
      expect(env.routes, name).toEqual([{ pattern: host, custom_domain: true }]);
      origins.add(parsed.publicOrigin);
    }
    // Each env has its own hostname, so its own OAuth client_id.
    expect(origins.size).toBe(envs.length);
    expect(parseConfig(config.vars)).toMatchObject({ plan: 'paid', ingestMode: 'socket' });
    expect(parseConfig(config.env.staging?.vars ?? BASE)).toMatchObject({ plan: 'free', ingestMode: 'pulse' });
  });

  it('rejects malformed vars with the field names', () => {
    for (const prefix of ['Org.Example', 'example', 'org..x', '9rg.example', 'org.-x', 'org.x-']) {
      expect(
        issuesOf(() => parseConfig({ ...BASE, LEXICON_PREFIX: prefix })),
        prefix,
      ).toEqual(['LEXICON_PREFIX']);
    }
    for (const origin of [
      'http://music.example.org',
      'https://music.example.org/',
      'https://music.example.org:443',
      'https://music.example.org/app',
      'https://u:p@music.example.org',
      'https://MUSIC.example.org',
    ]) {
      expect(
        issuesOf(() => parseConfig({ ...BASE, PUBLIC_ORIGIN: origin })),
        origin,
      ).toEqual(['PUBLIC_ORIGIN']);
    }
    expect(
      issuesOf(() =>
        parseConfig({
          ...BASE,
          INGEST_MODE: 'firehose',
          JETSTREAM_URLS: 'https://jetstream.example.org',
          JETSTREAM_LOOKBACK_HOURS: '1.5',
          RELAY_URL: 'wss://relay.example.org',
          PLAN: 'enterprise',
          DO_LOCATION_HINT: 'mars',
          ADMIN_TOKEN: 'short',
        }),
      ),
    ).toEqual([
      'INGEST_MODE',
      'JETSTREAM_URLS',
      'JETSTREAM_LOOKBACK_HOURS',
      'RELAY_URL',
      'PLAN',
      'DO_LOCATION_HINT',
      'ADMIN_TOKEN',
    ]);
    expect(issuesOf(() => parseConfig({ ...BASE, JETSTREAM_URLS: '' }))).toEqual(['JETSTREAM_URLS']);
    expect(parseConfig({ ...BASE, JETSTREAM_URLS: '', INGEST_MODE: 'off' }).jetstreamUrls).toEqual([]);
    const free = parseConfig({ ...BASE, PLAN: 'free', DO_LOCATION_HINT: '', ADMIN_TOKEN: 'a'.repeat(32) });
    expect(free).toMatchObject({ plan: 'free', doLocationHint: null, adminEnabled: true });
    expect(free.budget.subrequestsPerSlice).toBe(40);
    expect(JSON.stringify(free)).not.toContain('a'.repeat(32));
  });

  // M1.1.1/invalid_namespace: empty prefix, one segment, uppercase segment and
  // embedded slash each reject the configuration naming exactly LEXICON_PREFIX.
  it('one-segment, uppercase and embedded-slash LEXICON_PREFIX values are rejected naming LEXICON_PREFIX; empty yields prefix null', () => {
    const rejected = [
      // one segment
      'music',
      'atmusic',
      // an uppercase segment, first, middle or last
      'Org.example.music',
      'org.Example.music',
      'org.example.MUSIC',
      'dev.pythonplayer123.Music',
      // an embedded slash
      'org.example/music',
      'org/example.music',
      'dev.pythonplayer123.music/scrobble',
      'org.example.music/',
    ];
    for (const prefix of rejected) {
      let error: unknown;
      try {
        parseConfig({ ...BASE, LEXICON_PREFIX: prefix }, { allowFixturePrefix: true });
      } catch (err) {
        error = err;
      }
      expect(error, prefix).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      // Exactly one issue, on exactly the invalid field.
      expect(issues, prefix).toEqual([
        { field: 'LEXICON_PREFIX', message: 'must be a lowercase reverse-domain NSID prefix' },
      ]);
      expect((error as ConfigError).message, prefix).toBe(
        'invalid configuration: LEXICON_PREFIX: must be a lowercase reverse-domain NSID prefix',
      );
    }
    // The same prefixes fail whether or not a test entry allows the fixture prefix.
    for (const prefix of rejected) {
      expect(
        issuesOf(() => parseConfig({ ...BASE, LEXICON_PREFIX: prefix })),
        prefix,
      ).toEqual(['LEXICON_PREFIX']);
    }

    // Empty (and whitespace-only) is not an error: the namespace gate is closed.
    for (const empty of ['', '   ']) {
      const closed = parseConfig({ ...BASE, LEXICON_PREFIX: empty });
      expect(closed, JSON.stringify(empty)).toMatchObject({
        prefix: null,
        collections: null,
        fixturePrefix: false,
        publication: false,
        configuredIngestMode: 'socket',
        ingestMode: 'off',
      });
    }
    // Control: the valid neighbours of the rejected values are accepted.
    for (const [prefix, scrobble] of [
      ['org.example.music', 'org.example.music.scrobble'],
      ['dev.pythonplayer123.music', 'dev.pythonplayer123.music.scrobble'],
    ] as const) {
      expect(parseConfig({ ...BASE, LEXICON_PREFIX: prefix }).collections?.scrobble).toBe(scrobble);
    }
  });

  // M1.4.1/invalid_config: origin=http://..., an invalid namespace and a
  // malformed key fail with the field names and no secret value anywhere in
  // the error (message, issues or its serialization).
  it('http PUBLIC_ORIGIN and invalid LEXICON_PREFIX fail parseConfig naming each field without echoing any secret value', () => {
    const adminToken = 'S3cr3t-admin-token'; // set but shorter than 32 characters: invalid
    const cursorKey = 'feedfacecafebeef'.repeat(3); // 24 bytes: below the 32-byte minimum
    const env = {
      ...BASE,
      PUBLIC_ORIGIN: 'http://public.example',
      LEXICON_PREFIX: 'Public.Example/music',
      ADMIN_TOKEN: adminToken,
    };

    let error: unknown;
    try {
      parseConfig(env);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.name).toBe('ConfigError');
    // Every invalid field is named, in order, and nothing else is.
    expect(configError.issues.map((i) => i.field)).toEqual(['PUBLIC_ORIGIN', 'LEXICON_PREFIX', 'ADMIN_TOKEN']);
    expect(configError.message).toBe(
      'invalid configuration: PUBLIC_ORIGIN: must be an https origin without path, port, query, fragment or credentials; ' +
        'LEXICON_PREFIX: must be a lowercase reverse-domain NSID prefix; ' +
        'ADMIN_TOKEN: must be at least 32 characters when set',
    );

    let keyError: unknown;
    try {
      parseCursorKey({ CURSOR_KEY: cursorKey });
    } catch (err) {
      keyError = err;
    }
    expect(keyError).toBeInstanceOf(ConfigError);
    expect((keyError as ConfigError).issues).toEqual([
      { field: 'CURSOR_KEY', message: 'must be at least 32 hex-encoded bytes' },
    ]);

    // No secret value (or a recognisable fragment of one) is echoed anywhere a
    // log line or startup failure could carry it.
    for (const err of [configError, keyError as ConfigError]) {
      const surfaces = [err.message, String(err), JSON.stringify(err.issues), JSON.stringify(err), err.stack ?? ''];
      for (const surface of surfaces) {
        expect(surface).not.toContain(adminToken);
        expect(surface).not.toContain('S3cr3t');
        expect(surface).not.toContain(cursorKey);
        expect(surface).not.toContain('feedfacecafebeef');
      }
    }

    // Each failing field alone is reported alone.
    expect(issuesOf(() => parseConfig({ ...BASE, PUBLIC_ORIGIN: 'http://public.example' }))).toEqual(['PUBLIC_ORIGIN']);
    expect(issuesOf(() => parseConfig({ ...BASE, LEXICON_PREFIX: 'Public.Example/music' }))).toEqual([
      'LEXICON_PREFIX',
    ]);
    // Control: the same env with valid values parses, and a valid token is
    // reduced to a boolean rather than copied into AppConfig.
    const validToken = 'v'.repeat(40);
    const ok = parseConfig({
      ...env,
      PUBLIC_ORIGIN: 'https://public.example',
      LEXICON_PREFIX: 'org.example.music',
      ADMIN_TOKEN: validToken,
    });
    expect(ok).toMatchObject({
      publicOrigin: 'https://public.example',
      prefix: 'org.example.music',
      adminEnabled: true,
    });
    expect(JSON.stringify(ok)).not.toContain(validToken);
  });

  it('CURSOR_KEY is at least 32 hex-encoded bytes and not all zero', () => {
    const key = parseCursorKey({ CURSOR_KEY: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' });
    expect(Array.from(key)).toEqual(Array.from({ length: 32 }, (_, i) => i));
    for (const bad of ['', '00', 'zz'.repeat(32), '0'.repeat(64), 'ab'.repeat(31), `${'ab'.repeat(32)}a`]) {
      expect(
        issuesOf(() => parseCursorKey({ CURSOR_KEY: bad })),
        bad,
      ).toEqual(['CURSOR_KEY']);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ConfigError, FIXTURE_PREFIX, parseConfig, parseCursorKey } from '../src/config';
import type { EnvVars } from '../src/env';

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

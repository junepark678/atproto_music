import {
  authorityDomain,
  collectionsFor,
  FIXTURE_PREFIX,
  isFixturePrefix,
  isValidPrefix,
  type OwnershipEvidence,
  PREFIX_FIELD,
  requirePublication,
  SCHEMA_VERSION,
} from '@atmusic/core/namespace';
import { expect, it } from 'vitest';

// The production values decided in ADR 0004 §15 Q3. Here they are test inputs
// only: nothing in packages/core defaults to them.
const OWNED_PREFIX = 'dev.pythonplayer123.music';
const OWNED_DOMAIN = 'music.pythonplayer123.dev';
const OWNERSHIP_REF = '_lexicon.music.pythonplayer123.dev TXT, reviewed in docs/adr/0001-namespace.md';

/**
 * A minimal publisher in the shape every write path must take: the namespace
 * gate runs before any request is built, so a refusal makes zero remote calls.
 */
function makePublisher(prefix: string | null, ownership: OwnershipEvidence | string | null) {
  const calls: Request[] = [];
  const transport = async (req: Request) => {
    calls.push(req);
    return new Response('{}', { status: 200 });
  };
  async function publish(record: unknown) {
    const gate = requirePublication(prefix, ownership);
    if (!gate.ok) return { published: false as const, error: gate.error };
    await transport(
      new Request('https://pds.example.test/xrpc/com.atproto.repo.createRecord', {
        method: 'POST',
        body: JSON.stringify({ collection: gate.collections.scrobble, record }),
      }),
    );
    return { published: true as const };
  }
  return { calls, publish };
}

const NOT_PRODUCTION = {
  code: 'namespace_not_production',
  field: 'LEXICON_PREFIX',
  message: 'publication requires a non-fixture namespace with recorded owner evidence',
};

it('fixture prefix blocks publication; owned prefix with ownership ref allows it', async () => {
  expect(SCHEMA_VERSION).toBe(1);
  expect(PREFIX_FIELD).toBe('LEXICON_PREFIX');
  expect(FIXTURE_PREFIX).toBe('com.example.atmusic');
  expect(isFixturePrefix(FIXTURE_PREFIX)).toBe(true);
  expect(isFixturePrefix(OWNED_PREFIX)).toBe(false);

  // Fixture prefix: refused with or without evidence, before any HTTP call.
  for (const ownership of [null, 'some reference', { domain: 'atmusic.example.com', reference: 'r' }]) {
    const fixture = makePublisher(FIXTURE_PREFIX, ownership);
    expect(await fixture.publish({ artist: 'Björk' })).toEqual({ published: false, error: NOT_PRODUCTION });
    expect(fixture.calls).toHaveLength(0);
  }
  // An owned prefix without evidence (empty NAMESPACE_OWNERSHIP_REF) is not production either.
  for (const ownership of [null, '', '  \u3000 ']) {
    const unowned = makePublisher(OWNED_PREFIX, ownership);
    expect(await unowned.publish({})).toEqual({ published: false, error: NOT_PRODUCTION });
    expect(unowned.calls).toHaveLength(0);
  }

  // Owned prefix plus ownership reference: allowed, exactly one remote call to the owned collection.
  const owned = makePublisher(OWNED_PREFIX, OWNERSHIP_REF);
  expect(await owned.publish({ artist: 'Björk' })).toEqual({ published: true });
  expect(owned.calls).toHaveLength(1);
  expect(await owned.calls[0]?.json()).toEqual({
    collection: 'dev.pythonplayer123.music.scrobble',
    record: { artist: 'Björk' },
  });
  expect(requirePublication(OWNED_PREFIX, OWNERSHIP_REF)).toEqual({
    ok: true,
    prefix: OWNED_PREFIX,
    collections: {
      scrobble: 'dev.pythonplayer123.music.scrobble',
      follow: 'dev.pythonplayer123.music.follow',
      settings: 'dev.pythonplayer123.music.settings',
    },
    evidence: { domain: OWNED_DOMAIN, reference: OWNERSHIP_REF },
  });
  expect(authorityDomain(OWNED_PREFIX)).toBe(OWNED_DOMAIN);

  // Explicit evidence: the controlling domain or a parent of it.
  expect(requirePublication(OWNED_PREFIX, { domain: OWNED_DOMAIN, reference: 'r' }).ok).toBe(true);
  expect(requirePublication(OWNED_PREFIX, { domain: 'pythonplayer123.dev', reference: 'r' }).ok).toBe(true);
  const mismatch = {
    ok: false,
    error: {
      code: 'invalid_namespace_ownership',
      field: 'LEXICON_PREFIX',
      message: 'ownership evidence must identify the controlling domain and a reviewable reference',
    },
  };
  expect(requirePublication(OWNED_PREFIX, { domain: 'other.dev', reference: 'r' })).toEqual(mismatch);
  expect(requirePublication(OWNED_PREFIX, { domain: 'thon123.dev', reference: 'r' })).toEqual(mismatch);
  expect(requirePublication(OWNED_PREFIX, { domain: OWNED_DOMAIN, reference: ' ' })).toEqual(mismatch);
  expect(requirePublication(OWNED_PREFIX, { domain: 'Music.Pythonplayer123.dev', reference: 'r' })).toEqual(mismatch);
  expect(requirePublication(OWNED_PREFIX, { domain: 'dev', reference: 'r' })).toEqual(mismatch);
  const mismatchCalls = makePublisher(OWNED_PREFIX, { domain: 'other.dev', reference: 'r' });
  expect((await mismatchCalls.publish({})).published).toBe(false);
  expect(mismatchCalls.calls).toHaveLength(0);

  // Invalid prefixes are configuration errors naming the prefix field.
  const invalid = {
    ok: false,
    error: {
      code: 'invalid_namespace',
      field: 'LEXICON_PREFIX',
      message: 'expected a lowercase reverse-domain namespace prefix',
    },
  };
  for (const prefix of ['', 'atmusic', 'com.Example.atmusic', 'com.example/atmusic', '1com.example', 'com..x', null]) {
    expect(requirePublication(prefix, OWNERSHIP_REF)).toEqual(invalid);
    if (prefix !== null) expect(isValidPrefix(prefix)).toBe(false);
  }
  expect(isValidPrefix(OWNED_PREFIX)).toBe(true);
  expect(isValidPrefix(FIXTURE_PREFIX)).toBe(true);
  expect(isValidPrefix(`a.${'b'.repeat(63)}`)).toBe(true);
  expect(isValidPrefix(`a.${'b'.repeat(64)}`)).toBe(false);

  // A valid prefix derives exactly three collections and nothing else (A10).
  expect(Object.values(collectionsFor(FIXTURE_PREFIX))).toEqual([
    'com.example.atmusic.scrobble',
    'com.example.atmusic.follow',
    'com.example.atmusic.settings',
  ]);
  expect(() => collectionsFor('Bad')).toThrow(RangeError);
});

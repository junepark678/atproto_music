// N2-03: the confidential client's metadata document and JWKS (ADR 0005 §5.3,
// §5.4). The expected document is read from the ADR itself, so the test fails
// if either the code or the ADR's §5.3 block changes alone.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_CLIENT_KEYS } from '@atmusic/atproto/test-support/fake-oauth-as';
import { CLIENT_NAME } from '@atmusic/core/client-name';
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { NodeOAuthClient } from '@atproto/oauth-client-node';
import { describe, expect, it } from 'vitest';
import {
  clientMetadataFor,
  clientMetadataResponse,
  jwksDocument,
  jwksResponse,
  OAUTH_DOCUMENT_CACHE_CONTROL,
} from '../../../src/bff/client-metadata';
import { loadOAuthKeyset } from '../../../src/bff/keyset';
import { type NodeEnv, parseNodeConfig } from '../../../src/node/config';
import { secretsFor } from './oauth-world';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PRODUCTION_ORIGIN = 'https://music.214510.xyz';
const PRODUCTION_PREFIX = 'dev.pythonplayer123.music';

/** The JSON block of ADR 0005 §5.3, with `<p>` replaced. */
function adrDocument(prefix: string): Record<string, unknown> {
  const adr = readFileSync(join(REPO, 'docs/adr/0005-local-node-host-and-compat-apis.md'), 'utf8');
  const section = adr.slice(adr.indexOf('### 5.3 Client metadata and JWKS'), adr.indexOf('### 5.4 '));
  const block = /```json\n([\s\S]*?)\n```/.exec(section);
  if (block === null) throw new Error('ADR §5.3 has no JSON block');
  return JSON.parse((block[1] as string).replaceAll('<p>', prefix));
}

function env(over: NodeEnv = {}): NodeEnv {
  return {
    ATMUSIC_PUBLIC_ORIGIN: PRODUCTION_ORIGIN,
    ATMUSIC_CLIENT_IP_HEADER: 'cf-connecting-ip',
    ATMUSIC_SIGNIN_DIDS: 'did:plc:abcdefghijklmnopqrstuvwx',
    STATE_DIRECTORY: '/home/owner/.local/state/atmusic',
    XDG_RUNTIME_DIR: '/run/user/1000',
    LEXICON_PREFIX: FIXTURE_PREFIX,
    NAMESPACE_OWNERSHIP_REF: '',
    JETSTREAM_URLS: 'wss://jetstream.example.org',
    JETSTREAM_LOOKBACK_HOURS: '24',
    RELAY_URL: 'https://relay.example.org',
    ...over,
  };
}

const config = (over: NodeEnv = {}) =>
  parseNodeConfig(env(over), { allowFixturePrefix: true, releaseRoot: '/opt/atmusic/release' });

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

describe('client metadata and JWKS', () => {
  it('the metadata for https://music.214510.xyz equals the ADR 0005 §5.3 document with client_name AT Protocol Music and the four repo: scopes, and jwks.json has no private member', async () => {
    // The production prefix and the fixture prefix, both through the parsed Node config.
    for (const prefix of [PRODUCTION_PREFIX, FIXTURE_PREFIX]) {
      const doc = clientMetadataFor(config({ LEXICON_PREFIX: prefix }));
      const expected = adrDocument(prefix);
      expect(doc).toEqual(expected);
      // Byte for byte, member order included.
      expect(JSON.stringify(doc)).toBe(JSON.stringify(expected));
      expect(doc.client_name).toBe('AT Protocol Music');
      expect(CLIENT_NAME).toBe('AT Protocol Music');
      expect(doc.scope.split(' ')).toEqual([
        'atproto',
        `repo:${prefix}.scrobble`,
        `repo:${prefix}.follow`,
        `repo:${prefix}.settings`,
        `repo:${prefix}.love`,
      ]);

      const res = clientMetadataResponse(doc);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('cache-control')).toBe(OAUTH_DOCUMENT_CACHE_CONTROL);
      expect(OAUTH_DOCUMENT_CACHE_CONTROL).toBe('public, max-age=300');
      expect(res.headers.has('set-cookie')).toBe(false);
      expect(await res.json()).toEqual(expected);
    }

    // The published set: the signing key k1 and the announced k2, public members only.
    const keyset = await loadOAuthKeyset(secretsFor(['k1'], ['k2']));
    const res = jwksResponse(keyset);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.has('set-cookie')).toBe(false);
    const text = await res.text();
    const body = JSON.parse(text) as { keys: Array<Record<string, unknown>> };
    expect(body.keys.map((k) => k.kid)).toEqual(['k1', 'k2']);
    for (const key of body.keys) {
      expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
      expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
      for (const m of PRIVATE_MEMBERS) expect(key).not.toHaveProperty(m);
    }
    expect(body.keys[0]).toMatchObject({ x: FIXTURE_CLIENT_KEYS.k1.x, y: FIXTURE_CLIENT_KEYS.k1.y });
    expect(body.keys[1]).toMatchObject({ x: FIXTURE_CLIENT_KEYS.k2.x, y: FIXTURE_CLIENT_KEYS.k2.y });
    // No private scalar of any fixture key appears anywhere in the served bytes.
    for (const k of Object.values(FIXTURE_CLIENT_KEYS)) expect(text).not.toContain(k.d);
    expect(jwksDocument(keyset)).toEqual(body);

    // The library accepts the document with this keyset (it refuses a JWKS-less or keyless confidential client).
    const doc = clientMetadataFor(config());
    const client = new NodeOAuthClient({
      clientMetadata: doc,
      keyset: keyset.keyset,
      stateStore: { get: () => undefined, set: () => {}, del: () => {} },
      sessionStore: { get: () => undefined, set: () => {}, del: () => {} },
      identityResolver: { resolve: () => Promise.reject(new Error('unused')) },
      requestLock: (_name, fn) => fn(),
    });
    expect(client.clientMetadata.token_endpoint_auth_method).toBe('private_key_jwt');
    expect(client.jwks.keys.map((k) => k.kid)).toEqual(['k1']);
    expect(JSON.stringify(client.jwks)).not.toContain(FIXTURE_CLIENT_KEYS.k1.d);
  });

  it('transition:generic is appended only with ATMUSIC_OAUTH_TRANSITION_GENERIC=1', () => {
    const base = `atproto repo:${FIXTURE_PREFIX}.scrobble repo:${FIXTURE_PREFIX}.follow repo:${FIXTURE_PREFIX}.settings repo:${FIXTURE_PREFIX}.love`;
    expect(clientMetadataFor(config()).scope).toBe(base);
    expect(clientMetadataFor(config({ ATMUSIC_OAUTH_TRANSITION_GENERIC: '0' })).scope).toBe(base);
    const generic = clientMetadataFor(config({ ATMUSIC_OAUTH_TRANSITION_GENERIC: '1' }));
    expect(generic.scope).toBe(`${base} transition:generic`);
    expect(generic.scope.split(' ').filter((s) => s === 'transition:generic')).toHaveLength(1);
    // Everything else in the document is unchanged by the flag.
    expect({ ...generic, scope: base }).toEqual(clientMetadataFor(config()));
    // Any other value is a configuration error, not a silent default.
    expect(() => config({ ATMUSIC_OAUTH_TRANSITION_GENERIC: 'yes' })).toThrow(/ATMUSIC_OAUTH_TRANSITION_GENERIC/);
  });
});

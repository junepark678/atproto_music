// Identity resolution and bidirectional handle verification (W2-02).
//
// Proves M2.1.3/valid_chain (DID document → signing key + canonical PDS),
// M2.1.1/spoofed_handle (a handle is shown only when DNS/HTTPS and the
// document's alsoKnownAs agree) and the cache half of M2.1.1/cache_expiry
// (`fresh: true` bypasses the cache hook after a key rotation).
//
// Everything runs over the fixture network (routerTransport) with the
// production SafeFetch policy on, the frozen clock, and no real network. Each
// test asserts the resolved values, the typed error codes, the cache-hook
// writes and the exact remote calls made.
import { didDocumentUrl, IdentityError } from '@atmusic/atproto/identity/did-doc';
import { createHandleResolver } from '@atmusic/atproto/identity/handle';
import { createIdentityResolver, type IdentityCache } from '@atmusic/atproto/identity/resolver';
import type { ResolvedIdentity } from '@atmusic/atproto/identity/types';
import { SafeFetchError } from '@atmusic/atproto/net/safe-fetch';
import { FakeDoh } from '@atmusic/atproto/test-support/fake-doh';
import { didDocument, FakePlc } from '@atmusic/atproto/test-support/fake-plc';
import { type FixtureKeys, fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { type Endpoint, routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { FIXTURE_NOW_ISO, fixedClock } from '@atmusic/core/test-support/clock';
import { beforeAll, describe, expect, it } from 'vitest';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';
const MALLORY = 'did:plc:mmmmmmmmmmmmmmmmmmmmmmmm';
const DAVE = 'did:plc:dddddddddddddddddddddddd';
const WEB = 'did:web:web.example.test';
const NOW_MS = Date.parse(FIXTURE_NOW_ISO);

let keys: FixtureKeys;
beforeAll(async () => {
  keys = await fixtureKeys();
});

/** A counting in-memory cache hook (the worker's is identity_cache-backed). */
function memoryCache() {
  const store = new Map<string, { identity: ResolvedIdentity; docJson: string }>();
  const log = { gets: [] as string[], puts: [] as ResolvedIdentity[] };
  const cache: IdentityCache = {
    get(did) {
      log.gets.push(did);
      return store.get(did)?.identity ?? null;
    },
    put(identity, docJson) {
      log.puts.push(identity);
      store.set(identity.did, { identity, docJson });
    },
  };
  return { cache, store, log };
}

function network(o: { hosts?: Record<string, Endpoint> } = {}) {
  const clock = fixedClock();
  const plc = new FakePlc();
  const doh = new FakeDoh();
  const handles = new Map<string, string>();
  const transport = routerTransport({ plc, doh, handles, hosts: o.hosts });
  const memo = memoryCache();
  const resolver = createIdentityResolver({ transport, clock, cache: memo.cache });
  /** Calls that reached anything other than PLC, DoH and the handle well-known. */
  const otherCalls = () => transport.calls.entries.filter((c) => !['plc', 'doh', 'handle'].includes(c.service));
  return { clock, plc, doh, handles, transport, resolver, memo, otherCalls };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

async function identityFailure(p: Promise<unknown>, code: IdentityError['code']): Promise<IdentityError> {
  const error = await rejection(p);
  expect(error).toBeInstanceOf(IdentityError);
  expect((error as IdentityError).code).toBe(code);
  return error as IdentityError;
}

// --- tiny base58btc encoder, to build synthetic multikeys in tests ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btc(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return `z${out}`;
}
/** A compressed-point multikey whose x-coordinate is the integer `x`. */
function syntheticMultikey(curve: 'secp256k1' | 'p256', x: number | 'max'): string {
  const bytes = new Uint8Array(35);
  bytes.set(curve === 'secp256k1' ? [0xe7, 0x01] : [0x80, 0x24]);
  bytes[2] = 0x02;
  if (x === 'max') bytes.fill(0xff, 3);
  else bytes[34] = x;
  return base58btc(bytes);
}

function rawDoc(
  did: string,
  o: {
    methods?: Array<{ id: string; type?: string; controller?: string; publicKeyMultibase: string }>;
    services?: Array<{ id: string; type: string; serviceEndpoint: unknown }>;
    aka?: string[];
    id?: string;
  },
) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: o.id ?? did,
    alsoKnownAs: o.aka ?? [],
    verificationMethod: (o.methods ?? []).map((m) => ({
      id: m.id,
      type: m.type ?? 'Multikey',
      controller: m.controller ?? did,
      publicKeyMultibase: m.publicKeyMultibase,
    })),
    service: o.services ?? [
      { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds-raw.example.test' },
    ],
  };
}

describe('identity resolution', () => {
  it('plc and did:web documents resolve signing key and PDS', async () => {
    const net = network();
    net.plc.register(ALICE, { signingKey: keys.alice, pds: 'https://pds-alice.example.test', handle: 'alice.test' });
    net.doh.setTxt('_atproto.alice.test', [`did=${ALICE}`]);
    net.plc.register(WEB, { signingKey: keys.bob, pds: 'https://pds-web.example.test/', handle: 'web.example.test' });
    net.handles.set('web.example.test', WEB);

    // did:plc → plc.directory, secp256k1 key.
    const alice = await net.resolver.resolveDid(ALICE);
    expect(alice).toEqual({
      did: ALICE,
      pds: 'https://pds-alice.example.test',
      signingKey: keys.alice.didKey,
      handle: 'alice.test',
      fetchedAtMs: NOW_MS,
    });
    expect(alice.signingKey.startsWith('did:key:zQ3s')).toBe(true); // secp256k1 multicodec
    expect(net.transport.calls.count({ service: 'plc', host: 'plc.directory', path: `/${ALICE}` })).toBe(1);

    // did:web → https://<host>/.well-known/did.json, P-256 key; trailing slash canonicalised.
    const web = await net.resolver.resolveDid(WEB);
    expect(web).toEqual({
      did: WEB,
      pds: 'https://pds-web.example.test',
      signingKey: keys.bob.didKey,
      handle: 'web.example.test',
      fetchedAtMs: NOW_MS,
    });
    expect(web.signingKey.startsWith('did:key:zDn')).toBe(true); // P-256 multicodec
    expect(didDocumentUrl(WEB)).toBe('https://web.example.test/.well-known/did.json');
    expect(net.transport.calls.count({ service: 'plc', host: 'web.example.test', path: '/.well-known/did.json' })).toBe(
      1,
    );
    // Handle for did:web came from the HTTPS well-known (no TXT published).
    expect(net.transport.calls.count({ service: 'handle', host: 'web.example.test' })).toBe(1);

    // First VALID #atproto key wins, in document order: each unusable first
    // entry is skipped in favour of the second, and with two valid entries the
    // first is taken.
    net.plc.register(CAROL, { signingKey: keys.carol, pds: 'https://pds-carol.example.test', handle: null });
    const carolKey = { id: `${CAROL}#atproto`, publicKeyMultibase: keys.carol.multikey };
    const skipped: Array<{ id: string; type?: string; controller?: string; publicKeyMultibase: string }> = [
      { id: '#atproto', publicKeyMultibase: syntheticMultikey('secp256k1', 5) }, // x=5: no point on secp256k1
      { id: '#atproto', controller: BOB, publicKeyMultibase: keys.bob.multikey }, // foreign controller
      { id: '#atproto', type: 'EcdsaSecp256k1VerificationKey2019', publicKeyMultibase: keys.alice.multikey },
      { id: '#atproto_label', publicKeyMultibase: keys.aliceRotated.multikey }, // not #atproto
    ];
    for (const first of skipped) {
      net.plc.setRawDocument(CAROL, rawDoc(CAROL, { methods: [first, carolKey] }));
      expect((await net.resolver.resolveDid(CAROL, { fresh: true })).signingKey, JSON.stringify(first)).toBe(
        keys.carol.didKey,
      );
    }
    net.plc.setRawDocument(
      CAROL,
      rawDoc(CAROL, {
        methods: [carolKey, { id: '#atproto', publicKeyMultibase: keys.carolRotated.multikey }],
        services: [
          { id: '#other', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://wrong.example.test' },
          {
            id: `${CAROL}#atproto_pds`,
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: 'https://pds-carol.example.test',
          },
        ],
      }),
    );
    const carol = await net.resolver.resolveDid(CAROL, { fresh: true });
    expect(carol.signingKey).toBe(keys.carol.didKey);
    expect(carol.pds).toBe('https://pds-carol.example.test');
    expect(carol.handle).toBeNull();

    // The curve check is exact: x=1 is on secp256k1 and x=5 on P-256.
    const onCurve = syntheticMultikey('secp256k1', 1);
    net.plc.setRawDocument(MALLORY, rawDoc(MALLORY, { methods: [{ id: '#atproto', publicKeyMultibase: onCurve }] }));
    expect((await net.resolver.resolveDid(MALLORY)).signingKey).toBe(`did:key:${onCurve}`);
    const p256OnCurve = syntheticMultikey('p256', 5);
    net.plc.setRawDocument(
      MALLORY,
      rawDoc(MALLORY, {
        methods: [
          { id: '#atproto', publicKeyMultibase: syntheticMultikey('p256', 1) }, // x=1: no point on P-256
          { id: `${MALLORY}#atproto`, publicKeyMultibase: p256OnCurve },
        ],
      }),
    );
    expect((await net.resolver.resolveDid(MALLORY, { fresh: true })).signingKey).toBe(`did:key:${p256OnCurve}`);

    // Only the fields atproto reads are validated (the oracle's serde
    // DidDocument): DID-Core-legal or foreign content elsewhere in the
    // document never hides a valid #atproto key or #atproto_pds.
    net.doh.setTxt('_atproto.dave.test', [`did=${DAVE}`]);
    const daveKey = { id: '#atproto', type: 'Multikey', controller: DAVE, publicKeyMultibase: keys.carol.multikey };
    const davePds = {
      id: '#atproto_pds',
      type: 'AtprotoPersonalDataServer',
      serviceEndpoint: 'https://pds-dave.example.test',
    };
    const daveDoc = (extra: Record<string, unknown>) => ({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: DAVE,
      alsoKnownAs: ['at://dave.test'],
      verificationMethod: [daveKey],
      service: [davePds],
      ...extra,
    });
    const tolerated: Array<[string, Record<string, unknown>]> = [
      ['string @context', daveDoc({ '@context': 'https://www.w3.org/ns/did/v1' })],
      ['no @context', (({ '@context': _, ...rest }) => rest)(daveDoc({}))],
      ['duplicate alsoKnownAs', daveDoc({ alsoKnownAs: ['at://dave.test', 'at://dave.test', 'https://dave.test'] })],
      [
        'unrelated non-base58 / JWK / null-key methods',
        daveDoc({
          verificationMethod: [
            { id: '#other', type: 'Multikey', controller: DAVE, publicKeyMultibase: 'zQ3sh0OIl' },
            { id: '#jwk', type: 'JsonWebKey2020', controller: DAVE, publicKeyJwk: { kty: 'EC' } },
            { id: '#nokey', type: 'Multikey', controller: DAVE, publicKeyMultibase: null },
            daveKey,
          ],
        }),
      ],
      [
        'unrelated services with non-URL / map endpoints',
        daveDoc({
          service: [
            { id: '#notes', type: 'Notes', serviceEndpoint: 'not a url' },
            { id: '#hub', type: 'Hub', serviceEndpoint: { origins: ['https://hub.example.test'] } },
            davePds,
          ],
        }),
      ],
      [
        'duplicate #atproto ids: first invalid, second valid',
        daveDoc({
          verificationMethod: [{ ...daveKey, publicKeyMultibase: 'zQ3sh0OIl' }, daveKey],
        }),
      ],
      ['unknown properties, 40 KiB document', daveDoc({ controller: DAVE, padding: 'x'.repeat(40 * 1024) })],
    ];
    for (const [label, doc] of tolerated) {
      net.plc.setRawDocument(DAVE, doc);
      expect(await net.resolver.resolveDid(DAVE, { fresh: true }), label).toEqual({
        did: DAVE,
        pds: 'https://pds-dave.example.test',
        signingKey: keys.carol.didKey,
        handle: 'dave.test',
        fetchedAtMs: NOW_MS,
      });
    }
    // The cached JSON is the whole document, foreign content included.
    const daveStored = JSON.parse(net.memo.store.get(DAVE)!.docJson) as { padding: string };
    expect(daveStored.padding).toHaveLength(40 * 1024);
    expect(net.transport.calls.count({ service: 'plc', path: `/${DAVE}`, status: 200 })).toBe(tolerated.length);

    // Each successful resolution was written to the cache hook exactly once.
    expect(net.memo.log.puts.map((i) => i.did)).toEqual([
      ALICE,
      WEB,
      ...skipped.map(() => CAROL),
      CAROL,
      MALLORY,
      MALLORY,
      ...tolerated.map(() => DAVE),
    ]);
    const stored = JSON.parse(net.memo.store.get(ALICE)!.docJson) as { id: string };
    expect(stored.id).toBe(ALICE);
    // Resolution never contacts a PDS.
    expect(net.otherCalls()).toEqual([]);
  });

  it('document id mismatch and missing #atproto key are rejected', async () => {
    const net = network();
    net.plc.register(ALICE, { signingKey: keys.alice, pds: 'https://pds-alice.example.test', handle: 'alice.test' });

    // id mismatch: Alice's URL serves Bob's document.
    net.plc.setRawDocument(ALICE, didDocument(BOB, net.plc.entry(ALICE)!));
    await identityFailure(net.resolver.resolveDid(ALICE), 'did_mismatch');

    // Missing or unusable #atproto keys: each is rejected with no_signing_key.
    const unusable: Array<[string, ReturnType<typeof rawDoc>]> = [
      ['no methods', rawDoc(ALICE, { methods: [] })],
      [
        'only #atproto_label',
        rawDoc(ALICE, { methods: [{ id: '#atproto_label', publicKeyMultibase: keys.alice.multikey }] }),
      ],
      [
        'foreign controller',
        rawDoc(ALICE, { methods: [{ id: '#atproto', controller: BOB, publicKeyMultibase: keys.alice.multikey }] }),
      ],
      [
        'legacy key type',
        rawDoc(ALICE, {
          methods: [
            { id: '#atproto', type: 'EcdsaSecp256k1VerificationKey2019', publicKeyMultibase: keys.alice.multikey },
          ],
        }),
      ],
      [
        'off-curve secp256k1',
        rawDoc(ALICE, { methods: [{ id: '#atproto', publicKeyMultibase: syntheticMultikey('secp256k1', 5) }] }),
      ],
      [
        'x >= p',
        rawDoc(ALICE, { methods: [{ id: '#atproto', publicKeyMultibase: syntheticMultikey('p256', 'max') }] }),
      ],
      ['too long', rawDoc(ALICE, { methods: [{ id: '#atproto', publicKeyMultibase: `z${'2'.repeat(128)}` }] })],
      // Not base58btc: the method is well-formed, only its key is unusable.
      ['non-base58 key', rawDoc(ALICE, { methods: [{ id: '#atproto', publicKeyMultibase: 'zQ3sh0OIl' }] })],
      ['base32 multibase', rawDoc(ALICE, { methods: [{ id: '#atproto', publicKeyMultibase: 'bafkqaaa' }] })],
      [
        'unsupported multicodec (ed25519)',
        rawDoc(ALICE, {
          methods: [{ id: '#atproto', publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK' }],
        }),
      ],
    ];
    for (const [label, doc] of unusable) {
      net.plc.setRawDocument(ALICE, doc);
      const error = await identityFailure(net.resolver.resolveDid(ALICE), 'no_signing_key');
      expect(error.message, label).toContain(ALICE);
    }

    // A document whose atproto fields are malformed (the oracle's serde
    // shape) and a tombstone are definite failures too.
    const good = rawDoc(ALICE, { methods: [{ id: '#atproto', publicKeyMultibase: keys.alice.multikey }] });
    const goodMethod = good.verificationMethod[0]!;
    const goodService = good.service[0]!;
    const malformed: Array<[string, unknown]> = [
      ['non-array verificationMethod', { id: ALICE, verificationMethod: 'nope' }],
      ['null verificationMethod', { ...good, verificationMethod: null }],
      ['method without controller', { ...good, verificationMethod: [{ ...goodMethod, controller: undefined }] }],
      ['numeric publicKeyMultibase', { ...good, verificationMethod: [{ ...goodMethod, publicKeyMultibase: 5 }] }],
      ['non-string alsoKnownAs entry', { ...good, alsoKnownAs: ['at://alice.test', 42] }],
      ['service without endpoint', { ...good, service: [{ id: goodService.id, type: goodService.type }] }],
      ['service type array', { ...good, service: [{ ...goodService, type: ['AtprotoPersonalDataServer'] }] }],
      ['numeric id', { ...good, id: 7 }],
      ['top-level array', [good]],
    ];
    for (const [label, doc] of malformed) {
      net.plc.setRawDocument(ALICE, doc);
      const error = await identityFailure(net.resolver.resolveDid(ALICE), 'invalid_did_document');
      expect(error.message, label).toContain(ALICE);
    }
    net.plc.setRawDocument(MALLORY, { not: 'a document' });
    await identityFailure(net.resolver.resolveDid(MALLORY), 'invalid_did_document');
    net.plc.register(BOB, { signingKey: keys.bob, pds: 'https://pds-bob.example.test' });
    net.plc.tombstone(BOB);
    await identityFailure(net.resolver.resolveDid(BOB), 'did_not_found');

    // Every attempt fetched the document exactly once and nothing was cached.
    expect(net.transport.calls.count({ service: 'plc', path: `/${ALICE}`, status: 200 })).toBe(
      1 + unusable.length + malformed.length,
    );
    expect(net.transport.calls.count({ service: 'plc', path: `/${BOB}`, status: 410 })).toBe(1);
    expect(net.memo.log.puts).toEqual([]);
    // A rejected document never leads to a handle lookup or a PDS request: the
    // only DoH traffic is SafeFetch's A/AAAA pre-check of plc.directory (cached).
    expect(net.transport.calls.filter({ service: 'doh' }).map((c) => [c.params.name?.[0], c.params.type?.[0]])).toEqual(
      [
        ['plc.directory', '1'],
        ['plc.directory', '28'],
      ],
    );
    expect(net.transport.calls.count({ service: 'handle' })).toBe(0);
    expect(net.otherCalls()).toEqual([]);

    // Unsupported DID syntax is refused before the cache or the network.
    const before = net.transport.calls.entries.length;
    for (const bad of ['did:plc:short', 'did:web:web.example.test:path', 'did:key:zQ3sh', 'alice.test']) {
      await identityFailure(net.resolver.resolveDid(bad), 'invalid_did');
    }
    expect(net.transport.calls.entries.length).toBe(before);
    expect(net.memo.log.gets).not.toContain('did:plc:short');

    // Byte-level: the body must be UTF-8 JSON within SafeFetch's 64 KiB
    // didDoc cap (ADR §8); the content-type is not consulted (as the oracle).
    const RAW = 'did:web:raw.example.test';
    const rawBody = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc));
    let served: { body: Uint8Array; type: string } = { body: new Uint8Array(), type: 'application/json' };
    const raw = network({
      hosts: {
        'raw.example.test': () =>
          new Response(served.body as Uint8Array<ArrayBuffer>, { headers: { 'content-type': served.type } }),
      },
    });
    const rawGood = rawDoc(RAW, { methods: [{ id: '#atproto', publicKeyMultibase: keys.bob.multikey }] });
    served = { body: rawBody({ ...rawGood, padding: 'x'.repeat(60 * 1024) }), type: 'text/plain' };
    expect(served.body.byteLength).toBeLessThan(64 * 1024);
    expect(await raw.resolver.resolveDid(RAW)).toEqual({
      did: RAW,
      pds: 'https://pds-raw.example.test',
      signingKey: keys.bob.didKey,
      handle: null,
      fetchedAtMs: NOW_MS,
    });
    const badBodies: Array<[string, Uint8Array]> = [
      ['not JSON', new TextEncoder().encode('<html>hi</html>')],
      ['empty body', new Uint8Array()],
      ['BOM-prefixed JSON', new Uint8Array([0xef, 0xbb, 0xbf, ...rawBody(rawGood)])],
      // A lossy decoder would read `{"id":"\uFFFD"}` (did_mismatch); a fatal one refuses it.
      [
        'invalid UTF-8',
        new Uint8Array([...new TextEncoder().encode('{"id":"'), 0xff, ...new TextEncoder().encode('"}')]),
      ],
    ];
    for (const [label, body] of badBodies) {
      served = { body, type: 'application/json' };
      const error = await identityFailure(raw.resolver.resolveDid(RAW, { fresh: true }), 'invalid_did_document');
      expect(error.message, label).toContain(RAW);
    }
    served = { body: rawBody({ ...rawGood, padding: 'x'.repeat(64 * 1024) }), type: 'application/json' };
    const oversized = await rejection(raw.resolver.resolveDid(RAW, { fresh: true }));
    expect(oversized).toBeInstanceOf(SafeFetchError);
    expect((oversized as SafeFetchError).code).toBe('body_too_large');
    expect(raw.transport.calls.count({ service: 'host', host: 'raw.example.test' })).toBe(2 + badBodies.length);
    expect(raw.memo.log.puts.map((i) => i.did)).toEqual([RAW]);
  });

  it('handle verified only when TXT/well-known and alsoKnownAs agree; mismatch yields null', async () => {
    const net = network({
      hosts: {
        // A handle host that answers its well-known with a redirect.
        'redirect.test': () => new Response(null, { status: 302, headers: { location: 'https://evil.test/did' } }),
        'evil.test': () => new Response(MALLORY, { headers: { 'content-type': 'text/plain' } }),
        // A handle host that answers with the right DID but the wrong media type.
        'html.test': () => new Response(BOB, { headers: { 'content-type': 'text/html' } }),
        // A handle host with nothing published.
        'nobody.test': () => new Response('not found', { status: 404 }),
      },
    });
    const pds = 'https://pds.example.test';

    // (1) TXT agrees with alsoKnownAs → verified; no HTTPS lookup is made.
    net.plc.register(ALICE, { signingKey: keys.alice, pds, handle: 'Alice.TEST' });
    net.doh.setTxt('_atproto.alice.test', [`did=${ALICE}`, `did=${ALICE}`, 'unrelated=1']);
    expect((await net.resolver.resolveDid(ALICE)).handle).toBe('alice.test');
    expect(net.doh.count('_atproto.alice.test', 'TXT')).toBe(1);
    expect(net.transport.calls.count({ service: 'handle' })).toBe(0);

    // (2) well-known agrees (no TXT) → verified.
    net.plc.register(BOB, { signingKey: keys.bob, pds, handle: 'bob.test' });
    net.handles.set('bob.test', BOB);
    expect((await net.resolver.resolveDid(BOB)).handle).toBe('bob.test');
    expect(net.transport.calls.count({ service: 'handle', host: 'bob.test' })).toBe(1);

    // (3) spoofed_handle: the handle maps to Alice, but Alice's document aliases
    // Bob's handle (which maps to Bob) → no verified handle. The DID itself
    // still resolves: the stable identity is the DID.
    net.plc.setHandle(ALICE, 'bob.test');
    expect(await net.resolver.resolveHandle('alice.test')).toBe(ALICE);
    const spoofedAlice = await net.resolver.resolveDid(ALICE, { fresh: true });
    expect(spoofedAlice).toEqual({ did: ALICE, pds, signingKey: keys.alice.didKey, handle: null, fetchedAtMs: NOW_MS });

    // (4) Mallory claims Alice's handle; alice.test's TXT names Alice → null.
    net.plc.register(MALLORY, { signingKey: keys.carol, pds, handle: 'alice.test' });
    expect((await net.resolver.resolveDid(MALLORY)).handle).toBeNull();

    // (5) the claimed handle's well-known names another DID → null.
    net.plc.register(CAROL, { signingKey: keys.carol, pds, handle: 'carol.test' });
    net.handles.set('carol.test', BOB);
    expect((await net.resolver.resolveDid(CAROL)).handle).toBeNull();

    // (6) TXT lookup failure falls back to HTTPS; the HTTPS answer must still agree.
    net.handles.set('carol.test', CAROL);
    net.doh.fail({ path: '_atproto.carol.test' }, { kind: 'status', status: 500 });
    expect((await net.resolver.resolveDid(CAROL, { fresh: true })).handle).toBe('carol.test');

    // (7) Ambiguous TXT (two distinct DIDs) fails resolution, never falls back to HTTPS.
    net.doh.setTxt('_atproto.ambiguous.test', [`did=${ALICE}`, `did=${BOB}`]);
    net.handles.set('ambiguous.test', ALICE);
    await identityFailure(net.resolver.resolveHandle('ambiguous.test'), 'ambiguous_handle');
    expect(net.transport.calls.count({ service: 'handle', host: 'ambiguous.test' })).toBe(0);
    net.plc.setHandle(ALICE, 'ambiguous.test');
    expect((await net.resolver.resolveDid(ALICE, { fresh: true })).handle).toBeNull();

    // (8) A well-known redirect is refused and its Location is never fetched.
    const redirect = await rejection(net.resolver.resolveHandle('redirect.test'));
    expect(redirect).toBeInstanceOf(SafeFetchError);
    expect((redirect as SafeFetchError).code).toBe('redirect_refused');
    expect(net.transport.calls.count({ host: 'redirect.test' })).toBe(1);
    expect(net.transport.calls.count({ host: 'evil.test' })).toBe(0);
    net.plc.register(WEB, { signingKey: keys.bob, pds, handle: 'redirect.test' });
    expect((await net.resolver.resolveDid(WEB)).handle).toBeNull();
    expect(net.transport.calls.count({ host: 'evil.test' })).toBe(0);

    // (9) A well-known that is not text/plain does not verify.
    await identityFailure(net.resolver.resolveHandle('html.test'), 'invalid_handle_response');
    net.plc.setHandle(BOB, 'html.test');
    expect((await net.resolver.resolveDid(BOB, { fresh: true })).handle).toBeNull();

    // (10) Nothing published anywhere → handle_not_found; malformed handle → invalid_handle.
    await identityFailure(net.resolver.resolveHandle('nobody.test'), 'handle_not_found');
    await identityFailure(net.resolver.resolveHandle('not a handle'), 'invalid_handle');

    // verifyHandle on its own: both directions or null.
    const handles = createHandleResolver({ transport: net.transport, clock: net.clock });
    expect(await handles.verifyHandle(BOB, { alsoKnownAs: ['https://bob.test', 'at://bob.test'] })).toBe('bob.test');
    expect(await handles.verifyHandle(ALICE, { alsoKnownAs: ['at://bob.test'] })).toBeNull();
    expect(await handles.verifyHandle(ALICE, { alsoKnownAs: [] })).toBeNull();

    // Handle resolution never contacts a PDS; the cached identities carry the verdicts.
    expect(net.transport.calls.count({ host: 'pds.example.test' })).toBe(0);
    expect(net.memo.store.get(MALLORY)!.identity.handle).toBeNull();
    expect(net.memo.store.get(CAROL)!.identity.handle).toBe('carol.test');
  });

  it('PDS endpoint that fails URL policy is rejected', async () => {
    const net = network();
    net.plc.register(ALICE, { signingKey: keys.alice, pds: 'https://pds-alice.example.test', handle: null });
    const refused = [
      'http://pds-alice.example.test',
      'https://pds-alice.example.test:8443',
      'https://pds-alice.example.test:443',
      'https://user:pw@pds-alice.example.test',
      'https://pds-alice.example.test/#frag',
      'https://pds-alice.example.test/xrpc',
      'https://pds-alice.example.test/?q=1',
      'https://10.0.0.1',
      'https://169.254.169.254',
      'https://[::1]',
      'https://[::ffff:127.0.0.1]',
      'https://2130706433',
      'https://localhost',
      'https://pds.localhost',
      'https://pds.internal',
      'https://pds.local',
      'https://pds',
      'ftp://pds-alice.example.test',
    ];
    for (const endpoint of refused) {
      net.plc.setPds(ALICE, endpoint);
      const error = await identityFailure(net.resolver.resolveDid(ALICE, { fresh: true }), 'invalid_pds');
      expect(error.message.length, endpoint).toBeGreaterThan(0);
    }

    // Missing service, wrong type and a non-string endpoint are refused too.
    const services: Array<Array<{ id: string; type: string; serviceEndpoint: unknown }>> = [
      [],
      [{ id: '#atproto_pds', type: 'SomethingElse', serviceEndpoint: 'https://pds-alice.example.test' }],
      [
        {
          id: '#atproto_pds',
          type: 'AtprotoPersonalDataServer',
          serviceEndpoint: { uri: 'https://pds-alice.example.test' },
        },
      ],
    ];
    for (const s of services) {
      net.plc.setRawDocument(
        ALICE,
        rawDoc(ALICE, { methods: [{ id: '#atproto', publicKeyMultibase: keys.alice.multikey }], services: s }),
      );
      await identityFailure(net.resolver.resolveDid(ALICE, { fresh: true }), 'invalid_pds');
    }

    // Each refusal fetched the document once, cached nothing and contacted no PDS host.
    expect(net.transport.calls.count({ service: 'plc', path: `/${ALICE}` })).toBe(refused.length + services.length);
    expect(net.memo.log.puts).toEqual([]);
    expect(net.otherCalls()).toEqual([]);
    for (const host of ['pds-alice.example.test', '10.0.0.1', '169.254.169.254', 'localhost', 'pds.internal']) {
      expect(net.transport.calls.count({ host })).toBe(0);
      expect(net.doh.count(host)).toBe(0);
    }

    // The fixture TLDs are admitted only because this transport is a fixture
    // one: the same document under a production (unmarked) transport is refused.
    // (plc.directory itself is a public host, so the document is fetched.)
    const productionTransport = (req: Request) => net.transport(req);
    const production = createIdentityResolver({ transport: productionTransport, clock: net.clock });
    net.plc.register(BOB, { signingKey: keys.bob, pds: 'https://pds-bob.example.test', handle: null });
    const prodError = await identityFailure(production.resolveDid(BOB), 'invalid_pds');
    expect(prodError.message).toContain('reserved_tld');
    expect(net.transport.calls.count({ service: 'plc', path: `/${BOB}` })).toBe(1);

    // A canonical public origin (trailing slash allowed) is accepted and never contacted.
    net.plc.register(CAROL, { signingKey: keys.carol, pds: 'https://pds.example.com/', handle: null });
    expect((await net.resolver.resolveDid(CAROL)).pds).toBe('https://pds.example.com');
    expect(net.transport.calls.count({ host: 'pds.example.com' })).toBe(0);
  });

  it('fresh:true bypasses cache after key rotation', async () => {
    const net = network();
    net.plc.register(ALICE, { signingKey: keys.alice, pds: 'https://pds-alice.example.test', handle: 'alice.test' });
    net.doh.setTxt('_atproto.alice.test', [`did=${ALICE}`]);
    const plcCalls = () => net.transport.calls.count({ service: 'plc', path: `/${ALICE}` });

    const first = await net.resolver.resolveDid(ALICE);
    expect(first.signingKey).toBe(keys.alice.didKey);
    expect(first.fetchedAtMs).toBe(NOW_MS);
    expect(plcCalls()).toBe(1);
    expect(net.memo.log.gets).toEqual([ALICE]);
    expect(net.memo.log.puts).toEqual([first]);

    // A cache hit makes no remote call at all.
    const callsBefore = net.transport.calls.entries.length;
    expect(await net.resolver.resolveDid(ALICE)).toBe(first);
    expect(net.transport.calls.entries.length).toBe(callsBefore);

    // The key rotates at the PLC. A cached read still returns the old key…
    net.plc.rotateKey(ALICE, keys.aliceRotated);
    net.clock.advance(60_000);
    expect((await net.resolver.resolveDid(ALICE)).signingKey).toBe(keys.alice.didKey);
    expect(plcCalls()).toBe(1);
    expect(net.memo.log.gets).toEqual([ALICE, ALICE, ALICE]);

    // …and fresh:true skips the cache read, refetches, re-verifies the handle
    // and overwrites the cache with the rotated key.
    const dohBefore = net.doh.count('_atproto.alice.test', 'TXT');
    const fresh = await net.resolver.resolveDid(ALICE, { fresh: true });
    expect(fresh).toEqual({
      did: ALICE,
      pds: 'https://pds-alice.example.test',
      signingKey: keys.aliceRotated.didKey,
      handle: 'alice.test',
      fetchedAtMs: NOW_MS + 60_000,
    });
    expect(fresh.signingKey).not.toBe(keys.alice.didKey);
    expect(plcCalls()).toBe(2);
    expect(net.doh.count('_atproto.alice.test', 'TXT')).toBe(dohBefore + 1);
    expect(net.memo.log.gets).toEqual([ALICE, ALICE, ALICE]); // no get for the fresh call
    expect(net.memo.log.puts).toEqual([first, fresh]);
    const stored = JSON.parse(net.memo.store.get(ALICE)!.docJson) as {
      verificationMethod: Array<{ publicKeyMultibase: string }>;
    };
    expect(stored.verificationMethod[0]!.publicKeyMultibase).toBe(keys.aliceRotated.multikey);

    // Later cached reads now serve the rotated key without a remote call.
    expect(await net.resolver.resolveDid(ALICE)).toBe(fresh);
    expect(plcCalls()).toBe(2);

    // A failed fresh resolution leaves the cached identity untouched.
    net.plc.fail({ did: ALICE }, { kind: 'status', status: 503 });
    const outage = await rejection(net.resolver.resolveDid(ALICE, { fresh: true }));
    expect(outage).toBeInstanceOf(SafeFetchError);
    expect((outage as SafeFetchError).status).toBe(503);
    expect(net.memo.log.puts).toEqual([first, fresh]);
    expect(await net.resolver.resolveDid(ALICE)).toBe(fresh);
  });
});

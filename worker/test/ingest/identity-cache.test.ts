// W3-04 identity-cache.ts: the identity_cache table behind the production
// identity resolver (packages/atproto createIdentityResolver), over the
// fixture network with the injected clock. Proves the TTL half of
// M2.1.1/cache_expiry (the `fresh: true` half is
// packages/atproto/test/identity.test.ts). Expectations are hardcoded.

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  cachedIdentityResolver,
  IDENTITY_NEGATIVE_TTL_MS,
  IDENTITY_TTL_MS,
  resolveIdentity,
} from '../../src/do/ingest/identity-cache';
import type { HarnessDO } from '../harness/harness-do';
import { kit } from './drain-support';

const stubFor = (name: string) => env.HARNESS.get(env.HARNESS.idFromName(name));
const T0 = Date.parse('2026-01-15T12:00:00Z');

describe('identity cache', () => {
  it('cached identity served at 299 s and refreshed at 301 s with the injected clock', async () => {
    const k = await kit();
    const alice = k.users.Alice;
    k.resetCalls();
    expect(IDENTITY_TTL_MS).toBe(300_000);

    await runInDurableObject(stubFor('identity-ttl'), async (i: HarnessDO) => {
      const db = i.db;
      const resolver = cachedIdentityResolver(db, { transport: k.transport, clock: k.clock });
      const m = { db, clock: k.clock, identity: resolver };
      const docCalls = () => k.plc.count(alice.did);

      // t = 0: resolved from the DID document and stored.
      const first = await resolveIdentity(m, alice.did);
      expect(first).toEqual({
        ok: true,
        fromCache: false,
        identity: {
          did: alice.did,
          pds: 'https://pds-alice.example.test',
          signingKey: k.keys.alice.didKey,
          handle: alice.handle,
          fetchedAtMs: T0,
        },
      });
      expect(docCalls()).toBe(1);
      const row = db.one<Record<string, unknown>>('SELECT * FROM identity_cache WHERE did = ?', alice.did);
      expect(row).toMatchObject({
        did: alice.did,
        signing_key: k.keys.alice.didKey,
        pds: 'https://pds-alice.example.test',
        handle: alice.handle,
        fetched_at_ms: T0,
        neg_until_ms: null,
      });
      expect(JSON.parse(row!.doc_json as string)).toMatchObject({ id: alice.did });

      // The key rotates in the PLC directory right after: the cache does not know yet.
      k.plc.rotateKey(alice.did, k.keys.aliceRotated);

      // t = 299 s: served from identity_cache (old key), no DID document request.
      k.clock.advance(299_000);
      const original = {
        did: alice.did,
        pds: 'https://pds-alice.example.test',
        signingKey: k.keys.alice.didKey,
        handle: alice.handle,
        fetchedAtMs: T0,
      };
      expect(await resolveIdentity(m, alice.did)).toEqual({ ok: true, fromCache: true, identity: original });
      // The production resolver's own cache hook reads the same row.
      expect(await resolver.resolveDid(alice.did)).toEqual(original);
      expect(docCalls()).toBe(1);

      // t = 301 s: expired, so the document is fetched again and the new key replaces the old.
      k.clock.advance(2_000);
      const refreshed = await resolveIdentity(m, alice.did);
      expect(refreshed).toMatchObject({ ok: true, fromCache: false });
      expect(refreshed.ok && refreshed.identity).toEqual({
        did: alice.did,
        pds: 'https://pds-alice.example.test',
        signingKey: k.keys.aliceRotated.didKey,
        handle: alice.handle,
        fetchedAtMs: T0 + 301_000,
      });
      expect(docCalls()).toBe(2);
      expect(db.one('SELECT signing_key, fetched_at_ms FROM identity_cache WHERE did = ?', alice.did)).toEqual({
        signing_key: k.keys.aliceRotated.didKey,
        fetched_at_ms: T0 + 301_000,
      });

      // And the refreshed entry is itself served for the next 299 s.
      k.clock.advance(299_000);
      expect((await resolveIdentity(m, alice.did)).ok).toBe(true);
      expect(docCalls()).toBe(2);
    });
  });

  it('a definite identity failure is negatively cached for one hour; transport failures are not', async () => {
    const k = await kit();
    const bob = k.users.Bob;
    k.plc.tombstone(bob.did);
    k.resetCalls();

    await runInDurableObject(stubFor('identity-negative'), async (i: HarnessDO) => {
      const db = i.db;
      const m = {
        db,
        clock: k.clock,
        identity: cachedIdentityResolver(db, { transport: k.transport, clock: k.clock }),
      };
      expect(await resolveIdentity(m, bob.did)).toEqual({
        ok: false,
        kind: 'invalid',
        code: 'did_not_found',
        retryAt: T0 + IDENTITY_NEGATIVE_TTL_MS,
      });
      expect(k.plc.count(bob.did)).toBe(1);
      expect(
        db.one('SELECT signing_key, pds, fetched_at_ms, neg_until_ms FROM identity_cache WHERE did = ?', bob.did),
      ).toEqual({
        signing_key: null,
        pds: null,
        fetched_at_ms: T0,
        neg_until_ms: T0 + 3_600_000,
      });

      // Within the hour: answered from the negative entry, no request.
      k.clock.advance(3_599_999);
      expect(await resolveIdentity(m, bob.did)).toMatchObject({ ok: false, kind: 'invalid', code: 'negative_cache' });
      expect(k.plc.count(bob.did)).toBe(1);

      // After it: resolved again (and the DID document is back).
      k.plc.register(bob.did, { signingKey: k.keys.bob, pds: 'https://pds-bob.example.test', handle: null });
      k.clock.advance(1);
      expect(await resolveIdentity(m, bob.did)).toMatchObject({
        ok: true,
        identity: { signingKey: k.keys.bob.didKey },
      });
      expect(k.plc.count(bob.did)).toBe(2);

      // A 503 from the directory is transient: not cached, the next call asks again.
      k.clock.advance(IDENTITY_TTL_MS);
      k.plc.fail({ did: bob.did }, { kind: 'status', status: 503 });
      expect(await resolveIdentity(m, bob.did)).toMatchObject({ ok: false, kind: 'transient' });
      expect(db.one('SELECT neg_until_ms FROM identity_cache WHERE did = ?', bob.did)).toEqual({ neg_until_ms: null });
      expect(await resolveIdentity(m, bob.did)).toMatchObject({ ok: true });
      expect(k.plc.count(bob.did)).toBe(4);
    });
  });
});

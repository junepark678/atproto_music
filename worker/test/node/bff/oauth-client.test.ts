// N2-03: the confidential OAuth client (ADR 0005 §5.2, §5.5, §5.6, §20.2).
// Every test drives the real @atproto/oauth-client-node through
// worker/src/bff/oauth-client.ts against the fake AS, a fake PDS with DPoP
// accounts and the fake PLC, over the router transport; assertions are on the
// fakes' logs and state, the requests the client sent, the oauth_* rows and
// the accounts / operations rows.

import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_ASSERTION_TYPE_JWT_BEARER,
  decodeJwt,
  FIXTURE_CLIENT_KEYS,
  jwkThumbprint,
  verifyEs256,
} from '@atmusic/atproto/test-support/fake-oauth-as';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findCause, OAUTH_ERROR_STATUS, OAuthFlowError } from '../../../src/bff/oauth-client';
import type { Db } from '../../../src/do/db';
import { withMigratedDb } from '../support/node-db';
import {
  CLIENT_ID,
  containsBytes,
  createWorld,
  DAY_MS,
  freezeDate,
  gatedService,
  hex,
  rawDbBytes,
  sha256,
  until,
  type World,
} from './oauth-world';

beforeEach(freezeDate);
afterEach(() => vi.useRealTimers());

async function flowError(p: Promise<unknown>): Promise<OAuthFlowError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OAuthFlowError);
    return e as OAuthFlowError;
  }
  throw new Error('expected an OAuthFlowError');
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}

function form(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

/** The DID of an AS-side session revocation recorded since `from`. */
function revokedSubs(w: World, from = 0): Array<string | null> {
  return w.as.revocations.slice(from).map((r) => r.sub);
}

async function world(db: Db, o?: Parameters<typeof createWorld>[1]) {
  const w = await createWorld(db, o);
  const alice = await w.addUser('alice');
  return { w, alice };
}

describe('the confidential OAuth client', () => {
  it('authorize then callback against the fake AS stores a session for the DID; the assertion has iss=sub=client_id, aud=issuer, a unique jti and kid k1', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const svc = w.service();
      const result = await w.signIn(svc, alice);
      expect(result.did).toBe(alice.did);
      expect(result.handle).toBe(alice.handle);
      expect(result.startedFrom).toBe(alice.handle);

      // One sealed session row, bound to k1, decrypting to the AS's current tokens.
      expect(w.sessionRows()).toEqual([
        { did: alice.did, client_kid: 'k1', generation: 1, last_refresh_ms: w.clock.nowMs() },
      ]);
      const asSession = w.as.sessions(alice.did);
      expect(asSession).toHaveLength(1);
      const stored = w.storedSession(alice.did);
      expect(stored?.tokenSet).toMatchObject({
        sub: alice.did,
        iss: w.as.issuer,
        access_token: asSession[0]?.accessToken,
        refresh_token: asSession[0]?.refreshToken,
      });
      expect(stored?.authMethod).toEqual({ method: 'private_key_jwt', kid: 'k1' });
      expect(w.stateRows()).toBe(0); // the state was single use

      // Every client assertion the AS accepted (PAR 201, token 200).
      const accepted = w.captured.filter(
        (c) => (c.path === '/oauth/par' && c.status === 201) || (c.path === '/oauth/token' && c.status === 200),
      );
      expect(accepted.map((c) => c.path)).toEqual(['/oauth/par', '/oauth/token']);
      const jtis: string[] = [];
      for (const c of accepted) {
        const f = form(c.body);
        expect(f.get('client_id')).toBe(CLIENT_ID);
        expect(f.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE_JWT_BEARER);
        const jwt = decodeJwt(f.get('client_assertion') ?? '');
        expect(jwt).not.toBeNull();
        expect(jwt?.header).toMatchObject({ alg: 'ES256', kid: 'k1' });
        expect(jwt?.payload.iss).toBe(CLIENT_ID);
        expect(jwt?.payload.sub).toBe(CLIENT_ID);
        expect(jwt?.payload.aud).toBe('https://as.test');
        expect(jwt?.payload.iat).toBe(Math.floor(w.clock.nowMs() / 1000));
        expect(await verifyEs256(jwt!, FIXTURE_CLIENT_KEYS.k1)).toBe(true);
        expect(await verifyEs256(jwt!, FIXTURE_CLIENT_KEYS.k2)).toBe(false);
        jtis.push(String(jwt?.payload.jti));
      }
      expect(new Set(jtis).size).toBe(jtis.length);
      expect(jtis.every((j) => j.length >= 16)).toBe(true);

      // The session works: a DPoP-bound write reaches the fake PDS.
      const res = await w.writeScrobble(result.session, 1);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ uri: expect.stringContaining(`at://${alice.did}/`) });
    });
  });

  it('a replayed state and a state older than 600 s both fail and store no session', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const bob = await w.addUser('bob');
      const svc = w.service();

      // Replay: the first callback succeeds, the same callback again fails before any token request.
      const b = w.binding();
      const started = await svc.authorize(alice.handle, { bindingHash: b.hash });
      const params = await w.browse(started.url);
      await svc.callback(params, { bindingHash: b.hash });
      const tokenCalls = w.as.count('/oauth/token');
      const rows = w.sessionRows();
      const replay = await flowError(svc.callback(params, { bindingHash: b.hash }));
      // The v1.2 contract: a replayed state is 403 oauth_binding_mismatch (the finer reason is for logs).
      expect(replay.code).toBe('oauth_binding_mismatch');
      expect(replay.status).toBe(403);
      expect(replay.reason).toBe('state_unknown');
      expect(w.as.count('/oauth/token')).toBe(tokenCalls);
      expect(w.sessionRows()).toEqual(rows);

      // Expiry: a state 600 s and 1 ms old is refused and deleted; nothing reaches the token endpoint.
      const b2 = w.binding();
      const late = await svc.authorize(bob.handle, { bindingHash: b2.hash });
      const lateParams = await w.browse(late.url);
      expect(w.stateRows()).toBe(1);
      w.advance(600_001);
      const expired = await flowError(svc.callback(lateParams, { bindingHash: b2.hash }));
      expect(expired.code).toBe('oauth_binding_mismatch');
      expect(expired.status).toBe(403);
      expect(expired.reason).toBe('state_expired');
      expect(expired.message).toBe('expired state');
      expect(w.stateRows()).toBe(0);
      expect(w.as.count('/oauth/token')).toBe(tokenCalls);
      expect(w.sessionRows().map((r) => r.did)).toEqual([alice.did]);
    });
  });

  it('a callback whose sub resolves to a PDS with a different authorization server is rejected and the token is revoked', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db, { secondServer: true });
      const svc = w.service();
      const b = w.binding();
      const started = await svc.authorize(alice.handle, { bindingHash: b.hash });
      const params = await w.browse(started.url);
      // Between authorize and the code exchange the DID moves to a PDS whose AS is as2.test.
      w.plc.setPds(alice.did, w.pds2!.origin);
      const err = await flowError(svc.callback(params, { bindingHash: b.hash }));
      expect(err.code).toBe('oauth_binding_mismatch');
      expect(err.status).toBe(403);
      // The code was exchanged once, and the tokens it produced were revoked at the AS.
      expect(w.as.calls.count({ path: '/oauth/token', status: 200 })).toBe(1);
      expect(w.as.revocations).toHaveLength(1);
      expect(w.as.revocations[0]).toMatchObject({ source: 'endpoint', sub: alice.did, known: true });
      expect(w.as.sessions(alice.did)[0]?.revoked).not.toBeNull();
      // The issuer check fetched as2's metadata through the router and stored nothing.
      expect(w.as2!.count('/.well-known/oauth-authorization-server')).toBeGreaterThan(0);
      expect(w.sessionRows()).toEqual([]);
    });
  });

  it('invalid_grant on refresh deletes the session and marks the account reauth_required; a TransportError keeps the session', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const bob = await w.addUser('bob');
      const svc = w.service();
      await w.signIn(svc, alice);
      await w.signIn(svc, bob);
      w.seedAccount(alice.did, 'alice');
      w.seedAccount(bob.did, 'bob');
      w.seedOperation('op-a', alice.did, 'queued');
      w.seedOperation('op-b', bob.did, 'queued');

      // The user revokes the app at the AS: the next refresh is invalid_grant.
      w.as.revokeSession(alice.did);
      const err = await rejection(svc.restore(alice.did, true));
      expect((err as Error).constructor.name).toBe('TokenRefreshError');
      expect(w.sessionRows().map((r) => r.did)).toEqual([bob.did]);
      expect(w.accountStatus(alice.did)).toBe('reauth_required');
      expect(w.operationStates(alice.did)).toEqual(['blocked']);
      expect(w.revocations.entries()).toEqual([{ kind: 'oauth_session', did: alice.did, at: w.clock.nowMs() }]);

      // A network failure on the token request: the session, its row and the account stay.
      const before = w.sessionRows().find((r) => r.did === bob.did);
      w.as.fail(
        { path: '/oauth/token' },
        {
          kind: 'respond',
          respond: () => {
            throw new TypeError('connection reset by peer');
          },
        },
      );
      const transient = await rejection(svc.restore(bob.did, true));
      expect(findCause(transient, (e) => (e as Error)?.name === 'TransportError')).toBeDefined();
      expect(w.sessionRows().find((r) => r.did === bob.did)).toEqual(before);
      expect(w.accountStatus(bob.did)).toBe('active');
      expect(w.operationStates(bob.did)).toEqual(['queued']);
      expect(revokedSubs(w)).toEqual([alice.did]); // only the user's own revocation of alice
      // Once the network is back, the kept session refreshes.
      await svc.restore(bob.did, true);
      expect(w.sessionRows().find((r) => r.did === bob.did)?.generation).toBe((before?.generation ?? 0) + 1);
    });
  });

  it('a k1-bound session keeps refreshing after k2 is prepended and becomes reauth_required when k1 is removed', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const bob = await w.addUser('bob');
      await w.signIn(w.service(), alice);
      w.seedAccount(alice.did, 'alice');
      expect(w.sessionRows()[0]?.client_kid).toBe('k1');

      // Rotation step 3: the keyset becomes [k2, k1] (restart: a new client).
      await w.setKeys(['k2', 'k1']);
      expect(w.published.keyset.jwks.keys.map((k) => k.kid)).toEqual(['k2', 'k1']);
      const rotated = w.service();
      const mark = w.captured.length;
      await rotated.restore(alice.did, true);
      const refresh = w.captured.slice(mark).filter((c) => c.path === '/oauth/token' && c.status === 200);
      expect(refresh).toHaveLength(1);
      expect(decodeJwt(form(refresh[0]!.body).get('client_assertion') ?? '')?.header.kid).toBe('k1');
      expect(w.as.sessions(alice.did)[0]?.refreshCount).toBe(1);
      expect(w.sessionRows().find((r) => r.did === alice.did)).toMatchObject({ client_kid: 'k1', generation: 2 });
      // A new sign-in binds to the first key.
      await w.signIn(rotated, bob);
      expect(w.sessionRows().find((r) => r.did === bob.did)?.client_kid).toBe('k2');
      expect(w.accountStatus(alice.did)).toBe('active');

      // Step 5: k1 removed. The k1-bound session cannot authenticate any more and is dropped locally.
      await w.setKeys(['k2']);
      const without = w.service();
      const before = w.captured.length;
      const err = await rejection(without.restore(alice.did, true));
      expect((err as Error).constructor.name).toBe('AuthMethodUnsatisfiableError');
      expect(w.captured.slice(before).filter((c) => c.path === '/oauth/token')).toEqual([]);
      expect(w.sessionRows().map((r) => r.did)).toEqual([bob.did]);
      expect(w.accountStatus(alice.did)).toBe('reauth_required');
      // The k2 session keeps working.
      await without.restore(bob.did, true);
      expect(w.sessionRows()[0]).toMatchObject({ did: bob.did, client_kid: 'k2', generation: 2 });
    });
  });

  it('a callback whose bindingHash differs from the state binding is refused before the code exchange and consumes the state', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const svc = w.service();
      const victim = w.binding();
      const attacker = w.binding();
      const started = await svc.authorize(alice.handle, { bindingHash: attacker.hash });
      const params = await w.browse(started.url);
      expect(w.stateRows()).toBe(1);

      // The victim's browser (another cookie, or none) opens the attacker's callback URL.
      const mismatch = await flowError(svc.callback(params, { bindingHash: victim.hash }));
      expect(mismatch.code).toBe('oauth_binding_mismatch');
      expect(mismatch.status).toBe(403);
      expect(mismatch.reason).toBe('cookie_mismatch');
      expect(w.as.count('/oauth/token')).toBe(0);
      expect(w.stateRows()).toBe(0);
      expect(w.sessionRows()).toEqual([]);

      // The state is consumed: even the right cookie cannot complete it now.
      const consumed = await flowError(svc.callback(params, { bindingHash: attacker.hash }));
      expect(consumed.code).toBe('oauth_binding_mismatch');
      expect(consumed.status).toBe(403);
      expect(consumed.reason).toBe('state_unknown');
      expect(w.as.count('/oauth/token')).toBe(0);

      // No cookie at all is the same refusal.
      const b = w.binding();
      const again = await svc.authorize(alice.handle, { bindingHash: b.hash });
      const p2 = await w.browse(again.url);
      expect((await flowError(svc.callback(p2, { bindingHash: null }))).code).toBe('oauth_binding_mismatch');
      expect(w.as.count('/oauth/token')).toBe(0);
      expect(w.stateRows()).toBe(0);
    });
  });

  it('authorize refuses an authorization server whose metadata lacks PAR or S256 PKCE and stores no state', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);

      w.as.setMetadata({ pushed_authorization_request_endpoint: null, require_pushed_authorization_requests: false });
      const noPar = await flowError(w.service().authorize(alice.handle, { bindingHash: w.binding().hash }));
      expect(noPar.code).toBe('oauth_upstream');
      expect(noPar.status).toBe(502);
      expect(noPar.message).toMatch(/PAR/);
      expect(w.stateRows()).toBe(0);

      w.as.setMetadata({
        pushed_authorization_request_endpoint: `${w.as.issuer}/oauth/par`,
        require_pushed_authorization_requests: true,
        code_challenge_methods_supported: ['plain'],
      });
      const noS256 = await flowError(w.service().authorize(alice.handle, { bindingHash: w.binding().hash }));
      expect(noS256.code).toBe('oauth_upstream');
      expect(noS256.message).toMatch(/S256/);
      expect(w.stateRows()).toBe(0);
      expect(w.as.count('/oauth/par')).toBe(0);

      // Control: with both, authorize stores exactly one state.
      w.as.setMetadata({ code_challenge_methods_supported: ['S256'] });
      await w.service().authorize(alice.handle, { bindingHash: w.binding().hash });
      expect(w.stateRows()).toBe(1);
    });
  });

  it('authorize sends PAR with an S256 code_challenge and a private_key_jwt assertion; the verifier and DPoP key exist only sealed in oauth_states', async () => {
    await withMigratedDb(async (db, ctx) => {
      const { w, alice } = await world(db);
      const b = w.binding();
      const started = await w.service().authorize(alice.handle, { bindingHash: b.hash });
      expect(started.did).toBe(alice.did);
      expect(started.url.origin + started.url.pathname).toBe('https://as.test/oauth/authorize');
      expect(started.url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(started.url.searchParams.get('request_uri')).toMatch(/^urn:ietf:params:oauth:request_uri:/);

      const par = w.asRequests('/oauth/par').filter((c) => c.status === 201);
      expect(par).toHaveLength(1);
      const f = form(par[0]!.body);
      expect(f.get('response_type')).toBe('code');
      expect(f.get('response_mode')).toBe('query');
      expect(f.get('code_challenge_method')).toBe('S256');
      expect(f.get('redirect_uri')).toBe('https://music.214510.xyz/oauth/callback');
      expect(f.get('login_hint')).toBe(alice.handle);
      expect(f.get('code_verifier')).toBeNull();
      expect(f.get('client_assertion_type')).toBe(CLIENT_ASSERTION_TYPE_JWT_BEARER);
      const assertion = decodeJwt(f.get('client_assertion') ?? '');
      expect(assertion?.header).toMatchObject({ alg: 'ES256', kid: 'k1' });
      expect(await verifyEs256(assertion!, FIXTURE_CLIENT_KEYS.k1)).toBe(true);

      // The one state row: keyed by SHA-256 of the state sent, bound to the cookie hash, sealed.
      const rows = db.all<{
        key_hash: ArrayBuffer;
        ciphertext: ArrayBuffer;
        key_id: string;
        session_binding: ArrayBuffer;
      }>('SELECT key_hash, ciphertext, key_id, session_binding FROM oauth_states');
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      const stateKey = f.get('state') ?? '';
      expect(hex(row.key_hash)).toBe(hex(sha256(stateKey)));
      expect(hex(row.session_binding)).toBe(hex(b.hash));
      expect(row.key_id).toBe('e1');
      const state = JSON.parse(w.box.openText('oauth-state', new Uint8Array(row.ciphertext), hex(row.key_hash))) as {
        verifier: string;
        dpopJwk: Record<string, string>;
        iss: string;
        appState: string;
      };
      // The challenge is S256 of the sealed verifier.
      expect(Buffer.from(sha256(state.verifier)).toString('base64url')).toBe(f.get('code_challenge'));
      expect(state.verifier.length).toBeGreaterThanOrEqual(43);
      expect(state.iss).toBe('https://as.test');
      // The PAR's DPoP proof is signed with the sealed DPoP key.
      const proof = decodeJwt(par[0]!.headers.get('dpop') ?? '');
      expect(proof?.header.typ).toBe('dpop+jwt');
      const proofJwk = proof?.header.jwk as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      expect(proofJwk).not.toHaveProperty('d');
      expect(await jwkThumbprint(proofJwk)).toBe(
        await jwkThumbprint({ kty: 'EC', crv: 'P-256', x: state.dpopJwk.x!, y: state.dpopJwk.y! }),
      );
      expect(typeof state.dpopJwk.d).toBe('string');
      const derived = createPublicKey({ key: state.dpopJwk, format: 'jwk' }).export({ format: 'jwk' });
      expect(derived).toMatchObject({ x: proofJwk.x, y: proofJwk.y });
      // A wrong AAD (another row's key) does not open it.
      expect(() => w.box.openText('oauth-state', new Uint8Array(row.ciphertext), hex(sha256('other')))).toThrow();

      // Nowhere in the database file or its WAL in the clear.
      const raw = rawDbBytes(ctx.path);
      expect(containsBytes(raw, Buffer.from(row.ciphertext))).toBe(true); // the scan sees the row
      expect(containsBytes(raw, state.verifier)).toBe(false);
      expect(containsBytes(raw, state.dpopJwk.d!)).toBe(false);
      expect(containsBytes(raw, Buffer.from(state.dpopJwk.d!, 'base64url'))).toBe(false);
      expect(containsBytes(raw, stateKey)).toBe(false);
    });
  });

  it('a PAR error from the fake AS leaves no oauth_states row and surfaces oauth_upstream', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      w.as.failOAuth('/oauth/par', 'invalid_request', 'fixture PAR refusal', 400);
      const refused = await flowError(w.service().authorize(alice.handle, { bindingHash: w.binding().hash }));
      expect(refused.code).toBe('oauth_upstream');
      expect(refused.status).toBe(502);
      expect(w.as.calls.filter({ path: '/oauth/par' }).map((c) => c.status)).toEqual([400]);
      expect(w.stateRows()).toBe(0);

      w.as.fail({ path: '/oauth/par' }, { kind: 'status', status: 503 });
      const unavailable = await flowError(w.service().authorize(alice.handle, { bindingHash: w.binding().hash }));
      expect(unavailable.code).toBe('oauth_upstream');
      expect(w.as.calls.filter({ path: '/oauth/par' }).map((c) => c.status)).toEqual([400, 503]);
      expect(w.stateRows()).toBe(0);
    });
  });

  it('a token response whose iss differs from the authorize issuer or whose sub differs from the handle-resolved DID stores no session', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const bob = await w.addUser('bob');
      const svc = w.service();

      // iss: the authorization response names another issuer; no code exchange happens.
      w.as.nextAuthorize({ iss: 'https://evil.test' });
      const b1 = w.binding();
      const p1 = await w.browse((await svc.authorize(alice.handle, { bindingHash: b1.hash })).url);
      expect(p1.get('iss')).toBe('https://evil.test');
      const issErr = await flowError(svc.callback(p1, { bindingHash: b1.hash }));
      expect(issErr.code).toBe('oauth_binding_mismatch');
      expect(issErr.status).toBe(403);
      expect(issErr.reason).toBe('issuer_mismatch');
      expect(w.as.count('/oauth/token')).toBe(0);
      expect(w.sessionRows()).toEqual([]);

      // sub: sign-in started from alice's handle, but the AS issued tokens for bob.
      w.as.nextAuthorize({ sub: bob.did });
      const b2 = w.binding();
      const p2 = await w.browse((await svc.authorize(alice.handle, { bindingHash: b2.hash })).url);
      const subErr = await flowError(svc.callback(p2, { bindingHash: b2.hash }));
      expect(subErr.code).toBe('oauth_binding_mismatch');
      expect(subErr.status).toBe(403);
      expect(subErr.reason).toBe('subject_mismatch');
      expect(w.as.calls.count({ path: '/oauth/token', status: 200 })).toBe(1);
      expect(w.sessionRows()).toEqual([]);
      // The tokens issued for the wrong subject were revoked.
      expect(w.as.sessions(bob.did)[0]?.revoked?.source).toBe('endpoint');
      expect(revokedSubs(w)).toEqual([bob.did]);
    });
  });

  it('a use_dpop_nonce error on the token request and on a PDS write is retried once with the new nonce and succeeds', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const svc = w.service();
      const b = w.binding();
      const params = await w.browse((await svc.authorize(alice.handle, { bindingHash: b.hash })).url);
      // Every AS nonce handed out so far (the one PAR learnt) stops being accepted.
      w.as.rotateNonces();
      const result = await svc.callback(params, { bindingHash: b.hash });

      const token = w.asRequests('/oauth/token');
      expect(token.map((c) => c.status)).toEqual([400, 200]);
      const n1 = decodeJwt(token[0]!.headers.get('dpop') ?? '')?.payload.nonce;
      const n2 = decodeJwt(token[1]!.headers.get('dpop') ?? '')?.payload.nonce;
      expect(typeof n1).toBe('string');
      expect(typeof n2).toBe('string');
      expect(n2).not.toBe(n1);
      // The retry is the same request (same code, same assertion) with a new proof.
      expect(token[1]!.body).toBe(token[0]!.body);
      expect(w.sessionRows().map((r) => r.did)).toEqual([alice.did]);

      // The PDS has its own nonce: the first write learns it from a 401 and is retried once.
      const res = await w.writeScrobble(result.session, 1);
      expect(res.status).toBe(200);
      const writes = w.pds.calls.filter({ nsid: 'com.atproto.repo.createRecord' });
      expect(writes.map((c) => c.status)).toEqual([401, 200]);
      const uri = ((await res.json()) as { uri: string }).uri;
      const record = await alice.repo.getRecord(SCROBBLE_COLLECTION, uri.split('/').pop() ?? '');
      expect(record?.value).toMatchObject({ track: 'Track 1' });
      // A second write reuses the learnt nonce: one request.
      expect((await w.writeScrobble(result.session, 2)).status).toBe(200);
      expect(w.pds.calls.filter({ nsid: 'com.atproto.repo.createRecord' }).map((c) => c.status)).toEqual([
        401, 200, 200,
      ]);
    });
  });

  it('two concurrent restore() calls on an expired session send one refresh request and both use the new token', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const svc = w.service();
      await w.signIn(svc, alice);
      const before = w.as.sessions(alice.did)[0]!.accessToken;
      w.advance(3_600_000 + 60_000); // past the access token's expiry and the library's leeway
      const mark = w.as.calls.entries.length;
      const [s1, s2] = await Promise.all([svc.restore(alice.did), svc.restore(alice.did)]);
      const asSession = w.as.sessions(alice.did)[0]!;
      expect(asSession.refreshCount).toBe(1);
      expect(w.tokenSuccesses(mark)).toBe(1);
      expect(asSession.accessToken).not.toBe(before);
      expect(w.storedSession(alice.did)?.tokenSet.access_token).toBe(asSession.accessToken);
      // Both sessions write with the new token (the old one is no longer accepted by the PDS).
      expect((await w.writeScrobble(s1, 1)).status).toBe(200);
      expect((await w.writeScrobble(s2, 2)).status).toBe(200);
      expect(w.as.sessions(alice.did)[0]!.refreshCount).toBe(1);
      expect(w.as.revocations).toEqual([]);
    });
  });

  it('revoke against an AS without a revocation_endpoint deletes the local session and sends no request', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      await w.signIn(w.service(), alice);
      w.seedAccount(alice.did, 'alice');
      w.seedOperation('op-1', alice.did, 'queued');
      w.as.setMetadata({ revocation_endpoint: null });
      await w.service().revoke(alice.did);
      expect(w.sessionRows()).toEqual([]);
      expect(w.as.count('/oauth/revoke')).toBe(0);
      expect(w.as.revocations).toEqual([]);
      expect(w.accountStatus(alice.did)).toBe('signed_out');
      expect(w.operationStates(alice.did)).toEqual(['blocked']);
      expect(w.revocations.entries()).toEqual([{ kind: 'oauth_session', did: alice.did, at: w.clock.nowMs() }]);
      // Control: with the endpoint, the same revoke sends one request.
      w.as.setMetadata({ revocation_endpoint: `${w.as.issuer}/oauth/revoke` });
      const svc = w.service();
      await w.signIn(svc, alice);
      await w.service().revoke(alice.did);
      // (Its first attempt may learn a DPoP nonce: one accepted request, one revocation.)
      expect(w.as.calls.count({ path: '/oauth/revoke', status: 200 })).toBe(1);
      expect(w.as.revocations.map((r) => r.sub)).toEqual([alice.did]);
      expect(w.sessionRows()).toEqual([]);
    });
  });

  it('during sign-in and a later refresh the router transport sees no request to plc.directory; DID resolution goes through our identity module with fresh true', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const svc = w.service();
      await w.signIn(svc, alice);
      const freshAfterSignIn = w.identityCalls.filter((c) => c.did === alice.did && c.fresh).length;
      // verifyIssuer after the code exchange and our binding check: both fresh.
      expect(freshAfterSignIn).toBeGreaterThanOrEqual(2);
      w.advance(DAY_MS);
      await svc.restore(alice.did, true);
      // verifyIssuer before the refresh: one more fresh resolution through our module.
      expect(w.identityCalls.filter((c) => c.did === alice.did && c.fresh).length).toBe(freshAfterSignIn + 1);
      expect(w.as.sessions(alice.did)[0]?.refreshCount).toBe(1);

      // The OAuth library's transport never asked plc.directory; every PLC request came from our module.
      expect(w.oauthRouter.calls.count({ host: 'plc.directory' })).toBe(0);
      const ours = w.identityRouter.calls.count({ host: 'plc.directory' });
      expect(ours).toBeGreaterThanOrEqual(freshAfterSignIn + 1);
      expect(w.plc.count(alice.did)).toBe(ours);
      // Non-vacuity: plc.directory is reachable on the library's transport, so a library resolver would show up.
      const direct = await w.oauthTransport(new Request(`https://plc.directory/${alice.did}`));
      expect(direct.status).toBe(200);
      expect(w.oauthRouter.calls.count({ host: 'plc.directory' })).toBe(1);
    });
  });

  it('a callback for a DID whose document our identity rules reject fails and stores no session', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const svc = w.service();
      const b = w.binding();
      const params = await w.browse((await svc.authorize(alice.handle, { bindingHash: b.hash })).url);
      // The document loses its #atproto key: the library alone (it needs only the PDS) would accept it.
      const doc = w.plc.document(alice.did);
      w.plc.setRawDocument(alice.did, { ...doc, verificationMethod: [] });
      const err = await flowError(svc.callback(params, { bindingHash: b.hash }));
      expect(err.code).toBe('oauth_binding_mismatch');
      expect(err.status).toBe(403);
      expect(err.reason).toBe('identity_rejected');
      expect(findCause(err, (e) => (e as { code?: string })?.code === 'no_signing_key')).toBeDefined();
      expect(w.sessionRows()).toEqual([]);
      // The tokens of the failed exchange were revoked.
      expect(revokedSubs(w)).toEqual([alice.did]);
    });
  });

  it('re-sign-in of a DID with queued and blocked operations leaves oauth_status active, its operations queued and runnable, and never sets reauth_required', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const writes: Array<{ sql: string; params: unknown[]; rows: number }> = [];
      const recording: Db = {
        all: (sql, ...p) => db.all(sql, ...p),
        one: (sql, ...p) => db.one(sql, ...p),
        tx: (fn) => db.tx(fn),
        run(sql, ...p) {
          const r = db.run(sql, ...p);
          writes.push({ sql, params: p, rows: r.rowsWritten });
          return r;
        },
      };
      const svc = w.service({ db: recording });
      await w.signIn(svc, alice);
      const firstAsSession = w.as.sessions(alice.did)[0]!;
      w.seedAccount(alice.did, 'alice');
      w.seedOperation('op-1', alice.did, 'queued');
      w.seedOperation('op-2', alice.did, 'blocked');
      writes.length = 0;

      await w.signIn(svc, alice);
      expect(w.accountStatus(alice.did)).toBe('active');
      expect(w.operationStates(alice.did)).toEqual(['queued', 'queued']);
      const runnable = db.all<{ id: string }>(
        "SELECT id FROM operations WHERE did = ? AND state = 'queued' AND due_at <= ? ORDER BY id",
        alice.did,
        w.clock.nowMs(),
      );
      expect(runnable.map((r) => r.id)).toEqual(['op-1', 'op-2']);
      // Never: no statement that changed a row ever wrote reauth_required or blocked during the re-sign-in.
      const flips = writes.filter(
        (x) => x.rows > 0 && /SET (oauth_status = 'reauth_required'|state = 'blocked')/.test(x.sql),
      );
      expect(flips).toEqual([]);
      // The previous session was revoked at the AS and replaced by one new session.
      expect(firstAsSession.revoked?.source).toBe('endpoint');
      expect(w.as.sessions(alice.did).filter((s) => s.revoked === null)).toHaveLength(1);
      expect(w.sessionRows().map((r) => r.did)).toEqual([alice.did]);
      expect(w.storedSession(alice.did)?.tokenSet.access_token).toBe(w.as.sessions(alice.did)[1]?.accessToken);
      // The replacement is not a revocation of the DID's access: nothing is journaled.
      expect(w.revocations.entries()).toEqual([]);
    });
  });

  it('a PLC timeout during the binding check answers oauth_upstream, keeps the new session stored, sets no cookie and sends no revocation to the fake AS', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const svc = w.service();
      const b = w.binding();
      const params = await w.browse((await svc.authorize(alice.handle, { bindingHash: b.hash })).url);
      // The first PLC request of the callback (the library's issuer check, through our module) is answered;
      // the second (our binding check) hangs until its deadline expires.
      let plcCalls = 0;
      w.identityIntercept = (req) => {
        if (new URL(req.url).hostname !== 'plc.directory') return null;
        plcCalls += 1;
        if (plcCalls !== 2) return null;
        return new Promise<Response>((_, reject) => {
          req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
          queueMicrotask(() => w.timer.expireAll());
        });
      };
      const err = await flowError(svc.callback(params, { bindingHash: b.hash }));
      expect(plcCalls).toBe(2);
      expect(err.code).toBe('oauth_upstream');
      expect(err.status).toBe(502);
      expect(err.reason).toBe('identity_unavailable');
      expect(findCause(err, (e) => (e as { code?: string })?.code === 'timeout')).toBeDefined();
      // The new session stays stored, nothing was revoked, and no browser session exists.
      expect(w.sessionRows().map((r) => r.did)).toEqual([alice.did]);
      expect(w.as.revocations).toEqual([]);
      expect(w.as.sessions(alice.did)[0]?.revoked).toBeNull();
      expect(db.one<{ n: number }>('SELECT count(*) AS n FROM web_sessions')?.n).toBe(0);
      // The kept session is usable.
      w.identityIntercept = null;
      const session = await svc.restore(alice.did);
      expect((await w.writeScrobble(session, 1)).status).toBe(200);
    });
  });
  it('a revoke held open while the same DID signs in again keeps the new session, revokes only the old one and leaves the account active', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const { svc, hold } = gatedService(w);
      await w.signIn(svc, alice);
      w.seedAccount(alice.did, 'alice');
      w.seedOperation('op-1', alice.did, 'queued');
      const oldAs = w.as.sessions(alice.did)[0]!;

      // Sign-out reaches the AS's revocation endpoint and is held there.
      const revokeHold = hold('/oauth/revoke');
      const revoking = svc.revoke(alice.did);
      await until(() => revokeHold.reached);
      // Meanwhile the user signs in again; the new code exchange completes during the hold.
      const tokens = w.tokenSuccesses();
      const signingIn = w.signIn(svc, alice);
      await until(() => w.tokenSuccesses() === tokens + 1);
      revokeHold.release();
      const [outcome, result] = await Promise.all([revoking, signingIn]);

      expect(outcome).toBe('revoked'); // the old session was revoked
      expect(result.did).toBe(alice.did);
      // The new session survives, locally and at the AS; only the old one is revoked.
      const asSessions = w.as.sessions(alice.did);
      expect(asSessions).toHaveLength(2);
      expect(oldAs.revoked?.source).toBe('endpoint');
      const live = asSessions.filter((x) => x.revoked === null);
      expect(live).toHaveLength(1);
      expect(w.sessionRows().map((r) => r.did)).toEqual([alice.did]);
      expect(w.storedSession(alice.did)?.tokenSet.access_token).toBe(live[0]?.accessToken);
      expect(revokedSubs(w)).toEqual([alice.did]);
      // The account is active, not signed_out, and its operation runnable.
      expect(w.accountStatus(alice.did)).toBe('active');
      expect(w.operationStates(alice.did)).toEqual(['queued']);
      // The old session's deletion was a revocation and is journaled once.
      expect(w.revocations.entries()).toEqual([{ kind: 'oauth_session', did: alice.did, at: w.clock.nowMs() }]);
      // The kept session works.
      expect((await w.writeScrobble(await svc.restore(alice.did), 1)).status).toBe(200);
    });
  });

  it('a revoke that completes while a callback of the same DID is in flight defers signed_out to the callback: a completed sign-in stays active, a failed one ends signed_out', async () => {
    await withMigratedDb(async (db) => {
      const { w, alice } = await world(db);
      const { svc, hold } = gatedService(w);
      await w.signIn(svc, alice);
      w.seedAccount(alice.did, 'alice');
      w.seedOperation('op-1', alice.did, 'queued');

      // 1. The callback's token request is held; the whole revoke runs meanwhile.
      const b = w.binding();
      const params = await w.browse((await svc.authorize(alice.handle, { bindingHash: b.hash })).url);
      const tokenHold = hold('/oauth/token');
      const completing = svc.callback(params, { bindingHash: b.hash });
      await until(() => tokenHold.reached);
      expect(await svc.revoke(alice.did)).toBe('revoked');
      expect(w.sessionRows()).toEqual([]);
      // Not yet signed_out: the in-flight sign-in decides.
      expect(w.accountStatus(alice.did)).toBe('active');
      expect(w.operationStates(alice.did)).toEqual(['queued']);
      tokenHold.release();
      await completing;
      expect(w.sessionRows().map((r) => r.did)).toEqual([alice.did]);
      expect(w.accountStatus(alice.did)).toBe('active');
      expect(w.operationStates(alice.did)).toEqual(['queued']);
      expect(w.as.sessions(alice.did).filter((x) => x.revoked === null)).toHaveLength(1);

      // 2. Same, but the held token request then fails: the sign-out applies when the callback ends.
      const b2 = w.binding();
      const p2 = await w.browse((await svc.authorize(alice.handle, { bindingHash: b2.hash })).url);
      const hold2 = hold('/oauth/token');
      const failing = svc.callback(p2, { bindingHash: b2.hash });
      await until(() => hold2.reached);
      expect(await svc.revoke(alice.did)).toBe('revoked');
      expect(w.accountStatus(alice.did)).toBe('active');
      w.as.fail({ path: '/oauth/token' }, { kind: 'status', status: 503 });
      hold2.release();
      const err = await flowError(failing);
      expect(err.code).toBe('oauth_upstream');
      expect(err.status).toBe(502);
      expect(w.sessionRows()).toEqual([]);
      expect(w.accountStatus(alice.did)).toBe('signed_out');
      expect(w.operationStates(alice.did)).toEqual(['blocked']);
      expect(w.as.sessions(alice.did).filter((x) => x.revoked === null)).toHaveLength(0);
    });
  });

  it('every OAuthFlowError code and status is a v1.2 contract code of /api/v1/auth/start or /oauth/callback', () => {
    const spec = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../../api/openapi.yaml', import.meta.url).href), 'utf8'),
    ) as {
      paths: Record<string, { get?: unknown; post?: unknown }>;
    };
    const codes = new Map<string, Set<number>>();
    for (const [path, method] of [
      ['/oauth/callback', 'get'],
      ['/api/v1/auth/start', 'post'],
    ] as const) {
      const op = spec.paths[path]?.[method] as { responses: Record<string, { 'x-error-codes'?: string[] }> };
      for (const [status, r] of Object.entries(op.responses)) {
        for (const c of r['x-error-codes'] ?? []) {
          if (!codes.has(c)) codes.set(c, new Set());
          codes.get(c)!.add(Number(status));
        }
      }
    }
    expect(codes.get('oauth_binding_mismatch')).toEqual(new Set([403]));
    for (const [code, status] of Object.entries(OAUTH_ERROR_STATUS)) {
      if (code === 'oauth_denied') {
        // Not an error body: the AS's error is a 303 to /signin?error=denied.
        expect(status).toBe(303);
        continue;
      }
      if (code === 'invalid_handle' || code === 'handle_unresolved') {
        // /auth/start answers these as 422 validation_failed with fields.handle.
        expect(status).toBe(422);
        expect(codes.get('validation_failed')?.has(422)).toBe(true);
        continue;
      }
      expect([code, codes.get(code)?.has(status)]).toEqual([code, true]);
    }
  });
});

const SCROBBLE_COLLECTION = 'com.example.atmusic.scrobble';

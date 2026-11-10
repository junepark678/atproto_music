// N6-02 advisory interop: the production confidential BFF client against the
// real @atproto/dev-env OAuth provider, with every outbound hop kept in the
// local fixture transport. This proves local protocol compatibility only; it
// is not a live-gate receipt and never enables oauth PASS.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResolvedIdentity } from '@atmusic/atproto/identity/types';
import type { Transport } from '@atmusic/atproto/transport';
import type { TestPds, TestPlc } from '@atproto/dev-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ClientMetadataDocument,
  clientMetadataResponse,
  jwksResponse,
  OAUTH_JWKS_PATH,
  OAUTH_METADATA_PATH,
} from '../../../src/bff/client-metadata';
import type { OAuthKeyset } from '../../../src/bff/keyset';
import { createPolicyFetch } from '../../../src/node/policy-fetch';
import { createOwnedTestPds, createOwnedTestPlc } from '../support/dev-env-startup';
import { withMigratedDb } from '../support/node-db';
import { createWorld, freezeDate } from './oauth-world';

const CLIENT_ORIGIN = 'https://music.214510.xyz';
const PDS_HOST = 'pds1.test';
const PREFIX = 'com.example.atmusic';

afterEach(() => vi.useRealTimers());

function requestMetadata() {
  const req = {
    headers: { 'user-agent': 'atmusic-dev-env-interoperability-test' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 43123 },
  } as unknown as IncomingMessage;
  const res = {
    setHeader() {
      return this;
    },
    getHeader() {
      return undefined;
    },
  } as unknown as ServerResponse;
  return { req, res };
}

function localTransport(
  pdsPort: number,
  documents: { metadata: ClientMetadataDocument; keyset: OAuthKeyset },
): Transport {
  const fixture = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.origin === CLIENT_ORIGIN && req.method === 'GET') {
      if (url.pathname === OAUTH_METADATA_PATH) return clientMetadataResponse(documents.metadata);
      if (url.pathname === OAUTH_JWKS_PATH) return jwksResponse(documents.keyset);
    }
    if (url.hostname !== PDS_HOST || url.protocol !== 'https:') {
      throw new Error('dev-env OAuth fixture refused an unlisted destination');
    }
    const target = new URL(req.url);
    target.protocol = 'http:';
    target.hostname = '127.0.0.1';
    target.port = String(pdsPort);
    const headers = new Headers(req.headers);
    headers.set('host', PDS_HOST);
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers,
      redirect: 'manual',
      signal: req.signal,
    };
    if (req.body !== null) {
      init.body = req.body;
      init.duplex = 'half';
    }
    return fetch(new Request(target, init));
  };
  return Object.assign(fixture, { fixture: true as const });
}

async function finishProviderAuthorization(
  provider: NonNullable<TestPds['ctx']['oauthProvider']>,
  startedUrl: URL,
  device: Awaited<ReturnType<NonNullable<TestPds['ctx']['oauthProvider']>['deviceManager']['load']>>,
  handle: string,
  password: string,
) {
  const result = await provider.authorize(Object.fromEntries(startedUrl.searchParams.entries()) as never, device);
  let code: string;
  if ('redirect' in result) {
    if (!('code' in result.redirect)) throw new Error('provider denied the fixture authorization');
    code = result.redirect.code;
  } else {
    const authenticated = await provider.accountManager.authenticateAccount(
      device.deviceId,
      device.deviceMetadata,
      { username: handle, password, locale: 'en' },
      result.client.id,
    );
    code = await provider.requestManager.setAuthorized(
      result.requestUri,
      result.client,
      authenticated.account,
      device.deviceId,
      device.deviceMetadata,
    );
  }
  return new URLSearchParams({ code, state: result.parameters.state ?? '', iss: result.issuer });
}

describe('the confidential OAuth client against @atproto/dev-env', () => {
  it('exchanges a confidential grant, writes and deletes through the PDS, and observes upstream revocation', async () => {
    freezeDate();
    await withMigratedDb(async (db) => {
      const app = await createWorld(db);
      let plc: TestPlc | undefined;
      let pds: TestPds | undefined;
      const originalFetch = globalThis.fetch;
      let stage = 'PDS setup';
      try {
        plc = await createOwnedTestPlc({});
        globalThis.fetch = async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (url.origin === CLIENT_ORIGIN && request.method === 'GET') {
            if (url.pathname === OAUTH_METADATA_PATH) return clientMetadataResponse(app.published.metadata);
            if (url.pathname === OAUTH_JWKS_PATH) return jwksResponse(app.published.keyset);
          }
          if (
            url.protocol === 'http:' &&
            ['127.0.0.1', '::1', 'localhost'].includes(url.hostname) &&
            url.port.length > 0
          ) {
            return originalFetch(input, init);
          }
          throw new Error('dev-env OAuth test refused a non-fixture network request');
        };
        const devPds = await createOwnedTestPds({ didPlcUrl: plc.url, hostname: PDS_HOST });
        pds = devPds;

        const handle = 'n6-oauth.test';
        const password = 'local-n6-oauth-password';
        const account = await pds.getAgent().createAccount({
          email: 'n6-oauth@e2e.test',
          handle,
          password,
        });
        const pdsIdentity = await pds.ctx.idResolver.did.resolveAtprotoData(account.data.did, true);
        const identity: ResolvedIdentity = {
          did: pdsIdentity.did,
          pds: pdsIdentity.pds,
          signingKey: pdsIdentity.signingKey,
          handle: pdsIdentity.handle,
          fetchedAtMs: Date.now(),
        };
        const identityResolver = {
          resolveDid: async (did: string) => {
            if (did !== identity.did) throw new Error('unexpected fixture DID');
            return identity;
          },
          resolveHandle: async (value: string) => {
            if (value.toLowerCase() !== handle) throw new Error('unexpected fixture handle');
            return identity.did;
          },
        };
        // Use the production policy wrapper over an explicitly host-pinned
        // local transport. No DNS, Internet destination, or TLS exception is
        // available to this test.
        const fixtureService = app.service({
          identity: identityResolver,
          policyFetch: createPolicyFetch({
            transport: localTransport(devPds.port, app.published),
          }),
        });

        const bindingHash = new Uint8Array(32).fill(0x42);
        stage = 'client authorize';
        const started = await fixtureService.authorize(handle, { bindingHash });
        const provider = devPds.ctx.oauthProvider;
        if (!provider) throw new Error('dev-env PDS did not enable its OAuth provider');
        const deviceIo = requestMetadata();
        const device = await provider.deviceManager.load(deviceIo.req, deviceIo.res);
        stage = 'client callback';
        const callback = await fixtureService.callback(
          await finishProviderAuthorization(provider, started.url, device, handle, password),
          { bindingHash },
        );
        expect(callback.did).toBe(identity.did);

        stage = 'provider token observation';
        const issued = await provider.tokenManager.listAccountTokens(identity.did as `did:${string}:${string}`);
        expect(issued).toHaveLength(1);
        const token = issued[0]!;
        expect(token.data.clientAuth.method).toBe('private_key_jwt');
        expect(token.data.scope).toContain(`repo:${PREFIX}.scrobble`);
        expect(token.data.scope).toContain(`repo:${PREFIX}.follow`);
        expect(token.data.scope).toContain(`repo:${PREFIX}.settings`);
        expect(token.data.scope).toContain(`repo:${PREFIX}.love`);

        stage = 'session supersession';
        const secondBinding = new Uint8Array(32).fill(0x43);
        const secondStart = await fixtureService.authorize(handle, { bindingHash: secondBinding });
        const replacement = await fixtureService.callback(
          await finishProviderAuthorization(provider, secondStart.url, device, handle, password),
          { bindingHash: secondBinding },
        );
        const replacementTokens = await provider.tokenManager.listAccountTokens(
          identity.did as `did:${string}:${string}`,
        );
        expect(replacementTokens).toHaveLength(1);
        expect(replacementTokens[0]!.id).not.toBe(token.id);

        const collection = `${PREFIX}.scrobble`;
        stage = 'createRecord';
        const created = await replacement.session.fetchHandler('/xrpc/com.atproto.repo.createRecord', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            repo: identity.did,
            collection,
            record: {
              $type: collection,
              artist: 'N6 fixture artist',
              track: 'Confidential OAuth interop',
              listenedAt: '2026-01-15T11:00:00.000Z',
              createdAt: '2026-01-15T12:00:00.000Z',
            },
          }),
        });
        expect(created.status).toBe(200);
        const createdRecord = (await created.json()) as { uri: string; cid: string };
        expect(createdRecord.uri).toContain(`/${collection}/`);
        const listedAfterCreate = await pds.getAgent().com.atproto.repo.listRecords({
          repo: identity.did,
          collection,
          limit: 100,
        });
        expect(
          listedAfterCreate.data.records.some(
            (record) => record.uri === createdRecord.uri && record.value.track === 'Confidential OAuth interop',
          ),
        ).toBe(true);

        stage = 'deleteRecord';
        const deleted = await replacement.session.fetchHandler('/xrpc/com.atproto.repo.deleteRecord', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            repo: identity.did,
            collection,
            rkey: createdRecord.uri.split('/').at(-1),
            swapRecord: createdRecord.cid,
          }),
        });
        expect(deleted.status).toBe(200);
        const listedAfterDelete = await pds.getAgent().com.atproto.repo.listRecords({
          repo: identity.did,
          collection,
          limit: 100,
        });
        expect(listedAfterDelete.data.records.some((record) => record.uri === createdRecord.uri)).toBe(false);

        stage = 'upstream revoke';
        expect(await fixtureService.revoke(identity.did)).toBe('revoked');
        expect(await provider.tokenManager.listAccountTokens(identity.did as `did:${string}:${string}`)).toHaveLength(
          0,
        );
      } catch (error) {
        throw new Error(`dev-env interop failed during ${stage}`, { cause: error });
      } finally {
        // vitest runs this project sequentially; restore the process fetch even
        // when an assertion or provider operation fails.
        globalThis.fetch = originalFetch;
        await pds?.close();
        await plc?.close();
      }
    });
  }, 60_000);
});

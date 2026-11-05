import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { OAuthResponseError } from '@atproto/oauth-client-node';
import { describe, expect, it, vi } from 'vitest';
import type { OAuthService } from '../../src/bff/oauth-client';
import { createOAuthLiveObserver } from '../../src/node/oauth-live-observer';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const ISSUER = 'https://pds-b.214510.xyz';
const REFRESH = 'synthetic-refresh-token-never-in-evidence';
const SCOPE = [
  'atproto',
  'repo:dev.pythonplayer123.music.scrobble',
  'repo:dev.pythonplayer123.music.follow',
  'repo:dev.pythonplayer123.music.settings',
  'repo:dev.pythonplayer123.music.love',
].join(' ');

function observer(
  options: {
    issuer?: string;
    localSession?: boolean;
    refresh?: (tokenSet: unknown) => Promise<unknown>;
    fetchHandler?: (input: string, init?: RequestInit) => Promise<Response>;
  } = {},
) {
  const saved = {
    tokenSet: {
      sub: DID,
      iss: options.issuer ?? ISSUER,
      scope: SCOPE,
      refresh_token: REFRESH,
      token_type: 'DPoP',
    },
    authMethod: { method: 'private_key_jwt' },
  };
  const session = {
    getTokenInfo: vi.fn(async () => ({ sub: DID, iss: options.issuer ?? ISSUER, scope: SCOPE })),
    server: { refresh: options.refresh ?? vi.fn(async () => undefined) },
    fetchHandler: options.fetchHandler ?? vi.fn(async () => new Response(null, { status: 500 })),
  };
  let current: typeof saved | undefined = saved;
  let version = 1;
  const service = {
    sessionStore: {
      snapshot: vi.fn(() => ({ session: current, version })),
      has: vi.fn(() => current !== undefined && (options.localSession ?? false)),
    },
    restore: vi.fn(async () => session),
  } as unknown as OAuthService;
  return {
    instance: createOAuthLiveObserver({
      oauth: () => service,
      nowMs: () => Date.parse('2026-11-05T00:00:00.000Z'),
      prefix: 'dev.pythonplayer123.music',
      clock: fixedClock(),
      random: seededRandom(19),
    }),
    session,
    service,
    saved,
    setCurrent(next: typeof saved | undefined, nextVersion: number) {
      current = next;
      version = nextVersion;
    },
  };
}

describe('host OAuth live observer', () => {
  it('observes only safe sealed-session facts and never returns token material', async () => {
    const world = observer();
    const result = await world.instance.capture(DID);
    expect(result).toEqual({
      status: 'captured',
      tokenSub: DID,
      issuerHost: 'pds-b.214510.xyz',
      grantedScope: SCOPE,
      sealedSessionObserved: true,
      clientAuthMethod: 'private_key_jwt',
      dpopBound: true,
      refreshTokenPresent: true,
    });
    expect(JSON.stringify(result)).not.toContain(REFRESH);
    expect(world.session.getTokenInfo).toHaveBeenCalledWith(false);
    expect(world.service.restore).toHaveBeenCalledWith(DID, false);
  });

  it('rejects a non-HTTPS issuer before recording a capture', async () => {
    const world = observer({ issuer: 'http://pds-b.214510.xyz' });
    expect(await world.instance.capture(DID)).toEqual({ status: 'issuer_invalid' });
    expect(await world.instance.verifyAfterSignOut(DID)).toMatchObject({
      status: 'capture_missing_or_expired',
      localSessionAbsent: false,
      refreshRejected: false,
    });
  });

  it('proves sign-out by refreshing the captured sealed token and accepting only invalid_grant', async () => {
    let usedToken = '';
    const refresh = vi.fn(async (tokenSet: unknown) => {
      usedToken = (tokenSet as { refresh_token: string }).refresh_token;
      throw new OAuthResponseError(new Response(null, { status: 400 }), { error: 'invalid_grant' });
    });
    const world = observer({ refresh });
    expect((await world.instance.capture(DID)).status).toBe('captured');
    const latest = {
      ...world.saved,
      tokenSet: { ...world.saved.tokenSet, refresh_token: 'newly-rotated-refresh-token' },
    };
    world.setCurrent(latest, 2);
    expect(await world.instance.prepareSignOut(DID)).toEqual({
      status: 'prepared',
      refreshTokenPresent: true,
      sessionVersionStable: true,
    });
    world.setCurrent(undefined, 3);
    const result = await world.instance.verifyAfterSignOut(DID);
    expect(result).toEqual({
      status: 'revoked',
      localSessionAbsent: true,
      refreshRejected: true,
      refreshError: 'invalid_grant',
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(usedToken).toBe('newly-rotated-refresh-token');
    expect(JSON.stringify(result)).not.toContain(REFRESH);
  });

  it('restores an existing settings/self singleton after exercising CRUD', async () => {
    const collection = 'dev.pythonplayer123.music.settings';
    const original = { $type: collection, indexing: 'enabled', createdAt: '2025-01-01T00:00:00.000Z' };
    const records = new Map<string, { value: Record<string, unknown>; cid: string }>([
      [`${collection}/self`, { value: original, cid: 'original-cid' }],
    ]);
    let nextCid = 0;
    const requests: string[] = [];
    const fetchHandler = vi.fn(async (input: string, init?: RequestInit) => {
      requests.push(input);
      const url = new URL(input, 'https://pds.test');
      const method = url.pathname.split('.').at(-1);
      if (method === 'getRecord') {
        const key = `${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`;
        const current = records.get(key);
        return current
          ? Response.json({ uri: `at://${DID}/${key}`, cid: current.cid, value: current.value })
          : Response.json({ error: 'RecordNotFound' }, { status: 400 });
      }
      const body = JSON.parse(String(init?.body)) as {
        collection: string;
        rkey: string;
        record?: Record<string, unknown>;
        swapRecord?: string;
      };
      const key = `${body.collection}/${body.rkey}`;
      const current = records.get(key);
      if (method === 'createRecord') {
        if (current || !body.record) return Response.json({ error: 'RecordExists' }, { status: 400 });
        const cid = `cid-${++nextCid}`;
        records.set(key, { value: body.record, cid });
        return Response.json({ uri: `at://${DID}/${key}`, cid });
      }
      if (method === 'putRecord') {
        if (!current || current.cid !== body.swapRecord || !body.record)
          return Response.json({ error: 'InvalidSwap' }, { status: 400 });
        const cid = `cid-${++nextCid}`;
        records.set(key, { value: body.record, cid });
        return Response.json({ uri: `at://${DID}/${key}`, cid });
      }
      if (method === 'deleteRecord') {
        if (!current || current.cid !== body.swapRecord)
          return Response.json({ error: 'InvalidSwap' }, { status: 400 });
        records.delete(key);
        return Response.json({ success: true });
      }
      return Response.json({ error: 'UnknownMethod' }, { status: 404 });
    });
    const world = observer({ fetchHandler });
    expect((await world.instance.capture(DID)).status).toBe('captured');
    const result = await world.instance.exerciseCrud(DID, 'did:plc:bcdefghijklmnopqrstuvwxy');
    expect(result.status, `${JSON.stringify(result)} requests=${requests.join('|')}`).toBe('passed');
    expect(result.cleanupVerified).toBe(true);
    expect(records.get(`${collection}/self`)?.value).toEqual(original);
    expect(records.get(`${collection}/self`)?.cid).not.toBe('original-cid');
    expect(fetchHandler).toHaveBeenCalled();
  });
});

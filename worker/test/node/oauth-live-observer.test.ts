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

function observer(options: { issuer?: string; localSession?: boolean; refresh?: () => Promise<unknown> } = {}) {
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
  };
  const service = {
    sessionStore: {
      snapshot: vi.fn(() => ({ session: saved, version: 1 })),
      has: vi.fn(() => options.localSession ?? false),
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
    const refresh = vi.fn(async () => {
      throw new OAuthResponseError(new Response(null, { status: 400 }), { error: 'invalid_grant' });
    });
    const world = observer({ refresh });
    expect((await world.instance.capture(DID)).status).toBe('captured');
    const result = await world.instance.verifyAfterSignOut(DID);
    expect(result).toEqual({
      status: 'revoked',
      localSessionAbsent: true,
      refreshRejected: true,
      refreshError: 'invalid_grant',
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(REFRESH);
  });
});

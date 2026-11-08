import { describe, expect, it } from 'vitest';
import { pullWriterAvailability } from '../../src/node/pull-writer-availability';
import { ReauthRequiredError } from '../../src/outbox/pds-writer';

const base = {
  did: 'did:plc:pullsession',
  publicationEnabled: true,
  signInAllowed: true,
  prefix: 'com.example.atmusic',
  sessionStore: { has: (_did: string) => true },
  restore: async (_did: string) => ({
    getTokenInfo: async () => ({ scope: 'repo:com.example.atmusic.scrobble repo:com.example.atmusic.love' }),
  }),
};

describe('pull writer OAuth availability', () => {
  it('distinguishes absent and expired stored sessions from publication and scope holds', async () => {
    expect(await pullWriterAvailability({ ...base, sessionStore: { has: () => false } })).toEqual({
      available: false,
      reason: 'session_missing',
    });
    expect(
      await pullWriterAvailability({
        ...base,
        restore: async () => {
          throw new ReauthRequiredError();
        },
      }),
    ).toEqual({
      available: false,
      reason: 'reauth_required',
    });
    expect(await pullWriterAvailability({ ...base, publicationEnabled: false })).toEqual({
      available: false,
      reason: 'publication_disabled',
    });
    expect(
      await pullWriterAvailability({
        ...base,
        restore: async () => ({ getTokenInfo: async () => ({ scope: 'repo:com.example.atmusic.scrobble' }) }),
      }),
    ).toEqual({
      available: false,
      reason: 'scope_insufficient',
    });
    expect(
      await pullWriterAvailability({
        ...base,
        batchPublicationEnabled: true,
        restore: async () => ({
          getTokenInfo: async () => ({
            scope: 'repo:com.example.atmusic.scrobble repo:com.example.atmusic.love',
          }),
        }),
      }),
    ).toEqual({ available: false, reason: 'scope_insufficient' });
    expect(
      await pullWriterAvailability({
        ...base,
        restore: async () => {
          throw new Error('network');
        },
      }),
    ).toEqual({
      available: false,
      reason: 'session_restore_transient',
    });
  });

  it('resumes only after the stored OAuth session restores with both write scopes', async () => {
    expect(await pullWriterAvailability(base)).toEqual({ available: true });
  });
});

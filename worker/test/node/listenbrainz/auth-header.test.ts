// The /1/ Authorization header (ADR 0005 §8.2; N2-08): Token in any case and
// Bearer are accepted; the three 401s carry ListenBrainz's verbatim messages.

import { describe, expect, it } from 'vitest';
import {
  LB_AUTH_MESSAGES,
  parseAuthorization,
  unauthorized,
  validateTokenCandidate,
} from '../../../src/listenbrainz/auth-header';

const TOKEN = '7c3f9a52-1b8e-4d6a-9f02-5e4c3b2a1d0f';

async function bodyOf(res: Response): Promise<unknown> {
  expect(res.headers.get('content-type')).toBe('application/json');
  return JSON.parse(await res.text());
}

describe('Authorization header', () => {
  it('Token, token and Bearer schemes are accepted; missing, spaceless and unknown headers give the three verbatim 401 messages', async () => {
    // Accepted schemes, as a Request carries them.
    for (const [header, scheme] of [
      [`Token ${TOKEN}`, 'token'],
      [`token ${TOKEN}`, 'token'],
      [`TOKEN ${TOKEN}`, 'token'],
      [`Bearer ${TOKEN}`, 'bearer'],
      [`bearer ${TOKEN}`, 'bearer'],
    ] as const) {
      const req = new Request('http://127.0.0.1/1/submit-listens', { headers: { authorization: header } });
      expect(parseAuthorization(req.headers.get('authorization'))).toEqual({ ok: true, scheme, token: TOKEN });
    }
    // ListenBrainz takes header.split(" ")[1].
    expect(parseAuthorization(`Token ${TOKEN} trailing`)).toEqual({ ok: true, scheme: 'token', token: TOKEN });

    expect(LB_AUTH_MESSAGES).toMatchObject({
      missingHeader: 'You need to provide an Authorization header.',
      invalidHeader: 'Provided Authorization header is invalid.',
      invalidToken: 'Invalid authorization token.',
    });

    const cases: [string | null, string, string][] = [
      // Missing (or empty, which ListenBrainz's `not auth_token` also treats as missing).
      [null, 'missing_header', 'You need to provide an Authorization header.'],
      ['', 'missing_header', 'You need to provide an Authorization header.'],
      // No space at all.
      [TOKEN, 'invalid_header', 'Provided Authorization header is invalid.'],
      ['Token', 'invalid_header', 'Provided Authorization header is invalid.'],
      [`Token\t${TOKEN}`, 'invalid_header', 'Provided Authorization header is invalid.'],
      // Unknown: a scheme we do not take, an empty token, a MetaBrainz OAuth token.
      [`Basic ${TOKEN}`, 'invalid_token', 'Invalid authorization token.'],
      [`Token  ${TOKEN}`, 'invalid_token', 'Invalid authorization token.'],
      ['Bearer meba_abcdef0123456789', 'invalid_token', 'Invalid authorization token.'],
    ];
    for (const [header, failure, message] of cases) {
      const parsed = parseAuthorization(header);
      expect(parsed).toEqual({ ok: false, failure, message });
      if (parsed.ok) throw new Error('unreachable');

      const res = unauthorized(parsed.failure);
      expect(res.status).toBe(401);
      expect(await bodyOf(res)).toEqual({ code: 401, error: message });
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      // The header value is never echoed.
      expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
    }
    // A token our store does not know is the caller's lookup; it answers with the same 401.
    const res = unauthorized('invalid_token');
    expect(await bodyOf(res)).toEqual({ code: 401, error: 'Invalid authorization token.' });

    // GET /1/validate-token reads the header only when it starts with "token ", else ?token=.
    const q = (s: string) => new URLSearchParams(s);
    expect(validateTokenCandidate(`Token ${TOKEN}`, q('token=other'))).toBe(TOKEN);
    expect(validateTokenCandidate(`token ${TOKEN}`, q(''))).toBe(TOKEN);
    expect(validateTokenCandidate(`Bearer ${TOKEN}`, q('token=fromquery'))).toBe('fromquery');
    expect(validateTokenCandidate(null, q(`token=${TOKEN}`))).toBe(TOKEN);
    expect(validateTokenCandidate(null, q(''))).toBeNull();
    expect(validateTokenCandidate('Bearer x', q('token='))).toBeNull();
    expect(LB_AUTH_MESSAGES.noToken).toBe('You need to provide an Authorization token.');
  });
});

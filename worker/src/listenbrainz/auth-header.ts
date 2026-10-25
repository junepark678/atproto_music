// The /1/ Authorization header (ADR 0005 §8.2; N2-08).
//
// ListenBrainz `validate_auth_header` takes `header.split(" ")[1]` and looks
// the token up:
// - no header (or an empty one) → 401 "You need to provide an Authorization header.";
// - no space at all → 401 "Provided Authorization header is invalid.";
// - a token that is not a user's → 401 "Invalid authorization token.".
// We accept the schemes `Token` (any case; Pano sends `token`) and `Bearer`
// (any case). ListenBrainz never looks at the scheme, so a header with another
// scheme would only ever reach its token lookup; such a header is answered
// with the unknown-token message, the answer ListenBrainz gives for every
// token that is not one of its own. A MetaBrainz `meba_` OAuth token is not
// ours and is answered the same way without a lookup.
//
// This module only parses. The token lookup (SHA-256 of the token against
// `lb_tokens`, N2-09) belongs to the caller, which answers an unknown token
// with `LB_AUTH_MESSAGES.invalidToken`. Neither the header nor the token is
// ever logged or echoed.
//
// `validateTokenCandidate` is the different rule of GET /1/validate-token: the
// header counts only when it starts with `token ` (any case), else `?token=`.

import { lbError } from './errors';

export const LB_AUTH_MESSAGES = {
  missingHeader: 'You need to provide an Authorization header.',
  invalidHeader: 'Provided Authorization header is invalid.',
  invalidToken: 'Invalid authorization token.',
  /** GET /1/validate-token without any token: a 400. */
  noToken: 'You need to provide an Authorization token.',
} as const;

export const ACCEPTED_SCHEMES = ['token', 'bearer'] as const;

export type AuthHeaderFailure = 'missing_header' | 'invalid_header' | 'invalid_token';

export type AuthHeader =
  | { ok: true; scheme: (typeof ACCEPTED_SCHEMES)[number]; token: string }
  | { ok: false; failure: AuthHeaderFailure; message: string };

const MESSAGE_OF: Record<AuthHeaderFailure, string> = {
  missing_header: LB_AUTH_MESSAGES.missingHeader,
  invalid_header: LB_AUTH_MESSAGES.invalidHeader,
  invalid_token: LB_AUTH_MESSAGES.invalidToken,
};

function failure(f: AuthHeaderFailure): AuthHeader {
  return { ok: false, failure: f, message: MESSAGE_OF[f] };
}

/** Parses the Authorization header value (`Headers.get('authorization')`). */
export function parseAuthorization(value: string | null | undefined): AuthHeader {
  if (value === null || value === undefined || value === '') return failure('missing_header');
  const parts = value.split(' ');
  if (parts.length < 2) return failure('invalid_header');
  const scheme = parts[0]!.toLowerCase();
  const token = parts[1]!;
  if (scheme !== 'token' && scheme !== 'bearer') return failure('invalid_token');
  if (token === '' || token.startsWith('meba_')) return failure('invalid_token');
  return { ok: true, scheme, token };
}

/** The 401 for a failed header or token check, with the CORS set. */
export function unauthorized(f: AuthHeaderFailure, headers?: HeadersInit): Response {
  return lbError(401, MESSAGE_OF[f], headers);
}

/**
 * GET /1/validate-token's token: from a header starting with `token ` (any
 * case), else the `token` query parameter; null when neither gives one (the
 * caller's 400 `noToken`).
 */
export function validateTokenCandidate(header: string | null | undefined, query: URLSearchParams): string | null {
  const token = header?.toLowerCase().startsWith('token ') ? header.split(' ')[1]! : (query.get('token') ?? '');
  return token === '' ? null : token;
}

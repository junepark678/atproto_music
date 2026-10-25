// CSRF and the cookie guard (ADR 0005 §5.6, §13; N2-04), ported from the Rust
// oracle crates/server/src/auth/{csrf,session}.rs: exactly one Origin equal to
// PUBLIC_ORIGIN plus X-CSRF-Token = hex(HMAC-SHA256(csrfKey,
// "atmusic.csrf.v1\0" ‖ sessionToken)); no session is 401 unauthenticated,
// a CSRF failure 403 csrf_failed; /2.0 and /1/ never read the cookie.
//
// Real migrated node:sqlite database, frozen clock, seeded Random, the CSRF key
// derived by crypto/box.ts from a fixed master key. No network.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import { CSRF_LABEL, checkCsrf, checkOrigin, csrfToken } from '../../../src/bff/csrf';
import {
  isProtocolPath,
  requireSession,
  resolveRequestSession,
  type SessionGuardCtx,
  type SessionGuardResult,
  withSessionCookie,
} from '../../../src/bff/guard';
import { createWebSessions, SESSION_COOKIE, type WebSessions } from '../../../src/bff/sessions';
import { createBox } from '../../../src/crypto/box';
import type { SqliteDb } from '../../../src/node/sqlite-db';
import { withMigratedDb } from '../support/node-db';

const ORIGIN = 'https://music.example.test';
const ALICE = 'did:plc:alice';
const REQUEST_ID = 'a858325e-7dd0-4b1b-baaa-3b65af37f963';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const example = (name: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, 'api', 'examples', 'v1.2', name), 'utf8'));

function guardCtx(db: SqliteDb): { ctx: SessionGuardCtx; sessions: WebSessions; resolveCalls: () => number } {
  const clock = fixedClock();
  const sessions = createWebSessions({
    db,
    clock,
    random: seededRandom(3),
    revocations: new MemoryRevocations(clock),
  });
  let calls = 0;
  const counted: SessionGuardCtx['sessions'] = {
    resolveCookieHeader(header) {
      calls += 1;
      return sessions.resolveCookieHeader(header);
    },
  };
  const box = createBox([{ id: 'e1', key: Uint8Array.from({ length: 32 }, (_, i) => i + 1) }], seededRandom(4));
  return {
    ctx: { requestId: REQUEST_ID, sessions: counted, publicOrigin: ORIGIN, csrfKey: box.csrfKey() },
    sessions,
    resolveCalls: () => calls,
  };
}

function request(path: string, method: string, headers: [string, string][]): Request {
  const h = new Headers();
  for (const [name, value] of headers) h.append(name, value);
  return new Request(`${ORIGIN}${path}`, { method, headers: h });
}

async function expectEnvelope(result: SessionGuardResult, status: 401 | 403): Promise<void> {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const res = result.response;
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toBe('application/json');
  expect(res.headers.get('cache-control')).toBe('no-store');
  const body = (await res.json()) as { error: Record<string, unknown> };
  // The v1.2 fixture is the schema: same keys, code and message.
  expect(body).toEqual(example(status === 401 ? 'error-401.json' : 'error-403-csrf.json'));
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
}

describe('csrf', () => {
  it('the Rust matrix: no cookie 401; missing, duplicate or foreign Origin, missing or wrong X-CSRF-Token 403 csrf_failed; correct pair passes', async () => {
    // The token formula against an independently computed vector (Python
    // hmac.new(bytes(range(32)), b"atmusic.csrf.v1\x00" + token, sha256)).
    expect(CSRF_LABEL).toBe('atmusic.csrf.v1\u0000');
    expect(
      csrfToken(
        Uint8Array.from({ length: 32 }, (_, i) => i),
        '0123456789abcdef'.repeat(4),
      ),
    ).toBe('7271bf72b6110d77e298bb9f41cfd36254565988d9c5ed693414554496b539aa');

    await withMigratedDb(async (db) => {
      const { ctx, sessions } = guardCtx(db);
      const alice = sessions.create(ALICE);
      const other = sessions.create(ALICE);
      const cookie: [string, string] = ['cookie', `${SESSION_COOKIE}=${alice.token}`];
      const good = csrfToken(ctx.csrfKey, alice.token);
      const origin: [string, string] = ['origin', ORIGIN];
      const token: [string, string] = ['x-csrf-token', good];
      expect(good).toMatch(/^[0-9a-f]{64}$/);

      // 401: no cookie, an unknown cookie, a repeated cookie, the pre-__Host- name.
      const unauthenticated: [string, string][][] = [
        [origin, token],
        [['cookie', `${SESSION_COOKIE}=${'f'.repeat(64)}`], origin, token],
        [['cookie', `${SESSION_COOKIE}=${alice.token}; ${SESSION_COOKIE}=${other.token}`], origin, token],
        [['cookie', `atmusic_session=${alice.token}`], origin, token],
      ];
      for (const headers of unauthenticated) {
        const result = requireSession(request('/api/v1/scrobbles', 'POST', headers), ctx);
        await expectEnvelope(result, 401);
        expect(result.ok ? null : result.failure).toEqual({ reason: 'no_session' });
      }

      // 403 csrf_failed, with the reason for each row of the matrix.
      const forbidden: [string, [string, string][]][] = [
        ['origin_missing', [cookie, token]],
        ['origin_missing', [cookie, ['origin', ''], token]],
        ['origin_duplicate', [cookie, origin, origin, token]],
        ['origin_duplicate', [cookie, origin, ['origin', 'https://evil.example'], token]],
        ['origin_mismatch', [cookie, ['origin', 'https://evil.example'], token]],
        ['origin_mismatch', [cookie, ['origin', 'null'], token]],
        ['origin_mismatch', [cookie, ['origin', 'http://music.example.test'], token]],
        ['origin_mismatch', [cookie, ['origin', `${ORIGIN}:8443`], token]],
        ['origin_mismatch', [cookie, ['origin', `${ORIGIN}/`], token]],
        ['token_missing', [cookie, origin]],
        ['token_duplicate', [cookie, origin, token, token]],
        ['token_malformed', [cookie, origin, ['x-csrf-token', 'not-hex']]],
        ['token_malformed', [cookie, origin, ['x-csrf-token', good.slice(2)]]],
        ['token_mismatch', [cookie, origin, ['x-csrf-token', csrfToken(ctx.csrfKey, other.token)]]],
        ['token_mismatch', [cookie, origin, ['x-csrf-token', csrfToken(new Uint8Array(32), alice.token)]]],
        ['token_mismatch', [cookie, origin, ['x-csrf-token', `${good.slice(0, 63)}${good[63] === '0' ? '1' : '0'}`]]],
      ];
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const [reason, headers] of forbidden) {
          const result = requireSession(request('/api/v1/scrobbles', method, headers), ctx);
          await expectEnvelope(result, 403);
          expect(result.ok ? null : result.failure).toEqual({ reason: 'csrf', csrf: reason });
        }
      }

      // The correct pair passes for every unsafe method (hex case is not significant).
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const result = requireSession(request('/api/v1/scrobbles', method, [cookie, origin, token]), ctx);
        expect(result.ok).toBe(true);
        expect(result.ok ? result.session : null).toMatchObject({ did: ALICE, token: alice.token, renewCookie: null });
      }
      const upper = requireSession(
        request('/api/v1/account', 'PATCH', [cookie, origin, ['x-csrf-token', good.toUpperCase()]]),
        ctx,
      );
      expect(upper.ok).toBe(true);
      // The other session's own token works for it, and only for it.
      expect(
        requireSession(
          request('/api/v1/scrobbles', 'POST', [
            ['cookie', `${SESSION_COOKIE}=${other.token}`],
            origin,
            ['x-csrf-token', csrfToken(ctx.csrfKey, other.token)],
          ]),
          ctx,
        ).ok,
      ).toBe(true);

      // checkOrigin alone (auth/start): a trailing slash on the configured origin is ignored.
      expect(checkOrigin(new Headers({ origin: ORIGIN }), `${ORIGIN}/`)).toEqual({ ok: true });
      expect(
        checkCsrf(new Headers({ origin: ORIGIN, 'x-csrf-token': good }), {
          publicOrigin: ORIGIN,
          key: ctx.csrfKey,
          sessionToken: alice.token,
        }),
      ).toEqual({ ok: true });
    });
  });

  it('GET and HEAD never require CSRF, and requests under /2.0 and /1/ resolve to no session even with a valid cookie', async () => {
    await withMigratedDb(async (db) => {
      const { ctx, sessions, resolveCalls } = guardCtx(db);
      const alice = sessions.create(ALICE);
      const cookie: [string, string] = ['cookie', `${SESSION_COOKIE}=${alice.token}`];

      // Safe methods: the session with no Origin and no X-CSRF-Token, even a foreign Origin.
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const bare = requireSession(request('/api/v1/auth/session', method, [cookie]), ctx);
        expect(bare.ok ? bare.session.did : null).toBe(ALICE);
        const foreign = requireSession(
          request('/api/v1/auth/session', method, [cookie, ['origin', 'https://evil.example']]),
          ctx,
        );
        expect(foreign.ok).toBe(true);
      }
      // Without a cookie a GET is still 401; the same request as a POST is 403.
      await expectEnvelope(requireSession(request('/api/v1/auth/session', 'GET', []), ctx), 401);
      await expectEnvelope(requireSession(request('/api/v1/auth/logout', 'POST', [cookie]), ctx), 403);
      // `unsafe: true` adds the check to a GET; `unsafe: false` never removes it from a POST.
      await expectEnvelope(
        requireSession(request('/api/v1/auth/session', 'GET', [cookie]), ctx, { unsafe: true }),
        403,
      );
      await expectEnvelope(
        requireSession(request('/api/v1/auth/logout', 'POST', [cookie]), ctx, { unsafe: false }),
        403,
      );

      // Protocol paths: no session even with a valid cookie and a correct CSRF pair,
      // and the cookie is never looked up.
      const before = resolveCalls();
      const fullCsrf: [string, string][] = [
        cookie,
        ['origin', ORIGIN],
        ['x-csrf-token', csrfToken(ctx.csrfKey, alice.token)],
      ];
      const protocolPaths = [
        '/2.0',
        '/2.0/',
        '/2.0/?method=track.scrobble',
        '/1/submit-listens',
        '/1/user/alice/listens',
        '/1/validate-token',
        '/audioscrobbler/np',
      ];
      for (const path of protocolPaths) {
        expect(isProtocolPath(new URL(`${ORIGIN}${path}`).pathname)).toBe(true);
        for (const method of ['GET', 'POST']) {
          const req = request(path, method, fullCsrf);
          expect(resolveRequestSession(req, ctx)).toBeNull();
          const result = requireSession(req, ctx);
          await expectEnvelope(result, 401);
          expect(result.ok ? null : result.failure).toEqual({ reason: 'protocol_path' });
        }
      }
      expect(resolveCalls()).toBe(before);
      // Look-alikes outside those prefixes do read the cookie.
      for (const path of ['/2.0x', '/10/x', '/api/v1/2.0/']) {
        expect(isProtocolPath(new URL(`${ORIGIN}${path}`).pathname)).toBe(false);
      }
      expect(resolveRequestSession(request('/api/v1/account', 'GET', [cookie]), ctx)?.did).toBe(ALICE);
      expect(resolveCalls()).toBe(before + 1);

      // A renewal found by the guard reaches the response.
      const clock = fixedClock('2026-01-16T12:00:01Z');
      const later = createWebSessions({
        db,
        clock,
        random: seededRandom(5),
        revocations: new MemoryRevocations(clock),
      });
      const renewed = requireSession(request('/api/v1/account', 'GET', [cookie]), { ...ctx, sessions: later });
      expect(renewed.ok).toBe(true);
      if (renewed.ok) {
        const res = withSessionCookie(new Response('{}', { status: 200 }), renewed.session);
        expect(res.headers.getSetCookie()).toEqual([
          `${SESSION_COOKIE}=${alice.token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
        ]);
      }
    });
  });
});

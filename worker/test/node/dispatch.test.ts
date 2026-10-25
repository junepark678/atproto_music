// The Node dispatcher (ADR 0005 §3.1, §3.7, §3.10, §13; N2-01): methods beyond
// GET and POST, HEAD mapped to the GET route by this dispatcher only, 405 with
// Allow, the unchanged matchRoute of http/routes.ts, the request logs that never
// carry a query string, and the Audioscrobbler handshake at the root.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seededRandom } from '@atmusic/core/test-support/random';
import { afterEach, describe, expect, it } from 'vitest';
import { UUID_PATTERN } from '../../src/http/request-id';
import { matchRoute, noteLastfmMethod, ROUTES } from '../../src/http/routes';
import type { RouteDef } from '../../src/http/types';
import { createDispatcher } from '../../src/node/dispatch';
import { closeApps, DEFAULT_DIST, type LogLine, startApp } from './support/app';

const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

afterEach(async () => {
  await closeApps();
});

async function jsonOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

const INDEX = DEFAULT_DIST['index.html'] as string;

function requestLines(logs: readonly LogLine[]): LogLine[] {
  return logs.filter((l) => l.event === 'request');
}

describe('dispatch', () => {
  it('a PUT and an OPTIONS route dispatch; HEAD reaches the GET route without a body; another method on a matched path is 405 with Allow listing the registered methods plus HEAD when GET is registered', async () => {
    const calls: Array<{ route: string; method: string; body: string; params: Record<string, string> }> = [];
    const handler =
      (route: string, answer: (body: string, params: Record<string, string>) => Response): RouteDef['handler'] =>
      async (req, _ctx, params) => {
        const body = req.body === null ? '' : await req.text();
        calls.push({ route, method: req.method, body, params });
        return answer(body, params);
      };
    const routes: RouteDef[] = [
      {
        method: 'GET',
        pattern: '/api/v1/test/things/{id}',
        handler: handler('get', (_b, p) =>
          Response.json(
            { id: p.id, kind: 'thing' },
            { headers: { 'x-test': 'from-get', 'cache-control': 'no-store' } },
          ),
        ),
      },
      {
        method: 'PUT',
        pattern: '/api/v1/test/things/{id}',
        handler: handler('put', (b, p) => Response.json({ id: p.id, stored: JSON.parse(b) })),
      },
      {
        method: 'OPTIONS',
        pattern: '/api/v1/test/things/{id}',
        handler: handler('options', () => new Response(null, { status: 204, headers: { 'x-test': 'from-options' } })),
      },
      { method: 'PATCH', pattern: '/api/v1/test/patch-only', handler: handler('patch', () => Response.json({})) },
    ];
    const app = await startApp({ routes });

    const put = await app.fetch('/api/v1/test/things/a1', { method: 'PUT', body: '{"n":1}' });
    expect(put.status).toBe(200);
    expect(await jsonOf(put)).toEqual({ id: 'a1', stored: { n: 1 } });

    const options = await app.fetch('/api/v1/test/things/a1', { method: 'OPTIONS' });
    expect(options.status).toBe(204);
    expect(options.headers.get('x-test')).toBe('from-options');

    const get = await app.fetch('/api/v1/test/things/a1');
    expect(await jsonOf(get)).toEqual({ id: 'a1', kind: 'thing' });

    const head = await app.fetch('/api/v1/test/things/a1', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('x-test')).toBe('from-get');
    expect(head.headers.get('content-type')).toBe('application/json');
    expect(head.headers.get('x-request-id')).toMatch(UUID_PATTERN);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    expect(calls.map((c) => [c.route, c.method, c.body, c.params.id])).toEqual([
      ['put', 'PUT', '{"n":1}', 'a1'],
      ['options', 'OPTIONS', '', 'a1'],
      ['get', 'GET', '', 'a1'],
      // HEAD ran the GET route with a body-less GET request.
      ['get', 'GET', '', 'a1'],
    ]);

    for (const method of ['DELETE', 'POST', 'PATCH']) {
      const res = await app.fetch('/api/v1/test/things/a1', { method, body: method === 'DELETE' ? null : '{}' });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow'), method).toBe('GET, OPTIONS, PUT, HEAD');
      expect(await jsonOf(res), method).toEqual({
        error: {
          code: 'method_not_allowed',
          message: 'The method is not allowed for this resource.',
          requestId: res.headers.get('x-request-id'),
        },
      });
    }
    // Without a GET route there is no HEAD in Allow, and HEAD itself is refused.
    const getPatchOnly = await app.fetch('/api/v1/test/patch-only');
    expect(getPatchOnly.status).toBe(405);
    expect(getPatchOnly.headers.get('allow')).toBe('PATCH');
    const headPatchOnly = await app.fetch('/api/v1/test/patch-only', { method: 'HEAD' });
    expect(headPatchOnly.status).toBe(405);
    expect(headPatchOnly.headers.get('allow')).toBe('PATCH');
    expect(calls).toHaveLength(4);

    // The dispatcher itself drops the HEAD body (not only the bridge): its own answer has none.
    const dispatch = createDispatcher({
      routes,
      assets: null,
      context: (_r, info, requestId) => ({
        env: { LEXICON_PREFIX: '', NAMESPACE_OWNERSHIP_REF: '' },
        index: app.composed.core,
        requestId,
        clock: app.clock,
        cursorKey: {} as CryptoKey,
        clientIp: info.peer ?? '',
      }),
      log: { log: () => undefined },
      random: seededRandom(5),
    });
    const direct = await dispatch(new Request('https://music.example.test/api/v1/test/things/b2', { method: 'HEAD' }), {
      peer: '127.0.0.1',
    });
    expect(direct.status).toBe(200);
    expect(direct.body).toBeNull();
    expect(direct.headers.get('x-test')).toBe('from-get');
    expect(calls.at(-1)).toEqual({ route: 'get', method: 'GET', body: '', params: { id: 'b2' } });
  });

  it('http/routes.ts matchRoute still answers POST /api/v1/meta with 405 and Allow: GET, unchanged from router.ts', async () => {
    expect(matchRoute('POST', '/api/v1/meta')).toEqual({
      kind: 'method_not_allowed',
      allow: ['GET'],
      pattern: '/api/v1/meta',
    });
    // matchRoute never maps or lists HEAD: that is the Node dispatcher's alone.
    expect(matchRoute('HEAD', '/api/v1/meta')).toEqual({
      kind: 'method_not_allowed',
      allow: ['GET'],
      pattern: '/api/v1/meta',
    });
    const get = matchRoute('GET', '/api/v1/meta');
    expect(get.kind).toBe('route');
    expect(get.kind === 'route' && get.route).toBe(ROUTES.find((r) => r.pattern === '/api/v1/meta'));
    expect(matchRoute('GET', '/api/v1/nope')).toEqual({ kind: 'none' });
    // The registered methods of a path, sorted, as router.ts answered (POST /api/v1/notify is POST-only).
    expect(matchRoute('GET', '/api/v1/notify')).toMatchObject({ kind: 'method_not_allowed', allow: ['POST'] });
    // `{did}` matches one raw segment, percent-decoded once; an encoded `/` stays inside it.
    const stats = matchRoute('GET', '/api/v1/users/did%3Aplc%3Aabc/stats');
    expect(stats.kind === 'route' && stats.params).toEqual({ did: 'did:plc:abc' });

    // router.ts defines no matcher of its own any more: it re-exports this one (compose.test.ts proves the
    // bindings are identical in one bundle).
    const routerSource = readFileSync(join(WORKER_ROOT, 'src/router.ts'), 'utf8');
    expect(routerSource).not.toMatch(/function matchRoute|const ROUTES|function compileRoutes/);
    expect(routerSource).toMatch(/export \{[^}]*\bmatchRoute,[^}]*\bROUTES,[^}]*\} from '\.\/http\/routes';/s);

    // On the Node host the same path answers 405 with the dispatcher's HEAD appended.
    const app = await startApp();
    const res = await app.fetch('/api/v1/meta', { method: 'POST', body: '{}' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(((await jsonOf(res)) as { error: { code: string } }).error.code).toBe('method_not_allowed');
    const head = await app.fetch('/api/v1/meta', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
  });

  it('request log lines carry the route pattern and never a query string on any route, including /api/auth, /lastfm/authorize and /api/v1/links/lastfm/callback', async () => {
    const SECRETS = {
      token: 'tok0f3a9c1e7b2d48aa',
      apiKey: 'key7c2e9b1f04d36e5a',
      sk: 'sk19ab3e7f0c2d4856',
      sig: 'sig5d0e8c1b9a7f3e26',
      state: 'state3b8f1e0d7c9a24',
      code: 'code8e2f7a1c3d9b05',
      cb: 'cb.example.test/secret-callback-path',
      password: 'pw4c1e9b7a2d0f83',
    };
    const lastfm: RouteDef['handler'] = async (req) => {
      if (req.method === 'POST') {
        const form = new URLSearchParams(await req.text());
        noteLastfmMethod(req, form.get('method') ?? '');
      }
      return new Response('<lfm status="ok"/>', { headers: { 'content-type': 'text/xml; charset=utf-8' } });
    };
    const routes: RouteDef[] = [
      {
        method: 'GET',
        pattern: '/api/auth',
        handler: async (req) =>
          new Response(null, { status: 302, headers: { location: `/lastfm/authorize${new URL(req.url).search}` } }),
      },
      { method: 'GET', pattern: '/api/v1/links/lastfm/callback', handler: async () => Response.json({ linked: true }) },
      { method: 'GET', pattern: '/oauth/callback', handler: async () => new Response(null, { status: 303 }) },
      { method: 'GET', pattern: '/2.0', handler: lastfm },
      { method: 'GET', pattern: '/2.0/', handler: lastfm },
      { method: 'POST', pattern: '/2.0/', handler: lastfm },
      { method: 'GET', pattern: '/1/user/{user}/listens', handler: async () => Response.json({ payload: {} }) },
    ];
    const app = await startApp({ routes });

    const q = (o: Record<string, string>) => `?${new URLSearchParams(o).toString()}`;
    const sent: Array<[method: string, path: string, route: string, status: number, lastfmMethod?: string]> = [];
    const send = async (method: string, path: string, route: string, init: RequestInit = {}, lastfmMethod?: string) => {
      const res = await app.fetch(path, { method, ...init });
      await res.arrayBuffer();
      sent.push([method, path, route, res.status, lastfmMethod]);
    };
    await send('GET', `/api/auth${q({ api_key: SECRETS.apiKey, cb: `https://${SECRETS.cb}` })}`, '/api/auth');
    await send('GET', `/lastfm/authorize${q({ api_key: SECRETS.apiKey, token: SECRETS.token })}`, '(asset_miss)');
    await send(
      'GET',
      `/api/v1/links/lastfm/callback${q({ token: SECRETS.token, state: SECRETS.state })}`,
      '/api/v1/links/lastfm/callback',
    );
    await send(
      'GET',
      `/oauth/callback${q({ code: SECRETS.code, state: SECRETS.state, iss: 'https://as.test' })}`,
      '/oauth/callback',
    );
    await send(
      'GET',
      `/2.0/${q({ method: 'auth.getSession', token: SECRETS.token, api_key: SECRETS.apiKey, api_sig: SECRETS.sig })}`,
      '/2.0/',
      {},
      'auth.getSession',
    );
    await send(
      'GET',
      `/2.0${q({ method: 'user.getrecenttracks', user: 'alice', api_key: SECRETS.apiKey })}`,
      '/2.0',
      {},
      'user.getRecentTracks',
    );
    await send(
      'GET',
      `/2.0/${q({ method: `evil.${SECRETS.sk}`, api_key: SECRETS.apiKey })}`,
      '/2.0/',
      {},
      '(unlisted)',
    );
    await send(
      'POST',
      '/2.0/',
      '/2.0/',
      {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ method: 'track.scrobble', sk: SECRETS.sk, api_sig: SECRETS.sig }).toString(),
      },
      'track.scrobble',
    );
    await send(
      'POST',
      `/2.0/${q({ password: SECRETS.password })}`,
      '/2.0/',
      {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ method: 'auth.getMobileSession', password: SECRETS.password }).toString(),
      },
      'auth.getMobileSession',
    );
    await send('GET', `/1/user/alice/listens${q({ token: SECRETS.token })}`, '/1/user/{user}/listens');
    await send('GET', `/api/v1/meta${q({ sk: SECRETS.sk })}`, '/api/v1/meta');
    await send('GET', `/api/v1/nope${q({ token: SECRETS.token })}`, '(not_found)');
    await send('GET', `/internal/admin/status${q({ token: SECRETS.token })}`, '(internal)');
    await send('GET', `/assets/app.js${q({ v: SECRETS.token })}`, '(static)');
    await send('GET', `/feed${q({ token: SECRETS.token })}`, '(asset_miss)');
    await send('DELETE', `/api/v1/meta${q({ sk: SECRETS.sk })}`, '/api/v1/meta');

    const lines = requestLines(app.log.logs);
    expect(lines.map((l) => [l.method, l.route, l.status, l.lastfmMethod])).toEqual(
      sent.map(([method, , route, status, lastfmMethod]) => [method, route, status, lastfmMethod]),
    );
    expect(sent.map((s) => s[3])).toEqual([
      302, 404, 200, 303, 200, 200, 200, 200, 200, 200, 200, 404, 404, 200, 200, 405,
    ]);
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(
        [
          'durationMs',
          'event',
          'level',
          'method',
          'requestId',
          'route',
          'status',
          ...(line.lastfmMethod ? ['lastfmMethod'] : []),
        ].sort(),
      );
      expect(line.level).toBe('info');
      expect(line.requestId).toMatch(UUID_PATTERN);
      expect(typeof line.durationMs).toBe('number');
    }
    // No query string, no parameter value, no unrouted path reaches any log line.
    const everything = app.log.lines.join('\n');
    for (const value of Object.values(SECRETS)) expect(everything).not.toContain(value);
    for (const fragment of [
      '?',
      'api_key',
      'api_sig',
      'token=',
      'state=',
      '/lastfm/authorize',
      '/feed',
      '/api/v1/nope',
      '/internal/',
    ]) {
      expect(everything).not.toContain(fragment);
    }
  });

  it('GET /?hs=true reaches the router while GET / serves index.html', async () => {
    const handshakes: string[] = [];
    const FAILED = 'FAILED Protocol 1.2 is not supported; use the Last.fm 2.0 or ListenBrainz API\n';
    const app = await startApp({
      routes: [
        {
          method: 'GET',
          pattern: '/',
          handler: async (req) => {
            handshakes.push(new URL(req.url).searchParams.get('hs') ?? '');
            return new Response(FAILED, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
          },
        },
      ],
    });

    const handshake = await app.fetch('/?hs=true&p=1.2.1&c=tst&v=1.0&u=alice&t=1&a=x');
    expect(handshake.status).toBe(200);
    expect(await handshake.text()).toBe(FAILED);
    expect(handshakes).toEqual(['true']);

    for (const path of ['/', '/?hs=false', '/?other=1']) {
      const root = await app.fetch(path);
      expect(root.status, path).toBe(200);
      expect(root.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(await root.text(), path).toBe(INDEX);
    }
    expect(handshakes).toEqual(['true']);
    expect(requestLines(app.log.logs).map((l) => l.route)).toEqual(['/', '(static)', '(static)', '(static)']);
    await app.close();

    // Without a root route the handshake is still the router's: the JSON 404, never index.html.
    const bare = await startApp();
    const res = await bare.fetch('/?hs=true');
    expect(res.status).toBe(404);
    expect(await jsonOf(res)).toEqual({
      error: {
        code: 'not_found',
        message: 'The resource is absent or inactive.',
        requestId: res.headers.get('x-request-id'),
      },
    });
    expect(await (await bare.fetch('/')).text()).toBe(INDEX);
  });
});

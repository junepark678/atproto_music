import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { LocalCookieJar } from '../e2e/scrobbler-clients/cookie-jar.ts';

const PUBLIC_ORIGIN = 'https://music.214510.xyz';
let server: Server | undefined;
let seen: IncomingMessage[] = [];

async function startServer(): Promise<string> {
  seen = [];
  server = createServer((request, response) => {
    seen.push(request);
    if (request.url === '/auth/start') {
      response.writeHead(302, {
        location: '/oauth/callback?code=temporary-code',
        'set-cookie': [
          '__Host-atmusic_session=session-value; Path=/; Secure; HttpOnly; SameSite=Lax',
          '__Host-atmusic_oauth=oauth-value; Path=/; Secure; HttpOnly; SameSite=Lax',
        ],
      });
      response.end();
    } else if (request.url === '/clear') {
      response.writeHead(204, {
        'set-cookie': '__Host-atmusic_session=; Path=/; Secure; Max-Age=0',
      });
      response.end();
    } else if (request.url === '/bad-cookie') {
      response.writeHead(200, {
        'set-cookie': '__Host-atmusic_session=credential-secret; Domain=evil.example; Path=/; Secure',
      });
      response.end('ok');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ host: request.headers.host, cookie: request.headers.cookie ?? null }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
});

test('stores host-only session cookies and sends them only to the pinned app Host', async () => {
  const jar = new LocalCookieJar({ publicOrigin: PUBLIC_ORIGIN, transportOrigin: await startServer() });
  const auth = await jar.request('/auth/start');
  expect(auth.status).toBe(302);
  expect(auth.headers.get('location')).toBe('/oauth/callback?code=temporary-code');
  expect(auth.headers.get('set-cookie')).toBeNull();

  const result = await jar.request('/api/v1/auth/session', { headers: { origin: PUBLIC_ORIGIN } });
  expect(await result.json()).toEqual({
    host: 'music.214510.xyz',
    cookie: '__Host-atmusic_session=session-value; __Host-atmusic_oauth=oauth-value',
  });
  expect(seen[1]?.headers.origin).toBe(PUBLIC_ORIGIN);
});

test('does not follow redirects and expires a session cookie on Max-Age=0', async () => {
  const jar = new LocalCookieJar({ publicOrigin: PUBLIC_ORIGIN, transportOrigin: await startServer() });
  await jar.request('/auth/start');
  const clear = await jar.request('/clear');
  expect(clear.status).toBe(204);
  const result = await jar.request('/after-clear');
  expect(await result.json()).toEqual({ host: 'music.214510.xyz', cookie: '__Host-atmusic_oauth=oauth-value' });
});

test('rejects cross-origin paths, unsafe destinations and invalid __Host cookies with fixed errors', async () => {
  const transportOrigin = await startServer();
  const jar = new LocalCookieJar({ publicOrigin: PUBLIC_ORIGIN, transportOrigin });
  await expect(jar.request('https://evil.example/steal')).rejects.toThrow('scrobbler e2e app request failed');
  expect(seen).toHaveLength(0);

  await expect(jar.request('/bad-cookie')).rejects.toThrow('scrobbler e2e app request failed');
  expect(JSON.stringify(seen.map((request) => request.headers))).not.toContain('credential-secret');

  expect(
    () => new LocalCookieJar({ publicOrigin: PUBLIC_ORIGIN, transportOrigin: 'https://secret.example/token' }),
  ).toThrow('scrobbler e2e app request failed');
});

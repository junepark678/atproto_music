import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWebScrobbler } from '../e2e/scrobbler-clients/web-scrobbler';

interface Captured {
  method: string;
  path: string;
  body: string;
  authorization: string;
  contentType: string;
}

let server: Server | null = null;

async function listen(captured: Captured[]): Promise<string> {
  server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      captured.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: request.headers.authorization ?? '',
        contentType: request.headers['content-type'] ?? '',
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server !== null) await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
  server = null;
});

describe('Web Scrobbler ListenBrainz replay client', () => {
  it('preserves the captured now-playing request and submits a mixed batch with one ignored artist', async () => {
    const requests: Captured[] = [];
    const origin = await listen(requests);
    const result = await runWebScrobbler({
      origin,
      token: 'WEB-SCROBBLER-TOKEN-SECRET',
      listenedAtSeconds: 1_768_478_100,
    });

    expect(result.nowPlaying).toEqual({ status: 'ok' });
    expect(result.batch).toEqual({ status: 'ok' });
    expect(result.ignoredArtist).toHaveLength(257);
    expect(
      requests.map(({ method, path, authorization, contentType }) => [method, path, authorization, contentType]),
    ).toEqual([
      ['POST', '/1/submit-listens', 'Token WEB-SCROBBLER-TOKEN-SECRET', 'application/json; charset=utf-8'],
      ['POST', '/1/submit-listens', 'Token WEB-SCROBBLER-TOKEN-SECRET', 'application/json; charset=utf-8'],
    ]);
    const capturedNowPlaying = readFileSync(
      resolve('worker/test/node/listenbrainz/fixtures/web-scrobbler-playing-now.body'),
      'utf8',
    );
    expect(JSON.parse(requests[0]!.body)).toEqual(JSON.parse(capturedNowPlaying));
    expect(JSON.parse(requests[1]!.body)).toEqual({
      listen_type: 'import',
      payload: [
        {
          listened_at: 1_768_478_100,
          track_metadata: expect.objectContaining({ artist_name: 'Sigur Rós', track_name: 'Hoppípolla' }),
        },
        {
          listened_at: 1_768_478_070,
          track_metadata: expect.objectContaining({ artist_name: 'A'.repeat(257), track_name: 'Too Long Artist' }),
        },
        {
          listened_at: 1_768_478_040,
          track_metadata: expect.objectContaining({ artist_name: 'Sigur Rós', track_name: 'Starálfur' }),
        },
      ],
    });
    expect(requests.some((request) => request.body.includes('WEB-SCROBBLER-TOKEN-SECRET'))).toBe(false);
  });

  it('does not reflect malformed upstream bodies or transport error text', async () => {
    const secret = 'WEB-SCROBBLER-RESPONSE-SECRET';
    const options = {
      origin: 'http://127.0.0.1:1',
      token: secret,
      listenedAtSeconds: 1_768_478_100,
      fetchImpl: async () => new Response(`not-json ${secret}`, { status: 200 }),
    } as const;
    await expect(runWebScrobbler(options)).rejects.toThrow('Web Scrobbler ListenBrainz returned invalid JSON');
    await expect(
      runWebScrobbler({
        ...options,
        fetchImpl: async () => {
          throw new Error(`transport echoed ${secret}`);
        },
      }),
    ).rejects.toThrow('Web Scrobbler ListenBrainz transport failed');
    await expect(runWebScrobbler(options)).rejects.not.toThrow(secret);
  });
});

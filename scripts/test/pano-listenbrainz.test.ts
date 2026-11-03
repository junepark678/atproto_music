import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPanoListenBrainz } from '../e2e/scrobbler-clients/pano-listenbrainz';

interface Captured {
  method: string;
  path: string;
  body: string;
  authorization: string;
  contentType: string;
}

let server: Server | null = null;

async function listen(handler: (request: IncomingMessage, body: string) => void): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      handler(request, body);
      const listenType = (JSON.parse(body) as { listen_type: string }).listen_type;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          listenType === 'playing_now' ? { status: 'ok', recording_msid: 'e2e-recording-msid' } : { status: 'ok' },
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject);
    server?.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server !== null) await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

describe('Pano ListenBrainz replay client', () => {
  it('uses lowercase token auth, return_msid and exact Pano 4.10 single-listen fixture bytes', async () => {
    const requests: Captured[] = [];
    const origin = await listen((request, body) => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        body,
        authorization: request.headers.authorization ?? '',
        contentType: request.headers['content-type'] ?? '',
      });
    });

    const result = await runPanoListenBrainz({
      origin,
      token: 'PANO-TOKEN-SECRET',
      listenedAtSeconds: 1_768_478_100,
      artist: 'Radiohead',
      track: 'Paranoid Android',
      release: 'OK Computer',
      releaseArtist: 'Radiohead',
      durationMs: 383_000,
    });

    expect(result.nowPlaying).toEqual({ status: 'ok', recording_msid: 'e2e-recording-msid' });
    expect(result.single).toEqual({ status: 'ok' });
    expect(
      requests.map(({ method, path, authorization }) => [
        method,
        new URL(path, origin).pathname,
        new URL(path, origin).search,
        authorization,
      ]),
    ).toEqual([
      ['POST', '/1/submit-listens', '?return_msid=1', 'token PANO-TOKEN-SECRET'],
      ['POST', '/1/submit-listens', '', 'token PANO-TOKEN-SECRET'],
    ]);
    expect(requests.map((request) => request.contentType)).toEqual(['application/json', 'application/json']);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      listen_type: 'playing_now',
      payload: [
        {
          track_metadata: {
            artist_name: 'Radiohead',
            release_name: 'OK Computer',
            track_name: 'Paranoid Android',
            additional_info: {
              duration_ms: 383_000,
              release_artist_name: 'Radiohead',
              submission_client: 'Pano Scrobbler',
              submission_client_version: '4.10',
            },
          },
        },
      ],
    });
    const capture = readFileSync(resolve('worker/test/node/listenbrainz/fixtures/pano-single.body'), 'utf8');
    expect(requests[1]!.body).toBe(capture);
    expect(requests[0]!.body).not.toContain('PANO-TOKEN-SECRET');
    expect(requests[1]!.body).not.toContain('PANO-TOKEN-SECRET');
  });
  it('does not reflect malformed upstream bodies or transport error text', async () => {
    const secret = 'PANO-LB-RESPONSE-SECRET';
    const options = {
      origin: 'http://127.0.0.1:1',
      token: secret,
      listenedAtSeconds: 1_768_478_100,
      artist: 'Radiohead',
      track: 'Paranoid Android',
      release: 'OK Computer',
      releaseArtist: 'Radiohead',
      durationMs: 383_000,
      fetchImpl: async () => new Response(`not-json ${secret}`, { status: 200 }),
    } as const;
    await expect(runPanoListenBrainz(options)).rejects.toThrow('Pano ListenBrainz playing_now returned invalid JSON');
    await expect(
      runPanoListenBrainz({
        ...options,
        fetchImpl: async () => {
          throw new Error(`transport echoed ${secret}`);
        },
      }),
    ).rejects.toThrow('Pano ListenBrainz playing_now transport failed');
    await expect(runPanoListenBrainz(options)).rejects.not.toThrow(secret);
  });
});

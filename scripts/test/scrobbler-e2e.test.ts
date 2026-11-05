import { spawn } from 'node:child_process';
import { expect, test, vi } from 'vitest';
import type { LocalCookieJar } from '../e2e/scrobbler-clients/cookie-jar';
import { replayAppJson, replayAppRequest } from '../e2e/scrobbler-clients/replay';
import { terminateChild } from '../e2e/scrobbler-e2e';

function jarReturning(response: Response): LocalCookieJar {
  return { request: vi.fn(async () => response) } as unknown as LocalCookieJar;
}

test('app replay sends JSON with the public Origin and CSRF token and parses the response', async () => {
  const request = vi.fn(async () => new Response('{"id":"op-1"}', { status: 201 }));
  const jar = { request } as unknown as LocalCookieJar;
  const reply = await replayAppJson(
    jar,
    '/api/v1/example',
    { value: 1 },
    {
      csrfToken: 'csrf-secret',
      publicOrigin: 'https://music.214510.xyz',
    },
  );

  expect(reply).toEqual({ status: 201, body: { id: 'op-1' } });
  expect(request).toHaveBeenCalledWith(
    '/api/v1/example',
    expect.objectContaining({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://music.214510.xyz',
        'x-csrf-token': 'csrf-secret',
      },
      body: '{"value":1}',
    }),
  );
});

test('app replay rejects unexpected status without copying a response body into the error', async () => {
  await expect(
    replayAppRequest(jarReturning(new Response('synthetic-session-secret', { status: 503 })), '/api'),
  ).rejects.toThrow('scrobbler e2e app protocol failed');
});

test('app replay rejects malformed JSON without exposing response text', async () => {
  await expect(replayAppRequest(jarReturning(new Response('synthetic-callback-code')), '/api')).rejects.toThrow(
    'scrobbler e2e app returned invalid JSON',
  );
});

test('owned child termination sends a bounded kill fallback and waits for process exit', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  await new Promise<void>((resolveReady, reject) => {
    child.once('message', resolveReady);
    child.once('error', reject);
  });
  await terminateChild(child, 25);
  expect(child.signalCode).toBe('SIGKILL');
});

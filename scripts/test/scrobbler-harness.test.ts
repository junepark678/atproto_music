import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { startFakeUpstreams } from '../e2e/fake-upstreams.ts';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function forwardTo(target: URL, incoming: IncomingMessage, outgoing: ServerResponse): void {
  const upstream = httpRequest(
    {
      hostname: target.hostname,
      port: Number(target.port),
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`child process timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function childDone(child: ChildProcess): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolveDone) => {
    child.once('exit', (code) => resolveDone({ code, stderr }));
  });
}

test('the pinned Last.fm client waits for parent-side app approval and reports no credentials', async () => {
  const fakes = await startFakeUpstreams();
  const target = new URL(fakes.lastfmOrigin);
  const proxy: Server = createServer((incoming, outgoing) => forwardTo(target, incoming, outgoing));
  let clientChild: ChildProcess | null = null;
  try {
    proxy.listen(0, '127.2.0.1');
    await once(proxy, 'listening');
    const port = (proxy.address() as AddressInfo).port;
    const preload = resolve(REPO, 'scripts/e2e/scrobbler-clients/https-to-loopback.mjs');
    const client = resolve(REPO, 'scripts/e2e/scrobbler-clients/lastfm-ts-api-client.ts');
    const child = spawn(process.execPath, ['--import', preload, client], {
      cwd: REPO,
      env: {
        ...process.env,
        ATMUSIC_E2E_SCROBBLER_PORT: String(port),
        ATMUSIC_E2E_LASTFM_API_KEY: 'e2e-lastfm-api-key',
        ATMUSIC_E2E_LASTFM_SHARED_SECRET: 'e2e-lastfm-api-secret',
        ATMUSIC_E2E_LASTFM_USER: 'e2e-lastfm-user',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    clientChild = child;
    let childStdout = '';
    let childStderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      childStdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      childStderr += chunk;
    });
    const done = childDone(child);
    const result = new Promise<unknown>((resolveResult, reject) => {
      child.on('message', (raw: unknown) => {
        const message = raw as {
          type?: unknown;
          id?: unknown;
          action?: unknown;
          apiKey?: unknown;
          token?: unknown;
          result?: unknown;
          error?: unknown;
        };
        if (
          message.type === 'command' &&
          message.action === 'approveLastfmToken' &&
          typeof message.id === 'number' &&
          message.apiKey === 'e2e-lastfm-api-key' &&
          typeof message.token === 'string'
        ) {
          void fakes
            .authorizeLastfmToken(message.token, 'e2e-lastfm-user')
            .then(() => child.send?.({ type: 'answer', id: message.id, result: true }))
            .catch(reject);
        } else if (message.type === 'command' && message.action === 'pumpJetstream' && typeof message.id === 'number') {
          // This isolated client test verifies the HTTP protocol against the
          // fake Last.fm child; indexing is covered by the integrated journey.
          child.send?.({ type: 'answer', id: message.id, result: true });
        } else if (message.type === 'answer' && message.id === 0) resolveResult(message.result);
        else if (message.type === 'error') reject(new Error(String(message.error)));
      });
      child.once('error', reject);
    });
    const [clientResult, exit] = await Promise.all([
      withTimeout(result, 15_000).catch((error: unknown) => {
        throw new Error(`${String(error)}; child stdout=${childStdout}; child stderr=${childStderr}`);
      }),
      done,
    ]);
    expect(exit.code, exit.stderr).toBe(0);
    expect(clientResult).toMatchObject({
      sessionEstablished: true,
      scrobbleBatchSize: 2,
      recentTrackNames: expect.arrayContaining(['First Track', 'Second Track']),
    });
    expect(JSON.stringify(clientResult)).not.toContain('e2e-lastfm-api-secret');
    expect(JSON.stringify(clientResult)).not.toContain('e2e-lastfm-api-key');
    const snapshot = await fakes.snapshot();
    expect(snapshot.lastfm).toMatchObject({
      scrobbles: [
        { user: 'e2e-lastfm-user', indexed: true, items: [{ track: 'First Track' }, { track: 'Second Track' }] },
      ],
      nowPlaying: [{ user: 'e2e-lastfm-user', artist: 'E2E Artist', track: 'Now Playing' }],
    });
  } finally {
    if (clientChild !== null && clientChild.exitCode === null && clientChild.signalCode === null) {
      const exited = once(clientChild, 'exit');
      clientChild.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolveExit) => setTimeout(resolveExit, 1_000))]);
      if (clientChild.exitCode === null && clientChild.signalCode === null) {
        const killed = once(clientChild, 'exit');
        clientChild.kill('SIGKILL');
        await killed;
      }
    }
    await closeServer(proxy);
    await fakes.close();
  }
}, 30_000);

test('the HTTPS preload rejects every non-public hostname before opening a connection', async () => {
  const preload = resolve(REPO, 'scripts/e2e/scrobbler-clients/https-to-loopback.mjs');
  const code = `import https from 'node:https'; https.request({ hostname: 'attacker.example', path: '/' });`;
  const child = spawn(process.execPath, ['--import', preload, '--input-type=module', '-e', code], {
    cwd: REPO,
    env: { ...process.env, ATMUSIC_E2E_SCROBBLER_PORT: '30000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = await childDone(child);
  expect(exit.code).not.toBe(0);
  expect(exit.stderr).toContain('refused hostname attacker.example');
});

test('the HTTPS preload preserves the request method, path, Host header, and body bytes', async () => {
  const preload = resolve(REPO, 'scripts/e2e/scrobbler-clients/https-to-loopback.mjs');
  const body = 'artist=Å+Band&track=Path%20Test';
  let receivedResolve!: (value: { method: string; url: string; host: string | undefined; body: string }) => void;
  const received = new Promise<{ method: string; url: string; host: string | undefined; body: string }>(
    (resolveReceived) => {
      receivedResolve = resolveReceived;
    },
  );
  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    incoming.on('end', () => {
      receivedResolve({
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        host: incoming.headers.host,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      outgoing.writeHead(204);
      outgoing.end();
    });
  });
  try {
    server.listen(0, '127.2.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const code = [
      "import https from 'node:https';",
      `const body = ${JSON.stringify(body)};`,
      "const request = https.request({ hostname: 'music.214510.xyz', path: '/2.0/?method=track.scrobble&track=Path%20Test', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (response) => { response.resume(); response.on('end', () => process.exitCode = response.statusCode === 204 ? 0 : 1); });",
      'request.end(body);',
    ].join('\n');
    const child = spawn(process.execPath, ['--import', preload, '--input-type=module', '-e', code], {
      cwd: REPO,
      env: { ...process.env, ATMUSIC_E2E_SCROBBLER_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = await childDone(child);
    const observed = await withTimeout(received, 3_000);
    expect(exit.code, exit.stderr).toBe(0);
    expect(observed).toEqual({
      method: 'POST',
      url: '/2.0/?method=track.scrobble&track=Path%20Test',
      host: 'music.214510.xyz',
      body,
    });
  } finally {
    await closeServer(server);
  }
}, 10_000);

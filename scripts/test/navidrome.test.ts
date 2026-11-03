import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { submitNavidromeListen } from '../e2e/scrobbler-clients/navidrome.ts';

const CAPTURE = fileURLToPath(
  new URL('../../worker/test/node/listenbrainz/fixtures/navidrome-single.body', import.meta.url),
);

type SeenRequest = {
  method: string | undefined;
  path: string | undefined;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
};

async function readRequest(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function startServer(
  handle: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void | Promise<void>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    void readRequest(request).then((body) => handle(request, response, body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}/1/` };
}

test('Navidrome posts the captured ListenBrainz request bytes to its /1/ base', async () => {
  let resolveSeen!: (request: SeenRequest) => void;
  const seen = new Promise<SeenRequest>((resolve) => {
    resolveSeen = resolve;
  });
  const { server, baseUrl } = await startServer(async (request, response, body) => {
    resolveSeen({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      body,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"status":"ok"}');
  });

  try {
    const outcome = await submitNavidromeListen(baseUrl, 'navidrome-test-token');
    const request = await seen;
    const capture = await readFile(CAPTURE);

    expect(outcome).toBe('acknowledged');
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/1/submit-listens');
    expect(request.authorization).toBe('Token navidrome-test-token');
    expect(request.contentType).toBe('application/json; charset=UTF-8');
    expect(request.body.equals(capture)).toBe(true);
  } finally {
    await closeServer(server);
  }
});

test('Navidrome rejects bases that do not already end in /1/ without sending a request', async () => {
  let requests = 0;
  const { server, baseUrl } = await startServer((_request, response) => {
    requests += 1;
    response.writeHead(200);
    response.end();
  });

  try {
    expect(await submitNavidromeListen(new URL('/', baseUrl).href, 'token')).toBe('invalid_base_url');
    expect(await submitNavidromeListen(baseUrl.slice(0, -1), 'token')).toBe('invalid_base_url');
    expect(requests).toBe(0);
  } finally {
    await closeServer(server);
  }
});

test('upstream and transport failures return allowlisted outcomes without reflecting secret text', async () => {
  const token = 'never-return-this-token';
  const { server, baseUrl } = await startServer((_request, response) => {
    response.writeHead(503, { 'Content-Type': 'text/plain' });
    response.end(`upstream failure mentioned ${token}`);
  });

  try {
    const outcome = await submitNavidromeListen(baseUrl, token);
    expect(outcome).toBe('unavailable');
    expect(['acknowledged', 'unauthorized', 'rate_limited', 'unavailable', 'rejected', 'transport_error']).toContain(
      outcome,
    );
    expect(JSON.stringify(outcome)).not.toContain(token);
  } finally {
    await closeServer(server);
  }

  const broken = await startServer((_request, response) => {
    response.destroy();
  });
  try {
    const outcome = await submitNavidromeListen(broken.baseUrl, token);
    expect(outcome).toBe('transport_error');
    expect(JSON.stringify(outcome)).not.toContain(token);
  } finally {
    await closeServer(broken.server);
  }
});

test.each([
  ['invalid JSON', 'not-json', 200],
  ['error status', '{"status":"error"}', 200],
  ['empty success', '', 200],
  ['no-content success', '', 204],
])('Navidrome treats %s as no valid protocol acknowledgement', async (_label, body, status) => {
  const { server, baseUrl } = await startServer((_request, response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(body);
  });

  try {
    expect(await submitNavidromeListen(baseUrl, 'navidrome-token')).toBe('rejected');
  } finally {
    await closeServer(server);
  }
});

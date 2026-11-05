import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { WebSocketServer } from 'ws';
import type { LinkEvent } from '../../src/do/ingest/jetstream-socket';
import { createLoopbackJetstreamConnector } from '../../test/e2e/loopback-jetstream';

let server: Server | undefined;
let socketServer: WebSocketServer | undefined;

afterEach(async () => {
  for (const socket of socketServer?.clients ?? []) socket.terminate();
  if (socketServer) {
    await new Promise<void>((resolve) => socketServer!.close(() => resolve()));
    socketServer = undefined;
  }
  if (server) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }
});

test('rewrites only the configured test Jetstream host to the explicit local WebSocket listener', async () => {
  server = createServer();
  socketServer = new WebSocketServer({ server, path: '/xrpc/network.bsky.jetstream.subscribe' });
  const requests: string[] = [];
  socketServer.on('connection', (socket, request) => {
    requests.push(request.url ?? '');
    socket.send('{"op":"commit"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const connector = createLoopbackJetstreamConnector(`ws://127.0.0.1:${port}`, ['wss://jetstream.test']);

  const link = await connector('https://jetstream.test/xrpc/network.bsky.jetstream.subscribe?cursor=41');
  const received = new Promise<string>((resolve) =>
    link.start((event: LinkEvent) => event.type === 'message' && resolve(String(event.data))),
  );
  await expect(received).resolves.toBe('{"op":"commit"}');
  expect(requests).toEqual(['/xrpc/network.bsky.jetstream.subscribe?cursor=41']);
  link.close();
});

test('refuses a different Jetstream authority and rejects non-loopback targets before dialing', async () => {
  const connector = createLoopbackJetstreamConnector('ws://127.0.0.1:1', ['wss://jetstream.test']);
  await expect(connector('https://outside.example/xrpc/network.bsky.jetstream.subscribe')).rejects.toThrow(
    'jetstream connect refused',
  );
  expect(() => createLoopbackJetstreamConnector('ws://outside.example:1234', ['wss://jetstream.test'])).toThrow(
    'test Jetstream target was refused',
  );
});

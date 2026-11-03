// TEST ONLY. Packaged recovery host: identical production run()/features,
// fixture upstream transport over IPC, manual lanes, frozen clock. No public
// test routes, env-controlled production bypass, or imports into main.ts.
import { FakeJetstream, memoryLink } from '@atmusic/atproto/test-support/fake-jetstream';
import type { CommitResult } from '@atmusic/atproto/test-support/signed-repo';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { JetstreamConnectError } from '../../src/do/ingest/jetstream-socket';
import { type RunningServer, run } from '../../src/node/run';
import { manualTimers } from '../node/support/app';
import { createLoopbackJetstreamConnector } from './loopback-jetstream';

if (!process.send) throw new Error('fixture host requires IPC');
const send = (value: unknown) => process.send?.(value);
const clock = fixedClock(new Date(Number(process.env.ATMUSIC_TEST_NOW_MS)).toISOString());
Date.now = () => clock.nowMs();
const jetstream = new FakeJetstream({ clock });
const testJetstreamOrigin = process.env.ATMUSIC_TEST_JETSTREAM_WS;
const configuredJetstreamUrls = (process.env.JETSTREAM_URLS ?? '')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url !== '');
const connectJetstream =
  testJetstreamOrigin === undefined
    ? memoryLink(jetstream, { connectError: (s, e, m) => new JetstreamConnectError(s, e, m) })
    : createLoopbackJetstreamConnector(testJetstreamOrigin, configuredJetstreamUrls);
const initialCommits = process.env.ATMUSIC_TEST_JETSTREAM_COMMITS;
if (initialCommits) {
  const commits = JSON.parse(Buffer.from(initialCommits, 'base64').toString('utf8')) as CommitResult[];
  for (const commit of commits) jetstream.appendCommit(commit);
}
let nextId = 0;
const pending = new Map<number, (response: Response) => void>();
const transport = Object.assign(
  async (request: Request): Promise<Response> => {
    const id = ++nextId;
    const response = new Promise<Response>((resolve) => pending.set(id, resolve));
    send({
      type: 'request',
      id,
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: request.body === null ? null : Buffer.from(await request.arrayBuffer()).toString('base64'),
    });
    return response;
  },
  { fixture: true as const },
);
let server: RunningServer;
process.on('message', async (raw) => {
  const m = raw as {
    type: string;
    id: number;
    status: number;
    headers: [string, string][];
    body: string | null;
    action: string;
    advance?: number;
    commits?: CommitResult[];
  };
  if (m.type === 'response') {
    pending.get(m.id)?.(
      new Response(m.body === null ? null : Buffer.from(m.body, 'base64'), {
        status: m.status,
        headers: m.headers,
      }),
    );
    pending.delete(m.id);
    return;
  }
  if (m.type !== 'command') return;
  try {
    let result: unknown = null;
    if (m.action === 'pump') {
      clock.advance(m.advance ?? 0);
      await server.app.core.alarm();
      await new Promise<void>((r) => setImmediate(r));
      await server.app.core.extensionAlarm();
      await new Promise<void>((r) => setImmediate(r));
    } else if (m.action === 'events') {
      result = (m.commits ?? []).flatMap((commit) => jetstream.appendCommit(commit));
    } else if (m.action === 'disconnectJetstream') {
      const connections = jetstream.live();
      for (const connection of connections) connection.close(1011, 'fixture disconnect');
      await new Promise<void>((resolve) => setImmediate(resolve));
      result = connections.length;
    } else if (m.action === 'inspect') {
      result = Object.fromEntries(
        [
          'operations',
          'scrobbles',
          'follows',
          'record_state',
          'ingest_checkpoint',
          'operation_deps',
          'listen_keys',
          'hints',
          'users',
          'repo_jobs',
        ].map((table) => [table, server.db.all(`SELECT * FROM ${table} ORDER BY rowid`)]),
      );
    } else throw new Error(`unknown action ${m.action}`);
    send({ type: 'answer', id: m.id, result });
  } catch (error) {
    send({ type: 'answer', id: m.id, error: String(error) });
  }
});
const code = await run({
  argv: process.argv,
  env: process.env,
  clock,
  timers: manualTimers(),
  configOptions: { fixtureOrigins: true, allowFixturePrefix: true },
  transport,
  connectJetstream,
  onReady: (s: RunningServer) => {
    server = s;
    send({ type: 'ready', authority: s.address.authority });
  },
});
process.exit(code);

import { expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { fixtureToken } from '../../packages/atproto/test-support/fake-pds';
import type { CommitResult } from '../../packages/atproto/test-support/signed-repo';
import { startFakeUpstreams } from '../e2e/fake-upstreams';
import { FIXTURE_WRITER_DID } from '../e2e/fixture-world';

const commit = (did: string, rkey: string): CommitResult =>
  ({
    did,
    rev: `rev-${rkey}`,
    cid: `cid-${rkey}`,
    data: `data-${rkey}`,
    since: null,
    ops: [
      {
        action: 'create',
        collection: 'test.atmusic.e2e.scrobble',
        rkey,
        path: `test.atmusic.e2e.scrobble/${rkey}`,
        prev: null,
        record: { artist: 'Fixture', track: rkey },
        cid: `cid-${rkey}`,
      },
    ],
    blocks: new Map(),
    car: new Uint8Array(),
  }) as unknown as CommitResult;

function nextMessage(socket: WebSocket, timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Jetstream event timed out')), timeoutMs);
    socket.once('message', (data) => {
      clearTimeout(timeout);
      resolve(data.toString());
    });
  });
}

test('identity, scrobbler and Jetstream fake children start and clean up', async () => {
  const fakes = await startFakeUpstreams();
  const origins = [fakes.identityOrigin, fakes.jetstreamUrl, fakes.lastfmOrigin, fakes.listenBrainzOrigin];
  try {
    expect(fakes.accounts.map(({ name }) => name)).toEqual(['alice', 'bob', 'carol']);
    for (const origin of origins) expect(new URL(origin).port).not.toBe('');
  } finally {
    await fakes.close();
  }
  for (const origin of origins) {
    const url = new URL(origin);
    await expect(
      fetch(`${url.protocol === 'ws:' ? 'http:' : url.protocol}//127.0.0.1:${url.port}`, {
        signal: AbortSignal.timeout(250),
      }),
    ).rejects.toBeTruthy();
  }
});

test('identity child routes by Host and exposes seeded account records and actual commits', async () => {
  const fakes = await startFakeUpstreams();
  try {
    const bob = fakes.accounts.find(({ name }) => name === 'bob')!;
    const as = await fakes.route(new Request('https://as.test/.well-known/oauth-authorization-server'));
    expect(as.status).toBe(200);
    expect(await as.json()).toMatchObject({ issuer: 'https://as.test' });

    const seed = await fakes.listRecords(bob.did, 'test.atmusic.e2e.scrobble');
    expect(seed).toHaveLength(1);
    expect(seed[0]?.value).toMatchObject({ artist: 'Kate Bush', track: 'Running Up That Hill' });

    const write = await fakes.route(
      new Request('https://pds1.test/xrpc/com.atproto.repo.createRecord', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fixtureToken(FIXTURE_WRITER_DID)}` },
        body: JSON.stringify({
          repo: FIXTURE_WRITER_DID,
          collection: 'test.atmusic.e2e.scrobble',
          rkey: 'process-write',
          record: { $type: 'test.atmusic.e2e.scrobble', artist: 'Process', track: 'Commit' },
        }),
      }),
    );
    expect(write.status).toBe(200);
    const commits = fakes.drainCommits();
    expect(commits).toHaveLength(1);
    expect(commits[0]?.did).toBe(FIXTURE_WRITER_DID);
    const jetstreamEvents = await fakes.appendCommits([commits[0]!.commit]);
    expect(jetstreamEvents).toHaveLength(1);
  } finally {
    await fakes.close();
  }
});

test('Jetstream child accepts commits and replays them through its WebSocket endpoint', async () => {
  const fakes = await startFakeUpstreams();
  let socket: WebSocket | null = null;
  try {
    const alice = fakes.accounts.find(({ name }) => name === 'alice')!;
    const committed = commit(alice.did, 'first');
    await fakes.appendCommits([committed]);
    const endpoint = new URL('/xrpc/network.bsky.jetstream.subscribeEvents?cursor=1&kinds=commit', fakes.jetstreamUrl);
    socket = new WebSocket(endpoint);
    // Register before open: the child can send the cursor replay as soon as
    // the server accepts the socket, before the client's open handler runs.
    const replayMessage = nextMessage(socket);
    const opened = new Promise<void>((resolve, reject) => {
      socket!.once('open', resolve);
      socket!.once('error', reject);
    });
    await opened;
    const replay = JSON.parse(await replayMessage) as {
      did: string;
      seq: number;
      kind: string;
      commit: { rkey: string };
    };
    expect(replay).toMatchObject({ did: alice.did, seq: 1, kind: 'commit', commit: { rkey: 'first' } });

    // The child broadcasts synchronously while handling appendCommits, before
    // it sends the IPC acknowledgement. Subscribe before sending the command.
    const liveMessage = nextMessage(socket);
    await fakes.appendCommits([commit(alice.did, 'live')]);
    const live = JSON.parse(await liveMessage) as { seq: number; commit: { rkey: string } };
    expect(live).toMatchObject({ seq: 2, commit: { rkey: 'live' } });
  } finally {
    socket?.close();
    await fakes.close();
  }
});

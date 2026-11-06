// Current Node BFF → outbox → DPoP fixture PDS → verified drain → public feed.
// In-process integration evidence, deliberately not browser/live acceptance.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeWorlds, SCROBBLE, startWorld, T0 } from './world';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(async () => {
  await closeWorlds();
  vi.useRealTimers();
});

it('queued and published-but-unverified follows are excluded from following feed; verified follow includes Bob and global feed never changes', async () => {
  const { w, alice, bob } = await startWorld();
  const owner = await w.signIn(alice);
  const subject = await w.signIn(bob, { current: false });
  const posted = await w.send('POST', '/api/v1/scrobbles', {
    as: subject,
    body: { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:58:00Z' },
    headers: { 'idempotency-key': 'follow-feed-bob' },
  });
  expect(posted.status).toBe(202);
  await w.until(() => w.count('scrobbles', 'did = ?', bob.did) === 1);
  const remote = await bob.repo.list(SCROBBLE);
  expect(remote).toHaveLength(1);
  const uri = `at://${bob.did}/${SCROBBLE}/${remote[0]!.rkey}`;
  const feed = async (scope: 'global' | 'following') => {
    const res = await w.send('GET', `/api/v1/feed?scope=${scope}&viewer=${alice.did}`);
    expect(res.status).toBe(200);
    expect(checkResponse('GET', '/api/v1/feed', res)).toBe('valid');
    return (res.body as { items: Array<{ uri: string; cid: string; did: string }> }).items;
  };
  const global = await feed('global');
  expect(global.map((r) => r.uri)).toEqual([uri]);
  expect(await feed('following')).toEqual([]);
  const path = `/api/v1/follows/${bob.did}`;
  const self = await w.send('PUT', `/api/v1/follows/${alice.did}`, { as: owner });
  expect(self.status).toBe(422);
  const enqueue = async (method: 'PUT' | 'DELETE') => {
    const res = await w.send(method, path, { as: owner });
    expect(res.status).toBe(202);
    expect(checkResponse(method, '/api/v1/follows/{did}', res)).toBe('valid');
    return (res.body as { operation: { id: string; state: string } }).operation;
  };
  const queued = await enqueue('PUT');
  expect(queued.state).toBe('queued');
  expect((await enqueue('PUT')).id).toBe(queued.id);
  expect(w.count('follows')).toBe(0);
  expect(await feed('following')).toEqual([]);
  expect(await feed('global')).toEqual(global);

  // Only the extension lane: the remote write is acknowledged, but no proof
  // has run. A succeeded Operation is not an indexed edge.
  await w.pump({ core: false });
  const status = await w.send('GET', `/api/v1/operations/${queued.id}`, { as: owner });
  expect(status.body).toMatchObject({ id: queued.id, state: 'succeeded', attempts: 1 });
  expect(w.count('follows')).toBe(0);
  expect(await feed('following')).toEqual([]);
  expect(await feed('global')).toEqual(global);

  const proofCalls = w.pds.calls.count({ nsid: 'com.atproto.sync.getRecord', status: 200 });
  await w.until(() => w.count('follows', 'actor = ? AND subject = ?', alice.did, bob.did) === 1);
  expect(w.pds.calls.count({ nsid: 'com.atproto.sync.getRecord', status: 200 })).toBeGreaterThan(proofCalls);
  expect(await feed('following')).toEqual(global);
  expect((await enqueue('PUT')).id).toBe(queued.id);
  expect(w.count('operations', "kind = 'follow.put'")).toBe(1);

  // A different client can remove a confirmed edge. The old succeeded
  // receipt must not suppress a new intent after that contrary proof.
  w.advance(1_000);
  const followCollection = 'org.example.music.follow';
  const [onPds] = await alice.repo.list(followCollection);
  const externalDelete = await alice.repo.delete(followCollection, onPds!.rkey);
  w.jetstream.appendCommit(externalDelete);
  await w.until(() => w.count('follows', 'actor = ? AND subject = ?', alice.did, bob.did) === 0);
  expect(await feed('following')).toEqual([]);
  const restored = await enqueue('PUT');
  expect(restored.id).not.toBe(queued.id);
  await w.until(() => w.count('follows', 'actor = ? AND subject = ?', alice.did, bob.did) === 1);
  expect(await feed('following')).toEqual(global);

  const deleted = await enqueue('DELETE');
  expect(deleted.id).not.toBe(queued.id);
  expect((await enqueue('DELETE')).id).toBe(deleted.id);
  await w.until(() => w.count('follows', 'actor = ? AND subject = ?', alice.did, bob.did) === 0);
  expect(await feed('following')).toEqual([]);
  expect(await feed('global')).toEqual(global);
  w.advance(1_000);
  const externalFollow = await alice.repo.put(followCollection, 'other-client-follow', {
    $type: followCollection,
    subject: bob.did,
    createdAt: new Date(w.clock.nowMs()).toISOString(),
  });
  w.jetstream.appendCommit(externalFollow);
  await w.until(() => w.count('follows', 'actor = ? AND subject = ?', alice.did, bob.did) === 1);
  const removeExternal = await enqueue('DELETE');
  expect(removeExternal.id).not.toBe(deleted.id);
  await w.until(() => w.count('follows', 'actor = ? AND subject = ?', alice.did, bob.did) === 0);
  expect(await feed('following')).toEqual([]);
  expect(await feed('global')).toEqual(global);
}, 60_000);

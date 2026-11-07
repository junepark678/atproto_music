// The actual authenticated POST /1/delete-listen route and a removal that
// holds an unknown send (Astra de5abe1 F5; listenbrainz/token-routes.ts).
// The listen is the owner's own record created outside this app (no local
// create receipt). Its web removal commits, the answer is lost and the
// record is recreated: the removal holds. A delete-listen before the
// recreation is verified repeats that intent (absorbed); once a projection
// newer than its send fence is verified, the same request is a fresh intent,
// admitted and written once. Ordinary pending/failed removal overlays and an
// inactive owner still hide the listen. Every call goes through the route
// handler with a locally issued token (token guard, limiter, body checks,
// MSID matching, publication gate).

import { recordingMsid } from '@atmusic/core/msid';
import { expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { OperationRow } from '../../../src/app/rows';
import { ensureAccount } from '../../../src/credentials/accounts';
import { createLbToken } from '../../../src/credentials/lb-tokens';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { createTokenRoutes } from '../../../src/listenbrainz/token-routes';
import { enqueueBatchListenDelete } from '../../../src/outbox/batch-delete-ops';
import { enqueueScrobbleDelete } from '../../../src/outbox/delete-ops';
import { proofAt } from '../../write/support';
import { DELETE, type Harness, PUT, remoteRecords, SCROBBLE, T0, withHarness } from './support';

const PREFIX = 'com.example.atmusic';
const BATCH = `${PREFIX}.scrobbleBatch`;
const RKEY = '3lb2lbextern2';
const X = '3lb2batchidab';
const Y = '3lb2batchidac';
const Z = '3lb2batchidad';
const OPTIONS = { receiptNs: BigInt(T0) * 1_000_000n, nowNs: BigInt(T0) * 1_000_000n, prefix: PREFIX };
const LISTEN = { artist: 'External Artist', listenedAt: '2026-01-14T12:00:00Z', createdAt: '2026-01-15T12:00:00Z' };

type Kind = 'partial' | 'whole' | 'single';
const collectionOf = (kind: Kind) => (kind === 'single' ? SCROBBLE : BATCH);
const recordOf = (kind: Kind) =>
  kind === 'single'
    ? { $type: SCROBBLE, ...LISTEN, track: 'External X' }
    : {
        $type: BATCH,
        createdAt: LISTEN.createdAt,
        listens: [
          { id: X, ...LISTEN, track: 'External X' },
          { id: Y, ...LISTEN, track: 'External Y' },
          { id: Z, ...LISTEN, track: 'External Z' },
        ],
      };
const apply = (h: Harness, p: Awaited<ReturnType<typeof proofAt>>) =>
  h.db.tx(() => applyRecordProof(h.db, p, OPTIONS)).outcome;
const deletes = (h: Harness) => h.ops("kind = 'scrobble.delete'");
const writes = (h: Harness, from = 0) => h.writers.sent.slice(from).filter((r) => r.method === 'POST');

/** A route caller for the owner, with a real locally issued token. */
async function lbDelete(h: Harness) {
  const credentials = { ...h.m, revocations: new MemoryRevocations(h.m.clock) };
  ensureAccount(credentials, { did: h.alice, verifiedHandle: 'alice.test' });
  const token = createLbToken(credentials, { did: h.alice });
  const route = createTokenRoutes().find((r) => r.method === 'POST' && r.pattern === '/1/delete-listen')!;
  const body = {
    listened_at: Date.parse(LISTEN.listenedAt) / 1000,
    recording_msid: await recordingMsid(LISTEN.artist, 'External X'),
  };
  return async (auth = true) => {
    const response = await route.handler(
      new Request('https://app.test/1/delete-listen', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Token ${token.token}` } : {}) },
        body: JSON.stringify(body),
      }),
      { deps: h.m, clock: h.m.clock, clientIp: '127.0.0.1', requestId: 'test', index: {}, env: {} } as never,
      {},
    );
    return { status: response.status, body: (await response.json()) as unknown };
  };
}

/** The verified external record, its web removal committed with a lost answer, then recreated: it holds. */
async function held(h: Harness, kind: Kind): Promise<{ removal: OperationRow; fence: string }> {
  h.seedUser(h.alice);
  const collection = collectionOf(kind);
  await h.kit.externalPut('Alice', collection, RKEY, recordOf(kind));
  expect(apply(h, await proofAt(h.kit.repos.Alice, collection, RKEY))).toBe('applied');
  const uri = `at://${h.alice}/${collection}/${RKEY}`;
  const removal =
    kind === 'single'
      ? enqueueScrobbleDelete(h.m, { did: h.alice, uri, origin: 'web' })
      : enqueueBatchListenDelete(h.m, {
          did: h.alice,
          uri,
          listenIds: kind === 'whole' ? ['*'] : [X, Y],
          origin: 'web',
        });
  const writerFor = h.writers.writerFor.bind(h.writers);
  let once = false;
  h.writers.writerFor = async (did: string) => {
    const writer = await writerFor(did);
    if (writer === null) return null;
    return {
      ...writer,
      fetchHandler: async (path: string, init?: RequestInit) => {
        if (!once && path.includes(`/xrpc/${kind === 'partial' ? PUT : DELETE}`)) {
          once = true;
          await writer.fetchHandler(path, init);
          await h.kit.externalPut('Alice', collection, RKEY, recordOf(kind));
          throw new TypeError('connection reset after the server committed');
        }
        return writer.fetchHandler(path, init);
      },
    };
  };
  await h.runUntilIdle(10);
  // (A single delete returns its transport failure first; its next attempt
  // reads the moved head and holds.)
  const due = h.op(removal.id).due_at;
  if (due > h.kit.clock.nowMs()) h.kit.clock.advance(due - h.kit.clock.nowMs());
  await h.runUntilIdle(10);
  expect(h.op(removal.id)).toMatchObject({ state: 'queued', last_error: 'removal_send_uncertain' });
  expect(h.ops("kind = 'scrobble.create'")).toEqual([]);
  return { removal, fence: h.op(removal.id).removal_head_rev! };
}

it.each(['partial', 'whole', 'single'] as const)(
  '%s external record: the real route absorbs a repeat, then admits a fresh delete once R is verified newer than the fence',
  async (kind) => {
    await withHarness(async (h) => {
      const { removal, fence } = await held(h, kind);
      const call = await lbDelete(h);
      expect((await call(false)).status).toBe(401);
      // R not verified yet: the projection is at or below the fence. A repeat.
      expect(await call()).toEqual({ status: 200, body: { status: 'ok' } });
      expect(deletes(h)).toHaveLength(1);
      const r = await proofAt(h.kit.repos.Alice, collectionOf(kind), RKEY);
      expect(r.commit.rev > fence).toBe(true);
      expect(apply(h, r)).toBe('applied');
      // Provably newer: a fresh intent, admitted without waiting behind the held one.
      expect(await call()).toEqual({ status: 200, body: { status: 'ok' } });
      const fresh = deletes(h).find((d) => d.id !== removal.id)!;
      expect(fresh).toMatchObject({ origin: 'listenbrainz', state: 'queued' });
      expect(h.db.all('SELECT pred_id FROM operation_deps WHERE op_id = ?', fresh.id)).toEqual([]);
      // It names only the listen, so it covers the held single, not X+Y or the whole container.
      expect(h.op(removal.id).state).toBe(kind === 'single' ? 'cancelled' : 'queued');
      // A repeat now meets the fresh ordinary intent's overlay: absorbed.
      expect(await call()).toEqual({ status: 200, body: { status: 'ok' } });
      expect(deletes(h)).toHaveLength(2);
      const mark = h.writers.sent.length;
      await h.runUntilIdle(10);
      expect(writes(h, mark)).toHaveLength(1);
      expect(writes(h, mark)[0]!.body?.swapCommit).toBe(r.commit.cid);
      expect(h.op(fresh.id).state).toBe('succeeded');
      const remote = (await remoteRecords(h.kit, 'Alice', collectionOf(kind))).find((x) => x.rkey === RKEY);
      if (kind === 'single') expect(remote).toBeUndefined();
      else expect((remote!.value as { listens: Array<{ id: string }> }).listens.map((l) => l.id)).toEqual([Y, Z]);
    });
  },
);

it.each(['failed', 'inactive'] as const)(
  'a %s overlay still hides the newer projection from the real route',
  async (mode) => {
    await withHarness(async (h) => {
      const { removal } = await held(h, 'partial');
      expect(apply(h, await proofAt(h.kit.repos.Alice, BATCH, RKEY))).toBe('applied');
      if (mode === 'failed') {
        // An ordinary failed removal of the listen is still a public overlay.
        const failed = enqueueBatchListenDelete(h.m, {
          did: h.alice,
          uri: `at://${h.alice}/${BATCH}/${RKEY}`,
          listenIds: [X],
          origin: 'web',
        });
        h.db.run("UPDATE operations SET state = 'failed', last_error = 'upstream_unavailable' WHERE id = ?", failed.id);
      } else {
        h.db.run('UPDATE users SET active = 0 WHERE did = ?', h.alice);
      }
      const before = deletes(h).length;
      const call = await lbDelete(h);
      expect(await call()).toEqual({ status: 200, body: { status: 'ok' } });
      expect(deletes(h)).toHaveLength(before);
      expect(h.op(removal.id).state).toBe('queued');
    });
  },
);

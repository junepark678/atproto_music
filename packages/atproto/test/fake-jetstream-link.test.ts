// N1-04 (ADR 0005 §3.4): memoryLink(), the in-memory JetstreamLink connector
// of the fake Jetstream, under environment node (no workerd WebSocketPair).
// Its links carry the read-model fixture's commit events exactly as the fake
// logged and framed them, buffered until start(), and its refusals carry the
// status and XRPC error name the ingest socket's cursor handling needs.

import { buildSubscribeUrl } from '@atmusic/atproto/jetstream/events';
import {
  encodeEvent,
  MemoryLinkConnectError,
  type MemoryLinkEvent,
  memoryLink,
} from '@atmusic/atproto/test-support/fake-jetstream';
import { createFixtureKit, seedReadModels } from '@atmusic/atproto/test-support/read-models';
import { expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/read_models.json' with { type: 'json' };

/** Let queued microtasks and socket events run (no clock involved). */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

it('memoryLink delivers the read-model commit events in order under environment node', async () => {
  // Under environment node: no workerd socket pair exists on this host.
  expect((globalThis as { WebSocketPair?: unknown }).WebSocketPair).toBeUndefined();

  const kit = await createFixtureKit();
  const seeded = await seedReadModels(kit);
  const js = kit.jetstream;
  const collections = [kit.collections.scrobble, kit.collections.follow, kit.collections.settings];
  expect(seeded.events.length).toBeGreaterThan(fixture.scrobbles.length);
  const firstSeq = seeded.events[0]!.seq;

  const connect = memoryLink(js);
  const url = buildSubscribeUrl(`wss://${js.host}`, collections, firstSeq);
  const link = await connect(url);
  expect(link.url).toBe(url);
  expect(js.calls.count({ status: 101 })).toBe(1);
  expect(js.live()).toHaveLength(1);
  expect(js.live()[0]!.cursor).toBe(firstSeq);

  // The replay was sent at the handshake and dispatched while nobody listened:
  // start() hands the whole buffer over synchronously, in seq order.
  await flush();
  const got: MemoryLinkEvent[] = [];
  link.start((e) => got.push(e));
  expect(got).toEqual(seeded.events.map((e) => ({ type: 'message', data: encodeEvent(e) })));
  expect(() => link.start(() => {})).toThrow('already started');

  // The frames are the fixture's commits: strictly increasing seq, every
  // scrobble rkey of tests/fixtures/read_models.json, and each create carrying
  // the CID the PDS answered when the record was written.
  const frames = got.map(
    (e) =>
      JSON.parse((e as { data: string }).data) as {
        did: string;
        seq: number;
        commit: { operation: string; collection: string; rkey: string; cid?: string };
      },
  );
  for (let i = 1; i < frames.length; i++) expect(frames[i]!.seq).toBeGreaterThan(frames[i - 1]!.seq);
  const scrobbleRkeys = new Set(
    frames.filter((f) => f.commit.collection === kit.collections.scrobble).map((f) => f.commit.rkey),
  );
  expect([...scrobbleRkeys].sort()).toEqual(fixture.scrobbles.map((s) => s.rkey).sort());
  for (const f of frames) {
    if (f.commit.operation !== 'create') continue;
    const seededRecord = seeded.records.get(`at://${f.did}/${f.commit.collection}/${f.commit.rkey}`);
    expect(seededRecord?.cid).toBe(f.commit.cid);
  }
  const deleted = [...seeded.records.values()].filter((r) => r.state === 'deleted');
  expect(deleted.length).toBeGreaterThan(0);
  for (const r of deleted) {
    expect(frames.filter((f) => f.commit.rkey === r.rkey).map((f) => f.commit.operation)).toEqual(['create', 'delete']);
  }

  // Live events follow the replay on the started link, in order.
  const live = await kit.externalPut('Carol', kit.collections.scrobble, 'live1', {
    $type: kit.collections.scrobble,
    artist: 'Live',
    track: 'Tail',
    listenedAt: '2026-01-15T11:59:00Z',
    createdAt: '2026-01-15T11:59:00Z',
  });
  await flush();
  expect(got).toHaveLength(seeded.events.length + 1);
  const tail = JSON.parse((got.at(-1) as { data: string }).data) as {
    seq: number;
    commit: { rkey: string; cid: string };
  };
  expect(tail.seq).toBe(js.events.at(-1)!.seq);
  expect(tail.commit).toMatchObject({ rkey: 'live1', cid: live.ops[0]!.cid });

  // close(1000) reaches the fake's server end; its echo closes the link.
  link.close(1000);
  await flush();
  expect(js.connections[0]!.closeCode).toBe(1000);
  expect(js.live()).toHaveLength(0);
  expect(got.at(-1)).toEqual({ type: 'close', code: 1000, reason: 'client closed' });

  // A cursor whose events aged out of the lookback is refused before any
  // socket: status 400, XRPC error OutdatedCursor, cursorRejected.
  kit.clock.advance(25 * 3_600_000);
  const refused = await connect(buildSubscribeUrl(`wss://${js.host}`, collections, firstSeq)).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(MemoryLinkConnectError);
  expect(refused).toMatchObject({ status: 400, error: 'OutdatedCursor', cursorRejected: true });
  expect(js.connections).toHaveLength(1);
  expect(js.calls.count({ status: 400 })).toBe(1);

  // An unknown host is a DNS-like failure that reaches no fake; a custom
  // error factory (the worker passes JetstreamConnectError) is honoured.
  class HostError extends Error {
    constructor(
      readonly status: number | null,
      readonly error: string | null,
      message: string,
    ) {
      super(message);
    }
  }
  const viaFactory = memoryLink([js], { connectError: (s, e, m) => new HostError(s, e, m) });
  const unknown = await viaFactory(buildSubscribeUrl('wss://elsewhere.example.test', collections)).catch(
    (e: unknown) => e,
  );
  expect(unknown).toBeInstanceOf(HostError);
  expect(unknown).toMatchObject({ status: null, error: null });
  expect(js.calls.count()).toBe(2);
});

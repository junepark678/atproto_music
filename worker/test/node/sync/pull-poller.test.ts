import { describe, expect, it } from 'vitest';
import { createBox, linkedAad } from '../../../src/crypto/box';
import { runLinkedLastfmPull } from '../../../src/sync/pull-poller';
import type { PullWriterAvailability } from '../../../src/sync/pull-writer';
import { remoteRecords, SCROBBLE, T0, withHarness } from '../outbox/support';
import { FakeLastfm, type LastfmListen, type LastfmLoved } from '../support/fake-lastfm';

const API_KEY = 'pull-api-key';
const SHARED_SECRET = 'pull-shared-secret';
const SESSION_KEY = 'pull-session-key';

async function setup(h: Parameters<Parameters<typeof withHarness>[0]>[0]) {
  const did = h.alice;
  h.account(did);
  const linkId = h.link(did, 'lastfm');
  const box = createBox([{ id: 'e1', key: new Uint8Array(32).fill(19) }], h.m.random);
  const sealed = box.seal('linked-lastfm', SESSION_KEY, linkedAad(did, 'lastfm'));
  h.db.run(
    "UPDATE linked_accounts SET remote_user='remote',credential_ciphertext=?,key_id='e1' WHERE id=?",
    sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer,
    linkId,
  );
  const now = h.m.clock.nowMs();
  h.db.run(
    `INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,
      listen_floor_at_ms,love_floor_at_ms,love_boundary_ms,poll_next_at_ms,poll_phase,updated_at_ms)
     VALUES(?,1,'lastfm','remote',?,?,?,?,?,'listen',?)`,
    linkId,
    now - 3_600_000,
    now - 86_400_000,
    now - 86_400_000,
    now - 86_400_000,
    now,
    now,
  );
  const remote = new FakeLastfm({ clock: h.kit.clock, apiKey: API_KEY, secret: SHARED_SECRET });
  remote.addUser('remote');
  remote.addSession('remote', SESSION_KEY);
  const fetch = async (url: string | URL | Request, init?: RequestInit) =>
    remote.fetch(url instanceof Request ? url : new Request(url, init));
  const writerAvailability = async (): Promise<PullWriterAvailability> => ({
    available: false,
    reason: 'session_missing',
  });
  const deps = () => ({
    moduleDeps: h.m,
    db: h.db,
    clock: h.m.clock,
    random: h.m.random,
    box,
    fetch,
    apiRoot: 'https://lastfm.test/2.0/',
    apiKey: API_KEY,
    sharedSecret: SHARED_SECRET,
    intervalMs: 600_000,
    pacer: { take: () => null, holdUntil: () => undefined },
    writerAvailability,
  });
  return { did, linkId, box, remote, deps };
}

describe('linked Last.fm timer poller', () => {
  it('pins multi-page recent and loved rounds across restart, skips now-playing, and commits only completed boundaries', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      const nowSeconds = Math.floor(h.m.clock.nowMs() / 1000);
      const listens: LastfmListen[] = Array.from({ length: 201 }, (_, i) => ({
        artist: 'Recent Artist',
        track: `Track ${i}`,
        uts: nowSeconds - 1 - i * 5,
      }));
      const loves: LastfmLoved[] = Array.from({ length: 201 }, (_, i) => ({
        artist: 'Loved Artist',
        track: `Loved ${i}`,
        uts: nowSeconds - i,
      }));
      remote.seedHistory('remote', listens);
      remote.seedLoved('remote', loves);
      remote.setNowPlaying('remote', { artist: 'Playing', track: 'Skip me' });

      const first = await runLinkedLastfmPull(deps());
      expect(first).toMatchObject({ requested: 1, staged: 200 });
      expect(remote.calls.entries.at(-1)?.params).toMatchObject({ user: ['remote'], method: ['user.getRecentTracks'] });
      expect(remote.calls.entries.at(-1)?.params).not.toHaveProperty('did');
      expect(
        h.db.one(
          'SELECT listen_watermark_ms,listen_round_page,listen_round_upper_ms FROM linked_pull_state WHERE link_id=?',
          linkId,
        ),
      ).toMatchObject({
        listen_watermark_ms: T0 - 3_600_000,
        listen_round_page: 2,
        listen_round_upper_ms: T0,
      });
      expect(
        h.db.one(
          "SELECT count(*) AS n FROM linked_pull_items WHERE link_id=? AND payload_json LIKE '%Skip me%'",
          linkId,
        ),
      ).toEqual({ n: 0 });

      h.restart();
      h.kit.clock.advance(1000);
      const recentDone = await runLinkedLastfmPull(deps());
      expect(recentDone).toMatchObject({ requested: 1, staged: 1 });
      expect(
        h.db.one(
          'SELECT listen_watermark_ms,listen_round_page,listen_round_upper_ms,poll_phase FROM linked_pull_state WHERE link_id=?',
          linkId,
        ),
      ).toEqual({
        listen_watermark_ms: T0,
        listen_round_page: null,
        listen_round_upper_ms: null,
        poll_phase: 'love',
      });

      const boundaryBefore = h.db.one<{ love_boundary_ms: number }>(
        'SELECT love_boundary_ms FROM linked_pull_state WHERE link_id=?',
        linkId,
      )!.love_boundary_ms;
      h.kit.clock.advance(1000);
      expect((await runLinkedLastfmPull(deps())).staged).toBe(200);
      expect(
        h.db.one('SELECT love_boundary_ms,love_round_page FROM linked_pull_state WHERE link_id=?', linkId),
      ).toEqual({
        love_boundary_ms: boundaryBefore,
        love_round_page: 2,
      });
      h.restart();
      h.kit.clock.advance(1000);
      const lovesDone = await runLinkedLastfmPull(deps());
      expect(lovesDone).toMatchObject({ requested: 1, staged: 1 });
      expect(
        h.db.one('SELECT love_boundary_ms,love_round_page,poll_phase FROM linked_pull_state WHERE link_id=?', linkId),
      ).toEqual({
        love_boundary_ms: T0, // Newest upstream love, independent of the round's receive time.
        love_round_page: null,
        poll_phase: 'listen',
      });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 402 });
      expect(h.db.one('SELECT hold_reason FROM linked_pull_state WHERE link_id=?', linkId)).toEqual({
        hold_reason: 'session_missing',
      });
      expect(remote.calls.entries.map((call) => call.params.method?.[0])).toEqual([
        'user.getRecentTracks',
        'user.getRecentTracks',
        'user.getLovedTracks',
        'user.getLovedTracks',
      ]);
    });
  });

  it('keeps the creation floor, stops egress at capacity, and respects pause/resume', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      h.db.run('UPDATE linked_accounts SET pull_enabled=0 WHERE id=?', linkId);
      expect((await runLinkedLastfmPull(deps())).requested).toBe(0);
      expect(remote.calls.entries).toHaveLength(0);

      h.db.run('UPDATE linked_accounts SET pull_enabled=1 WHERE id=?', linkId);
      h.db.run(
        `INSERT INTO linked_pull_items(link_id,generation,item_key,kind,source_service,source_account,payload_json,payload_bytes,staged_at_ms)
         VALUES(?,1,'cap-marker','listen','lastfm','remote','{}',?,?)`,
        linkId,
        32 * 1024 * 1024,
        h.m.clock.nowMs(),
      );
      const full = await runLinkedLastfmPull(deps());
      expect(full).toMatchObject({ requested: 0, held: 'session_missing' });
      expect(remote.calls.entries).toHaveLength(0);
      expect(h.db.one('SELECT listen_watermark_ms FROM linked_pull_state WHERE link_id=?', linkId)).toEqual({
        listen_watermark_ms: T0 - 3_600_000,
      });
    });
  });

  it('sends a pulled listen through the existing import outbox into the signed fake PDS', async () => {
    await withHarness(async (h) => {
      const { did, linkId, remote, deps } = await setup(h);
      remote.seedHistory('remote', [{ artist: 'Pulled Artist', track: 'Delivered', uts: Math.floor(T0 / 1000) - 60 }]);
      h.db.run('UPDATE linked_accounts SET forward_scrobbles=1 WHERE id=?', linkId);
      const destination = h.link(did, 'listenbrainz', { forward_scrobbles: 1 });
      h.db.run("UPDATE linked_accounts SET remote_user='other-remote' WHERE id=?", destination);
      const options = deps();
      options.writerAvailability = async () => ({ available: true });

      const report = await runLinkedLastfmPull(options);
      expect(report).toMatchObject({ requested: 1, staged: 1 });
      expect(h.db.one("SELECT origin,state FROM operations WHERE did=? AND kind='scrobble.create'", did)).toMatchObject(
        {
          origin: 'import',
          state: 'queued',
        },
      );
      expect(
        h.db.all<{ service: string }>(
          "SELECT l.service FROM forward_outbox f JOIN linked_accounts l ON l.id=f.link_id WHERE f.did=? AND f.kind='scrobble'",
          did,
        ),
      ).toEqual([{ service: 'listenbrainz' }]);
      await h.runUntilIdle();
      expect(await remoteRecords(h.kit, 'Alice', `${SCROBBLE}Batch`)).toHaveLength(1);
      expect(h.writers.sent.some((sent) => sent.nsid === 'com.atproto.repo.createRecord' && sent.status === 200)).toBe(
        true,
      );
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
      h.db.run("UPDATE linked_pull_state SET poll_phase='listen',poll_next_at_ms=? WHERE link_id=?", T0, linkId);
      expect((await runLinkedLastfmPull(options)).staged).toBe(0);
      await h.runUntilIdle();
      expect(await remoteRecords(h.kit, 'Alice', `${SCROBBLE}Batch`)).toHaveLength(1);
    });
  });

  it('drops an inflight response after account relink instead of staging it under the new account', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      remote.seedHistory('remote', [{ artist: 'Old Account', track: 'Stale', uts: Math.floor(T0 / 1000) - 60 }]);
      const options = deps();
      let release!: (response: Response) => void;
      let reached!: () => void;
      const waiting = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      options.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
        reached();
        return waiting;
      };
      const pending = runLinkedLastfmPull(options);
      await started;
      h.db.run("UPDATE linked_accounts SET generation=2,remote_user='new-remote' WHERE id=?", linkId);
      h.db.run(
        `INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,
          listen_floor_at_ms,love_floor_at_ms,love_boundary_ms,poll_next_at_ms,updated_at_ms)
         VALUES(?,2,'lastfm','new-remote',?,?,?,?,?,?)`,
        linkId,
        T0 - 3_600_000,
        T0,
        T0,
        T0,
        T0,
        T0,
      );
      release(await remote.fetch(new Request('https://lastfm.test/2.0/?method=user.getRecentTracks')));
      expect(await pending).toMatchObject({ requested: 1, staged: 0 });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_state WHERE link_id=? AND generation=2', linkId)).toEqual({
        n: 1,
      });
    });
  });

  it('persists bounded exponential retry and does not rearm after eight failures', async () => {
    await withHarness(async (h) => {
      const { linkId, deps } = await setup(h);
      const options = deps();
      let requests = 0;
      options.fetch = async () => {
        requests++;
        return new Response('{}', { status: 503 });
      };
      for (let attempt = 0; attempt < 8; attempt++) {
        expect((await runLinkedLastfmPull(options)).requested).toBe(1);
        const state = h.db.one<{ poll_next_at_ms: number | null }>(
          'SELECT poll_next_at_ms FROM linked_pull_state WHERE link_id=?',
          linkId,
        )!;
        if (state.poll_next_at_ms !== null) h.kit.clock.advance(state.poll_next_at_ms - h.m.clock.nowMs());
      }
      expect(requests).toBe(8);
      expect(
        h.db.one('SELECT failures,hold_reason,poll_next_at_ms FROM linked_pull_state WHERE link_id=?', linkId),
      ).toEqual({
        failures: 8,
        hold_reason: 'retry_exhausted',
        poll_next_at_ms: null,
      });
      expect((await runLinkedLastfmPull(options)).requested).toBe(0);
      expect(requests).toBe(8);
    });
  });
});

it('completed Lastfm love boundary retains upstream second ties across restart', async () =>
  withHarness(async (h) => {
    const { linkId, remote, deps } = await setup(h);
    const second = Math.floor(h.m.clock.nowMs() / 1000) - 30;
    const first = { artist: 'Artist', track: 'One', uts: second };
    remote.seedLoved('remote', [first]);
    h.db.run("UPDATE linked_pull_state SET poll_phase='love' WHERE link_id=?", linkId);
    await runLinkedLastfmPull(deps());
    expect
      .soft(
        h.db.one<{ love_boundary_ms: number }>('SELECT love_boundary_ms FROM linked_pull_state WHERE link_id=?', linkId)
          ?.love_boundary_ms,
      )
      .toBe(second * 1000);
    h.restart();
    h.kit.clock.advance(600000);
    remote.seedLoved('remote', [first, { artist: 'Artist', track: 'Tied arrival', uts: second }]);
    h.db.run(
      "UPDATE linked_pull_state SET poll_phase='love',poll_next_at_ms=? WHERE link_id=?",
      h.m.clock.nowMs(),
      linkId,
    );
    await runLinkedLastfmPull(deps());
    expect
      .soft(
        h.db.one<{ n: number }>("SELECT count(*) n FROM linked_pull_items WHERE payload_json LIKE '%Tied arrival%'")?.n,
      )
      .toBe(1);
    expect(remote.calls.entries.length).toBe(2);
  }));

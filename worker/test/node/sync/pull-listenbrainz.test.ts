import { trackKey } from '@atmusic/core/music-key';
import { describe, expect, it } from 'vitest';
import { createBox, linkedAad } from '../../../src/crypto/box';
import { runLinkedLastfmPull } from '../../../src/sync/pull-poller';
import type { PullWriterAvailability } from '../../../src/sync/pull-writer';
import { T0, withHarness } from '../outbox/support';
import { FakeListenBrainz, type LbListen } from '../support/fake-listenbrainz';

const TOKEN = 'linked-lb-token';

async function setup(h: Parameters<Parameters<typeof withHarness>[0]>[0]) {
  const did = h.alice;
  h.seedUser(did);
  h.account(did);
  const linkId = h.link(did, 'listenbrainz');
  const box = createBox([{ id: 'e1', key: new Uint8Array(32).fill(73) }], h.m.random);
  const sealed = box.seal('linked-listenbrainz', TOKEN, linkedAad(did, 'listenbrainz'));
  h.db.run(
    "UPDATE linked_accounts SET remote_user='remote-lb',credential_ciphertext=?,key_id='e1' WHERE id=?",
    sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer,
    linkId,
  );
  const now = h.m.clock.nowMs();
  h.db.run(
    `INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,
      listen_floor_at_ms,love_floor_at_ms,love_boundary_ms,poll_next_at_ms,poll_phase,updated_at_ms)
     VALUES(?,1,'listenbrainz','remote-lb',?,?,?,?,?,'listen',?)`,
    linkId,
    now - 3_600_000,
    now - 86_400_000,
    now - 86_400_000,
    now - 86_400_000,
    now,
    now,
  );
  const remote = new FakeListenBrainz({ clock: h.kit.clock });
  remote.addToken('remote-lb', TOKEN);
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
    listenbrainzApiRoot: 'https://listenbrainz.test/',
    apiKey: null,
    sharedSecret: null,
    intervalMs: 600_000,
    pacer: { take: () => null, holdUntil: () => undefined },
    listenbrainzPacer: () => ({ take: () => null, holdUntil: () => undefined }),
    writerAvailability,
  });
  return { linkId, remote, deps };
}

describe('linked ListenBrainz timer poller', () => {
  it('uses exclusive min_ts with descending pages, persists max-time continuation, and resumes after restart', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      const floor = Math.floor((T0 - 7_200_000) / 1000);
      const listens: LbListen[] = Array.from({ length: 1001 }, (_, i) => ({
        listened_at: floor + i + 1,
        track_metadata: { artist_name: 'Pulled artist', track_name: `LB ${i}` },
      }));
      remote.seedListens('remote-lb', listens);

      const first = await runLinkedLastfmPull(deps());
      expect(first).toMatchObject({ requested: 1, staged: 1000, held: 'session_missing' });
      expect(remote.calls.entries[0]?.params).toMatchObject({ min_ts: [String(floor - 1)], count: ['1000'] });
      expect(
        h.db.one(
          'SELECT page_cursor,listen_watermark_ms,listen_round_page FROM linked_pull_state WHERE link_id=?',
          linkId,
        ),
      ).toMatchObject({
        page_cursor: String(floor + 1000 - 1),
        listen_watermark_ms: T0 - 3_600_000,
        listen_round_page: 2,
      });
      h.restart();
      h.kit.clock.advance(1000);
      const second = await runLinkedLastfmPull(deps());
      expect(second).toMatchObject({ requested: 1, staged: 1, held: 'session_missing' });
      expect(remote.calls.entries[1]?.params.min_ts).toEqual([String(floor + 1000 - 1)]);
      expect(
        h.db.one(
          'SELECT listen_watermark_ms,listen_round_upper_ms,poll_phase FROM linked_pull_state WHERE link_id=?',
          linkId,
        ),
      ).toEqual({
        listen_watermark_ms: T0,
        listen_round_upper_ms: null,
        poll_phase: 'love',
      });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 1001 });
    });
  });

  it('holds a saturated same-second page without claiming completion or advancing the watermark', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      const second = Math.floor(T0 / 1000) - 20;
      remote.seedListens(
        'remote-lb',
        Array.from({ length: 1001 }, (_, i) => ({
          listened_at: second,
          recording_msid: `msid-${i}`,
          track_metadata: { artist_name: 'Same second', track_name: `Track ${i}` },
        })),
      );
      const report = await runLinkedLastfmPull(deps());
      expect(report.held).toBe('listenbrainz_page_saturated');
      expect(
        h.db.one(
          'SELECT listen_watermark_ms,listen_round_saturated,hold_reason FROM linked_pull_state WHERE link_id=?',
          linkId,
        ),
      ).toEqual({
        listen_watermark_ms: T0 - 3_600_000,
        listen_round_saturated: 1,
        hold_reason: 'listenbrainz_page_saturated',
      });
    });
  });

  it('scans feedback offsets through ties and unresolved metadata without stopping at a local love', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      const second = Math.floor(T0 / 1000) - 30;
      remote.seedFeedback('remote-lb', [
        { created: second, recording_msid: 'msid-one', track_metadata: { artist_name: 'Liked', track_name: 'One' } },
        { created: second, recording_msid: 'msid-two', track_metadata: null },
        {
          created: second,
          recording_msid: 'msid-three',
          track_metadata: { artist_name: 'Liked', track_name: 'Unseen' },
        },
      ]);
      // Existing local love knowledge must not terminate this upstream scan.
      const [artistKey, trackKeyValue] = trackKey('Liked', 'One');
      const createdAt = new Date(T0).toISOString().replace(/\.\d{3}Z$/, '.000000000Z');
      h.db.run(
        `INSERT INTO loves(uri,did,rkey,cid,artist,track,artist_key,track_key,created_at,indexed_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        `at://${h.alice}/com.example.love/local`,
        h.alice,
        'local',
        'cid',
        'Liked',
        'One',
        artistKey,
        trackKeyValue,
        createdAt,
        createdAt,
      );
      h.db.run("UPDATE linked_pull_state SET poll_phase='love' WHERE link_id=?", linkId);
      const report = await runLinkedLastfmPull(deps());
      expect(report.requested).toBe(1);
      expect(remote.feedbackCalls[0]).toMatchObject({
        user: 'remote-lb',
        offset: 0,
        count: 1000,
        score: 1,
        metadata: true,
      });
      expect(report.staged).toBe(1);
      expect(h.db.one("SELECT count(*) AS n FROM linked_pull_items WHERE link_id=? AND kind='love'", linkId)).toEqual({
        n: 1,
      });
      expect(
        h.db.one('SELECT love_boundary_ms,poll_phase FROM linked_pull_state WHERE link_id=?', linkId),
      ).toMatchObject({
        love_boundary_ms: second * 1000,
        poll_phase: 'listen',
      });
    });
  });

  it('restarts feedback offsets after restart and settles every entry tied at the boundary', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      const second = Math.floor(T0 / 1000) - 40;
      remote.seedFeedback(
        'remote-lb',
        Array.from({ length: 1001 }, (_, i) => ({
          created: second,
          recording_msid: `tie-${i}`,
          track_metadata: { artist_name: 'Boundary', track_name: `Tie ${i}` },
        })),
      );
      h.db.run("UPDATE linked_pull_state SET poll_phase='love' WHERE link_id=?", linkId);
      expect((await runLinkedLastfmPull(deps())).staged).toBe(1000);
      h.restart();
      h.kit.clock.advance(1000);
      expect(await runLinkedLastfmPull(deps())).toMatchObject({ requested: 1, staged: 0 });
      expect(
        h.db.one('SELECT love_boundary_ms,love_round_page,love_cursor FROM linked_pull_state WHERE link_id=?', linkId),
      ).toMatchObject({
        love_boundary_ms: T0 - 86_400_000,
        love_round_page: 1000,
        love_cursor: '1000',
      });
      h.kit.clock.advance(1000);
      expect((await runLinkedLastfmPull(deps())).staged).toBe(1);
      expect(remote.feedbackCalls.map((call) => call.offset)).toEqual([0, 0, 1000]);
      expect(h.db.one('SELECT love_boundary_ms,poll_phase FROM linked_pull_state WHERE link_id=?', linkId)).toEqual({
        love_boundary_ms: second * 1000,
        poll_phase: 'listen',
      });
      expect(h.db.one("SELECT count(*) AS n FROM linked_pull_items WHERE link_id=? AND kind='love'", linkId)).toEqual({
        n: 1001,
      });
    });
  });

  it('uses local recording metadata for a feedback MBID and skips unresolved metadata without inventing names', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      const mbid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const second = Math.floor(T0 / 1000) - 50;
      h.db.run(
        `INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,title,artist_credit,created_at_ms)
         VALUES('local-artist','local-track','', 'matched', ?, 'Local title', 'Local artist', ?)`,
        mbid,
        T0,
      );
      remote.seedFeedback('remote-lb', [
        { created: second, recording_mbid: mbid, track_metadata: null },
        { created: second - 1, recording_msid: 'unknown-only', track_metadata: null },
        {
          created: second - 2,
          recording_msid: 'mapped-mbid',
          track_metadata: {
            mbid_mapping: {
              recording_mbid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              recording_name: 'Mapped title',
              artist_credit_name: 'Mapped artist',
            },
          },
        },
        {
          created: second - 3,
          recording_msid: 'submitted-mbid',
          submitted: {
            artist_name: 'Submitted artist',
            track_name: 'Submitted title',
            additional_info: { recording_mbid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
          },
          track_metadata: null,
        },
      ]);
      h.db.run("UPDATE linked_pull_state SET poll_phase='love' WHERE link_id=?", linkId);
      expect((await runLinkedLastfmPull(deps())).staged).toBe(3);
      const staged = h.db.one<{ payload_json: string; recording_mbid: string | null }>(
        "SELECT payload_json,recording_mbid FROM linked_pull_items WHERE link_id=? AND kind='love'",
        linkId,
      )!;
      expect(staged).toMatchObject({
        recording_mbid: mbid,
        payload_json: JSON.stringify({ artist: 'Local artist', track: 'Local title', recordingMbid: mbid }),
      });
      expect(
        h.db.one(
          "SELECT count(*) AS n FROM linked_pull_items WHERE link_id=? AND kind='love' AND payload_json LIKE '%Mapped title%'",
          linkId,
        ),
      ).toEqual({ n: 1 });
      expect(
        h.db.one(
          "SELECT count(*) AS n FROM linked_pull_items WHERE link_id=? AND kind='love' AND payload_json LIKE '%Submitted title%'",
          linkId,
        ),
      ).toEqual({ n: 1 });
      expect(h.db.one('SELECT skipped_count FROM linked_pull_state WHERE link_id=?', linkId)).toEqual({
        skipped_count: 1,
      });
    });
  });

  it('fences an in-flight page after pause or relink and leaves the current generation untouched', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      remote.seedListens('remote-lb', [
        { listened_at: Math.floor(T0 / 1000) - 5, track_metadata: { artist_name: 'Old', track_name: 'Account' } },
      ]);
      const options = deps();
      let release!: (response: Response) => void;
      let reached!: () => void;
      const waiting = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      options.fetch = async () => {
        reached();
        return waiting;
      };
      const pending = runLinkedLastfmPull(options);
      await started;
      h.db.run("UPDATE linked_accounts SET generation=2,remote_user='new-lb' WHERE id=?", linkId);
      h.db.run(
        `INSERT INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,
          listen_floor_at_ms,love_floor_at_ms,love_boundary_ms,poll_next_at_ms,updated_at_ms)
         VALUES(?,2,'listenbrainz','new-lb',?,?,?,?,?,?)`,
        linkId,
        T0 - 3_600_000,
        T0,
        T0,
        T0,
        T0,
        T0,
      );
      release(await remote.fetch(new Request('https://listenbrainz.test/1/user/remote-lb/listens?min_ts=0')));
      expect(await pending).toMatchObject({ requested: 1, staged: 0 });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_items WHERE link_id=?', linkId)).toEqual({ n: 0 });
      expect(h.db.one('SELECT count(*) AS n FROM linked_pull_state WHERE link_id=? AND generation=2', linkId)).toEqual({
        n: 1,
      });
    });
  });

  it('makes no request while pull is paused, resumes from the durable cursor, and stops at staging capacity', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      remote.seedListens('remote-lb', [
        { listened_at: Math.floor(T0 / 1000) - 10, track_metadata: { artist_name: 'Resume', track_name: 'Later' } },
      ]);
      h.db.run('UPDATE linked_accounts SET pull_enabled=0 WHERE id=?', linkId);
      expect((await runLinkedLastfmPull(deps())).requested).toBe(0);
      expect(remote.calls.entries).toHaveLength(0);
      h.db.run('UPDATE linked_accounts SET pull_enabled=1 WHERE id=?', linkId);
      h.db.run('UPDATE linked_pull_state SET poll_next_at_ms=? WHERE link_id=?', T0, linkId);
      expect((await runLinkedLastfmPull(deps())).requested).toBe(1);
      expect(remote.calls.entries).toHaveLength(1);

      h.db.run('DELETE FROM linked_pull_items WHERE link_id=?', linkId);
      h.db.tx(() => {
        for (let i = 0; i < 5000; i++) {
          h.db.run(
            `INSERT INTO linked_pull_items(link_id,generation,item_key,kind,source_service,source_account,
             listened_at_ms,payload_json,payload_bytes,staged_at_ms) VALUES(?,1,?,'listen','listenbrainz','remote-lb',?,?,1,?)`,
            linkId,
            `cap-${i}`,
            T0 - i * 1000,
            '{}',
            T0,
          );
        }
      });
      h.db.run("UPDATE linked_pull_state SET poll_phase='listen',poll_next_at_ms=? WHERE link_id=?", T0, linkId);
      const calls = remote.calls.entries.length;
      expect((await runLinkedLastfmPull(deps())).requested).toBe(0);
      expect(remote.calls.entries).toHaveLength(calls);
    });
  });

  it('persists the upstream rate limit and bounded retry state without losing its cursor', async () => {
    await withHarness(async (h) => {
      const { linkId, remote, deps } = await setup(h);
      remote.fail({ status: 429, resetIn: 7, path: '/1/user/remote-lb/listens' });
      const report = await runLinkedLastfmPull(deps());
      expect(report).toMatchObject({ requested: 1, held: 'upstream_retry' });
      expect(
        h.db.one('SELECT failures,listen_watermark_ms,page_cursor FROM linked_pull_state WHERE link_id=?', linkId),
      ).toEqual({
        failures: 1,
        listen_watermark_ms: T0 - 3_600_000,
        page_cursor: null,
      });
      expect(remote.calls.entries[0]?.status).toBe(429);
    });
  });
});

it.each(['listen', 'love'])('429 stops after eight attempts (%s)', async (phase) =>
  withHarness(async (h) => {
    const { linkId, deps } = await setup(h);
    h.db.run('UPDATE linked_pull_state SET poll_phase=? WHERE link_id=?', phase, linkId);
    let calls = 0;
    const d = {
      ...deps(),
      fetch: async () => {
        calls++;
        return new Response('{}', { status: 429, headers: { 'x-ratelimit-reset-in': '1' } });
      },
    };
    for (let i = 0; i < 10; i++) {
      await runLinkedLastfmPull(d);
      const row = h.db.one<{ poll_next_at_ms: number | null }>(
        'SELECT poll_next_at_ms FROM linked_pull_state WHERE link_id=?',
        linkId,
      );
      h.kit.clock.advance(Math.max(1, (row?.poll_next_at_ms ?? h.m.clock.nowMs() + 600000) - h.m.clock.nowMs()));
    }
    expect.soft(calls).toBe(8);
    expect
      .soft(
        h.db.one<{ failures: number; hold_reason: string; poll_next_at_ms: number | null }>(
          'SELECT failures,hold_reason,poll_next_at_ms FROM linked_pull_state WHERE link_id=?',
          linkId,
        ),
      )
      .toEqual({ failures: 8, hold_reason: 'retry_exhausted', poll_next_at_ms: null });
  }),
);

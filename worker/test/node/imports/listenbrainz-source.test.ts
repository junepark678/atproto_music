// The `listenbrainz_api` import source (ADR 0005 §11.1, §11.3; N3-09).
//
// The job runs through the real `import` timer run (runImports) over a
// migrated temporary database; requests go through policyFetch to the fake
// ListenBrainz at listenbrainz.test (worker/test/node/support/fake-listenbrainz.ts),
// whose fixed-window rate limit and X-RateLimit-* headers are real. Frozen
// clock, stepped by hand; seeded randomness; no network.

import type { Transport } from '@atmusic/atproto/transport';
import { describe, expect, it } from 'vitest';
import type { ImportItemRow, ImportJobRow } from '../../../src/app/rows';
import { createBox, linkedAad } from '../../../src/crypto/box';
import {
  createJob,
  IMPORT_FETCH_CAPS,
  type ImportRuntime,
  intervalPacer,
  parseCursor,
  runImports,
} from '../../../src/imports/jobs';
import { LISTENBRAINZ_PAGE_COUNT } from '../../../src/imports/listenbrainz-source';
import { fsUploadStore } from '../../../src/imports/uploads';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { T0, withHarness } from '../outbox/support';
import { FakeListenBrainz, type LbListen } from '../support/fake-listenbrainz';

const USER = 'alice_lb';
const KEYS = [{ id: 'e1', key: new Uint8Array(32).fill(9) }];

/**
 * 2,300 listens, newest first, one per second apart by 30 s, except that
 * listens 999 and 1000 share a second, as do 1998 and 1999 (page boundaries).
 */
function history(): LbListen[] {
  const t0 = Math.floor(T0 / 1000) - 600;
  let second = t0;
  const out: LbListen[] = [];
  for (let i = 0; i < 2_300; i++) {
    if (i > 0 && !(i === 1_000 || i === 1_999)) second -= 30;
    out.push({
      listened_at: second,
      track_metadata: {
        artist_name: `LB Artist ${i}`,
        track_name: `LB Track ${i}`,
        additional_info: { recording_mbid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` },
      },
    });
  }
  return out;
}

describe('listenbrainz_api import source', () => {
  it('max_ts paging with count 1000 honours X-RateLimit-Reset-In and stages listens sharing a boundary second exactly once', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const clock = h.kit.clock;
      // Two requests per 10 s window: the second answers X-RateLimit-Remaining 0.
      const fake = new FakeListenBrainz({ clock, rateLimit: 2, rateWindowS: 10 });
      const listens = history();
      fake.seedListens(USER, listens);
      const token = 'lb-user-token-0123456789';
      fake.addToken(USER, token);
      const requests: Array<{ atMs: number; url: URL; authorization: string | null; status?: number }> = [];
      const transport = Object.assign(
        async (req: Request) => {
          const url = new URL(req.url);
          if (url.hostname !== 'listenbrainz.test') return h.kit.transport(req);
          const entry: (typeof requests)[number] = {
            atMs: clock.nowMs(),
            url,
            authorization: req.headers.get('authorization'),
          };
          requests.push(entry);
          const res = await fake.fetch(req);
          entry.status = res.status;
          return res;
        },
        { fixture: true as const },
      ) as unknown as Transport;
      const box = createBox(KEYS, h.m.random);
      h.db.run(
        `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, status, created_at_ms, updated_at_ms)
         VALUES ('link-lb', ?, 'listenbrainz', ?, ?, 'e1', 'active', ?, ?)`,
        h.alice,
        USER,
        box.seal('linked-listenbrainz', token, linkedAad(h.alice, 'listenbrainz')).slice().buffer,
        T0,
        T0,
      );
      const rt: ImportRuntime = {
        m: h.m,
        uploadDir: `${h.ctx.dir}/imports`,
        lastfm: null,
        listenbrainzApiRoot: 'https://listenbrainz.test/',
        fetch: bindPolicyFetch(createPolicyFetch({ transport }), IMPORT_FETCH_CAPS),
        pacers: { lastfm: intervalPacer(), listenbrainz: intervalPacer() },
        diskLow: () => false,
        uploads: fsUploadStore,
        box,
      };
      createJob(h.db, { id: 'job-lb', did: h.alice, source: 'listenbrainz_api', remoteUser: USER, now: T0 });
      const job = () => h.db.one<ImportJobRow>("SELECT * FROM import_jobs WHERE id = 'job-lb'") as ImportJobRow;

      // T0: page 1. T0 + 1 s: page 2, which spends the window (reset in 9 s).
      await runImports(rt, clock.nowMs());
      clock.advance(1_000);
      await runImports(rt, clock.nowMs());
      expect(requests).toHaveLength(2);
      // T0 + 2 s … 9.999 s: the pacer is held until the window resets; nothing is sent.
      clock.advance(1_000);
      const held = await runImports(rt, clock.nowMs());
      expect(held.actions).toEqual([{ jobId: 'job-lb', action: 'paced', atMs: T0 + 10_000 }]);
      clock.set(new Date(T0 + 9_999).toISOString());
      await runImports(rt, clock.nowMs());
      expect(requests).toHaveLength(2);

      // T0 + 10 s: a scripted 429 with Reset-In 10 pauses the job until T0 + 20 s.
      fake.fail({ status: 429, resetIn: 10 });
      clock.set(new Date(T0 + 10_000).toISOString());
      const limited = await runImports(rt, clock.nowMs());
      expect(limited.actions).toContainEqual({
        jobId: 'job-lb',
        action: 'paused',
        atMs: T0 + 20_000,
        detail: 'rate_limited',
      });
      expect(job()).toMatchObject({ state: 'paused', error: 'rate_limited' });
      clock.set(new Date(T0 + 19_999).toISOString());
      await runImports(rt, clock.nowMs());
      expect(requests).toHaveLength(3);

      // T0 + 20 s: resumed; the last page is fetched and the walk ends.
      clock.set(new Date(T0 + 20_000).toISOString());
      const last = await runImports(rt, clock.nowMs());
      expect(last.actions.map((a) => a.action)).toEqual(['resumed', 'page']);

      expect(requests.map((r) => r.atMs - T0)).toEqual([0, 1_000, 10_000, 20_000]);
      expect(requests.map((r) => r.status)).toEqual([200, 200, 429, 200]);
      for (const r of requests) {
        expect(r.url.pathname).toBe(`/1/user/${USER}/listens`);
        expect(r.url.searchParams.get('count')).toBe(String(LISTENBRAINZ_PAGE_COUNT));
        expect(r.authorization).toBe(`Token ${token}`);
      }
      // max_ts: the start second + 1, then the oldest listened_at + 1 of each page
      // (the 429 retried the same bound).
      const t0s = Math.floor(T0 / 1000);
      const maxTs = requests.map((r) => Number(r.url.searchParams.get('max_ts')));
      const second = (i: number) => (listens[i] as LbListen).listened_at;
      expect(maxTs).toEqual([t0s + 1, second(999) + 1, second(1_998) + 1, second(1_998) + 1]);

      const row = job();
      expect(row).toMatchObject({ state: 'writing', fetched: 2_300, staged: 2_300, duplicates: 0, invalid: 0 });
      expect(parseCursor(row).fetchDone).toBe(true);
      const items = h.db.all<ImportItemRow>("SELECT * FROM import_items WHERE job_id = 'job-lb' ORDER BY seq");
      expect(items).toHaveLength(2_300);
      const tracks = items.map((i) => (JSON.parse(i.record_json) as { input: { track: string } }).input.track);
      expect(new Set(tracks).size).toBe(2_300);
      // Both listens of each shared boundary second, each exactly once.
      for (const n of [999, 1_000, 1_998, 1_999]) expect(tracks.filter((t) => t === `LB Track ${n}`)).toHaveLength(1);
      // Record MBIDs come from additional_info.
      const first = JSON.parse((items[0] as ImportItemRow).record_json) as { input: Record<string, unknown> };
      expect(first.input).toMatchObject({
        artist: 'LB Artist 0',
        track: 'LB Track 0',
        recordingMbid: '00000000-0000-4000-8000-000000000000',
      });
    });
  });
});

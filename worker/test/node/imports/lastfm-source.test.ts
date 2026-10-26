// The `lastfm_api` import source (ADR 0005 §11.1, §11.3, §11.4; N3-09).
//
// The whole job runs through the real `import` timer run (runImports) over a
// migrated temporary database, with every request sent through policyFetch to
// the fake Last.fm at lastfm.test (worker/test/node/support/fake-lastfm.ts).
// Frozen clock 2026-01-15T12:00:00Z, stepped by hand; seeded randomness; no
// network.

import type { Transport } from '@atmusic/atproto/transport';
import { describe, expect, it } from 'vitest';
import type { ImportItemRow, ImportJobRow } from '../../../src/app/rows';
import { createBox, linkedAad } from '../../../src/crypto/box';
import {
  createJob,
  IMPORT_FETCH_CAPS,
  type ImportRunReport,
  type ImportRuntime,
  intervalPacer,
  type Pacer,
  parseCursor,
  runImports,
} from '../../../src/imports/jobs';
import { LASTFM_PAGE_LIMIT } from '../../../src/imports/lastfm-source';
import { fsUploadStore } from '../../../src/imports/uploads';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { type Harness, T0, withHarness } from '../outbox/support';
import { FakeLastfm, type LastfmListen, lastfmSignature } from '../support/fake-lastfm';

const API_KEY = 'b'.repeat(32);
const SECRET = 'owner-shared-secret';
const USER = 'rj';
const KEYS = [{ id: 'e1', key: new Uint8Array(32).fill(7) }];

interface Rig {
  rt: ImportRuntime;
  fake: FakeLastfm;
  /** Every request to lastfm.test: the clock when it was sent and its query. */
  requests: Array<{ atMs: number; params: URLSearchParams }>;
}

function rig(h: Harness, fake: FakeLastfm, requests: Rig['requests'], pacer: Pacer = intervalPacer()): Rig {
  const transport = Object.assign(
    async (req: Request) => {
      const url = new URL(req.url);
      if (url.hostname === 'lastfm.test') {
        requests.push({ atMs: h.kit.clock.nowMs(), params: url.searchParams });
        return fake.fetch(req);
      }
      return h.kit.transport(req);
    },
    { fixture: true as const },
  ) as unknown as Transport;
  const rt: ImportRuntime = {
    m: h.m,
    uploadDir: `${h.ctx.dir}/imports`,
    lastfm: { apiRoot: 'https://lastfm.test/2.0/', apiKey: API_KEY, sharedSecret: SECRET },
    listenbrainzApiRoot: 'https://listenbrainz.test/',
    fetch: bindPolicyFetch(createPolicyFetch({ transport }), IMPORT_FETCH_CAPS),
    pacers: { lastfm: pacer, listenbrainz: intervalPacer() },
    diskLow: () => false,
    uploads: fsUploadStore,
    box: createBox(KEYS, h.m.random),
  };
  return { rt, fake, requests };
}

/** 1,050 listens, two per second, newest first from T0 − 1,000 s; distinct names. */
function history(n = 1_050): LastfmListen[] {
  const t0 = Math.floor(T0 / 1000);
  return Array.from({ length: n }, (_, i) => ({
    artist: `Artist ${i}`,
    track: `Track ${i}`,
    uts: t0 - 1_000 - Math.floor(i / 2) * 60,
    ...(i % 3 === 0 ? { album: `Album ${i}` } : {}),
  }));
}

function job(h: Harness, id: string): ImportJobRow {
  return h.db.one<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ?', id) as ImportJobRow;
}

function items(h: Harness, id: string): ImportItemRow[] {
  return h.db.all<ImportItemRow>('SELECT * FROM import_items WHERE job_id = ? ORDER BY seq', id);
}

/** Runs the timer once per simulated second until `stop` or `max` runs. */
async function drive(h: Harness, r: Rig, stop: () => boolean, max = 40): Promise<ImportRunReport[]> {
  const reports: ImportRunReport[] = [];
  for (let i = 0; i < max && !stop(); i++) {
    reports.push(await runImports(r.rt, h.kit.clock.nowMs()));
    h.kit.clock.advance(1_000);
  }
  return reports;
}

function newFake(h: Harness): FakeLastfm {
  const fake = new FakeLastfm({ clock: h.kit.clock, apiKey: API_KEY, secret: SECRET });
  fake.seedHistory(USER, history());
  fake.setNowPlaying(USER, { artist: 'Now Artist', track: 'Now Playing Song' });
  return fake;
}

describe('lastfm_api import source', () => {
  it('a 1,050-listen fake history at limit 200 is fetched in 6 pages with the nowplaying row skipped and every listen staged exactly once', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const r = rig(h, newFake(h), []);
      const created = createJob(h.db, {
        id: 'job-lastfm',
        did: h.alice,
        source: 'lastfm_api',
        remoteUser: USER,
        now: T0,
      });
      expect(created.state).toBe('waiting_index');

      await drive(h, r, () => job(h, 'job-lastfm').state === 'writing');

      // Six requests, each page 1 below a moving `to`, limit 200, extended.
      expect(r.requests).toHaveLength(6);
      for (const { params } of r.requests) {
        expect(params.get('method')).toBe('user.getRecentTracks');
        expect(params.get('limit')).toBe(String(LASTFM_PAGE_LIMIT));
        expect(params.get('extended')).toBe('1');
        expect(params.get('page')).toBe('1');
        expect(params.get('api_key')).toBe(API_KEY);
        expect(params.get('format')).toBe('json');
        expect(params.has('sk')).toBe(false);
      }
      const t0s = Math.floor(T0 / 1000);
      const listens = history();
      // `to` = the start second + 1, then the previous page's oldest uts + 1.
      const expectedTo = [t0s + 1, ...[199, 397, 595, 793, 991].map((i) => (listens[i] as LastfmListen).uts + 1)];
      expect(r.requests.map((q) => Number(q.params.get('to')))).toEqual(expectedTo);

      const row = job(h, 'job-lastfm');
      expect(row).toMatchObject({ state: 'writing', fetched: 1_050, staged: 1_050, duplicates: 0, invalid: 0 });
      expect(parseCursor(row).fetchDone).toBe(true);
      const staged = items(h, 'job-lastfm');
      expect(staged).toHaveLength(1_050);
      expect(new Set(staged.map((i) => i.dedupe_key)).size).toBe(1_050);
      const inputs = staged.map(
        (i) =>
          JSON.parse(i.record_json) as {
            kind: string;
            input: { artist: string; track: string; listenedAt: string; album?: string };
          },
      );
      expect(inputs.every((x) => x.kind === 'listen')).toBe(true);
      // Exactly the seeded listens, in walk order (newest second first), the now-playing row nowhere.
      expect(inputs.map((x) => x.input.track).sort()).toEqual(listens.map((l) => l.track).sort());
      const times = inputs.map((x) => x.input.listenedAt);
      expect(times).toEqual([...times].sort().reverse());
      expect(inputs.some((x) => x.input.track === 'Now Playing Song')).toBe(false);
      expect(inputs.find((x) => x.input.track === 'Track 0')?.input).toEqual({
        artist: 'Artist 0',
        track: 'Track 0',
        album: 'Album 0',
        listenedAt: new Date((listens[0] as LastfmListen).uts * 1000).toISOString().replace('.000Z', 'Z'),
      });
      expect(staged.map((i) => i.state)).toEqual(Array(1_050).fill('staged'));
    });
  });

  it('after a restart between pages the job resumes at the stored cursor without refetching completed pages', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const requests: Rig['requests'] = [];
      const fake = newFake(h);
      let r = rig(h, fake, requests);
      createJob(h.db, { id: 'job-resume', did: h.alice, source: 'lastfm_api', remoteUser: USER, now: T0 });
      await drive(h, r, () => requests.length === 3);
      expect(requests).toHaveLength(3);
      const before = job(h, 'job-resume');
      expect(before).toMatchObject({ state: 'fetching', fetched: 600 - 4, staged: 596, attempts: 0 });
      const stored = parseCursor(before).lastfm;
      expect(stored?.to).toBe((history()[595] as LastfmListen).uts + 1);

      // A process restart: the same file reopened, fresh deps and a fresh pacer.
      h.restart();
      r = rig(h, fake, requests);
      await drive(h, r, () => job(h, 'job-resume').state === 'writing');

      expect(requests).toHaveLength(6);
      // The first request after the restart starts exactly at the stored cursor.
      expect(Number(requests[3]?.params.get('to'))).toBe(stored?.to);
      // No `to` was ever requested twice.
      const tos = requests.map((q) => q.params.get('to'));
      expect(new Set(tos).size).toBe(6);
      const after = job(h, 'job-resume');
      expect(after).toMatchObject({ state: 'writing', fetched: 1_050, staged: 1_050, duplicates: 0 });
      expect(new Set(items(h, 'job-resume').map((i) => i.dedupe_key)).size).toBe(1_050);
    });
  });

  it("Last.fm requests are at least 1 s apart and codes 29, 11 and 16 back off; a linked account's sk is sent", async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const fake = new FakeLastfm({ clock: h.kit.clock, apiKey: API_KEY, secret: SECRET });
      fake.seedHistory(USER, history(450));
      const requests: Rig['requests'] = [];
      const r = rig(h, fake, requests);
      // The DID's linked Last.fm account: the sk sealed exactly as linking stores it.
      const sk = 'linked-session-key-0123456789abcdef';
      const sealed = createBox(KEYS, h.m.random).seal('linked-lastfm', sk, linkedAad(h.alice, 'lastfm'));
      h.db.run(
        `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, status, created_at_ms, updated_at_ms)
         VALUES ('link-lf', ?, 'lastfm', ?, ?, 'e1', 'active', ?, ?)`,
        h.alice,
        USER,
        sealed.slice().buffer,
        T0,
        T0,
      );
      createJob(h.db, { id: 'job-pace', did: h.alice, source: 'lastfm_api', remoteUser: USER, now: T0 });
      const clock = h.kit.clock;
      const run = () => runImports(r.rt, clock.nowMs());

      // Page 1 at T0; a second run at the same instant is paced and sends nothing.
      expect((await run()).actions.map((a) => a.action)).toEqual(['started', 'page']);
      const paced = await run();
      expect(paced.actions).toEqual([{ jobId: 'job-pace', action: 'paced', atMs: T0 + 1_000 }]);
      expect(paced.nextDueMs).toBe(T0 + 1_000);
      expect(requests).toHaveLength(1);

      // T0 + 1 s: code 29 → paused rate_limited for 30 s.
      fake.fail({ code: 29, method: 'user.getRecentTracks' });
      clock.advance(1_000);
      const limited = await run();
      expect(limited.actions).toContainEqual({
        jobId: 'job-pace',
        action: 'paused',
        atMs: T0 + 31_000,
        detail: 'rate_limited',
      });
      expect(job(h, 'job-pace')).toMatchObject({ state: 'paused', error: 'rate_limited' });
      clock.set(new Date(T0 + 30_999).toISOString());
      await run();
      expect(requests).toHaveLength(2);

      // T0 + 31 s: resumed; code 11 → 60 s backoff.
      fake.fail({ code: 11, method: 'user.getRecentTracks' });
      clock.set(new Date(T0 + 31_000).toISOString());
      const r11 = await run();
      expect(r11.actions.map((a) => a.action)).toEqual(['resumed', 'backoff']);
      expect(r11.actions[1]).toMatchObject({ atMs: T0 + 91_000, detail: 'lastfm_11' });
      expect(job(h, 'job-pace')).toMatchObject({ state: 'fetching', error: null, attempts: 0 });
      clock.set(new Date(T0 + 90_999).toISOString());
      await run();
      expect(requests).toHaveLength(3);

      // T0 + 91 s: code 16 → 120 s backoff.
      fake.fail({ code: 16, method: 'user.getRecentTracks' });
      clock.set(new Date(T0 + 91_000).toISOString());
      expect((await run()).actions).toEqual([
        { jobId: 'job-pace', action: 'backoff', atMs: T0 + 211_000, detail: 'lastfm_16' },
      ]);
      clock.set(new Date(T0 + 210_999).toISOString());
      await run();
      expect(requests).toHaveLength(4);

      // T0 + 211 s: the page is fetched, then the walk finishes one request per second.
      clock.set(new Date(T0 + 211_000).toISOString());
      await drive(h, r, () => job(h, 'job-pace').state === 'writing');

      const times = requests.map((q) => q.atMs - T0);
      expect(times.slice(0, 5)).toEqual([0, 1_000, 31_000, 91_000, 211_000]);
      for (let i = 1; i < times.length; i++)
        expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(1_000);
      // Three failed requests plus the successful pages: 450 listens at 200 per page, two per second → 3 pages.
      expect(requests).toHaveLength(6);

      // Every request carried the linked sk and a valid owner signature.
      for (const { params } of requests) {
        expect(params.get('sk')).toBe(sk);
        const signed = [...params.entries()].filter(([k]) => k !== 'api_sig' && k !== 'format');
        expect(params.get('api_sig')).toBe(lastfmSignature(signed, SECRET));
      }
      expect(job(h, 'job-pace')).toMatchObject({ state: 'writing', fetched: 450, staged: 450, duplicates: 0 });
      expect(fake.pendingFaults).toBe(0);
    });
  });
});

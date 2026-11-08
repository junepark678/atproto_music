// Link routes (ADR 0005 §12.1, §5.6, §13, §14.5; api/openapi.yaml v1.2
// links_*; N3-08): the Last.fm web-auth link flow with single-use states
// bound to the web session, ListenBrainz token linking through
// validate-token, sealed credentials, PATCH and DELETE.
//
// The real composition (support/app.ts) over a migrated file database, the
// frozen clock 2026-01-15T12:00:00Z and a seeded Random; Last.fm and
// ListenBrainz are the fakes of support/ at lastfm.test and listenbrainz.test
// behind the fixture router (no network). Every JSON answer is checked
// against the contract with AJV (acceptance/support/openapi.ts).

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { routerTransport } from '@atmusic/atproto/test-support/router-transport';
import { listenKey } from '@atmusic/core/listen-key';
import { albumKey, trackKey } from '@atmusic/core/music-key';
import { type FixedClock, fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { parseRfc3339 } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { LinkedAccountRow } from '../../../src/app/rows';
import { csrfToken } from '../../../src/bff/csrf';
import { createWebSessions, SESSION_COOKIE, type WebSessions } from '../../../src/bff/sessions';
import { ensureAccount } from '../../../src/credentials/accounts';
import { type Box, BoxError, createBox, linkedAad } from '../../../src/crypto/box';
import type { SqlParam } from '../../../src/do/db';
import { completeSnapshot } from '../../../src/do/write/apply-snapshot';
import {
  BACKFILL_HISTORY_QUEUE_HIGH_WATER,
  BACKFILL_MAX_FAILURES,
  recordBackfillFailure,
  runLinkBackfill,
} from '../../../src/forward/backfill';
import { dueRows } from '../../../src/forward/forward-outbox';
import { LINK_STATE_TTL_MS, patchLink, saveLink, sweepExpiredLinkStates } from '../../../src/forward/links';
import { admitForwardIdentity, projectionListenKey } from '../../../src/forward/projection';
import { linksFeature } from '../../../src/http/links';
import { parseSecrets } from '../../../src/node/secrets';
import { openSqliteDb } from '../../../src/node/sqlite-db';
import { enqueueForwards } from '../../../src/outbox/forward-enqueue';
import { checkResponse } from '../../acceptance/support/openapi';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp, testSecretsDocument } from '../support/app';
import { FakeLastfm, md5Hex } from '../support/fake-lastfm';
import { FakeListenBrainz } from '../support/fake-listenbrainz';

const API_KEY = '0123456789abcdef0123456789abcdef';
const SECRET = 'owner-shared-secret-for-tests';
const ALICE = 'did:plc:alicealicealicealicealic';
const BOB = 'did:plc:bobbobbobbobbobbobbobbobb';
const UPSTREAM_ENV = {
  LASTFM_API_ROOT: 'https://lastfm.test/2.0/',
  LASTFM_AUTH_URL: 'https://lastfm.test/api/auth/',
  LISTENBRAINZ_API_ROOT: 'https://listenbrainz.test/',
};

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

interface World {
  app: TestApp;
  clock: FixedClock;
  lastfm: FakeLastfm;
  lb: FakeListenBrainz;
  journal: MemoryRevocations;
  sessions: WebSessions;
  box: Box;
  /** Cookie (and, for unsafe requests, Origin + X-CSRF-Token) headers of `token`. */
  headers(token: string, unsafe?: boolean): Record<string, string>;
  /** A new web session of `did`; returns its token. */
  signIn(did: string): string;
}

async function world(options: { lastfmKey?: boolean } = {}): Promise<World> {
  const clock = fixedClock();
  const lastfm = new FakeLastfm({ clock, apiKey: API_KEY, secret: SECRET });
  const lb = new FakeListenBrainz({ clock });
  const journal = new MemoryRevocations(clock);
  const doc = testSecretsDocument();
  const secrets = parseSecrets(
    options.lastfmKey === false ? doc : { ...doc, lastfm: { apiKey: API_KEY, sharedSecret: SECRET } },
  );
  const app = await startApp({
    clock,
    secrets,
    transport: routerTransport({ hosts: { 'lastfm.test': lastfm, 'listenbrainz.test': lb } }),
    features: [linksFeature({ revocations: journal })],
    env: UPSTREAM_ENV,
  });
  for (const did of [ALICE, BOB]) ensureAccount({ db: app.db, clock }, { did, verifiedHandle: null });
  const sessions = createWebSessions({ db: app.db, clock, random: seededRandom(42), revocations: journal });
  const box = createBox(secrets.encryptionKeys, seededRandom(3));
  return {
    app,
    clock,
    lastfm,
    lb,
    journal,
    sessions,
    box,
    headers: (token, unsafe = false) => ({
      cookie: `${SESSION_COOKIE}=${token}`,
      ...(unsafe ? { origin: TEST_PUBLIC_ORIGIN, 'x-csrf-token': csrfToken(box.csrfKey(), token) } : {}),
    }),
    signIn: (did) => sessions.create(did).token,
  };
}

afterEach(async () => {
  await closeApps();
});

async function call(w: World, method: string, path: string, init: { token: string; body?: unknown }) {
  const unsafe = method !== 'GET';
  const res = await w.app.fetch(path, {
    method,
    headers: {
      ...w.headers(init.token, unsafe),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  const body = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
  return { res, body };
}

function seedBackfillScrobble(w: World, i: number, did = ALICE): void {
  const at = `2026-01-10T00:00:0${i}.000000000Z`;
  const [artistKey, trackValue] = trackKey('A', `T${i}`);
  w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', did, at);
  w.app.db.run(
    `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,listened_at,created_at,indexed_at,artist_key,track_key)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    `at://${did}/com.example.atmusic.scrobble/r${i}`,
    `cid-${i}`,
    did,
    `r${i}`,
    `rev-${i}`,
    'A',
    `T${i}`,
    at,
    at,
    at,
    artistKey,
    trackValue,
  );
}

function links(w: World): LinkedAccountRow[] {
  return w.app.db.all<LinkedAccountRow>('SELECT * FROM linked_accounts ORDER BY created_at_ms, id');
}

function linkStates(w: World): Array<{ state_hash: string; did: string; session_hash: string; expires_at_ms: number }> {
  return w.app.db.all(
    'SELECT lower(hex(state_hash)) AS state_hash, did, lower(hex(session_hash)) AS session_hash, expires_at_ms FROM link_states',
  );
}

function bytes(blob: ArrayBuffer | Uint8Array): Uint8Array {
  return blob instanceof Uint8Array ? blob : new Uint8Array(blob);
}

function containsText(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'utf8'));
}

/** POST start for `token`; returns the state carried by the cb. */
async function startLastfm(w: World, token: string): Promise<{ state: string; authorizeUrl: URL }> {
  const { res, body } = await call(w, 'POST', '/api/v1/links/lastfm/start', { token });
  expect(res.status).toBe(200);
  expect(checkResponse('POST', '/api/v1/links/lastfm/start', { status: res.status, headers: res.headers, body })).toBe(
    'valid',
  );
  const authorizeUrl = new URL(body?.authorizeUrl as string);
  const cb = new URL(authorizeUrl.searchParams.get('cb') as string);
  return { state: cb.searchParams.get('state') as string, authorizeUrl };
}

describe('link routes', () => {
  it('uses two indexed bounded keyset scans and merges them without a global sort', async () => {
    const w = await world();
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(201), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential: 'lb-token' },
    );
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    seedBackfillScrobble(w, 1);
    seedBackfillScrobble(w, 2);
    const plans: Array<{ sql: string; params: SqlParam[]; detail: string[] }> = [];
    const originalAll = w.app.db.all.bind(w.app.db);
    w.app.db.all = <T>(sql: string, ...params: SqlParam[]): T[] => {
      if (sql.includes("SELECT 'scrobble' AS kind") || sql.includes("SELECT 'love' AS kind")) {
        const plan = originalAll<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params);
        plans.push({ sql, params, detail: plan.map((entry) => entry.detail) });
      }
      return originalAll<T>(sql, ...params);
    };

    expect(await runLinkBackfill(w.app.db, seededRandom(202), w.clock.nowMs(), 1)).toBe(1);
    expect(await runLinkBackfill(w.app.db, seededRandom(203), w.clock.nowMs(), 1)).toBe(1);
    expect(await runLinkBackfill(w.app.db, seededRandom(215), w.clock.nowMs(), 1)).toBe(1);
    expect(plans.length).toBeGreaterThanOrEqual(4);
    for (const query of plans) {
      expect(query.sql).not.toMatch(/\bUNION\b|\bOFFSET\b|\bOR\b/i);
      expect(query.params.at(-1)).toBeGreaterThan(0);
      expect(query.params.at(-1)).toBeLessThanOrEqual(500);
      expect(query.detail.join(' ')).not.toMatch(/TEMP B-TREE|SCAN \(subquery/i);
      expect(query.detail.join(' ')).toMatch(
        query.sql.includes('scrobbles s') ? /scrobbles_owner_time/ : /loves_owner_time/,
      );
    }
    expect(w.app.db.one('SELECT id FROM linked_accounts WHERE id=?', linked.link.id)).toEqual({ id: linked.link.id });
  });

  it('does not enqueue a historical love after deletion while identity resolution is pending', async () => {
    const w = await world();
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(204), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential: 'lb-token' },
    );
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    const uri = `at://${ALICE}/com.example.atmusic.love/history-deletion-race`;
    const mbid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    w.app.db.run(
      `INSERT INTO loves(uri,did,rkey,cid,artist,track,artist_key,track_key,recording_mbid,created_at,indexed_at)
       VALUES(?,?,'history-deletion-race','cid-old','Artist','Track','artist-key','track-key',?,?,?)`,
      uri,
      ALICE,
      mbid,
      '2026-01-10T00:00:00.000000000Z',
      '2026-01-10T00:00:00.000000000Z',
    );
    w.app.db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
       VALUES(?,'love:old','present','snapshot',NULL,?)`,
      uri,
      w.clock.nowMs(),
    );
    const pending = runLinkBackfill(w.app.db, seededRandom(206), w.clock.nowMs());
    w.app.db.run('DELETE FROM loves WHERE uri=?', uri);
    w.app.db.run("UPDATE love_incarnations SET state='deleted' WHERE uri=?", uri);
    enqueueForwards(w.app.db, {
      did: ALICE,
      now: w.clock.nowMs(),
      random: seededRandom(207),
      items: [
        {
          kind: 'unlove',
          operationId: 'delete-old',
          payload: { artist: 'Artist', track: 'Track', recordingMbid: mbid },
        },
      ],
    });

    expect(await pending).toBe(1);
    expect(w.app.db.all<{ kind: string }>('SELECT kind FROM forward_outbox ORDER BY rowid')).toEqual([
      { kind: 'unlove' },
    ]);
    expect(w.app.db.one('SELECT id FROM linked_accounts WHERE id=?', linked.link.id)).toEqual({ id: linked.link.id });
  });

  it('does not enqueue an old historical love after the record is replaced during identity resolution', async () => {
    const w = await world();
    saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(208), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential: 'lb-token' },
    );
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    const uri = `at://${ALICE}/com.example.atmusic.love/history-replacement-race`;
    const oldMbid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newMbid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    w.app.db.run(
      `INSERT INTO loves(uri,did,rkey,cid,artist,track,artist_key,track_key,recording_mbid,created_at,indexed_at)
       VALUES(?,?,'history-replacement-race','cid-old','Old Artist','Old Track','artist-old','track-old',?,?,?)`,
      uri,
      ALICE,
      oldMbid,
      '2026-01-10T00:00:00.000000000Z',
      '2026-01-10T00:00:00.000000000Z',
    );
    w.app.db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
       VALUES(?,'love:old','present','snapshot',NULL,?)`,
      uri,
      w.clock.nowMs(),
    );
    const pending = runLinkBackfill(w.app.db, seededRandom(210), w.clock.nowMs());
    w.app.db.run(
      `UPDATE loves SET cid='cid-new',artist='New Artist',track='New Track',artist_key='artist-new',track_key='track-new',
         recording_mbid=?,created_at='2026-01-11T00:00:00.000000000Z' WHERE uri=?`,
      newMbid,
      uri,
    );
    w.app.db.run("UPDATE love_incarnations SET incarnation_key='love:new',state='present' WHERE uri=?", uri);
    enqueueForwards(w.app.db, {
      did: ALICE,
      now: w.clock.nowMs(),
      random: seededRandom(211),
      items: [
        {
          kind: 'love',
          operationId: 'love:new',
          payload: { artist: 'New Artist', track: 'New Track', recordingMbid: newMbid },
        },
      ],
    });

    expect(await pending).toBe(1);
    expect(
      w.app.db.all<{ kind: string; dedupe_key: string }>('SELECT kind,dedupe_key FROM forward_outbox ORDER BY rowid'),
    ).toEqual([{ kind: 'love', dedupe_key: 'love:new' }]);
  });

  it('settles a staged deleted candidate and keeps backfill progress internally consistent', async () => {
    const w = await world();
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(212), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential: 'lb-token' },
    );
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    const uri = `at://${ALICE}/com.example.atmusic.love/progress-deletion`;
    w.app.db.run(
      `INSERT INTO loves(uri,did,rkey,cid,artist,track,artist_key,track_key,recording_mbid,created_at,indexed_at)
       VALUES(?,?,'progress-deletion','cid-progress','Artist','Track','artist-key','track-key',?, ?, ?)`,
      uri,
      ALICE,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '2026-01-10T00:00:00.000000000Z',
      '2026-01-10T00:00:00.000000000Z',
    );
    w.app.db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
       VALUES(?,'love:progress','present','snapshot',NULL,?)`,
      uri,
      w.clock.nowMs(),
    );
    expect(await runLinkBackfill(w.app.db, seededRandom(213), w.clock.nowMs())).toBe(1);
    expect(w.app.db.one('SELECT backfill_done,backfill_total FROM linked_accounts WHERE id=?', linked.link.id)).toEqual(
      {
        backfill_done: 0,
        backfill_total: 1,
      },
    );
    w.app.db.run('DELETE FROM loves WHERE uri=?', uri);
    w.app.db.run("UPDATE love_incarnations SET state='deleted' WHERE uri=?", uri);
    expect(await runLinkBackfill(w.app.db, seededRandom(214), w.clock.nowMs())).toBe(1);
    expect(
      w.app.db.one(
        'SELECT backfill_state,backfill_done,backfill_total FROM linked_accounts WHERE id=?',
        linked.link.id,
      ),
    ).toEqual({ backfill_state: 'done', backfill_done: 1, backfill_total: 1 });
    expect(w.app.db.one('SELECT count(*) AS n FROM link_backfill_items WHERE link_id=?', linked.link.id)).toEqual({
      n: 0,
    });
    expect(w.app.db.one('SELECT count(*) AS n FROM forward_outbox WHERE link_id=?', linked.link.id)).toEqual({ n: 0 });
  });

  it('backfill scans indexed history newest-first in bounded resumable chunks without upstream calls', async () => {
    const w = await world();
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(101), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential: 'lb-token' },
    );
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    expect(w.app.db.one('SELECT indexing_state FROM users WHERE did=?', ALICE)).toEqual({ indexing_state: 'current' });
    expect(
      w.app.db.one(
        'SELECT status,forward_scrobbles,backfill_state,backfill_run_revision FROM linked_accounts WHERE id=?',
        linked.link.id,
      ),
    ).toMatchObject({
      status: 'active',
      forward_scrobbles: 1,
      backfill_state: 'pending',
      backfill_run_revision: 1,
    });
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    const batch = 501;
    for (let i = 1; i <= batch; i++) {
      const artist = `Backfill Artist ${i}`;
      const track = `Backfill Track ${i}`;
      const listenedAt = new Date(Date.parse('2026-01-10T00:00:00Z') + i * 1000).toISOString();
      const ns = parseRfc3339(listenedAt);
      const [artistKey, trackValue] = trackKey(artist, track);
      const key = await listenKey({ did: ALICE, listenedAtNs: ns as bigint, artist, track });
      w.app.db.run(
        `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,album,listened_at,created_at,duration_seconds,
          recording_mbid,indexed_at,artist_key,track_key,album_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `at://${ALICE}/com.example.atmusic.scrobble/r${i}`,
        `cid-${i}`,
        ALICE,
        `r${i}`,
        `rev-${i}`,
        artist,
        track,
        null,
        listenedAt.replace(/\.\d{3}Z$/, '.000000000Z'),
        listenedAt.replace(/\.\d{3}Z$/, '.000000000Z'),
        null,
        null,
        listenedAt.replace(/\.\d{3}Z$/, '.000000000Z'),
        artistKey,
        trackValue,
        null,
      );
      if (i <= 2) {
        w.app.db.run(
          'INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq) VALUES(?,?,?,?,?,?)',
          ALICE,
          key,
          i === 1 ? 'live' : 'snapshot',
          null,
          w.clock.nowMs(),
          i,
        );
      }
      expect(key).toHaveLength(64);
    }
    expect(await runLinkBackfill(w.app.db, seededRandom(102), w.clock.nowMs())).toBe(500);
    expect(
      w.app.db.one(
        'SELECT backfill_state,backfill_done,backfill_total FROM linked_accounts WHERE id=?',
        linked.link.id,
      ),
    ).toEqual({ backfill_state: 'running', backfill_done: 0, backfill_total: 500 });
    expect(w.app.db.one('SELECT count(*) AS n FROM forward_outbox WHERE link_id=?', linked.link.id)).toEqual({ n: 0 });
    expect(await runLinkBackfill(w.app.db, seededRandom(107), w.clock.nowMs())).toBe(500);
    expect(w.app.db.one('SELECT backfill_done,backfill_total FROM linked_accounts WHERE id=?', linked.link.id)).toEqual(
      {
        backfill_done: 500,
        backfill_total: batch - 1,
      },
    );
    expect(await runLinkBackfill(w.app.db, seededRandom(108), w.clock.nowMs())).toBe(1);
    expect(w.app.db.one('SELECT count(*) AS n FROM forward_outbox WHERE link_id=?', linked.link.id)).toEqual({
      n: 500,
    });
    expect(
      w.app.db.one('SELECT priority FROM forward_outbox WHERE link_id=? ORDER BY rowid LIMIT 1', linked.link.id),
    ).toEqual({ priority: 1 });
    const first = JSON.parse(
      w.app.db.one<{ payload_json: string }>(
        'SELECT payload_json FROM forward_outbox WHERE link_id=? ORDER BY rowid LIMIT 1',
        linked.link.id,
      )?.payload_json ?? '{}',
    ) as { listen?: { track?: string } };
    expect(first.listen?.track).toBe('Backfill Track 501');
    enqueueForwards(w.app.db, {
      did: ALICE,
      now: w.clock.nowMs(),
      random: seededRandom(106),
      items: [
        {
          kind: 'scrobble',
          listenKey: 'live-priority-key',
          payload: { listen: { artist: 'Live', track: 'Now', timestamp: 1 } },
        },
      ],
    });
    const due = dueRows(w.app.db, linked.link.id, linked.link.generation, 'scrobble', w.clock.nowMs(), 10);
    expect(due[0]).toMatchObject({ priority: 0, dedupe_key: 'live-priority-key' });
    expect(await runLinkBackfill(w.app.db, seededRandom(103), w.clock.nowMs())).toBe(0);
    expect(
      w.app.db.one(
        'SELECT backfill_state,backfill_done,backfill_total FROM linked_accounts WHERE id=?',
        linked.link.id,
      ),
    ).toEqual({ backfill_state: 'done', backfill_done: 500, backfill_total: batch - 1 });
    const liveKey = await listenKey({
      did: ALICE,
      listenedAtNs: parseRfc3339('2026-01-10T00:00:01.000Z') as bigint,
      artist: 'Backfill Artist 1',
      track: 'Backfill Track 1',
    });
    expect(
      w.app.db.one('SELECT 1 AS yes FROM forward_outbox WHERE link_id=? AND dedupe_key=?', linked.link.id, liveKey),
    ).toBeNull();
    expect(w.lb.calls.count()).toBe(0);
  });

  it('ListenBrainz backfill imports only known indexed loves with a submitted or matched MBID', async () => {
    const w = await world();
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(104), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_lb', credential: 'lb-token' },
    );
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    const [artistKey, trackKeyValue] = trackKey('Matched Artist', 'Matched Song');
    const [, matchedAlbumKey] = albumKey('Matched Artist', 'Album') as [string, string];
    const incarnationKey = 'love:matched-incarnation';
    const loveUri = `at://${ALICE}/com.example.atmusic.love/love-matched`;
    w.app.db.run(
      `INSERT INTO loves(uri,did,rkey,cid,artist,track,album,artist_key,track_key,recording_mbid,created_at,indexed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      loveUri,
      ALICE,
      'love-matched',
      'cid-love',
      'Matched Artist',
      'Matched Song',
      'Album',
      artistKey,
      trackKeyValue,
      null,
      '2026-01-14T00:00:00.000000000Z',
      '2026-01-15T12:00:00.000000000Z',
    );
    w.app.db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
       VALUES(?,?,'present','snapshot',NULL,?)`,
      loveUri,
      incarnationKey,
      w.clock.nowMs(),
    );
    w.app.db.run(
      'INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq) VALUES(?,?,?,?,?,?)',
      ALICE,
      incarnationKey,
      'snapshot',
      null,
      w.clock.nowMs(),
      1,
    );
    w.app.db.run(
      `INSERT INTO mb_tracks(artist_key,track_key,album_key,status,recording_mbid,created_at_ms)
       VALUES(?,?,?,'matched','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',?)`,
      artistKey,
      trackKeyValue,
      matchedAlbumKey,
      w.clock.nowMs(),
    );
    const importedUri = `at://${ALICE}/com.example.atmusic.love/love-imported-unknown`;
    w.app.db.run(
      `INSERT INTO loves(uri,did,rkey,cid,artist,track,album,artist_key,track_key,recording_mbid,created_at,indexed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      importedUri,
      ALICE,
      'love-imported-unknown',
      'cid-imported',
      'Unknown Artist',
      'Unknown Song',
      null,
      'unknown-artist',
      'unknown-track',
      null,
      '2026-01-14T00:00:00.000000000Z',
      '2026-01-15T12:00:00.000000000Z',
    );
    w.app.db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
       VALUES(?,?,'present','import',NULL,?)`,
      importedUri,
      'love:unknown-import',
      w.clock.nowMs(),
    );

    expect(await runLinkBackfill(w.app.db, seededRandom(105), w.clock.nowMs())).toBe(2);
    expect(await runLinkBackfill(w.app.db, seededRandom(110), w.clock.nowMs())).toBe(1);
    const rows = w.app.db.all<{ kind: string; payload_json: string }>(
      'SELECT kind,payload_json FROM forward_outbox WHERE link_id=?',
      linked.link.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('love');
    expect(JSON.parse(rows[0]?.payload_json ?? '{}')).toMatchObject({
      artist: 'Matched Artist',
      track: 'Matched Song',
      recordingMbid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(w.lb.calls.count()).toBe(0);
  });

  it('Last.fm backfill keeps the 13-day listen window while retaining older loves', async () => {
    const w = await world();
    const sk = w.lastfm.addSession('alice_fm');
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(107), box: w.box },
      { did: ALICE, service: 'lastfm', remoteUser: 'alice_fm', credential: sk },
    );
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    for (const [suffix, listenedAt] of [
      ['old', '2025-12-31T00:00:00.000Z'],
      ['recent', '2026-01-10T00:00:00.000Z'],
    ] as const) {
      const artist = `Age ${suffix}`;
      const track = `Song ${suffix}`;
      const [artistKey, trackValue] = trackKey(artist, track);
      const storageTime = listenedAt.replace(/\.\d{3}Z$/, '.000000000Z');
      w.app.db.run(
        `INSERT INTO scrobbles(uri,cid,did,rkey,revision,artist,track,album,listened_at,created_at,duration_seconds,
          recording_mbid,indexed_at,artist_key,track_key,album_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `at://${ALICE}/com.example.atmusic.scrobble/${suffix}`,
        `cid-${suffix}`,
        ALICE,
        suffix,
        `rev-${suffix}`,
        artist,
        track,
        null,
        storageTime,
        storageTime,
        null,
        null,
        storageTime,
        artistKey,
        trackValue,
        null,
      );
    }
    const [artistKey, trackValue] = trackKey('Older Love', 'Loved Track');
    const loveUri = `at://${ALICE}/com.example.atmusic.love/old-love`;
    w.app.db.run(
      `INSERT INTO loves(uri,did,rkey,cid,artist,track,album,artist_key,track_key,recording_mbid,created_at,indexed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      loveUri,
      ALICE,
      'old-love',
      'cid-love',
      'Older Love',
      'Loved Track',
      null,
      artistKey,
      trackValue,
      null,
      '2020-01-01T00:00:00.000000000Z',
      '2026-01-15T12:00:00.000000000Z',
    );
    w.app.db.run(
      `INSERT INTO love_incarnations(uri,incarnation_key,state,path,source_service,updated_at_ms)
       VALUES(?,?,'present','snapshot',NULL,?)`,
      loveUri,
      'love:old-love',
      w.clock.nowMs(),
    );
    expect(await runLinkBackfill(w.app.db, seededRandom(108), w.clock.nowMs())).toBe(2);
    expect(await runLinkBackfill(w.app.db, seededRandom(111), w.clock.nowMs())).toBe(2);
    const rows = w.app.db.all<{ kind: string; payload_json: string }>(
      'SELECT kind,payload_json FROM forward_outbox WHERE link_id=?',
      linked.link.id,
    );
    expect(rows.map((row) => row.kind).sort()).toEqual(['love', 'scrobble']);
    expect(rows.map((row) => row.payload_json).join('\n')).not.toContain('Song old');
    expect(w.lastfm.calls.count()).toBe(0);
  });

  it('waits for initial indexing and rescans after a completed later snapshot', async () => {
    const w = await world();
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(301), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'late_snapshot', credential: 'lb-token' },
    ).link;
    expect(await runLinkBackfill(w.app.db, seededRandom(302), w.clock.nowMs())).toBe(0);
    expect(
      w.app.db.one<{ backfill_state: string }>('SELECT backfill_state FROM linked_accounts WHERE id=?', linked.id),
    ).toEqual({ backfill_state: 'pending' });

    const addSnapshotRecord = async (i: number, rev: string) => {
      seedBackfillScrobble(w, i);
      const at = `2026-01-10T00:00:0${i}.000000000Z`;
      const key = projectionListenKey(ALICE, at, 'a', `t${i}`);
      admitForwardIdentity(w.app.db, { did: ALICE, identityKey: key, path: 'snapshot', now: w.clock.nowMs() });
      const generation = w.app.db.one<{ generation: number }>(
        'SELECT generation FROM users WHERE did=?',
        ALICE,
      )!.generation;
      w.app.db.run(
        `INSERT INTO repo_jobs(did,kind,generation,head_rev,due_at,updated_at_ms)
         VALUES(?,'snapshot',?,?,?,?) ON CONFLICT(did,kind) DO UPDATE SET generation=excluded.generation,
         head_rev=excluded.head_rev,due_at=excluded.due_at,updated_at_ms=excluded.updated_at_ms`,
        ALICE,
        generation,
        rev,
        w.clock.nowMs(),
        w.clock.nowMs(),
      );
      expect(
        completeSnapshot(w.app.db, {
          did: ALICE,
          generation,
          headRev: rev,
          accountActive: true,
          nowNs: BigInt(w.clock.nowMs()) * 1_000_000n,
        }).outcome,
      ).toBe('complete');
    };

    await addSnapshotRecord(1, 'rev1');
    expect(await runLinkBackfill(w.app.db, seededRandom(303), w.clock.nowMs())).toBe(1);
    expect(await runLinkBackfill(w.app.db, seededRandom(305), w.clock.nowMs())).toBe(1);
    expect(w.app.db.one('SELECT backfill_state FROM linked_accounts WHERE id=?', linked.id)).toEqual({
      backfill_state: 'done',
    });

    await addSnapshotRecord(2, 'rev2');
    expect(w.app.db.one('SELECT backfill_state,backfill_cursor FROM linked_accounts WHERE id=?', linked.id)).toEqual({
      backfill_state: 'pending',
      backfill_cursor: null,
    });
    expect(await runLinkBackfill(w.app.db, seededRandom(304), w.clock.nowMs())).toBe(2);
    expect(await runLinkBackfill(w.app.db, seededRandom(306), w.clock.nowMs())).toBe(2);
    expect(w.app.db.one('SELECT count(*) AS n FROM forward_outbox WHERE link_id=?', linked.id)).toEqual({ n: 2 });
  });

  it('an async page cannot enqueue or overwrite cursor after an off/on reset in the same generation', async () => {
    const w = await world();
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did=?", ALICE);
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(311), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'reset_race', credential: 'lb-token' },
    ).link;
    seedBackfillScrobble(w, 1);
    seedBackfillScrobble(w, 2);
    const oldPage = runLinkBackfill(w.app.db, seededRandom(312), w.clock.nowMs(), 1);
    expect(patchLink({ db: w.app.db, clock: w.clock }, ALICE, linked.id, { forwardScrobbles: false })).not.toBeNull();
    expect(patchLink({ db: w.app.db, clock: w.clock }, ALICE, linked.id, { forwardScrobbles: true })).not.toBeNull();
    seedBackfillScrobble(w, 3);
    await oldPage;
    expect(w.app.db.one('SELECT count(*) AS n FROM forward_outbox WHERE link_id=?', linked.id)).toEqual({ n: 0 });
    expect(w.app.db.one('SELECT backfill_state,backfill_cursor FROM linked_accounts WHERE id=?', linked.id)).toEqual({
      backfill_state: 'pending',
      backfill_cursor: null,
    });
    expect(await runLinkBackfill(w.app.db, seededRandom(313), w.clock.nowMs(), 10)).toBe(3);
    expect(await runLinkBackfill(w.app.db, seededRandom(314), w.clock.nowMs(), 10)).toBe(3);
    expect(w.app.db.one('SELECT count(*) AS n FROM forward_outbox WHERE link_id=?', linked.id)).toEqual({ n: 3 });
  });

  it('rotates bounded discovery across links and pauses history admission at its queue high-water mark', async () => {
    const w = await world();
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', ALICE, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run('INSERT OR IGNORE INTO users(did,joined_at) VALUES(?,?)', BOB, '2026-01-01T00:00:00.000000000Z');
    w.app.db.run("UPDATE users SET indexing_state='current' WHERE did IN (?,?)", ALICE, BOB);
    const alice = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(331), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice_fair', credential: 'lb-token' },
    ).link;
    const bob = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(332), box: w.box },
      { did: BOB, service: 'listenbrainz', remoteUser: 'bob_fair', credential: 'lb-token' },
    ).link;
    seedBackfillScrobble(w, 1, ALICE);
    seedBackfillScrobble(w, 1, BOB);
    const first = alice.id < bob.id ? alice : bob;
    const second = first.id === alice.id ? bob : alice;
    expect(await runLinkBackfill(w.app.db, seededRandom(333), w.clock.nowMs())).toBe(1);
    expect(w.app.db.one('SELECT backfill_total FROM linked_accounts WHERE id=?', first.id)).toEqual({
      backfill_total: 1,
    });
    expect(w.app.db.one('SELECT backfill_total FROM linked_accounts WHERE id=?', second.id)).toEqual({
      backfill_total: 0,
    });
    expect(await runLinkBackfill(w.app.db, seededRandom(334), w.clock.nowMs())).toBe(1);
    expect(w.app.db.one('SELECT backfill_total FROM linked_accounts WHERE id=?', second.id)).toEqual({
      backfill_total: 1,
    });

    w.app.db.run(
      `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<=?)
       INSERT INTO forward_outbox(id,link_id,did,kind,dedupe_key,payload_json,state,attempts,due_at,last_error,
         created_at_ms,updated_at_ms,priority)
       SELECT 'history-'||i,?,?, 'scrobble','queue-key-'||i,'{}','queued',0,?,NULL,?,?,1 FROM seq`,
      BACKFILL_HISTORY_QUEUE_HIGH_WATER,
      first.id,
      first.did,
      w.clock.nowMs(),
      w.clock.nowMs(),
      w.clock.nowMs(),
    );
    expect(await runLinkBackfill(w.app.db, seededRandom(335), w.clock.nowMs())).toBe(0);
    expect(
      w.app.db.one('SELECT backfill_state,backfill_cursor,backfill_done FROM linked_accounts WHERE id=?', first.id),
    ).toEqual({
      backfill_state: 'running',
      backfill_cursor: null,
      backfill_done: 0,
    });
    expect(w.app.db.one('SELECT count(*) AS n FROM forward_outbox WHERE link_id=? AND priority=1', first.id)).toEqual({
      n: BACKFILL_HISTORY_QUEUE_HIGH_WATER + 1,
    });
  });

  it('backs off a bounded number of times, exposes a safe terminal error, and toggle resets retry state', async () => {
    const w = await world();
    const linked = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(321), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'retry_limit', credential: 'lb-token' },
    ).link;
    const revision = linked.backfill_run_revision;
    w.app.db.run("UPDATE linked_accounts SET backfill_state='running' WHERE id=?", linked.id);
    let now = w.clock.nowMs();
    for (let n = 1; n < BACKFILL_MAX_FAILURES; n++) {
      const retry = recordBackfillFailure(
        w.app.db,
        { id: linked.id, generation: linked.generation, backfill_run_revision: revision },
        now,
      );
      expect(retry).toMatchObject({ failures: n, exhausted: false });
      expect(retry?.retryAt).toBeGreaterThan(now);
      now = retry?.retryAt ?? now;
    }
    expect(
      recordBackfillFailure(
        w.app.db,
        { id: linked.id, generation: linked.generation, backfill_run_revision: revision },
        now,
      ),
    ).toEqual({ failures: BACKFILL_MAX_FAILURES, retryAt: null, exhausted: true });
    expect(
      w.app.db.one(
        'SELECT backfill_state,backfill_last_error,backfill_next_attempt_ms FROM linked_accounts WHERE id=?',
        linked.id,
      ),
    ).toEqual({
      backfill_state: 'skipped',
      backfill_last_error: 'retry_exhausted',
      backfill_next_attempt_ms: null,
    });
    const token = w.signIn(ALICE);
    const response = await call(w, 'GET', '/api/v1/links', { token });
    expect(response.res.status).toBe(200);
    expect(response.body?.items).toMatchObject([
      { id: linked.id, sync: { backfill: { state: 'skipped', lastError: 'retry_exhausted' } } },
    ]);

    expect(patchLink({ db: w.app.db, clock: w.clock }, ALICE, linked.id, { forwardScrobbles: false })).not.toBeNull();
    expect(patchLink({ db: w.app.db, clock: w.clock }, ALICE, linked.id, { forwardScrobbles: true })).not.toBeNull();
    expect(
      recordBackfillFailure(
        w.app.db,
        { id: linked.id, generation: linked.generation, backfill_run_revision: revision },
        now,
      ),
    ).toBeNull();
    expect(
      w.app.db.one(
        'SELECT backfill_state,backfill_last_error,backfill_failures FROM linked_accounts WHERE id=?',
        linked.id,
      ),
    ).toEqual({
      backfill_state: 'pending',
      backfill_last_error: null,
      backfill_failures: 0,
    });
  });

  it.each(['logout', 'logout-all', 'disconnect', 'expiry'] as const)(
    'Last.fm callback cannot relink after %s while auth.getSession is in flight, even with a new same-DID cookie',
    async (revocation) => {
      const w = await world();
      const token = w.signIn(ALICE);
      const { state } = await startLastfm(w, token);
      const lfToken = w.lastfm.issueToken(undefined, API_KEY);
      w.lastfm.authorizeToken(lfToken, 'alice_fm');
      let reached!: () => void;
      let release!: () => void;
      const upstreamReached = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const upstreamRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalFetch = w.lastfm.fetch.bind(w.lastfm);
      w.lastfm.fetch = async (req: Request) => {
        reached();
        await upstreamRelease;
        return originalFetch(req);
      };
      const callback = `/api/v1/links/lastfm/callback?state=${state}&token=${lfToken}`;
      const pending = w.app.fetch(callback, { headers: w.headers(token) });
      await upstreamReached;
      if (revocation === 'logout') expect(w.sessions.logout(token)).toBe(true);
      else if (revocation === 'logout-all') expect(w.sessions.logoutAll(ALICE)).toBe(1);
      else if (revocation === 'disconnect') {
        const { disconnectLocally } = await import('../../../src/http/auth');
        disconnectLocally({ db: w.app.db, revocations: w.journal }, ALICE, w.clock.nowMs());
      } else {
        w.app.db.run('UPDATE web_sessions SET expires_at_ms = ? WHERE did = ?', w.clock.nowMs() - 1, ALICE);
      }
      const replacement = w.sessions.create(ALICE).token;
      release();
      const answer = await pending;
      expect(answer.status).toBe(401);
      expect(answer.headers.get('set-cookie')).toBeNull();
      expect(await answer.json()).toMatchObject({ error: { code: 'unauthenticated' } });
      expect(w.headers(replacement).cookie).not.toBe(w.headers(token).cookie);
      expect(links(w)).toEqual([]);
      expect(w.app.db.one('SELECT 1 FROM forward_outbox')).toBeNull();
      expect(w.app.db.one('SELECT 1 FROM link_states')).toBeNull();
      expect(w.journal.entries().some((e) => e.kind === 'linked_account')).toBe(false);
      const dir = mkdtempSync(join(tmpdir(), 'atmusic-link-race-'));
      const path = join(dir, 'reopened.db');
      await sqlite.backup(w.app.db.raw, path);
      const reopened = openSqliteDb(path, { busyTimeoutMs: 200 });
      try {
        expect(reopened.one('SELECT 1 FROM linked_accounts')).toBeNull();
        expect(reopened.one('SELECT 1 FROM link_states')).toBeNull();
        expect(reopened.one('SELECT 1 FROM forward_outbox')).toBeNull();
      } finally {
        reopened.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('ListenBrainz link cannot save or requeue held rows after logout-all during validation', async () => {
    const w = await world();
    const token = w.signIn(ALICE);
    w.lb.addToken('Alice_LB', 'lb-token-1');
    const initial = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(99), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'previous_user', credential: 'old-lb-token' },
    );
    w.app.db.run(
      `INSERT INTO forward_outbox (id, link_id, did, kind, dedupe_key, payload_json, state, attempts, due_at,
         last_error, created_at_ms, updated_at_ms)
       VALUES ('held-row-1', ?, ?, 'scrobble', 'cid-1', '{}', 'held', 0, ?, 'upstream_error', ?, ?)`,
      initial.link.id,
      ALICE,
      w.clock.nowMs(),
      w.clock.nowMs(),
      w.clock.nowMs(),
    );
    let reached!: () => void;
    let release!: () => void;
    const upstreamReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const upstreamRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalFetch = w.lb.fetch.bind(w.lb);
    w.lb.fetch = async (req: Request) => {
      reached();
      await upstreamRelease;
      return originalFetch(req);
    };
    const pending = w.app.fetch('/api/v1/links/listenbrainz', {
      method: 'POST',
      headers: { ...w.headers(token, true), 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'lb-token-1' }),
    });
    await upstreamReached;
    expect(w.sessions.logoutAll(ALICE)).toBe(1);
    const replacement = w.sessions.create(ALICE).token;
    release();
    const answer = await pending;
    expect(answer.status).toBe(401);
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(await answer.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(w.headers(replacement).cookie).not.toBe(w.headers(token).cookie);
    expect(links(w)).toEqual([initial.link]);
    expect(w.app.db.one<{ state: string }>("SELECT state FROM forward_outbox WHERE id = 'held-row-1'")?.state).toBe(
      'held',
    );
    const dir = mkdtempSync(join(tmpdir(), 'atmusic-held-link-'));
    const path = join(dir, 'reopened.db');
    await sqlite.backup(w.app.db.raw, path);
    const reopened = openSqliteDb(path, { busyTimeoutMs: 200 });
    try {
      expect(reopened.one<{ state: string }>("SELECT state FROM forward_outbox WHERE id = 'held-row-1'")?.state).toBe(
        'held',
      );
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Last.fm link start returns LASTFM_AUTH_URL with our api_key and a cb carrying a single-use state; the callback calls signed auth.getSession and stores the sk sealed; reusing the state is 400', async () => {
    const w = await world();
    const token = w.signIn(ALICE);

    const { state, authorizeUrl } = await startLastfm(w, token);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe('https://lastfm.test/api/auth/');
    expect([...authorizeUrl.searchParams.keys()]).toEqual(['api_key', 'cb']);
    expect(authorizeUrl.searchParams.get('api_key')).toBe(API_KEY);
    const cb = new URL(authorizeUrl.searchParams.get('cb') as string);
    expect(`${cb.origin}${cb.pathname}`).toBe(`${TEST_PUBLIC_ORIGIN}/api/v1/links/lastfm/callback`);
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    // Stored only as hashes, bound to this session's token hash, valid 600 s.
    expect(linkStates(w)).toEqual([
      {
        state_hash: sha256Hex(state),
        did: ALICE,
        session_hash: sha256Hex(token),
        expires_at_ms: w.clock.nowMs() + LINK_STATE_TTL_MS,
      },
    ]);
    expect(LINK_STATE_TTL_MS).toBe(600_000);

    // The user approves on Last.fm; Last.fm redirects back with ?state&token.
    // A token shaped like the ones last.fm issues today: mixed case, digits, `-` and `_` (not hex).
    const lfToken = w.lastfm.issueToken('Ab3dE9F2gh7JKl0m-NoP4qr_S-TuvwXy', API_KEY);
    w.lastfm.authorizeToken(lfToken, 'alice_fm');
    const callback = `/api/v1/links/lastfm/callback?state=${state}&token=${lfToken}`;
    const first = await w.app.fetch(callback, { headers: w.headers(token) });
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('/settings/links');

    // One signed auth.getSession, which the fake accepted only because api_sig verified.
    const getSession = w.lastfm.calls.filter({ nsid: 'auth.getSession' });
    expect(getSession).toHaveLength(1);
    expect(getSession[0]?.status).toBe(200);
    expect(getSession[0]?.method).toBe('POST');
    expect(getSession[0]?.params.api_key).toEqual([API_KEY]);
    expect(getSession[0]?.params.api_sig?.[0]).toMatch(/^[0-9a-f]{32}$/);

    // The sk is stored sealed: the ciphertext opens to the session key under this row's AAD only.
    const sk = md5Hex('fake-lastfm-session:alice_fm:1');
    const [row, ...rest] = links(w);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      did: ALICE,
      service: 'lastfm',
      remote_user: 'alice_fm',
      status: 'active',
      key_id: 'e1',
    });
    const sealed = bytes(row?.credential_ciphertext as ArrayBuffer);
    expect(containsText(sealed, sk)).toBe(false);
    expect(w.box.openText('linked-lastfm', sealed, linkedAad(ALICE, 'lastfm'))).toBe(sk);
    expect(() => w.box.openText('linked-lastfm', sealed, linkedAad(BOB, 'lastfm'))).toThrow(BoxError);
    expect(linkStates(w)).toEqual([]);

    // Reusing the state: 400, no second upstream call, the link unchanged.
    const again = await w.app.fetch(callback, { headers: w.headers(token) });
    expect(again.status).toBe(400);
    const againBody = (await again.json()) as { error: { code: string } };
    expect(checkResponse('GET', callback, { status: 400, headers: again.headers, body: againBody })).toBe('valid');
    expect(againBody.error.code).toBe('bad_request');
    expect(w.lastfm.calls.count({ nsid: 'auth.getSession' })).toBe(1);
    expect(links(w)).toEqual([row]);
    // A malformed query (a repeated state) is 400 as well, before any state is looked at.
    const repeated = await w.app.fetch(`${callback}&state=${state}`, { headers: w.headers(token) });
    expect(repeated.status).toBe(400);
    const repeatedBody = (await repeated.json()) as { error: { code: string } };
    expect(checkResponse('GET', callback, { status: 400, headers: repeated.headers, body: repeatedBody })).toBe(
      'valid',
    );
    expect(repeatedBody.error.code).toBe('bad_request');
    expect(w.lastfm.calls.count({ nsid: 'auth.getSession' })).toBe(1);

    // The list shows the link without its credential.
    const list = await call(w, 'GET', '/api/v1/links', { token });
    expect(list.res.status).toBe(200);
    expect(checkResponse('GET', '/api/v1/links', { status: 200, headers: list.res.headers, body: list.body })).toBe(
      'valid',
    );
    expect(list.body).toEqual({
      items: [
        {
          id: row?.id,
          service: 'lastfm',
          remoteUser: 'alice_fm',
          forwardScrobbles: true,
          forwardNowPlaying: true,
          status: 'active',
          lastError: null,
          sync: { backfill: { state: 'pending', done: 0, total: 0 }, pullEnabled: true, queued: 0, failed: 0 },
          createdAt: '2026-01-15T12:00:00.000Z',
          updatedAt: '2026-01-15T12:00:00.000Z',
        },
      ],
    });
    expect(JSON.stringify(list.body)).not.toContain(sk);
    // No log line carries the sk or the Last.fm token of the callback query.
    expect(w.app.log.lines.join('\n')).not.toContain(sk);
    expect(w.app.log.lines.join('\n')).not.toContain(lfToken);
  });

  it('a ListenBrainz token is validated upstream; an invalid one is 422; a valid one is stored sealed with user_name', async () => {
    const w = await world();
    const token = w.signIn(ALICE);
    const lbToken = '5c7f3a3e-2f1d-4c1b-9a77-0d1e2f3a4b5c';
    w.lb.addToken('Alice_LB', lbToken);

    const bad = await call(w, 'POST', '/api/v1/links/listenbrainz', {
      token,
      body: { token: 'ffffffff-ffff-4fff-bfff-ffffffffffff' },
    });
    expect(bad.res.status).toBe(422);
    expect(
      checkResponse('POST', '/api/v1/links/listenbrainz', { status: 422, headers: bad.res.headers, body: bad.body }),
    ).toBe('valid');
    expect((bad.body as { error: { fields?: Record<string, string> } }).error.fields).toHaveProperty('token');
    expect(w.lb.calls.count({ path: '/1/validate-token' })).toBe(1);
    expect(links(w)).toEqual([]);

    const good = await call(w, 'POST', '/api/v1/links/listenbrainz', { token, body: { token: lbToken } });
    expect(good.res.status).toBe(201);
    expect(
      checkResponse('POST', '/api/v1/links/listenbrainz', { status: 201, headers: good.res.headers, body: good.body }),
    ).toBe('valid');
    expect(good.body).toMatchObject({
      service: 'listenbrainz',
      remoteUser: 'Alice_LB',
      status: 'active',
      forwardScrobbles: true,
      forwardNowPlaying: true,
      sync: { backfill: { state: 'pending', done: 0, total: 0 }, pullEnabled: true, queued: 0, failed: 0 },
    });
    expect(w.lb.calls.filter({ path: '/1/validate-token' }).map((c) => c.status)).toEqual([200, 200]);

    const [row] = links(w);
    expect(row).toMatchObject({ id: good.body?.id, did: ALICE, service: 'listenbrainz', remote_user: 'Alice_LB' });
    const queuedKey = trackKey('Queue Artist', 'Queue Track');
    for (const [id, generation, state] of [
      ['delete-queued', 1, 'queued'],
      ['delete-failed', 1, 'failed'],
      ['delete-stale', 0, 'queued'],
    ] as const) {
      w.app.db.run(
        `INSERT INTO listenbrainz_deletes
        (id,event_key,link_id,generation,did,identity_key,listened_at,artist_key,track_key,artist,track,source_path,state,attempts,due_at,deadline_at,created_at_ms,updated_at_ms)
        VALUES(?,?,?,?,?,'identity',1768392000,?,?,'Queue Artist','Queue Track','api',?,0,?,?,?,?)`,
        id,
        id,
        row!.id,
        generation,
        ALICE,
        queuedKey[0],
        queuedKey[1],
        state,
        w.clock.nowMs(),
        w.clock.nowMs() + 7 * 24 * 60 * 60 * 1000,
        w.clock.nowMs(),
        w.clock.nowMs(),
      );
    }
    const reported = await call(w, 'GET', '/api/v1/links', { token });
    expect(reported.body).toMatchObject({
      items: [{ id: row!.id, sync: { queued: 1, failed: 1 } }],
    });
    const sealed = bytes(row?.credential_ciphertext as ArrayBuffer);
    expect(containsText(sealed, lbToken)).toBe(false);
    expect(w.box.openText('linked-listenbrainz', sealed, linkedAad(ALICE, 'listenbrainz'))).toBe(lbToken);
    expect(() => w.box.openText('linked-lastfm', sealed, linkedAad(ALICE, 'listenbrainz'))).toThrow(BoxError);
    expect(JSON.stringify(good.body)).not.toContain(lbToken);

    // A malformed body is refused before any upstream call.
    const unknownField = await call(w, 'POST', '/api/v1/links/listenbrainz', {
      token,
      body: { token: lbToken, user: 'x' },
    });
    expect(unknownField.res.status).toBe(422);
    expect(w.lb.calls.count({ path: '/1/validate-token' })).toBe(2);
    // Without CSRF the route is 403 and validates nothing.
    const noCsrf = await w.app.fetch('/api/v1/links/listenbrainz', {
      method: 'POST',
      headers: { ...w.headers(token), 'content-type': 'application/json' },
      body: JSON.stringify({ token: lbToken }),
    });
    expect(noCsrf.status).toBe(403);
    expect(w.lb.calls.count({ path: '/1/validate-token' })).toBe(2);
  });

  it('PATCH toggles forwarding; DELETE removes the credential and its queued rows; without the owner Last.fm key, Last.fm linking is 503 lastfm_not_configured', async () => {
    const w = await world();
    const token = w.signIn(ALICE);
    w.lb.addToken('alice', 'lb-token-1');
    const created = await call(w, 'POST', '/api/v1/links/listenbrainz', { token, body: { token: 'lb-token-1' } });
    const id = created.body?.id as string;
    expect(created.body).toMatchObject({ sync: { backfill: { state: 'pending' }, pullEnabled: true } });

    const patched = await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: { forwardScrobbles: false } });
    expect(patched.res.status).toBe(200);
    expect(
      checkResponse('PATCH', `/api/v1/links/${id}`, { status: 200, headers: patched.res.headers, body: patched.body }),
    ).toBe('valid');
    expect(patched.body).toMatchObject({ id, forwardScrobbles: false, forwardNowPlaying: true });
    expect(links(w)[0]).toMatchObject({ forward_scrobbles: 0, forward_now_playing: 1 });
    w.app.db.run(
      "UPDATE linked_accounts SET backfill_state='running',backfill_cursor='cursor-x',backfill_done=12,backfill_total=30 WHERE id=?",
      id,
    );
    const togglePull = await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: { pullEnabled: false } });
    expect(togglePull.res.status).toBe(200);
    expect(togglePull.body).toMatchObject({
      forwardScrobbles: false,
      forwardNowPlaying: true,
      sync: { pullEnabled: false, backfill: { state: 'running', done: 12, total: 30 } },
    });
    const sameRemote = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(11), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice', credential: 'lb-token-2' },
    );
    expect(sameRemote.link).toMatchObject({
      backfill_state: 'running',
      backfill_cursor: 'cursor-x',
      backfill_done: 12,
      backfill_total: 30,
      pull_enabled: 0,
    });
    const newRemote = saveLink(
      { db: w.app.db, clock: w.clock, random: seededRandom(12), box: w.box },
      { did: ALICE, service: 'listenbrainz', remoteUser: 'alice2', credential: 'lb-token-3' },
    );
    expect(newRemote.link).toMatchObject({
      backfill_state: 'pending',
      backfill_cursor: null,
      backfill_done: 0,
      backfill_total: 0,
      pull_watermark_ms: w.clock.nowMs(),
      sync_remote_user: 'alice2',
    });

    // The flags decide which rows enqueueForwards (N2-05) creates.
    const random = seededRandom(5);
    const now = w.clock.nowMs();
    const scrobble = {
      kind: 'scrobble' as const,
      listenKey: 'lk-1',
      payload: { listen: { artist: 'A', track: 'T', listenedAt: '2026-01-15T11:55:00Z' } },
    };
    const nowPlaying = {
      kind: 'nowplaying' as const,
      startedAtMs: now,
      artist: 'A',
      track: 'T',
      payload: { track: { artist: 'A', track: 'T' }, startedAtMs: now },
    };
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [scrobble, nowPlaying], now, random })).toBe(1);
    expect(w.app.db.all('SELECT kind FROM forward_outbox')).toEqual([{ kind: 'nowplaying' }]);

    const restored = await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: { forwardScrobbles: true } });
    expect(restored.body).toMatchObject({ forwardScrobbles: true, forwardNowPlaying: true });
    expect(enqueueForwards(w.app.db, { did: ALICE, items: [scrobble], now, random })).toBe(1);
    expect(w.app.db.one<{ n: number }>('SELECT count(*) AS n FROM forward_outbox WHERE link_id = ?', id)?.n).toBe(2);
    w.app.db.run(
      "UPDATE linked_accounts SET backfill_state='running',backfill_cursor='cursor-y',backfill_done=7,backfill_total=20 WHERE id=?",
      id,
    );
    await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: { forwardScrobbles: false } });
    w.app.db.run(
      'INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq) VALUES(?,?,?,?,?,?)',
      ALICE,
      'listen-admitted-while-disabled',
      'live',
      null,
      w.clock.nowMs(),
      42,
    );
    const enabledAgain = await call(w, 'PATCH', `/api/v1/links/${id}`, {
      token,
      body: { forwardScrobbles: true },
    });
    expect(enabledAgain.body).toMatchObject({
      sync: { backfill: { state: 'pending', done: 0, total: 0 } },
    });
    expect(links(w)[0]).toMatchObject({ backfill_state: 'pending', backfill_cursor: null });
    expect(links(w)[0]?.generation_start_seq).toBe(42);

    // Invalid patches and other owners' links.
    expect(
      (await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: { forwardScrobbles: 'no' } })).res.status,
    ).toBe(422);
    expect((await call(w, 'PATCH', `/api/v1/links/${id}`, { token, body: {} })).res.status).toBe(422);
    const bobToken = w.signIn(BOB);
    const foreign = await call(w, 'PATCH', `/api/v1/links/${id}`, {
      token: bobToken,
      body: { forwardScrobbles: false },
    });
    expect(foreign.res.status).toBe(404);
    expect((await call(w, 'DELETE', `/api/v1/links/${id}`, { token: bobToken })).res.status).toBe(404);
    expect(links(w)).toHaveLength(1);
    expect(w.journal.entries()).toEqual([]);

    // DELETE: 204, the credential and every queued row gone, the deletion journaled.
    const deleted = await call(w, 'DELETE', `/api/v1/links/${id}`, { token });
    expect(deleted.res.status).toBe(204);
    expect(deleted.body).toBeNull();
    expect(links(w)).toEqual([]);
    expect(w.app.db.one<{ n: number }>('SELECT count(*) AS n FROM forward_outbox')?.n).toBe(0);
    expect(w.journal.entries()).toEqual([{ kind: 'linked_account', id, did: ALICE, at: w.clock.nowMs() }]);
    expect((await call(w, 'DELETE', `/api/v1/links/${id}`, { token })).res.status).toBe(404);

    // Without the owner's Last.fm key.
    const bare = await world({ lastfmKey: false });
    const bareToken = bare.signIn(ALICE);
    const start = await call(bare, 'POST', '/api/v1/links/lastfm/start', { token: bareToken });
    expect(start.res.status).toBe(503);
    expect(
      checkResponse('POST', '/api/v1/links/lastfm/start', {
        status: 503,
        headers: start.res.headers,
        body: start.body,
      }),
    ).toBe('valid');
    expect((start.body as { error: { code: string } }).error.code).toBe('lastfm_not_configured');
    expect(linkStates(bare)).toEqual([]);
    const callback = await bare.app.fetch(
      `/api/v1/links/lastfm/callback?state=${'a'.repeat(64)}&token=${'b'.repeat(32)}`,
      {
        headers: bare.headers(bareToken),
      },
    );
    expect(callback.status).toBe(503);
    const callbackBody = (await callback.json()) as { error: { code: string } };
    expect(
      checkResponse('GET', '/api/v1/links/lastfm/callback', {
        status: 503,
        headers: callback.headers,
        body: callbackBody,
      }),
    ).toBe('valid');
    expect(callbackBody.error.code).toBe('lastfm_not_configured');
    expect(bare.lastfm.calls.count()).toBe(0);
    expect(links(bare)).toEqual([]);
    // ListenBrainz linking does not need the Last.fm key.
    bare.lb.addToken('alice', 'lb-token-2');
    expect(
      (await call(bare, 'POST', '/api/v1/links/listenbrainz', { token: bareToken, body: { token: 'lb-token-2' } })).res
        .status,
    ).toBe(201);
  });

  it('a Last.fm link callback whose state belongs to another session is 403 and stores nothing', async () => {
    const w = await world();
    const owner = w.signIn(ALICE);
    const { state } = await startLastfm(w, owner);
    const lfToken = w.lastfm.issueToken(undefined, API_KEY);
    w.lastfm.authorizeToken(lfToken, 'alice_fm');
    const before = linkStates(w);
    const callback = `/api/v1/links/lastfm/callback?state=${state}&token=${lfToken}`;

    // Another session of the same DID, and a session of another DID.
    for (const intruder of [w.signIn(ALICE), w.signIn(BOB)]) {
      const res = await w.app.fetch(callback, { headers: w.headers(intruder) });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(checkResponse('GET', '/api/v1/links/lastfm/callback', { status: 403, headers: res.headers, body })).toBe(
        'valid',
      );
      expect(body.error.code).toBe('csrf_failed');
    }
    // Nothing stored and nothing sent upstream; the state is untouched.
    expect(links(w)).toEqual([]);
    expect(w.lastfm.calls.count()).toBe(0);
    expect(linkStates(w)).toEqual(before);
    // Without any session the callback is 401 and touches nothing either.
    const anonymous = await w.app.fetch(callback);
    expect(anonymous.status).toBe(401);
    const anonymousBody = (await anonymous.json()) as { error: { code: string } };
    expect(checkResponse('GET', callback, { status: 401, headers: anonymous.headers, body: anonymousBody })).toBe(
      'valid',
    );
    expect(anonymousBody.error.code).toBe('unauthenticated');
    expect(linkStates(w)).toEqual(before);

    // The session that started the flow can still complete it.
    const done = await w.app.fetch(callback, { headers: w.headers(owner) });
    expect(done.status).toBe(303);
    expect(links(w).map((l) => [l.did, l.remote_user])).toEqual([[ALICE, 'alice_fm']]);

    // An expired state is refused like a used one.
    const { state: late } = await startLastfm(w, owner);
    w.clock.advance(LINK_STATE_TTL_MS);
    const expired = await w.app.fetch(`/api/v1/links/lastfm/callback?state=${late}&token=${lfToken}`, {
      headers: w.headers(owner),
    });
    expect(expired.status).toBe(400);
    const expiredBody = (await expired.json()) as { error: { code: string } };
    expect(checkResponse('GET', callback, { status: 400, headers: expired.headers, body: expiredBody })).toBe('valid');
    expect(expiredBody.error.code).toBe('bad_request');
    expect(w.lastfm.calls.count({ nsid: 'auth.getSession' })).toBe(1);
    // Abandoned states are removed by the expiry sweep once they are past 600 s.
    await startLastfm(w, owner);
    expect(sweepExpiredLinkStates(w.app.db, w.clock.nowMs())).toBe(0);
    w.clock.advance(LINK_STATE_TTL_MS);
    expect(sweepExpiredLinkStates(w.app.db, w.clock.nowMs())).toBe(1);
    expect(linkStates(w)).toEqual([]);
  });
});

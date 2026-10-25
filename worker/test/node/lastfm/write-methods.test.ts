// N3-03: the Last.fm write methods (ADR 0005 §7.5, §7.7, §7.8, §12.2).
//
// The real Node composition runs in process (test/node/support/app.ts: a
// migrated temporary database, frozen clock 2026-01-15T12:00:00Z, seeded
// Random, no network) with the `lastfm-auth` feature and a /2.0 route over
// the auth and write method tables (`handleLastfmMethod`). The publication
// gate is open through an owned test prefix with ownership evidence
// (org.example.music, as worker/test/config.test.ts); the fixture prefix
// com.example.atmusic never publishes, which is the closed-gate case.
// Requests are signed with node:crypto's MD5 under the public panoScrobbler
// pair. Outcomes are asserted on the HTTP answer and on the operations,
// listen_keys, forward_outbox, operation_deps and now_playing rows.

import { createHash } from 'node:crypto';
import { fixtureKeys } from '@atmusic/atproto/test-support/keys';
import { SignedRepo } from '@atmusic/atproto/test-support/signed-repo';
import { verifyRecordProof } from '@atmusic/atproto/verify/record-proof';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { seededRandom } from '@atmusic/core/test-support/random';
import { fromMs, toStorage } from '@atmusic/core/timestamp';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { OperationRow } from '../../../src/app/rows';
import { type CredentialDeps, ensureAccount } from '../../../src/credentials/accounts';
import { createSession, revokeLastfmSession } from '../../../src/credentials/lastfm-auth';
import { applyRecordProof } from '../../../src/do/write/apply-record';
import { lastfmAuthFeature } from '../../../src/http/lastfm-authorize';
import type { RouteDef } from '../../../src/http/types';
import { authMethods, handleLastfmMethod } from '../../../src/lastfm/auth-methods';
import { writeMethods } from '../../../src/lastfm/write-methods';
import { beginAttempts } from '../../../src/outbox/operations';
import { closeApps, startApp, type TestApp } from '../support/app';

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const ALICE_HANDLE = 'alice.test';
const OWNED = 'org.example.music';
const SCROBBLE = `${OWNED}.scrobble`;
const OPEN_GATE = { LEXICON_PREFIX: OWNED, NAMESPACE_OWNERSHIP_REF: 'dns:_lexicon.music.example.org TXT' };
const PANO = 'panoScrobbler';
const NOW_MS = Date.parse('2026-01-15T12:00:00Z');
const NOW_S = NOW_MS / 1000;

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

function sign(params: Record<string, string>, secret: string): string {
  const names = Object.keys(params)
    .filter((n) => n !== 'format' && n !== 'callback' && n !== 'api_sig')
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  return md5(names.map((n) => n + params[n]).join('') + secret);
}

const TABLE = { ...authMethods, ...writeMethods };
const PROTOCOL_ROUTES: RouteDef[] = (['GET', 'POST'] as const).map((method) => ({
  method,
  pattern: '/2.0/',
  handler: (req, ctx) => handleLastfmMethod(TABLE, req, ctx),
}));

interface Rig {
  app: TestApp;
  deps: CredentialDeps;
  sk: string;
  sessionId: string;
}

async function rig(env: Record<string, string> | null = OPEN_GATE): Promise<Rig> {
  const clock = fixedClock();
  const revocations = new MemoryRevocations(clock);
  const app = await startApp({
    clock,
    features: [lastfmAuthFeature({ revocations })],
    routes: PROTOCOL_ROUTES,
    ...(env !== null ? { env } : {}),
  });
  const deps: CredentialDeps = { db: app.db, clock, random: seededRandom(21), revocations };
  app.db.run(
    `INSERT INTO users(did, handle, joined_at, active, account_status, indexing_state)
     VALUES (?, ?, ?, 1, 'active', 'current')`,
    ALICE,
    ALICE_HANDLE,
    toStorage(fromMs(NOW_MS)),
  );
  ensureAccount(deps, { did: ALICE, verifiedHandle: ALICE_HANDLE });
  const session = createSession(deps, { did: ALICE, apiKey: PANO, clientName: 'Pano Scrobbler' });
  return { app, deps, sk: session.key, sessionId: session.id };
}

afterEach(closeApps);

/** A signed POST /2.0/ call (JSON unless `format` says xml). */
async function post(
  app: TestApp,
  params: Record<string, string>,
  format: 'json' | 'xml' = 'json',
): Promise<{ status: number; text: string; json: () => Record<string, unknown> }> {
  const p: Record<string, string> = { api_key: PANO, ...params };
  p.api_sig = sign(p, PANO);
  if (format === 'json') p.format = 'json';
  const res = await app.fetch('/2.0/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(p).toString(),
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) as Record<string, unknown> };
}

function scrobbleParams(sk: string, entries: Array<Record<string, string>>): Record<string, string> {
  const p: Record<string, string> = { method: 'track.scrobble', sk };
  entries.forEach((entry, i) => {
    for (const [k, v] of Object.entries(entry)) p[`${k}[${i}]`] = v;
  });
  return p;
}

const count = (app: TestApp, sql: string, ...args: unknown[]): number =>
  app.db.one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...(args as never[]))!.n;

const operations = (app: TestApp, kind?: string): OperationRow[] =>
  kind === undefined
    ? app.db.all<OperationRow>('SELECT * FROM operations ORDER BY rowid')
    : app.db.all<OperationRow>('SELECT * FROM operations WHERE kind = ? ORDER BY rowid', kind);

function addLink(
  app: TestApp,
  id: string,
  service: 'lastfm' | 'listenbrainz',
  options: Record<string, unknown> = {},
): void {
  app.db.run(
    `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, forward_scrobbles,
       forward_now_playing, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'remote', ?, 'e1', ?, ?, ?, ?, ?)`,
    id,
    ALICE,
    service,
    new Uint8Array([1, 2, 3]).buffer,
    (options.forwardScrobbles as number | undefined) ?? 1,
    (options.forwardNowPlaying as number | undefined) ?? 1,
    (options.status as string | undefined) ?? 'active',
    NOW_MS,
    NOW_MS,
  );
}

const THREE: Array<Record<string, string>> = [
  { artist: 'First Artist', track: 'First Track', album: 'First Album', timestamp: String(NOW_S - 3600) },
  { artist: 'Second Artist', track: 'Second Track', timestamp: String(NOW_S - 1800), duration: '215' },
  { artist: 'Third Artist', track: 'Third Track', timestamp: String(NOW_S - 600) },
];

describe('Last.fm write methods', () => {
  it('track.scrobble with 3 entries answers accepted 3 with an array, creates 3 operations and listen keys; a single entry answers an object', async () => {
    const { app, sk } = await rig();
    const res = await post(app, scrobbleParams(sk, THREE));
    expect(res.status).toBe(200);
    const body = res.json() as { scrobbles: { scrobble: unknown; '@attr': unknown } };
    expect(body.scrobbles['@attr']).toEqual({ accepted: 3, ignored: 0 });
    expect(Array.isArray(body.scrobbles.scrobble)).toBe(true);
    const items = body.scrobbles.scrobble as Array<Record<string, unknown>>;
    expect(items.map((s) => (s.track as { '#text': string })['#text'])).toEqual([
      'First Track',
      'Second Track',
      'Third Track',
    ]);
    expect(items[0]).toEqual({
      track: { corrected: '0', '#text': 'First Track' },
      artist: { corrected: '0', '#text': 'First Artist' },
      album: { corrected: '0', '#text': 'First Album' },
      albumArtist: { corrected: '0', '#text': '' },
      timestamp: String(NOW_S - 3600),
      ignoredMessage: { code: '0', '#text': '' },
    });

    const ops = operations(app);
    expect(ops.map((o) => [o.kind, o.origin, o.priority, o.state, o.collection])).toEqual([
      ['scrobble.create', 'lastfm', 0, 'queued', SCROBBLE],
      ['scrobble.create', 'lastfm', 0, 'queued', SCROBBLE],
      ['scrobble.create', 'lastfm', 0, 'queued', SCROBBLE],
    ]);
    const records = ops.map((o) => JSON.parse(o.record_json!) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      $type: SCROBBLE,
      artist: 'First Artist',
      track: 'First Track',
      album: 'First Album',
      listenedAt: '2026-01-15T11:00:00.000000000Z',
      submissionClient: 'Pano Scrobbler',
    });
    expect(records[1]).toMatchObject({ durationSeconds: 215 });
    const keys = app.db.all<{ operation_id: string; source: string }>(
      'SELECT operation_id, source FROM listen_keys WHERE did = ? ORDER BY rowid',
      ALICE,
    );
    expect(keys).toEqual(ops.map((o) => ({ operation_id: o.id, source: 'lastfm' })));

    // One unindexed entry: `scrobbles.scrobble` is an object, in XML and JSON.
    const single = await post(app, {
      method: 'track.scrobble',
      sk,
      artist: 'Solo Artist',
      track: 'Solo Track',
      timestamp: String(NOW_S - 60),
    });
    expect(single.status).toBe(200);
    const one = single.json() as { scrobbles: { scrobble: Record<string, unknown>; '@attr': unknown } };
    expect(one.scrobbles['@attr']).toEqual({ accepted: 1, ignored: 0 });
    expect(Array.isArray(one.scrobbles.scrobble)).toBe(false);
    expect(one.scrobbles.scrobble.artist).toEqual({ corrected: '0', '#text': 'Solo Artist' });
    const xml = await post(
      app,
      { method: 'track.scrobble', sk, artist: 'Xml Artist', track: 'Xml Track', timestamp: String(NOW_S - 30) },
      'xml',
    );
    expect(xml.text).toContain('<lfm status="ok">\n  <scrobbles accepted="1" ignored="0">\n    <scrobble>\n');
    expect(count(app, 'operations')).toBe(5);
    expect(count(app, 'listen_keys')).toBe(5);
  });

  it('resending the same batch is accepted 3 again and creates no new operation or forward row', async () => {
    const { app, sk } = await rig();
    addLink(app, 'link-lastfm', 'lastfm');
    const first = await post(app, scrobbleParams(sk, THREE));
    expect((first.json().scrobbles as { '@attr': unknown })['@attr']).toEqual({ accepted: 3, ignored: 0 });
    const opsBefore = operations(app).map((o) => o.id);
    const forwardsBefore = app.db.all<{ id: string; dedupe_key: string }>(
      'SELECT id, dedupe_key FROM forward_outbox ORDER BY rowid',
    );
    expect(opsBefore).toHaveLength(3);
    expect(forwardsBefore).toHaveLength(3);
    expect(forwardsBefore.map((f) => f.dedupe_key).sort()).toEqual(
      app.db
        .all<{ dedupe_key: string }>('SELECT dedupe_key FROM listen_keys')
        .map((k) => k.dedupe_key)
        .sort(),
    );

    const again = await post(app, scrobbleParams(sk, THREE));
    expect(again.status).toBe(200);
    const body = again.json() as { scrobbles: { scrobble: Array<Record<string, unknown>>; '@attr': unknown } };
    expect(body.scrobbles['@attr']).toEqual({ accepted: 3, ignored: 0 });
    expect(body.scrobbles.scrobble.map((s) => (s.ignoredMessage as { code: string }).code)).toEqual(['0', '0', '0']);
    expect(operations(app).map((o) => o.id)).toEqual(opsBefore);
    expect(app.db.all('SELECT id, dedupe_key FROM forward_outbox ORDER BY rowid')).toEqual(forwardsBefore);
    expect(count(app, 'listen_keys')).toBe(3);
  });

  it('empty artist gives code 1, empty track 2, timestamp 1033430399 gives 3, now+301 s gives 4, the 3,001st listen of the day gives 5; status stays ok', async () => {
    const { app, sk } = await rig();
    // 2,999 live listens in the last 24 h.
    app.db.tx(() => {
      for (let i = 0; i < 2999; i++) {
        app.db.run(
          `INSERT INTO listen_keys(did, dedupe_key, operation_id, source, created_at_ms) VALUES (?, ?, NULL, 'lastfm', ?)`,
          ALICE,
          `seed-${i}`,
          NOW_MS - 3_600_000,
        );
      }
    });
    const entries = [
      { artist: '', track: 'Track A', timestamp: String(NOW_S - 100) },
      { artist: 'Artist B', track: '', timestamp: String(NOW_S - 100) },
      { artist: 'Artist C', track: 'Track C', timestamp: '1033430399' },
      { artist: 'Artist D', track: 'Track D', timestamp: String(NOW_S + 301) },
      { artist: 'Artist E', track: 'Track E', timestamp: String(NOW_S + 300) },
      { artist: 'Artist F', track: 'Track F', timestamp: String(NOW_S - 100) },
    ];
    const res = await post(app, scrobbleParams(sk, entries));
    expect(res.status).toBe(200);
    const body = res.json() as { scrobbles: { scrobble: Array<Record<string, unknown>>; '@attr': unknown } };
    expect(body.scrobbles['@attr']).toEqual({ accepted: 1, ignored: 5 });
    expect(body.scrobbles.scrobble.map((s) => s.ignoredMessage)).toEqual([
      { code: '1', '#text': 'Artist name failed filter' },
      { code: '2', '#text': 'Track name failed filter' },
      { code: '3', '#text': 'Timestamp too old' },
      { code: '4', '#text': 'Timestamp too new' },
      { code: '0', '#text': '' },
      { code: '5', '#text': 'Daily scrobble limit exceeded' },
    ]);
    // Ignored entries are echoed as sent.
    expect(body.scrobbles.scrobble[0]?.artist).toEqual({ corrected: '0', '#text': '' });
    expect(body.scrobbles.scrobble[2]?.timestamp).toBe('1033430399');
    const ops = operations(app);
    expect(ops).toHaveLength(1);
    expect(JSON.parse(ops[0]!.record_json!)).toMatchObject({ artist: 'Artist E', track: 'Track E' });
    expect(count(app, 'listen_keys WHERE operation_id IS NOT NULL')).toBe(1);

    const xml = await post(app, scrobbleParams(sk, entries.slice(0, 2)), 'xml');
    expect(xml.status).toBe(200);
    expect(xml.text).toContain('<lfm status="ok">');
    expect(xml.text).toContain('<scrobbles accepted="0" ignored="2">');
    expect(xml.text).toContain('<ignoredMessage code="1">Artist name failed filter</ignoredMessage>');
  });

  it('a batch missing timestamp[1] gives error 6 and stores nothing', async () => {
    const { app, sk } = await rig();
    addLink(app, 'link-lastfm', 'lastfm');
    const params = scrobbleParams(sk, THREE);
    delete params['timestamp[1]'];
    const res = await post(app, params);
    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: 6, message: 'Invalid parameters - missing required parameter "timestamp"' });
    const xml = await post(app, params, 'xml');
    expect(xml.status).toBe(400);
    expect(xml.text).toContain('<lfm status="failed"><error code="6">');
    expect(count(app, 'operations')).toBe(0);
    expect(count(app, 'listen_keys')).toBe(0);
    expect(count(app, 'forward_outbox')).toBe(0);
  });

  it("track.updateNowPlaying stores now playing and answers nowplaying with ignoredMessage code 0 and #text ''", async () => {
    const { app, sk } = await rig();
    addLink(app, 'link-lastfm', 'lastfm');
    addLink(app, 'link-lb', 'listenbrainz', { forwardNowPlaying: 0 });
    const params = {
      method: 'track.updateNowPlaying',
      sk,
      artist: 'Test Artist',
      track: 'Test Track',
      album: 'Test Album',
      duration: '200',
    };
    const res = await post(app, params);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      nowplaying: {
        track: { corrected: '0', '#text': 'Test Track' },
        artist: { corrected: '0', '#text': 'Test Artist' },
        album: { corrected: '0', '#text': 'Test Album' },
        albumArtist: { corrected: '0', '#text': '' },
        ignoredMessage: { code: '0', '#text': '' },
      },
    });
    const row = app.db.one<Record<string, unknown>>('SELECT * FROM now_playing WHERE did = ?', ALICE);
    expect(row).toMatchObject({
      artist: 'Test Artist',
      track: 'Test Track',
      album: 'Test Album',
      duration_seconds: 200,
      client: 'Pano Scrobbler',
      source: 'lastfm',
      started_at_ms: NOW_MS,
      expires_at_ms: NOW_MS + 200_000,
    });
    // One nowplaying forward row, only for the link that forwards now playing.
    const forwards = app.db.all<{ link_id: string; kind: string; payload_json: string }>(
      'SELECT link_id, kind, payload_json FROM forward_outbox',
    );
    expect(forwards.map((f) => [f.link_id, f.kind])).toEqual([['link-lastfm', 'nowplaying']]);
    expect(JSON.parse(forwards[0]!.payload_json)).toMatchObject({
      track: { artist: 'Test Artist', track: 'Test Track', album: 'Test Album', durationSeconds: 200 },
      startedAtMs: NOW_MS,
      origin: 'lastfm',
    });
    // The same track again only refreshes: no second forward row, no PDS operation.
    const xml = await post(app, params, 'xml');
    expect(xml.status).toBe(200);
    expect(xml.text).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<lfm status="ok">',
        '  <nowplaying>',
        '    <track corrected="0">Test Track</track>',
        '    <artist corrected="0">Test Artist</artist>',
        '    <album corrected="0">Test Album</album>',
        '    <albumArtist corrected="0"/>',
        '    <ignoredMessage code="0"/>',
        '  </nowplaying>',
        '</lfm>',
        '',
      ].join('\n'),
    );
    expect(count(app, 'forward_outbox')).toBe(1);
    expect(count(app, 'operations')).toBe(0);
  });

  it('track.love and unlove queue love.put and love.delete operations and forward rows', async () => {
    const { app, sk } = await rig();
    addLink(app, 'link-lastfm', 'lastfm');
    const love = await post(app, { method: 'track.love', sk, artist: 'Loved Artist', track: 'Loved Track' });
    expect(love.status).toBe(200);
    expect(love.json()).toEqual({});
    const unlove = await post(app, { method: 'track.unlove', sk, artist: 'Loved Artist', track: 'Loved Track' }, 'xml');
    expect(unlove.status).toBe(200);
    expect(unlove.text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="ok"/>\n');

    const ops = operations(app);
    expect(ops.map((o) => [o.kind, o.origin, o.collection])).toEqual([
      ['love.put', 'lastfm', `${OWNED}.love`],
      ['love.delete', 'lastfm', `${OWNED}.love`],
    ]);
    expect(JSON.parse(ops[0]!.record_json!)).toMatchObject({ artist: 'Loved Artist', track: 'Loved Track' });
    expect(JSON.parse(ops[1]!.record_json!)).toEqual({ artist: 'Loved Artist', track: 'Loved Track' });
    // The unlove waits for the love (FIFO per key).
    expect(app.db.all('SELECT op_id, pred_id FROM operation_deps')).toEqual([
      { op_id: ops[1]!.id, pred_id: ops[0]!.id },
    ]);
    const forwards = app.db.all<{ kind: string; dedupe_key: string; link_id: string }>(
      'SELECT kind, dedupe_key, link_id FROM forward_outbox ORDER BY rowid',
    );
    expect(forwards).toEqual([
      { kind: 'love', dedupe_key: ops[0]!.id, link_id: 'link-lastfm' },
      { kind: 'unlove', dedupe_key: ops[1]!.id, link_id: 'link-lastfm' },
    ]);
    // A missing track is 6 and queues nothing.
    const bad = await post(app, { method: 'track.love', sk, artist: 'Loved Artist' });
    expect(bad.status).toBe(400);
    expect(bad.json().error).toBe(6);
    expect(count(app, 'operations')).toBe(2);
  });

  it('a missing or revoked sk gives 9; a closed publication gate gives 11; accepted scrobbles enqueue forward rows for each active link', async () => {
    const r = await rig();
    const { app, sk } = r;
    addLink(app, 'link-lastfm', 'lastfm');
    addLink(app, 'link-lb', 'listenbrainz');
    // Another DID's active link never receives Alice's listens.
    app.db.run(
      `INSERT INTO linked_accounts(id, did, service, remote_user, credential_ciphertext, key_id, status, created_at_ms,
         updated_at_ms)
       VALUES ('link-bob', 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', 'lastfm', 'bob', X'01', 'e1', 'active', ?, ?)`,
      NOW_MS,
      NOW_MS,
    );

    const missing = await post(app, { method: 'track.scrobble', ...THREE[0]! });
    expect(missing.status).toBe(403);
    expect(missing.json()).toEqual({ error: 9, message: 'Invalid session key - Please re-authenticate' });
    const unknown = await post(app, scrobbleParams('f'.repeat(32), THREE.slice(0, 1)));
    expect(unknown.json().error).toBe(9);
    expect(count(app, 'operations')).toBe(0);

    const accepted = await post(app, scrobbleParams(sk, THREE.slice(0, 2)));
    expect(accepted.status).toBe(200);
    const keys = app.db
      .all<{ dedupe_key: string }>('SELECT dedupe_key FROM listen_keys ORDER BY rowid')
      .map((k) => k.dedupe_key);
    const forwards = () =>
      app.db.all<{ link_id: string; kind: string; dedupe_key: string; payload_json: string }>(
        'SELECT link_id, kind, dedupe_key, payload_json FROM forward_outbox ORDER BY link_id, rowid',
      );
    expect(forwards().map((f) => [f.link_id, f.kind, f.dedupe_key])).toEqual([
      ['link-lastfm', 'scrobble', keys[0]],
      ['link-lastfm', 'scrobble', keys[1]],
      ['link-lb', 'scrobble', keys[0]],
      ['link-lb', 'scrobble', keys[1]],
    ]);
    expect(JSON.parse(forwards()[0]!.payload_json)).toEqual({
      listen: { artist: 'First Artist', track: 'First Track', album: 'First Album', timestamp: String(NOW_S - 3600) },
      origin: 'lastfm',
    });
    // A revoked link gets nothing more; the active one does.
    app.db.run("UPDATE linked_accounts SET status = 'revoked' WHERE id = 'link-lb'");
    expect((await post(app, scrobbleParams(sk, THREE.slice(2)))).status).toBe(200);
    const third = app.db
      .all<{ dedupe_key: string }>('SELECT dedupe_key FROM listen_keys ORDER BY rowid')
      .map((k) => k.dedupe_key)[2];
    expect(
      forwards()
        .filter((f) => f.dedupe_key === third)
        .map((f) => f.link_id),
    ).toEqual(['link-lastfm']);
    expect(count(app, 'forward_outbox WHERE link_id = ?', 'link-bob')).toBe(0);

    // Revoked in Settings: 9, and nothing more is stored.
    expect(revokeLastfmSession(r.deps, ALICE, r.sessionId)).toBe(true);
    const revoked = await post(app, scrobbleParams(sk, [{ artist: 'Late', track: 'Late', timestamp: String(NOW_S) }]));
    expect(revoked.status).toBe(403);
    expect(revoked.json().error).toBe(9);
    expect(count(app, 'operations')).toBe(3);
    expect(count(app, 'forward_outbox')).toBe(5);

    // The fixture prefix never publishes: the gate is closed, 11, nothing stored.
    const closed = await rig(null);
    const offline = await post(closed.app, scrobbleParams(closed.sk, THREE));
    expect(offline.status).toBe(503);
    expect(offline.json()).toEqual({ error: 11, message: 'Service Offline' });
    for (const method of ['track.updateNowPlaying', 'track.love', 'track.unlove', 'library.removeScrobble']) {
      const res = await post(closed.app, { method, sk: closed.sk, ...THREE[0]! });
      expect(res.json().error, method).toBe(11);
    }
    expect(count(closed.app, 'operations')).toBe(0);
    expect(count(closed.app, 'listen_keys')).toBe(0);
    expect(count(closed.app, 'now_playing')).toBe(0);
  });

  it("library.removeScrobble cancels a still-queued create at that second, chains a delete after a running one, deletes an indexed record, and answers 7 'Invalid resource specified' when nothing matches", async () => {
    const { app, sk } = await rig();
    addLink(app, 'link-lastfm', 'lastfm');
    const queued = { artist: 'Queued Artist', track: 'Queued Track', timestamp: String(NOW_S - 300) };
    const running = { artist: 'Running Artist', track: 'Running Track', timestamp: String(NOW_S - 200) };
    expect((await post(app, scrobbleParams(sk, [queued, running]))).status).toBe(200);
    const [queuedOp, runningOp] = operations(app, 'scrobble.create');
    expect(count(app, 'forward_outbox')).toBe(2);

    // The runner has started the second create's first attempt.
    expect(beginAttempts(app.db, [runningOp!.id], NOW_MS).map((o) => o.state)).toEqual(['running']);

    // An indexed record of the owner, applied from a verified proof.
    const keys = await fixtureKeys();
    const repo = new SignedRepo(ALICE, keys.alice, { clock: fixedClock() });
    const indexedRecord = {
      $type: SCROBBLE,
      artist: 'Indexed Artist',
      track: 'Indexed Track',
      listenedAt: '2026-01-15T10:00:00Z',
      createdAt: '2026-01-15T10:00:05Z',
    };
    await repo.put(SCROBBLE, '3lbindexed22a', indexedRecord);
    const proof = await verifyRecordProof(await repo.getRecordCar(SCROBBLE, '3lbindexed22a'), {
      did: ALICE,
      collection: SCROBBLE,
      rkey: '3lbindexed22a',
      signingKey: repo.key.didKey,
    });
    const nowNs = fromMs(NOW_MS);
    expect(app.db.tx(() => applyRecordProof(app.db, proof, { receiptNs: nowNs, prefix: OWNED, nowNs })).outcome).toBe(
      'applied',
    );
    const indexedUri = `at://${ALICE}/${SCROBBLE}/3lbindexed22a`;
    expect(count(app, 'scrobbles WHERE uri = ?', indexedUri)).toBe(1);

    const remove = (entry: Record<string, string>, format: 'json' | 'xml' = 'json') =>
      post(app, { method: 'library.removeScrobble', sk, ...entry }, format);

    // 1. Still queued: cancelled, its listen key and unsent forward row deleted, nothing for the PDS.
    const r1 = await remove({ artist: 'queued artist', track: 'QUEUED TRACK', timestamp: queued.timestamp });
    expect(r1.status).toBe(200);
    expect(r1.json()).toEqual({});
    expect(app.db.one<{ state: string }>('SELECT state FROM operations WHERE id = ?', queuedOp!.id)?.state).toBe(
      'cancelled',
    );
    expect(count(app, 'listen_keys WHERE operation_id = ?', queuedOp!.id)).toBe(0);
    expect(count(app, 'forward_outbox')).toBe(1);
    expect(operations(app, 'scrobble.delete')).toHaveLength(0);

    // 2. Running: a delete chained after the create, which keeps running.
    const r2 = await remove({ artist: running.artist, track: running.track, timestamp: running.timestamp });
    expect(r2.status).toBe(200);
    const [chained] = operations(app, 'scrobble.delete');
    expect(chained).toMatchObject({ origin: 'lastfm', state: 'queued', collection: SCROBBLE, rkey: runningOp!.rkey });
    expect(app.db.all('SELECT pred_id FROM operation_deps WHERE op_id = ?', chained!.id)).toEqual([
      { pred_id: runningOp!.id },
    ]);
    expect(app.db.one<{ state: string }>('SELECT state FROM operations WHERE id = ?', runningOp!.id)?.state).toBe(
      'running',
    );

    // 3. Indexed: a delete of that record.
    const r3 = await remove(
      {
        artist: 'Indexed Artist',
        track: 'Indexed Track',
        timestamp: String(Date.parse('2026-01-15T10:00:00Z') / 1000),
      },
      'xml',
    );
    expect(r3.status).toBe(200);
    expect(r3.text).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="ok"/>\n');
    const deletes = operations(app, 'scrobble.delete');
    expect(deletes).toHaveLength(2);
    expect(deletes[1]).toMatchObject({ rkey: '3lbindexed22a', collection: SCROBBLE, state: 'queued' });
    expect(app.db.all('SELECT pred_id FROM operation_deps WHERE op_id = ?', deletes[1]!.id)).toEqual([]);

    // 4. No match: another second, another track, or the already cancelled create.
    for (const entry of [
      {
        artist: 'Indexed Artist',
        track: 'Indexed Track',
        timestamp: String(Date.parse('2026-01-15T10:00:01Z') / 1000),
      },
      { artist: 'Nobody', track: 'Nothing', timestamp: String(NOW_S - 50) },
      { artist: queued.artist, track: queued.track, timestamp: queued.timestamp },
    ]) {
      const res = await remove(entry);
      expect(res.status).toBe(400);
      expect(res.json()).toEqual({ error: 7, message: 'Invalid resource specified' });
    }
    const xml = await remove({ artist: 'Nobody', track: 'Nothing', timestamp: String(NOW_S - 50) }, 'xml');
    expect(xml.text).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<lfm status="failed"><error code="7">Invalid resource specified</error></lfm>\n',
    );
    // A double tap on the running one is matched by its pending delete; no third delete.
    expect((await remove({ artist: running.artist, track: running.track, timestamp: running.timestamp })).status).toBe(
      200,
    );
    expect(operations(app, 'scrobble.delete')).toHaveLength(2);
  });
});

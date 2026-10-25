// Import uploads (ADR 0005 §11.1, §11.4, §13; N3-09): the two export formats,
// the ZIP bomb bounds on actual inflated bytes, feedback resolution, the
// storage bounds (507), the upload file's lifetime and the crash-loop guard.
//
// Two rigs: the import timer run (runImports) over a migrated temporary
// database with the server outbox and the fake PDS (outbox/support.ts), and
// the whole composed app in-process (support/app.ts) for the HTTP routes,
// with real cookie sessions and CSRF. Fault injection only through injected
// interfaces (the UploadStore). Frozen clock 2026-01-15T12:00:00Z; seeded
// randomness; no network.

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { Transport } from '@atmusic/atproto/transport';
import { seededRandom } from '@atmusic/core/test-support/random';
import { zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRevocations } from '../../../src/app/revocations';
import type { ImportItemRow, ImportJobRow } from '../../../src/app/rows';
import { csrfToken } from '../../../src/bff/csrf';
import { createWebSessions, type WebSessions } from '../../../src/bff/sessions';
import { createBox } from '../../../src/crypto/box';
import { importsFeature } from '../../../src/http/imports';
import {
  CRASH_LOOP_ATTEMPTS,
  createJob,
  IMPORT_FETCH_CAPS,
  type ImportRuntime,
  intervalPacer,
  runImports,
} from '../../../src/imports/jobs';
import { fsUploadStore, type UploadStore } from '../../../src/imports/uploads';
import { MAX_ZIP_ENTRIES, readZip, ZipBoundError } from '../../../src/imports/zip';
import { bindPolicyFetch, createPolicyFetch } from '../../../src/node/policy-fetch';
import { checkResponse } from '../../acceptance/support/openapi';
import { type Harness, LOVE, remoteRecords, T0, withHarness } from '../outbox/support';
import { closeApps, startApp, TEST_PUBLIC_ORIGIN, type TestApp } from '../support/app';

afterEach(async () => {
  await closeApps();
});

const MiB = 1024 * 1024;

// ---------------------------------------------------------------------------
// Rigs

function runtime(h: Harness, uploads: UploadStore = fsUploadStore): ImportRuntime {
  const transport = Object.assign(async (req: Request) => h.kit.transport(req), {
    fixture: true as const,
  }) as unknown as Transport;
  return {
    m: h.m,
    uploadDir: join(h.ctx.dir, 'imports'),
    lastfm: null,
    listenbrainzApiRoot: 'https://listenbrainz.test/',
    fetch: bindPolicyFetch(createPolicyFetch({ transport }), IMPORT_FETCH_CAPS),
    pacers: { lastfm: intervalPacer(), listenbrainz: intervalPacer() },
    diskLow: () => false,
    uploads,
    box: null,
  };
}

function writeUpload(
  h: Harness,
  id: string,
  did: string,
  source: 'lastfm_json' | 'listenbrainz_zip',
  body: Uint8Array | string,
): string {
  const dir = join(h.ctx.dir, 'imports');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${id}.upload`);
  writeFileSync(path, body, { mode: 0o600 });
  createJob(h.db, { id, did, source, remoteUser: null, uploadPath: path, uploadBytes: body.length, now: T0 });
  return path;
}

function job(db: { one: Harness['db']['one'] }, id: string): ImportJobRow {
  return db.one<ImportJobRow>('SELECT * FROM import_jobs WHERE id = ?', id) as ImportJobRow;
}

async function untilState(h: Harness, rt: ImportRuntime, id: string, state: string, max = 20): Promise<void> {
  for (let i = 0; i < max && job(h.db, id).state !== state; i++) await runImports(rt, h.kit.clock.nowMs());
  expect(job(h.db, id).state).toBe(state);
}

function stagedInputs(h: Harness, id: string): Array<Record<string, unknown>> {
  return h.db
    .all<ImportItemRow>('SELECT * FROM import_items WHERE job_id = ? ORDER BY seq', id)
    .map((i) => (JSON.parse(i.record_json) as { input: Record<string, unknown> }).input);
}

const enc = new TextEncoder();

/** A minimal ZIP writer: entries with given method, stored bytes and declared sizes (CRC 0, never checked). */
function buildZip(entries: Array<{ name: string; method: 0 | 8; data: Uint8Array; declaredSize: number }>): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const local = new Uint8Array(30 + name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true);
    v.setUint16(8, e.method, true);
    v.setUint32(18, e.data.length, true);
    v.setUint32(22, e.declaredSize, true);
    v.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, e.method, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.declaredSize, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, e.data);
    central.push(cd);
    offset += local.length + e.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new Uint8Array(22);
  const d = new DataView(eocd.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, cdSize, true);
  d.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * `bytes` of data that DEFLATE compresses about 47:1 (under the 100 ratio
 * bound): blocks of 600 fresh pseudo-random bytes followed by 30,000 zeros.
 */
function compressible(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let x = 0x2545f491;
  for (let block = 0; block < bytes; block += 30_600) {
    for (let i = block; i < Math.min(bytes, block + 600); i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 0xff;
    }
  }
  return out;
}

async function* chunks(bytes: Uint8Array, size = 64 * 1024): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

async function zipError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ZipBoundError) return error.bound;
    throw error;
  }
  return 'accepted';
}

interface ImportsApp {
  app: TestApp;
  /** A signed-in DID's cookie and CSRF headers for unsafe requests. */
  login(did: string): Record<string, string>;
  tick(): Promise<void>;
}

async function importsApp(env: Record<string, string> = {}): Promise<ImportsApp> {
  let sessions: WebSessions | null = null;
  const lazy = {
    lookupCookieHeader: (h: string | null) => (sessions as WebSessions).lookupCookieHeader(h),
    renew: (s: Parameters<WebSessions['renew']>[0]) => (sessions as WebSessions).renew(s),
  };
  const app = await startApp({ features: [importsFeature({ sessions: lazy, diskLow: () => false })], env });
  const ws = createWebSessions({
    db: app.db,
    clock: app.clock,
    random: seededRandom(77),
    revocations: new MemoryRevocations(app.clock),
  });
  sessions = ws;
  const csrfKey = createBox(app.secrets.encryptionKeys, seededRandom(1)).csrfKey();
  return {
    app,
    login(did) {
      const s = ws.create(did);
      return {
        cookie: `__Host-atmusic_session=${s.token}`,
        origin: TEST_PUBLIC_ORIGIN,
        'x-csrf-token': csrfToken(csrfKey, s.token),
      };
    },
    async tick() {
      await app.composed.core.tick('extension');
    },
  };
}

function seedCurrentUser(app: TestApp, did: string): void {
  app.db.run(
    `INSERT INTO users(did, joined_at, active, account_status, indexing_state, generation)
     VALUES (?, '2026-01-15T12:00:00.000000000Z', 1, 'active', 'current', 1)`,
    did,
  );
}

function lastfmExportBody(n: number, base = Math.floor(T0 / 1000) - 86_400): string {
  return JSON.stringify([
    {
      recenttracks: {
        track: Array.from({ length: n }, (_, i) => ({
          artist: { '#text': `Up Artist ${i}`, mbid: '' },
          name: `Up Track ${i}`,
          album: { '#text': '' },
          mbid: '',
          date: { uts: String(base - i * 60) },
        })),
      },
    },
  ]);
}

// ---------------------------------------------------------------------------

describe('import uploads', () => {
  it('a ListenBrainz export ZIP (float listened_at, listens/2025/1.jsonl, one listen with a null and one with an object mbid_mapping) and a Last.fm JSON export stage their listens, with record MBIDs taken from additional_info only', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      h.seedUser(h.bob);
      const A = '1b4a5b2c-0000-4000-8000-00000000000a';
      const B = '1b4a5b2c-0000-4000-8000-00000000000b';
      const X = '9f9f9f9f-0000-4000-8000-00000000000c';
      const Y = '9f9f9f9f-0000-4000-8000-00000000000d';
      const W = '9f9f9f9f-0000-4000-8000-00000000000e';
      // Raw JSONL text: the floats are written as the export writes them.
      const listens = [
        `{"listened_at": 1735689600.0, "recording_msid": "5b8f3c2e-1111-4111-8111-111111111111", "track_metadata": {"artist_name": "Zed", "track_name": "Null Mapping", "mbid_mapping": null, "additional_info": {"recording_mbid": "${A}", "release_mbid": "${B}", "duration_ms": 215000}}}`,
        `{"listened_at": 1735693200.75, "track_metadata": {"artist_name": "Zed", "track_name": "Object Mapping", "release_name": "Album Z", "mbid_mapping": {"recording_mbid": "${X}", "release_mbid": "${Y}", "artist_mbids": ["${W}"], "recording_name": "Object Mapping"}, "additional_info": {"submission_client": "Pano", "submission_client_version": "1.2"}}}`,
        '{"listened_at": 1735696800, "track_metadata": {"artist_name": "Zed", "track_name": "Plain"}}',
      ].join('\n');
      const zip = zipSync({
        'listens/2025/1.jsonl': enc.encode(`${listens}\n`),
        'user.json': enc.encode('{"user_id": 1, "user_name": "zed"}'),
        'readme.txt': enc.encode('not an export entry'),
      });
      const zipPath = writeUpload(h, 'job-zip', h.alice, 'listenbrainz_zip', zip);
      // The Last.fm export: two pages, a now-playing row, names with JSON structure characters.
      const tricky = 'Brackets ]} [{ "quoted" \\ back';
      const t = Math.floor(T0 / 1000);
      const lastfm = JSON.stringify([
        {
          recenttracks: {
            track: [
              { '@attr': { nowplaying: 'true' }, artist: { '#text': 'Now' }, name: 'Playing', album: { '#text': '' } },
              {
                artist: { '#text': 'Lf Artist', mbid: '' },
                name: tricky,
                album: { '#text': 'Lf Album', mbid: '' },
                mbid: 'aaaaaaaa-0000-4000-8000-000000000001',
                date: { uts: String(t - 7_200), '#text': '' },
              },
            ],
            '@attr': { page: '1', totalPages: '2' },
          },
        },
        {
          recenttracks: {
            track: {
              artist: { '#text': 'Lf Artist' },
              name: 'Single Row Page',
              album: { '#text': '' },
              mbid: '',
              date: { uts: String(t - 9_000) },
            },
          },
        },
      ]);
      const jsonPath = writeUpload(h, 'job-json', h.bob, 'lastfm_json', lastfm);
      const rt = runtime(h);

      await untilState(h, rt, 'job-zip', 'writing');
      await untilState(h, rt, 'job-json', 'writing');

      expect(job(h.db, 'job-zip')).toMatchObject({
        fetched: 3,
        staged: 3,
        invalid: 0,
        duplicates: 0,
        upload_path: null,
      });
      expect(stagedInputs(h, 'job-zip')).toEqual([
        {
          artist: 'Zed',
          track: 'Null Mapping',
          listenedAt: '2025-01-01T00:00:00Z',
          recordingMbid: A,
          releaseMbid: B,
          durationSeconds: 215,
        },
        // mbid_mapping is never copied: no recording or release MBID here.
        {
          artist: 'Zed',
          track: 'Object Mapping',
          album: 'Album Z',
          listenedAt: '2025-01-01T01:00:00Z',
          submissionClient: 'Pano 1.2',
        },
        { artist: 'Zed', track: 'Plain', listenedAt: '2025-01-01T02:00:00Z' },
      ]);
      expect(job(h.db, 'job-json')).toMatchObject({ fetched: 2, staged: 2, invalid: 0, upload_path: null });
      expect(stagedInputs(h, 'job-json')).toEqual([
        {
          artist: 'Lf Artist',
          track: tricky,
          album: 'Lf Album',
          recordingMbid: 'aaaaaaaa-0000-4000-8000-000000000001',
          listenedAt: new Date((t - 7_200) * 1000).toISOString().replace('.000Z', 'Z'),
        },
        {
          artist: 'Lf Artist',
          track: 'Single Row Page',
          listenedAt: new Date((t - 9_000) * 1000).toISOString().replace('.000Z', 'Z'),
        },
      ]);
      // Fully parsed: both upload files are gone.
      expect(existsSync(zipPath)).toBe(false);
      expect(existsSync(jsonPath)).toBe(false);

      // The records the writer builds carry the additional_info MBIDs only.
      await runImports(rt, h.kit.clock.nowMs());
      await runImports(rt, h.kit.clock.nowMs());
      const records = h
        .ops("import_job_id = 'job-zip'")
        .map((o) => JSON.parse(o.record_json as string) as Record<string, unknown>);
      expect(records.map((r) => [r.track, r.recordingMbid ?? null, r.releaseMbid ?? null])).toEqual([
        ['Null Mapping', A, B],
        ['Object Mapping', null, null],
        ['Plain', null, null],
      ]);
    });
  });

  it('a ZIP whose headers understate sizes is refused by counting actual inflated bytes past 64 MiB per entry or 256 MiB in total; a ratio > 100 or > 10,000 entries is refused; an upload over 64 MiB is 413', async () => {
    // Per entry: 65 MiB that inflates honestly at ~47:1, its headers claiming 100 bytes.
    const big = compressible(65 * MiB);
    const bigDeflated = deflateRawSync(big, { level: 1 });
    expect(big.length / bigDeflated.length).toBeLessThan(100);
    const understated = buildZip([{ name: 'listens/2025/1.jsonl', method: 8, data: bigDeflated, declaredSize: 100 }]);

    // Refused through the real parse of a job: it fails with zip_entry_too_large and its upload is deleted.
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const path = writeUpload(h, 'job-bomb', h.alice, 'listenbrainz_zip', understated);
      await untilState(h, runtime(h), 'job-bomb', 'failed');
      expect(job(h.db, 'job-bomb')).toMatchObject({ error: 'zip_entry_too_large', upload_path: null, staged: 0 });
      expect(existsSync(path)).toBe(false);
    });

    // In total: five 60 MiB entries (each within its bound, all claiming 100 bytes).
    const sixty = deflateRawSync(compressible(60 * MiB), { level: 1 });
    const five = buildZip(
      [1, 2, 3, 4, 5].map((m) => ({
        name: `listens/2025/${m}.jsonl`,
        method: 8 as const,
        data: sixty,
        declaredSize: 100,
      })),
    );
    let inflated = 0;
    expect(
      await zipError(
        readZip(chunks(five), {
          accept: () => true,
          data: (_name, chunk) => {
            inflated += chunk.length;
          },
        }),
      ),
    ).toBe('total_too_large');
    expect(inflated).toBeLessThanOrEqual(256 * MiB);
    expect(inflated).toBeGreaterThan(4 * 60 * MiB);

    // Ratio: 4 MiB of zeros compresses about 1,000:1.
    const zeros = deflateRawSync(new Uint8Array(4 * MiB), { level: 9 });
    const ratio = buildZip([{ name: 'listens/2025/2.jsonl', method: 8, data: zeros, declaredSize: 4 * MiB }]);
    let ratioBytes = 0;
    expect(
      await zipError(
        readZip(chunks(ratio), {
          accept: () => true,
          data: (_n, c) => {
            ratioBytes += c.length;
          },
        }),
      ),
    ).toBe('ratio_too_high');
    expect(ratioBytes).toBeLessThan(2 * MiB);

    // Entries: 10,001 empty stored entries (skipped names count too).
    const many = buildZip(
      Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
        name: `skip/${i}`,
        method: 0 as const,
        data: new Uint8Array(0),
        declaredSize: 0,
      })),
    );
    expect(await zipError(readZip(chunks(many), { accept: () => false, data: () => {} }))).toBe('too_many_entries');
    // 10,000 entries are fine.
    const enough = buildZip(
      Array.from({ length: MAX_ZIP_ENTRIES }, (_, i) => ({
        name: `skip/${i}`,
        method: 0 as const,
        data: new Uint8Array(0),
        declaredSize: 0,
      })),
    );
    expect(await zipError(readZip(chunks(enough), { accept: () => false, data: () => {} }))).toBe('accepted');

    // The upload route: a body over 64 MiB is 413 and nothing is kept.
    const { app, login } = await importsApp();
    const headers = login('did:plc:uploaderuploaderuploader');
    const res = await app.fetch('/api/v1/imports/upload?source=listenbrainz_zip', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: new Uint8Array(64 * MiB + 1),
    });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(413);
    expect(body.error.code).toBe('payload_too_large');
    expect(checkResponse('POST', '/api/v1/imports/upload', { status: 413, headers: res.headers, body })).toBe('valid');
    expect(existsSync(app.config.uploadDir) ? readdirSync(app.config.uploadDir) : []).toEqual([]);
    expect(app.db.one('SELECT count(*) AS n FROM import_jobs')).toEqual({ n: 0 });
  }, 120_000);

  it('feedback.jsonl rows resolve by recording_msid to the newest archive listen and by recording_mbid through mbid_mapping or additional_info into loves; unresolved rows count invalid with reason feedback_unresolved; scores 0 and -1 are skipped', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const M1 = '0b0b0b0b-1111-4111-8111-000000000001';
      const M9 = '0b0b0b0b-1111-4111-8111-000000000009';
      const R2 = 'c2c2c2c2-2222-4222-8222-000000000002';
      const R3 = 'c3c3c3c3-3333-4333-8333-000000000003';
      const line = (o: unknown) => JSON.stringify(o);
      const listens = [
        line({
          listened_at: 1_700_000_000.0,
          recording_msid: M1,
          track_metadata: { artist_name: 'Old Spelling', track_name: 'Song One' },
        }),
        line({
          listened_at: 1_700_000_500,
          recording_msid: M1,
          track_metadata: { artist_name: 'New Spelling', track_name: 'Song One' },
        }),
        line({
          listened_at: 1_700_000_100,
          track_metadata: { artist_name: 'Mapped', track_name: 'Song Two', mbid_mapping: { recording_mbid: R2 } },
        }),
        line({
          listened_at: 1_700_000_200,
          track_metadata: { artist_name: 'Info', track_name: 'Song Three', additional_info: { recording_mbid: R3 } },
        }),
      ];
      const feedback = [
        line({ recording_msid: M1, score: 1, created: 1_700_100_000 }),
        line({ recording_mbid: R2, score: 1, created: 1_700_100_001 }),
        line({ recording_mbid: R3, score: 1, created: 1_700_100_002 }),
        line({ recording_msid: M9, score: 1, created: 1_700_100_003 }),
        line({ recording_msid: M1, score: 0, created: 1_700_100_004 }),
        line({ recording_mbid: R2, score: -1, created: 1_700_100_005 }),
      ];
      // feedback.jsonl comes first in the archive: resolution still waits for every listens entry.
      const zip = zipSync({
        'feedback.jsonl': enc.encode(feedback.join('\n')),
        'listens/2023/11.jsonl': enc.encode(`${listens.join('\n')}\n`),
      });
      writeUpload(h, 'job-fb', h.alice, 'listenbrainz_zip', zip);
      const rt = runtime(h);
      await untilState(h, rt, 'job-fb', 'writing');

      const row = job(h.db, 'job-fb');
      expect(row).toMatchObject({ staged: 7, invalid: 1, duplicates: 0 });
      expect(JSON.parse(row.invalid_reasons)).toEqual({ feedback_unresolved: 1 });
      const items = h.db.all<ImportItemRow>("SELECT * FROM import_items WHERE job_id = 'job-fb' ORDER BY seq");
      const loves = items
        .map((i) => JSON.parse(i.record_json) as { kind: string; input: Record<string, unknown> })
        .filter((r) => r.kind === 'love')
        .map((r) => r.input);
      expect(loves).toEqual([
        { artist: 'New Spelling', track: 'Song One' },
        { artist: 'Mapped', track: 'Song Two', recordingMbid: R2 },
        { artist: 'Info', track: 'Song Three', recordingMbid: R3 },
      ]);

      // The writer turns them into love.put operations with origin import, never forwarded.
      await runImports(rt, h.kit.clock.nowMs());
      const loveOps = h.ops("kind = 'love.put'");
      expect(loveOps.map((o) => [o.origin, o.priority, o.collection, o.import_job_id])).toEqual(
        Array(3).fill(['import', 1, LOVE, 'job-fb']),
      );
      expect(h.ops("kind = 'love.delete'")).toHaveLength(0);
      expect(h.db.one('SELECT count(*) AS n FROM forward_outbox')).toEqual({ n: 0 });
      await h.runUntilIdle();
      const onPds = (await remoteRecords(h.kit, 'Alice', LOVE)).map((r) => r.value as Record<string, unknown>);
      expect(onPds.map((r) => [r.artist, r.track, r.recordingMbid ?? null]).sort()).toEqual([
        ['Info', 'Song Three', R3],
        ['Mapped', 'Song Two', R2],
        ['New Spelling', 'Song One', null],
      ]);
    });
  });

  it('an upload that would take ATMUSIC_UPLOAD_DIR past ATMUSIC_UPLOAD_MAX_BYTES or the filesystem below ATMUSIC_MIN_FREE_BYTES is 507 and writes nothing; the upload file is deleted once parsed and when its job is cancelled or fails', async () => {
    const body = lastfmExportBody(20);
    expect(body.length).toBeGreaterThan(1_000);
    const post = (a: ImportsApp, headers: Record<string, string>, payload: BodyInit, extra: RequestInit = {}) =>
      a.app.fetch('/api/v1/imports/upload?source=lastfm_json', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/octet-stream' },
        body: payload,
        ...extra,
      });
    const expect507 = async (res: Response) => {
      const json = (await res.json()) as unknown;
      expect(res.status).toBe(507);
      expect(json).toMatchObject({
        error: { code: 'insufficient_storage', message: 'The upload would exceed the storage limits.' },
      });
      expect(checkResponse('POST', '/api/v1/imports/upload', { status: 507, headers: res.headers, body: json })).toBe(
        'valid',
      );
    };
    const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

    // The directory cap (declared length, then counted while streaming without one).
    const capped = await importsApp({ ATMUSIC_UPLOAD_MAX_BYTES: '1000' });
    const h1 = capped.login('did:plc:capcapcapcapcapcapcapcap');
    await expect507(await post(capped, h1, body));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = enc.encode(body);
        for (let i = 0; i < bytes.length; i += 300) controller.enqueue(bytes.subarray(i, i + 300));
        controller.close();
      },
    });
    await expect507(await post(capped, h1, stream, { duplex: 'half' } as RequestInit));
    expect(files(capped.app.config.uploadDir)).toEqual([]);
    expect(capped.app.db.one('SELECT count(*) AS n FROM import_jobs')).toEqual({ n: 0 });

    // The free-space floor.
    const floor = await importsApp({ ATMUSIC_MIN_FREE_BYTES: '9000000000000000' });
    await expect507(await post(floor, floor.login('did:plc:floorfloorfloorfloorfloo'), body));
    expect(files(floor.app.config.uploadDir)).toEqual([]);
    expect(floor.app.db.one('SELECT count(*) AS n FROM import_jobs')).toEqual({ n: 0 });

    // Within the bounds: the file is kept (0600) only until parsed, cancelled or failed.
    const ok = await importsApp();
    const dir = ok.app.config.uploadDir;
    const parsedDid = 'did:plc:parsedparsedparsedparsed';
    const cancelDid = 'did:plc:cancelcancelcancelcancel';
    const failDid = 'did:plc:failfailfailfailfailfail';
    for (const did of [parsedDid, failDid]) seedCurrentUser(ok.app, did);

    const parsedRes = await post(ok, ok.login(parsedDid), body);
    const parsed = (await parsedRes.json()) as { id: string; state: string; source: string; remoteUser: null };
    expect(parsedRes.status).toBe(202);
    expect(parsed).toMatchObject({ state: 'waiting_index', source: 'lastfm_json', remoteUser: null });
    const parsedPath = join(dir, `${parsed.id}.upload`);
    expect(statSync(parsedPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(parsedPath).size).toBe(body.length);

    const cancelHeaders = ok.login(cancelDid);
    const cancelled = (await (await post(ok, cancelHeaders, body)).json()) as { id: string };
    const cancelledPath = join(dir, `${cancelled.id}.upload`);
    expect(existsSync(cancelledPath)).toBe(true);
    const cancelRes = await ok.app.fetch(`/api/v1/imports/${cancelled.id}/cancel`, {
      method: 'POST',
      headers: cancelHeaders,
    });
    expect(cancelRes.status).toBe(200);
    expect(await cancelRes.json()).toMatchObject({ state: 'cancelled' });
    expect(existsSync(cancelledPath)).toBe(false);
    expect(job(ok.app.db, cancelled.id).upload_path).toBeNull();

    const failed = (await (await post(ok, ok.login(failDid), '[{"recenttracks": {"track": [')).json()) as {
      id: string;
    };
    const failedPath = join(dir, `${failed.id}.upload`);
    expect(existsSync(failedPath)).toBe(true);

    for (let i = 0; i < 6; i++) await ok.tick();
    expect(job(ok.app.db, parsed.id)).toMatchObject({ state: 'writing', staged: 20, upload_path: null });
    expect(existsSync(parsedPath)).toBe(false);
    expect(job(ok.app.db, failed.id)).toMatchObject({ state: 'failed', error: 'export_malformed', upload_path: null });
    expect(existsSync(failedPath)).toBe(false);
    expect(files(dir)).toEqual([]);
  }, 30_000);

  it('a job whose slice was interrupted three times becomes failed with crash_loop and its upload file is deleted', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const path = writeUpload(h, 'job-crash', h.alice, 'lastfm_json', lastfmExportBody(5));
      expect(CRASH_LOOP_ATTEMPTS).toBe(3);
      for (let crash = 1; crash <= CRASH_LOOP_ATTEMPTS; crash++) {
        // The parse slice starts, then the process dies inside it (the read never returns).
        let reached!: () => void;
        const inSlice = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const dying: UploadStore = {
          read: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () => {
                reached();
                return new Promise<IteratorResult<Uint8Array>>(() => {});
              },
            }),
          }),
          remove: fsUploadStore.remove,
        };
        void runImports(runtime(h, dying), h.kit.clock.nowMs());
        await inSlice;
        expect(job(h.db, 'job-crash')).toMatchObject({ state: 'fetching', attempts: crash, staged: 0 });
        h.restart();
      }
      expect(existsSync(path)).toBe(true);

      const report = await runImports(runtime(h), h.kit.clock.nowMs());
      expect(report.actions).toEqual([{ jobId: 'job-crash', action: 'failed', detail: 'crash_loop' }]);
      expect(job(h.db, 'job-crash')).toMatchObject({
        state: 'failed',
        error: 'crash_loop',
        upload_path: null,
        staged: 0,
      });
      expect(existsSync(path)).toBe(false);
      // A failed job is never picked up again.
      const again = await runImports(runtime(h), h.kit.clock.nowMs());
      expect(again.actions).toEqual([]);
      expect(again.nextDueMs).toBeNull();
    });
  });
});

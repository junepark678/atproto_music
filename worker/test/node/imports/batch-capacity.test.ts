// scrobbleBatch capacity evidence (ADR 0006 "Capacity";
// docs/verification/batch-capacity.md). Deterministic ListenBrainz fixtures go
// through the actual import path: mapListenBrainzRow (the ZIP and API
// mapping), stageEntries, then writeSlice (buildScrobbleRecord, the exact
// sizer, one byte-filled container per slice). The fixtures are labelled
// representative, minimal and maximal; none is measured user data.

import { measureScrobbleBatch, scrobbleBatchSizer } from '@atmusic/atproto/scrobble-batch-size';
import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import {
  MAX_CREATE_BODY_BYTES,
  packScrobbleBatchEntries,
  type ScrobbleBatchEntry,
  type ScrobbleBatchRecord,
} from '@atmusic/core/scrobble-batch';
import { describe, expect, it } from 'vitest';
import { createJob } from '../../../src/imports/jobs';
import { mapListenBrainzRow } from '../../../src/imports/listenbrainz-source';
import { stageEntries } from '../../../src/imports/staging';
import { writeSlice } from '../../../src/imports/writer';
import { type Harness, T0, withHarness } from '../outbox/support';

const BATCH = 'com.example.atmusic.scrobbleBatch';
const T0S = Math.floor(T0 / 1000);
const UUID = (n: number) => `${n.toString(16).padStart(8, '0')}-4b2c-4d1e-9f3a-1c2d3e4f5a6b`;

/**
 * Representative fixture: what a ListenBrainz listen submitted by a typical
 * scrobbler carries (artist, title, release, the usual MBIDs, duration, track
 * number, submission client and music service). Names have fixed lengths so
 * every entry is the same size.
 */
function representative(i: number) {
  return {
    listened_at: T0S - 86_400 - i * 180,
    track_metadata: {
      artist_name: 'Radiohead',
      track_name: 'Weird Fishes/Arpeggi',
      release_name: 'In Rainbows',
      additional_info: {
        recording_mbid: UUID(0x1000_0000 + i),
        release_mbid: UUID(0x2000_0000),
        release_group_mbid: UUID(0x3000_0000),
        artist_mbids: [UUID(0x4000_0000)],
        duration_ms: 318_000,
        tracknumber: 4,
        submission_client: 'Pano Scrobbler',
        submission_client_version: '3.9.1',
        music_service: 'spotify.com',
      },
    },
  };
}

/** Minimal fixture: only the required artist and title, one character each. */
function minimal(i: number) {
  return { listened_at: T0S - 86_400 - i * 60, track_metadata: { artist_name: 'a', track_name: 'b' } };
}

/**
 * Maximal fixture: every mapped field at its longest, display strings of 256
 * scalars mixing four-byte, multibyte and JSON-escaped characters.
 */
function maximal(i: number) {
  const text = (seed: string) => `${seed}${'🎵é"\\\u0001'.repeat(51)}`.slice(0, 256 + 51);
  const capped = (s: string) => Array.from(s).slice(0, 256).join('');
  return {
    listened_at: T0S - 86_400 - i * 60,
    track_metadata: {
      artist_name: capped(text('A')),
      track_name: capped(text(`T${String(i).padStart(5, '0')}`)),
      release_name: capped(text('R')),
      additional_info: {
        release_artist_name: capped(text('B')),
        recording_mbid: UUID(0x1000_0000 + i),
        release_mbid: UUID(0x2000_0000),
        release_group_mbid: UUID(0x3000_0000),
        artist_mbids: Array.from({ length: 10 }, (_, k) => UUID(0x4000_0000 + k)),
        duration: 86_400,
        tracknumber: 9_999,
        isrc: 'GBAYE0601498',
        submission_client: 'c'.repeat(64),
        music_service: `${'m'.repeat(60)}.example.com`,
      },
    },
  };
}

type Fixture = (i: number) => unknown;

/** Entries exactly as the writer builds them (mapping → staged input → record → entry). */
function entries(fixture: Fixture, n: number, nowMs: number): ScrobbleBatchEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const mapped = mapListenBrainzRow(fixture(i)).entry;
    if (mapped.kind !== 'listen') throw new Error('fixture listen did not map');
    const built = buildScrobbleRecord(mapped.input, 'com.example.atmusic', { nowMs: () => nowMs });
    if (!built.ok) throw new Error('fixture listen did not build');
    const { $type: _type, ...fields } = built.record;
    return {
      id: `3lb2${String(i)
        .padStart(9, '2')
        .replace(/[0189]/g, 'a')}`,
      ...fields,
    };
  });
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Imports `n` listens of `fixture` through staging and the writer; returns the container lengths. */
async function importThroughWriter(
  h: Harness,
  jobId: string,
  fixture: Fixture,
  n: number,
): Promise<ScrobbleBatchRecord[]> {
  const now = h.kit.clock.nowMs();
  createJob(h.db, {
    id: jobId,
    did: h.alice,
    source: 'listenbrainz_zip',
    remoteUser: null,
    uploadPath: `/nonexistent/${jobId}`,
    uploadBytes: 0,
    now,
  });
  for (let start = 0; start < n; start += 1_000) {
    const parsed = Array.from(
      { length: Math.min(1_000, n - start) },
      (_, i) => mapListenBrainzRow(fixture(start + i)).entry,
    );
    await stageEntries(h.m, { id: jobId, did: h.alice }, parsed, { now });
  }
  h.db.run("UPDATE import_jobs SET state = 'writing' WHERE id = ?", jobId);
  for (let guard = 0; guard < 1_000; guard++) {
    const report = await writeSlice(h.m, { id: jobId, did: h.alice }, now);
    if (report.taken === 0) break;
    // Test-only stand-in for the outbox: settled containers free the back-pressure room.
    h.db.run("UPDATE import_items SET state = 'written' WHERE job_id = ? AND state = 'queued'", jobId);
  }
  expect(
    h.db.one<{ n: number }>("SELECT count(*) AS n FROM import_items WHERE job_id = ? AND state = 'staged'", jobId)?.n,
  ).toBe(0);
  return h.ops(`import_job_id = '${jobId}'`).map((op) => JSON.parse(op.record_json as string) as ScrobbleBatchRecord);
}

describe('scrobbleBatch capacity (ListenBrainz fixtures)', () => {
  it('measures the representative fixture through mapping, staging and the writer', async () => {
    await withHarness(async (h) => {
      h.seedUser(h.alice);
      const records = await importThroughWriter(h, 'job-rep', representative, 3_000);
      const sample = records[0]!.listens[0]!;
      const sizes = records.map((record, i) =>
        measureScrobbleBatch(record, {
          repo: h.alice,
          collection: BATCH,
          rkey: h.ops("import_job_id = 'job-rep'")[i]!.rkey!,
        }),
      );
      // One representative entry is 507 bytes of JSON (shown; its listenedAt keeps nanoseconds).
      expect(bytes(sample)).toBe(507);
      expect(Object.keys(sample).sort()).toEqual([
        'album',
        'artist',
        'artistMbids',
        'createdAt',
        'durationSeconds',
        'id',
        'listenedAt',
        'musicService',
        'recordingMbid',
        'releaseGroupMbid',
        'releaseMbid',
        'submissionClient',
        'track',
        'trackNumber',
      ]);
      // 3,000 listens: one full container and the job's tail, never a short one in between.
      expect(records.map((r) => r.listens.length)).toEqual([1_947, 1_053]);
      expect(sizes).toEqual([
        { cborBytes: 889_868, createBodyBytes: 989_297 },
        { cborBytes: 481_310, createBodyBytes: 535_145 },
      ]);
      // The next listen does not fit the full container.
      const grown = { ...records[0]!, listens: [...records[0]!.listens, records[1]!.listens[0]!] };
      expect(
        measureScrobbleBatch(grown, { repo: h.alice, collection: BATCH, rkey: '3lb2batchidab' }).createBodyBytes,
      ).toBe(989_805);
      expect(989_805).toBeGreaterThan(MAX_CREATE_BODY_BYTES);
    });
  }, 120_000);

  it('bounds per-container capacity with minimal and maximal fixtures and projects 1,000 and 116,700 representative listens', () => {
    const now = T0;
    const envelope = { $type: BATCH, createdAt: new Date(now).toISOString() };
    const request = { repo: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', collection: BATCH, rkey: '3lb2batchidab' };
    const pack = (list: ScrobbleBatchEntry[]) =>
      packScrobbleBatchEntries(list, {
        sizer: scrobbleBatchSizer(envelope, request),
        measure: (group) => measureScrobbleBatch({ ...envelope, listens: [...group] }, request),
      });
    const measured = (fixture: Fixture, n: number) => {
      const list = entries(fixture, n, now);
      const groups = pack(list);
      const first = groups[0]!;
      const next = groups[1]?.entries[0];
      return {
        entryJson: bytes(list[0]),
        perContainer: first.entries.length,
        cbor: first.cborBytes,
        body: first.createBodyBytes,
        nextBody:
          next === undefined
            ? null
            : measureScrobbleBatch({ ...envelope, listens: [...first.entries, next] }, request).createBodyBytes,
        containers: groups.length,
        lengths: groups.map((g) => g.entries.length),
      };
    };
    // Lower bound on capacity: every mapped field at its longest, escape-rich multibyte text.
    const most = measured(maximal, 1_000);
    expect(most).toMatchObject({
      entryJson: 4_224,
      perContainer: 234,
      cbor: 642_418,
      body: 988_871,
      nextBody: 993_096,
    });
    // Upper bound for built entries: one-character artist and title.
    const least = measured(minimal, 20_000);
    expect(least).toMatchObject({
      entryJson: 128,
      perContainer: 7_668,
      cbor: 835_901,
      body: 989_393,
      nextBody: 989_522,
    });
    // Representative: 1,000 listens are one three-point create; a large import amortizes
    // to 3 × 1,000 / 1,947 = 1.54 points per 1,000 listens; 116,700 listens are 60 creates.
    const thousand = measured(representative, 1_000);
    expect(thousand).toMatchObject({ perContainer: 1_000, containers: 1, nextBody: null });
    const large = measured(representative, 116_700);
    expect(large).toMatchObject({
      entryJson: 507,
      perContainer: 1_947,
      cbor: 889_868,
      body: 989_297,
      nextBody: 989_805,
    });
    expect(large.containers).toBe(60);
    expect(large.lengths.slice(0, -1).every((n) => n === 1_947)).toBe(true);
    expect(large.lengths.at(-1)).toBe(116_700 - 59 * 1_947);
    expect(large.containers * 3).toBe(180);
    for (const m of [most, least, large]) {
      expect(m.body).toBeLessThanOrEqual(MAX_CREATE_BODY_BYTES);
      expect(m.nextBody).toBeGreaterThan(MAX_CREATE_BODY_BYTES);
      expect(m.cbor).toBeLessThan(m.body);
    }
  }, 120_000);
});

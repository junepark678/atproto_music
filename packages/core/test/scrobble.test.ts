/// <reference types="vite/client" />
import { buildFollowRecord, validateFollowRecord } from '@atmusic/core/follow';
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import {
  buildScrobbleRecord,
  JsonFloat,
  MSG_DISPLAY,
  MSG_DURATION,
  MSG_HYPHENATED_UUID,
  MSG_LONE_SURROGATE,
  MSG_UNKNOWN_FIELD,
  MSG_UUID,
  parseLexiconJson,
  reasonText,
  trimWhiteSpace,
  validateScrobbleRecord,
} from '@atmusic/core/scrobble';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { MSG_BOUNDS, parseRfc3339 } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';
import validationJson from '../../../tests/goldens/validation.json?raw';

interface Vector {
  id: string;
  kind: 'scrobbleInput' | 'scrobbleRecord' | 'followRecord' | 'followSubject';
  json: string;
  receiptTime: string;
  verdict: 'accept' | 'reject';
  output: Record<string, unknown> | null;
  error: { stage: 'json' | 'validation'; code: string; field: string | null; message: string } | null;
}
const golden = JSON.parse(validationJson) as { namespacePrefix: string; receiptTime: string; vectors: Vector[] };
const byId = new Map(golden.vectors.map((v) => [v.id, v]));
function vector(id: string): Vector {
  const v = byId.get(id);
  if (!v) throw new Error(`missing golden vector ${id}`);
  return v;
}

const P = FIXTURE_PREFIX;
const RECEIPT_NS = 1_768_478_400_000_000_000n; // 2026-01-15T12:00:00Z
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const base = { artist: 'Björk', track: 'Jóga', listenedAt: '2026-01-15T11:00:00Z' };
const remote = (over: Record<string, unknown> = {}) => ({
  $type: `${P}.scrobble`,
  ...base,
  createdAt: '2026-01-15T11:00:00Z',
  ...over,
});

type Outcome = { verdict: 'accept'; output: unknown } | { verdict: 'reject'; error: unknown };

/** Run one golden vector through the TypeScript port exactly as the oracle ran it. */
function run(v: Vector, value: unknown): Outcome {
  const receiptNs = parseRfc3339(v.receiptTime);
  if (receiptNs === null) throw new Error(`bad receipt ${v.receiptTime}`);
  const clock = fixedClock(v.receiptTime);
  switch (v.kind) {
    case 'scrobbleInput': {
      const r = buildScrobbleRecord(value, P, clock);
      return r.ok ? { verdict: 'accept', output: r.record } : { verdict: 'reject', error: r.reason };
    }
    case 'scrobbleRecord': {
      const r = validateScrobbleRecord(value, P, receiptNs);
      return r.ok ? { verdict: 'accept', output: r.row.record } : { verdict: 'reject', error: r.reason };
    }
    case 'followRecord': {
      const r = validateFollowRecord(value, P, receiptNs);
      return r.ok ? { verdict: 'accept', output: r.row.record } : { verdict: 'reject', error: r.reason };
    }
    case 'followSubject': {
      // FollowRecord::new has no actor; any actor distinct from every subject keeps parity.
      const r = buildFollowRecord({ actor: ALICE, subject: value as string }, P, clock);
      return r.ok ? { verdict: 'accept', output: r.record } : { verdict: 'reject', error: r.reason };
    }
  }
}

it('validation.json vectors match Rust verdicts and reasons', () => {
  expect(golden.namespacePrefix).toBe(FIXTURE_PREFIX);
  expect(golden.vectors).toHaveLength(142);
  const kinds = golden.vectors.reduce<Record<string, number>>((acc, v) => {
    acc[v.kind] = (acc[v.kind] ?? 0) + 1;
    return acc;
  }, {});
  expect(kinds).toEqual({ scrobbleInput: 92, scrobbleRecord: 18, followRecord: 11, followSubject: 21 });

  let jsonStage = 0;
  for (const v of golden.vectors) {
    const parsed = parseLexiconJson(v.json);
    if (v.error?.stage === 'json') {
      // serde_json refused the whole document (lone surrogate): so does the TS decoder.
      jsonStage++;
      expect({ id: v.id, ok: parsed.ok }).toEqual({ id: v.id, ok: false });
      // Defence in depth: the validator itself refuses the value after a plain JSON.parse.
      const outcome = run(v, JSON.parse(v.json));
      expect({ id: v.id, verdict: outcome.verdict }).toEqual({ id: v.id, verdict: 'reject' });
      if (outcome.verdict === 'reject') {
        expect(outcome.error).toMatchObject({ code: 'invalid_field', message: MSG_LONE_SURROGATE });
      }
      continue;
    }
    expect({ id: v.id, ok: parsed.ok }).toEqual({ id: v.id, ok: true });
    if (!parsed.ok) continue;
    const outcome = run(v, parsed.value);
    if (v.verdict === 'accept') {
      expect({ id: v.id, ...outcome }).toEqual({ id: v.id, verdict: 'accept', output: v.output });
    } else {
      const { stage: _stage, ...error } = v.error ?? { stage: 'validation' };
      expect({ id: v.id, ...outcome }).toEqual({ id: v.id, verdict: 'reject', error });
    }
  }
  expect(jsonStage).toBe(5);

  // Remote rows carry the storage forms the projection writes.
  const row = validateScrobbleRecord(parseValue(vector('record_remote_spelling_kept').json), P, RECEIPT_NS);
  expect(row).toEqual({
    ok: true,
    row: {
      record: vector('record_remote_spelling_kept').output,
      artist: '  BJÖRK  ',
      track: 'Jóga',
      album: null,
      listenedAt: '2026-01-15T11:00:00.000000000Z',
      listenedAtNs: 1_768_474_800_000_000_000n,
      createdAt: '2026-01-15T11:00:00.000000000Z',
      createdAtNs: 1_768_474_800_000_000_000n,
      durationSeconds: null,
      recordingMbid: null,
    },
  });
});

it('now+300s accepted and now+301s rejected at 2026-01-15T12:00:00Z receipt', () => {
  const clock = fixedClock('2026-01-15T12:00:00Z');
  const local = (listenedAt: string) => buildScrobbleRecord({ ...base, listenedAt }, P, clock);
  const ok300 = local('2026-01-15T12:05:00Z');
  expect(ok300).toEqual({
    ok: true,
    record: {
      $type: `${P}.scrobble`,
      artist: 'Björk',
      track: 'Jóga',
      listenedAt: '2026-01-15T12:05:00.000000000Z',
      createdAt: '2026-01-15T12:00:00Z',
    },
  });
  const bounds = (field: string) => ({
    ok: false,
    reason: { field, code: 'invalid_field' as const, message: MSG_BOUNDS },
  });
  expect(local('2026-01-15T12:05:01Z')).toEqual(bounds('listenedAt'));
  expect(local('2026-01-15T12:05:00.000000001Z')).toEqual(bounds('listenedAt'));
  expect(local('1970-01-01T00:00:00Z').ok).toBe(true);
  expect(local('1969-12-31T23:59:59Z')).toEqual(bounds('listenedAt'));

  // The bound moves with the receipt time, never with a later wall clock.
  clock.advance(1000);
  expect(local('2026-01-15T12:05:01Z').ok).toBe(true);
  expect(local('2026-01-15T12:05:02Z')).toEqual(bounds('listenedAt'));

  // Remote records: both listenedAt and createdAt use the event receipt time.
  const at = (over: Record<string, unknown>, receipt = RECEIPT_NS) => validateScrobbleRecord(remote(over), P, receipt);
  const accepted = at({ listenedAt: '2026-01-15T12:05:00Z', createdAt: '2026-01-15T12:05:00Z' });
  expect(accepted.ok && accepted.row.listenedAt).toBe('2026-01-15T12:05:00.000000000Z');
  expect(accepted.ok && accepted.row.createdAt).toBe('2026-01-15T12:05:00.000000000Z');
  expect(at({ listenedAt: '2026-01-15T12:05:01Z' })).toEqual(bounds('listenedAt'));
  expect(at({ createdAt: '2026-01-15T12:05:01Z' })).toEqual(bounds('createdAt'));
  expect(at({ createdAt: '1969-12-31T23:59:59.999999999Z' })).toEqual(bounds('createdAt'));
  expect(at({ listenedAt: '1970-01-01T00:00:00Z' }).ok).toBe(true);
  // A replay one hour later still validates against the original receipt.
  expect(at({ listenedAt: '2026-01-15T12:05:01Z' }, RECEIPT_NS + 3_600_000_000_000n).ok).toBe(true);
  expect(reasonText(bounds('listenedAt').reason)).toBe(`listenedAt: ${MSG_BOUNDS}`);
});

it('White_Space trim (NEL, U+3000) differs from JS trim and matches Rust', () => {
  // JS trim() and \s disagree with Unicode White_Space in both directions.
  expect('\u0085Björk\u0085'.trim()).toBe('\u0085Björk\u0085');
  expect(trimWhiteSpace('\u0085Björk\u0085')).toBe('Björk');
  expect('\ufeffBjörk\ufeff'.trim()).toBe('Björk');
  expect(trimWhiteSpace('\ufeffBjörk\ufeff')).toBe('\ufeffBjörk\ufeff');
  expect(/^\s$/.test('\ufeff')).toBe(true);
  expect(/^\s$/.test('\u0085')).toBe(false);
  expect(trimWhiteSpace('\u3000\u00a0 Björk \t\u2003')).toBe('Björk');
  expect(trimWhiteSpace('\u180e\u200b')).toBe('\u180e\u200b');

  const clock = fixedClock();
  const artist = (value: string) => buildScrobbleRecord({ ...base, artist: value }, P, clock);
  const record = (value: string) => {
    const r = artist(value);
    return r.ok ? r.record.artist : r.reason;
  };
  const display = { field: 'artist', code: 'invalid_field', message: MSG_DISPLAY };
  expect(record('\u0085Björk\u0085')).toBe('Björk');
  expect(record('\u3000Björk\u3000')).toBe('Björk');
  expect(record('\u0085')).toEqual(display);
  expect(record('\u3000')).toEqual(display);
  expect(record('\u2028')).toEqual(display);
  expect(record('\u00a0')).toEqual(display);
  expect(record('\ufeff')).toBe('\ufeff');
  expect(record('\u200b')).toBe('\u200b');
  expect(record('\u180e')).toBe('\u180e');
  expect(record('\ufeffBjörk\ufeff')).toBe('\ufeffBjörk\ufeff');

  // Each of these matches the Rust oracle's own vector.
  for (const id of [
    'artist_trimmed_nel_edges',
    'artist_trimmed_mixed_edges',
    'artist_trimmed_bom_edges_kept',
    'artist_nel_only',
    'artist_ideographic_space_only',
    'artist_bom_only_not_white_space',
    'artist_mongolian_vowel_separator_only',
  ]) {
    const v = vector(id);
    const outcome = run(v, parseValue(v.json));
    expect({ id, verdict: outcome.verdict }).toEqual({ id, verdict: v.verdict });
    if (outcome.verdict === 'accept') expect(outcome.output).toEqual(v.output);
  }

  // Remote validation applies the same trim for emptiness but keeps the spelling.
  expect(validateScrobbleRecord(remote({ artist: '\u3000' }), P, RECEIPT_NS)).toEqual({ ok: false, reason: display });
  const kept = validateScrobbleRecord(remote({ artist: '\u0085Björk\u0085' }), P, RECEIPT_NS);
  expect(kept.ok && kept.row.artist).toBe('\u0085Björk\u0085');
  // Bounds are counted on the raw value: 256 scalars plus padding exceed the limit.
  expect(record(` ${'a'.repeat(255)} `)).toEqual(display);
  expect(record(` ${'a'.repeat(254)} `)).toBe('a'.repeat(254));
  // Lone surrogates never reach a record.
  expect(record('a\ud800b')).toEqual({ field: 'artist', code: 'invalid_field', message: MSG_LONE_SURROGATE });
});

it('buildScrobbleRecord rejects unknown input fields', () => {
  const clock = fixedClock();
  const unknown = (field: string) => ({
    ok: false,
    reason: { field, code: 'invalid_field', message: MSG_UNKNOWN_FIELD },
  });
  expect(buildScrobbleRecord({ ...base, mood: 'happy' }, P, clock)).toEqual(unknown('mood'));
  expect(buildScrobbleRecord({ ...base, createdAt: '2026-01-15T11:00:00Z' }, P, clock)).toEqual(unknown('createdAt'));
  expect(buildScrobbleRecord({ ...base, $type: `${P}.scrobble` }, P, clock)).toEqual(unknown('$type'));
  expect(buildScrobbleRecord({ ...base, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb' }, P, clock)).toEqual(unknown('did'));
  // Several unknown fields: the first in code-point order, as the oracle's sorted map.
  expect(buildScrobbleRecord({ zeta: 1, ...base, Alpha: 2, mood: 3 }, P, clock)).toEqual(unknown('Alpha'));
  // Unknown fields are rejected even when a known field is also invalid.
  expect(buildScrobbleRecord({ artist: '', mood: 'x' }, P, clock)).toEqual(unknown('mood'));
  // A JSON `__proto__` key is an own data property, hence an unknown field (never a prototype).
  expect(buildScrobbleRecord(JSON.parse(`{"__proto__":"x",${JSON.stringify(base).slice(1)}`), P, clock)).toEqual(
    unknown('__proto__'),
  );
  // `undefined` is not JSON-representable, so an undefined-valued key counts as omitted.
  const omitted = buildScrobbleRecord(
    { ...base, album: undefined, durationSeconds: undefined, mood: undefined },
    P,
    clock,
  );
  expect(omitted.ok && Object.keys(omitted.record).sort()).toEqual([
    '$type',
    'artist',
    'createdAt',
    'listenedAt',
    'track',
  ]);
  // Non-objects are not inputs.
  for (const value of [null, ['Björk'], 'Björk', 7, new JsonFloat(1)]) {
    expect(buildScrobbleRecord(value, P, clock)).toEqual({
      ok: false,
      reason: { field: 'body', code: 'invalid_field', message: 'expected a JSON object' },
    });
  }
  // The same fields as a remote record are ignored (open lexicon object).
  const remoteRow = validateScrobbleRecord(remote({ mood: 'happy' }), P, RECEIPT_NS);
  expect(remoteRow.ok && remoteRow.row.record).toEqual(remote());

  // A clean input yields exactly the known record fields, ready for the outbox.
  const built = buildScrobbleRecord(
    {
      artist: '  BJÖRK  ',
      track: 'jóga',
      listenedAt: '2026-01-14T11:00:00+00:00',
      album: ' HOMOGENIC ',
      durationSeconds: 305,
      recordingMbid: '3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10',
    },
    P,
    clock,
  );
  expect(built).toEqual({
    ok: true,
    record: {
      $type: 'com.example.atmusic.scrobble',
      artist: 'BJÖRK',
      track: 'jóga',
      listenedAt: '2026-01-14T11:00:00.000000000Z',
      createdAt: '2026-01-15T12:00:00Z',
      album: 'HOMOGENIC',
      durationSeconds: 305,
      recordingMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
    },
  });
  // What the SPA builds, the ingestion validator accepts at the same receipt time.
  if (!built.ok) throw new Error('unreachable');
  const reread = validateScrobbleRecord(built.record, P, RECEIPT_NS);
  expect(reread.ok && reread.row.record).toEqual(built.record);
  // Building never needs publication rights, but needs a valid prefix.
  expect(() => buildScrobbleRecord(base, 'Not A Prefix', clock)).toThrow(RangeError);
});

it('duration 1 and 86400 accepted; 0, 86401 and 1.5 rejected; invalid MBID rejected; omitted album accepted', () => {
  const clock = fixedClock();
  const local = (over: Record<string, unknown>) => buildScrobbleRecord({ ...base, ...over }, P, clock);
  const err = (field: string, message: string) => ({ ok: false, reason: { field, code: 'invalid_field', message } });

  for (const d of [1, 86_400]) {
    const r = local({ durationSeconds: d });
    expect(r.ok && r.record.durationSeconds).toBe(d);
    const remoteRow = validateScrobbleRecord(remote({ durationSeconds: d }), P, RECEIPT_NS);
    expect(remoteRow.ok && remoteRow.row.durationSeconds).toBe(d);
  }
  for (const d of [0, 86_401, 1.5, -1, 4_294_967_296, null, '60', Number.NaN, new JsonFloat(60)]) {
    expect(local({ durationSeconds: d })).toEqual(err('durationSeconds', MSG_DURATION));
    expect(validateScrobbleRecord(remote({ durationSeconds: d }), P, RECEIPT_NS)).toEqual(
      err('durationSeconds', MSG_DURATION),
    );
  }
  // `60.0` in JSON text is a float, not a lexicon integer (Rust as_u64 refuses it).
  const floatDoc = parseLexiconJson(
    '{"artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","durationSeconds":60.0}',
  );
  expect(floatDoc.ok).toBe(true);
  if (floatDoc.ok) expect(buildScrobbleRecord(floatDoc.value, P, clock)).toEqual(err('durationSeconds', MSG_DURATION));
  const intDoc = parseLexiconJson(
    '{"artist":"Björk","track":"Jóga","listenedAt":"2026-01-15T11:00:00Z","durationSeconds":60}',
  );
  if (intDoc.ok) expect(buildScrobbleRecord(intDoc.value, P, clock).ok).toBe(true);
  expect(intDoc.ok).toBe(true);

  // MBIDs: hyphenated UUIDs in either case (normalized to lowercase locally).
  expect(local({ recordingMbid: '3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10' })).toMatchObject({
    ok: true,
    record: { recordingMbid: '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10' },
  });
  expect(local({ recordingMbid: '00000000-0000-0000-0000-000000000000' }).ok).toBe(true);
  for (const m of [
    '3f2f7f3e3c1d4b9e9a391f3a7c5b2d10',
    '{3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10}',
    'urn:uuid:3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
  ]) {
    expect(local({ recordingMbid: m })).toEqual(err('recordingMbid', MSG_HYPHENATED_UUID));
  }
  for (const m of [
    '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d1',
    '3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2dzz',
    ' 3f2f7f3e-3c1d-4b9e-9a39-1f3a7c5b2d10',
    '',
    'not-a-uuid',
  ]) {
    expect(local({ recordingMbid: m })).toEqual(err('recordingMbid', MSG_UUID));
  }
  expect(local({ recordingMbid: 42 })).toEqual(err('recordingMbid', 'expected a string or omitted field'));
  // Remote MBIDs keep their spelling.
  const upper = validateScrobbleRecord(
    remote({ recordingMbid: '3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10' }),
    P,
    RECEIPT_NS,
  );
  expect(upper.ok && upper.row.recordingMbid).toBe('3F2F7F3E-3C1D-4B9E-9A39-1F3A7C5B2D10');

  // Album: omitted stays omitted; a provided empty or null album is invalid.
  const noAlbum = local({});
  expect(noAlbum.ok && 'album' in noAlbum.record).toBe(false);
  const remoteNoAlbum = validateScrobbleRecord(remote(), P, RECEIPT_NS);
  expect(remoteNoAlbum.ok && remoteNoAlbum.row.album).toBeNull();
  expect(remoteNoAlbum.ok && 'album' in remoteNoAlbum.row.record).toBe(false);
  expect(local({ album: '' })).toEqual(err('album', MSG_DISPLAY));
  expect(local({ album: null })).toEqual(err('album', 'expected a string or omitted field'));
  const withAlbum = local({ album: ' Homogenic ' });
  expect(withAlbum.ok && withAlbum.record.album).toBe('Homogenic');
});

function parseValue(text: string): unknown {
  const parsed = parseLexiconJson(text);
  if (!parsed.ok) throw new Error(`golden JSON did not parse: ${parsed.message}`);
  return parsed.value;
}

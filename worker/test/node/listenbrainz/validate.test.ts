// POST /1/submit-listens validation (ADR 0005 §8.3, Q11; N2-08): ListenBrainz's
// envelope and per-listen checks with its verbatim messages, the whole request
// failing only for what ListenBrainz itself rejects, and the accept / defer /
// ignore classification of every listen it accepts.

import { buildScrobbleRecord } from '@atmusic/core/scrobble';
import { FIXTURE_NOW_ISO, fixedClock } from '@atmusic/core/test-support/clock';
import { describe, expect, it } from 'vitest';
import {
  LB_SUBMIT_MESSAGES as M,
  MAX_LISTEN_PAYLOAD_SIZE,
  type SubmissionResult,
  type ValidatedListen,
  validateSubmission,
} from '../../../src/listenbrainz/validate';
import { LISTENBRAINZ_PAYLOAD_TOO_LARGE } from '../../../src/node/http-bridge';

const PREFIX = 'com.example.atmusic';
const NOW_MS = Date.parse(FIXTURE_NOW_ISO);
const NOW_S = NOW_MS / 1000;

function body(doc: unknown): string {
  return JSON.stringify(doc);
}

function listen(listenedAt: unknown, meta: Record<string, unknown> = {}): Record<string, unknown> {
  return { listened_at: listenedAt, track_metadata: { artist_name: 'Artist', track_name: 'Track', ...meta } };
}

function submit(listenType: unknown, payload: unknown, extra: Record<string, unknown> = {}): string {
  return body({ listen_type: listenType, payload, ...extra });
}

function errorOf(result: SubmissionResult): string {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  expect(result.error.status).toBe(400);
  expect(Object.keys(result)).toEqual(['ok', 'error']);
  return result.error.message;
}

function listensOf(result: SubmissionResult): ValidatedListen[] {
  if (!result.ok) throw new Error(`expected success, got ${result.error.message}`);
  return result.listens;
}

function only(result: SubmissionResult): ValidatedListen {
  const listens = listensOf(result);
  expect(listens).toHaveLength(1);
  return listens[0]!;
}

describe('envelope checks', () => {
  it('the envelope errors come in ListenBrainz order with verbatim messages: payload too large, unparsable JSON, non-object, non-list payload, empty, >1000, average >10240 bytes, bad listen_type, two listens for single', () => {
    // Each body also breaks every later rule, so only the order can pick its message.

    // 1. Over 10,240,000 bytes, and not even JSON.
    expect(M.payloadTooLarge).toBe('Payload too large. Payload cannot exceed 10240000 bytes');
    expect(M.payloadTooLarge).toBe(LISTENBRAINZ_PAYLOAD_TOO_LARGE);
    const huge = new Uint8Array(MAX_LISTEN_PAYLOAD_SIZE + 1).fill(0x7b); // '{' x 10,240,001
    expect(errorOf(validateSubmission(huge, NOW_MS))).toBe(M.payloadTooLarge);
    // Exactly at the cap it is a parse error instead.
    expect(errorOf(validateSubmission(huge.subarray(0, MAX_LISTEN_PAYLOAD_SIZE), NOW_MS))).toMatch(
      /^Cannot parse JSON document: /,
    );

    // 2. Unparsable: syntax, undecodable UTF-8, an empty body, a lone surrogate escape, an overflowing number.
    expect(errorOf(validateSubmission('{"listen_type": "single", "payload": [', NOW_MS))).toMatch(
      /^Cannot parse JSON document: .+/,
    );
    expect(errorOf(validateSubmission(new Uint8Array([0xff, 0x7b, 0x7d]), NOW_MS))).toBe(
      "Cannot parse JSON document: 'utf-8' codec can't decode byte 0xff in position 0: invalid start byte",
    );
    expect(errorOf(validateSubmission(new Uint8Array([0x7b, 0x22, 0xe2, 0x82]), NOW_MS))).toBe(
      "Cannot parse JSON document: 'utf-8' codec can't decode bytes in position 2-3: unexpected end of data",
    );
    expect(errorOf(validateSubmission('', NOW_MS))).toBe(
      'Cannot parse JSON document: Input is a zero-length, empty document: line 1 column 1 (char 0)',
    );
    expect(
      // JSON.stringify writes a lone surrogate as the escape \ud800.
      errorOf(validateSubmission(submit('single', [listen(NOW_S, { artist_name: 'A\ud800' })]), NOW_MS)),
    ).toBe('Cannot parse JSON document: no low surrogate in string');
    expect(errorOf(validateSubmission('{"payload": 1e400}', NOW_MS))).toBe(
      'Cannot parse JSON document: number is infinity when parsed as double',
    );
    // A byte order mark is kept by Python's utf-8 codec, and orjson refuses it.
    expect(errorOf(validateSubmission(`﻿${submit('single', [listen(NOW_S)])}`, NOW_MS))).toMatch(
      /^Cannot parse JSON document: /,
    );

    // 3. Top level not an object.
    expect(M.notObject).toBe('Invalid JSON document submitted. Top level of JSON document should be a json object.');
    expect(errorOf(validateSubmission('[]', NOW_MS))).toBe(M.notObject);
    expect(errorOf(validateSubmission('"single"', NOW_MS))).toBe(M.notObject);
    // A missing payload key is ListenBrainz's KeyError answer.
    expect(errorOf(validateSubmission(body({ listen_type: 'bogus' }), NOW_MS))).toBe(
      'Invalid JSON document submitted.',
    );

    // 4. payload not a list (listen_type is bad too).
    expect(errorOf(validateSubmission(submit('bogus', { 0: listen(NOW_S) }), NOW_MS))).toBe(
      'The payload in the JSON document should be a list of listens.',
    );

    // 5. Empty.
    expect(errorOf(validateSubmission(submit('bogus', []), NOW_MS))).toBe('JSON document does not contain any listens');

    // 6. More than 1,000 listens (1,001 nulls, listen_type bad).
    expect(
      errorOf(
        validateSubmission(
          submit(
            'bogus',
            Array.from({ length: 1001 }, () => null),
          ),
          NOW_MS,
        ),
      ),
    ).toBe('Too many listens. You may not submit more than 1000 listens at once.');
    // 1,000 is not too many: the next rule (listen_type) answers.
    expect(
      errorOf(
        validateSubmission(
          submit(
            'bogus',
            Array.from({ length: 1000 }, () => null),
          ),
          NOW_MS,
        ),
      ),
    ).toBe('JSON document requires a valid listen_type key.');

    // 7. Raw body larger than 10,240 bytes per listen (one listen, listen_type bad).
    const padded = submit('bogus', [listen(NOW_S)], { pad: 'x'.repeat(10_240) });
    expect(new TextEncoder().encode(padded).byteLength).toBeGreaterThan(10_240);
    expect(errorOf(validateSubmission(padded, NOW_MS))).toBe(
      'JSON document is too large. Each listens may not be larger than 10240 bytes.',
    );
    // The same bytes spread over two listens average under the bound.
    expect(
      errorOf(validateSubmission(submit('bogus', [listen(NOW_S), listen(NOW_S)], { pad: 'x'.repeat(10_240) }), NOW_MS)),
    ).toBe('JSON document requires a valid listen_type key.');

    // 8. Bad or missing listen_type (two invalid listens, so rule 9 and the per-listen rules would also fire).
    for (const bad of ['bogus', 'Single', '', 1, null, ['single']]) {
      expect(errorOf(validateSubmission(submit(bad, [null, null]), NOW_MS))).toBe(
        'JSON document requires a valid listen_type key.',
      );
    }
    expect(errorOf(validateSubmission(body({ payload: [null] }), NOW_MS))).toBe('Invalid JSON document submitted.');

    // 9. single or playing_now with two listens (both null, which the per-listen check would reject).
    const moreThanOne = 'JSON document contains more than listen for a single/playing_now. It should contain only one.';
    expect(errorOf(validateSubmission(submit('single', [null, null]), NOW_MS))).toBe(moreThanOne);
    expect(errorOf(validateSubmission(submit('playing_now', [null, null]), NOW_MS))).toBe(moreThanOne);
    // import allows several; then the per-listen check answers.
    expect(errorOf(validateSubmission(submit('import', [null, null]), NOW_MS))).toBe(
      'Listen is empty and cannot be validated.',
    );
    // And a well-formed import of two passes.
    expect(listensOf(validateSubmission(submit('import', [listen(NOW_S), listen(NOW_S - 1)]), NOW_MS))).toHaveLength(2);
  });
});

describe('per-listen checks', () => {
  it("listened_at '123' is coerced; > now+3600 s gives 'Value for key listened_at is too high.'; < 1033430400 is too low; playing_now with listened_at is rejected", () => {
    const tooLow =
      'Value for key listened_at is too low. listened_at timestamp should be greater than 1033410600 (2002-10-01 00:00:00 UTC).';
    const tooHigh = 'Value for key listened_at is too high.';
    const one = (listenedAt: unknown) => validateSubmission(submit('single', [listen(listenedAt)]), NOW_MS);

    // The string '123' is coerced with int() and is then too low (not "must contain an int").
    expect(errorOf(one('123'))).toBe(tooLow);
    // Coercion as Python int(): whitespace, sign, underscores, Unicode digits; floats truncate.
    for (const spelled of [String(NOW_S), ` ${NOW_S}\n`, `+${NOW_S}`, '1_768_478_400', '١٧٦٨٤٧٨٤٠٠', NOW_S + 0.9]) {
      const v = only(one(spelled));
      expect(v.listen.listened_at).toBe(NOW_S);
      expect(v.listenedAtSeconds).toBe(NOW_S);
      expect(v.record?.listenedAt).toBe('2026-01-15T12:00:00Z');
      expect(v.disposition).toEqual({ kind: 'accept' });
    }
    // Not coercible: int() raises.
    for (const bad of ['1768478400.5', '0x10', 'abc', '', null, [NOW_S], { s: NOW_S }]) {
      expect(errorOf(one(bad))).toBe('JSON document must contain an int value for listened_at.');
    }
    expect(errorOf(validateSubmission(submit('single', [{ track_metadata: listen(0).track_metadata }]), NOW_MS))).toBe(
      'JSON document must contain the key listened_at at the top level.',
    );

    // Too high: above now + 3,600 s (and ListenBrainz's >= int(now) + 3600 makes +3,600 itself too high).
    expect(errorOf(one(NOW_S + 3601))).toBe(tooHigh);
    expect(errorOf(one(NOW_S + 3600))).toBe(tooHigh);
    expect(errorOf(one(String(NOW_S + 10 ** 12)))).toBe(tooHigh);
    expect(only(one(NOW_S + 3599)).disposition.kind).toBe('defer');

    // Too low: below 1033430400 (2002-10-01T00:00:00Z); the bound itself is valid.
    expect(errorOf(one(1_033_430_399))).toBe(tooLow);
    expect(errorOf(one(-5))).toBe(tooLow);
    expect(only(one(1_033_430_400)).record?.listenedAt).toBe('2002-10-01T00:00:00Z');

    // Extra top-level keys.
    expect(errorOf(validateSubmission(submit('single', [{ ...listen(NOW_S), inserted_at: NOW_S }]), NOW_MS))).toBe(
      'JSON document may only contain listened_at and track_metadata top level keys',
    );

    // playing_now must omit listened_at, and may hold track_metadata only.
    const meta = listen(0).track_metadata;
    expect(
      errorOf(validateSubmission(submit('playing_now', [{ listened_at: NOW_S, track_metadata: meta }]), NOW_MS)),
    ).toBe('JSON document must not contain listened_at while submitting playing_now.');
    expect(errorOf(validateSubmission(submit('playing_now', [{ track_metadata: meta, x: 1 }]), NOW_MS))).toBe(
      'JSON document may only contain track_metadata as top level key when submitting playing_now.',
    );
    const playing = only(validateSubmission(submit('playing_now', [{ track_metadata: meta }]), NOW_MS));
    expect(playing.disposition).toEqual({ kind: 'accept' });
    expect(playing.record).toBeNull();
    expect(playing.listenedAtSeconds).toBeNull();
    expect(playing.track).toEqual({ artist: 'Artist', track: 'Track' });
  });

  it("artist_name and track_name must be non-empty strings; empty release_name is deleted; duration with duration_ms is rejected; invalid release_mbid gives 'release_mbid MBID format invalid.'; a NUL is rejected", () => {
    const one = (meta: Record<string, unknown>) =>
      validateSubmission(submit('single', [{ listened_at: NOW_S, track_metadata: meta }]), NOW_MS);
    const named = (extra: Record<string, unknown>) => one({ artist_name: 'Artist', track_name: 'Track', ...extra });

    // Required, strings, non-empty after Python str.strip(); track_name is checked first.
    expect(errorOf(one({}))).toBe('JSON document does not contain required field track_metadata.track_name.');
    expect(errorOf(one({ track_name: 'Track' }))).toBe(
      'JSON document does not contain required field track_metadata.artist_name.',
    );
    expect(errorOf(one({ track_name: 'Track', artist_name: 5 }))).toBe(
      'track_metadata.artist_name must be a single string.',
    );
    expect(errorOf(one({ track_name: ['Track'], artist_name: 'A' }))).toBe(
      'track_metadata.track_name must be a single string.',
    );
    expect(errorOf(one({ track_name: 'Track', artist_name: ' \t　\u001f ' }))).toBe(
      'field track_metadata.artist_name is empty.',
    );
    expect(errorOf(one({ track_name: '', artist_name: '' }))).toBe('field track_metadata.track_name is empty.');
    expect(errorOf(validateSubmission(submit('single', [{ listened_at: NOW_S, track_metadata: null }]), NOW_MS))).toBe(
      'JSON document may not have track_metadata with null value.',
    );
    expect(errorOf(validateSubmission(submit('single', [{ listened_at: NOW_S }]), NOW_MS))).toBe(
      'JSON document must contain the key track_metadata at the top level.',
    );
    const trimmed = only(one({ artist_name: '  Artist　', track_name: '\nTrack ' }));
    expect(trimmed.listen.track_metadata).toEqual({ artist_name: 'Artist', track_name: 'Track' });
    expect(trimmed.record).toMatchObject({ artist: 'Artist', track: 'Track' });

    // An empty (after strip) release_name is deleted, never an error; a real one maps to album.
    const noRelease = only(named({ release_name: '   ' }));
    expect(noRelease.listen.track_metadata).toEqual({ artist_name: 'Artist', track_name: 'Track' });
    expect(noRelease.record).not.toHaveProperty('album');
    expect(errorOf(named({ release_name: 7 }))).toBe('track_metadata.release_name must be a single string.');
    expect(only(named({ release_name: ' Album ' })).record?.album).toBe('Album');

    // duration and duration_ms together are rejected; each is range-checked as int(float(x)).
    expect(errorOf(named({ additional_info: { duration: 200, duration_ms: 200_000 } }))).toBe(
      'JSON document should not contain both duration and duration_ms.',
    );
    expect(errorOf(named({ additional_info: { duration: 0 } }))).toBe(
      'Value for duration is invalid, should be a positive integer.',
    );
    expect(errorOf(named({ additional_info: { duration: null } }))).toBe(
      'Value for duration is invalid, should be a positive integer.',
    );
    expect(errorOf(named({ additional_info: { duration_ms: 'abc' } }))).toBe(
      'Value for duration_ms is invalid, should be a positive integer.',
    );
    expect(errorOf(named({ additional_info: { duration: 2_073_601 } }))).toBe(
      'Value for duration is too large, max permitted value is 2073600',
    );
    const dur = only(named({ additional_info: { duration: '245.7' } }));
    expect(dur.listen.track_metadata).toMatchObject({ additional_info: { duration: 245 } });
    expect(dur.record?.durationSeconds).toBe(245);
    // ListenBrainz accepts up to 2,073,600 s; our record allows 86,400, so the field is dropped with a note.
    const long = only(named({ additional_info: { duration: 100_000 } }));
    expect(long.disposition).toEqual({ kind: 'accept' });
    expect(long.record).not.toHaveProperty('durationSeconds');
    expect(long.dropped.map((d) => d.source)).toEqual(['additional_info.duration']);

    // MBIDs: null or empty are deleted; anything uuid.UUID() refuses is the request's error.
    const mbid = '0f5b8c2a-6c3e-4b2d-9a1f-1e2d3c4b5a69';
    expect(errorOf(named({ additional_info: { release_mbid: 'not-a-uuid' } }))).toBe(
      'release_mbid MBID format invalid.',
    );
    expect(errorOf(named({ additional_info: { recording_mbid: 12345 } }))).toBe('recording_mbid MBID format invalid.');
    expect(errorOf(named({ additional_info: { artist_mbids: [mbid, 'nope'] } }))).toBe(
      'artist_mbids MBID format invalid.',
    );
    const pruned = only(
      named({
        additional_info: { release_mbid: '', recording_mbid: null, artist_mbids: [], work_mbids: [null, mbid, ''] },
      }),
    );
    expect(pruned.listen.track_metadata).toEqual({
      artist_name: 'Artist',
      track_name: 'Track',
      additional_info: { work_mbids: [mbid] },
    });
    // uuid.UUID() spellings ListenBrainz accepts: braces, urn:uuid:, no hyphens, uppercase.
    for (const spelled of [`{${mbid}}`, `urn:uuid:${mbid}`, mbid.replaceAll('-', ''), mbid.toUpperCase()]) {
      expect(only(named({ additional_info: { release_mbid: spelled } })).disposition).toEqual({ kind: 'accept' });
    }
    expect(only(named({ additional_info: { release_mbid: mbid } })).record?.releaseMbid).toBe(mbid);

    // Tags: at most 50 of at most 64 characters, validated and then not stored.
    expect(errorOf(named({ additional_info: { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) } }))).toBe(
      'JSON document may not contain more than 50 items in track_metadata.additional_info.tags.',
    );
    expect(errorOf(named({ additional_info: { tags: ['x'.repeat(65)] } }))).toBe(
      'JSON document may not contain track_metadata.additional_info.tags longer than 64 characters.',
    );
    const tagged = only(named({ additional_info: { tags: ['𝄞'.repeat(64)] } }));
    expect(tagged.record).toEqual({ artist: 'Artist', track: 'Track', listenedAt: '2026-01-15T12:00:00Z' });

    // A NUL anywhere is rejected, with ListenBrainz's message naming the value.
    expect(errorOf(named({ track_name: 'Tr\u0000ack' }))).toBe('Tr\u0000ack contains a unicode null');
    expect(errorOf(named({ additional_info: { tags: ['ok', 'b\u0000d'] } }))).toBe('b\u0000d contains a unicode null');
    expect(errorOf(named({ additional_info: { origin_url: 'https://x.test/\u0000' } }))).toBe(
      'https://x.test/\u0000 contains a unicode null',
    );
    // The NUL check runs after every other check of the listen.
    expect(errorOf(named({ track_name: 'Tr\u0000ack', additional_info: { release_mbid: 'bad' } }))).toBe(
      'release_mbid MBID format invalid.',
    );
  });

  it('one listen that ListenBrainz itself rejects in a batch of 3 rejects the whole request and yields no records', () => {
    const good = (i: number) => listen(NOW_S - i * 60, { track_name: `Track ${i}` });
    for (const at of [0, 1, 2]) {
      const batch = [good(0), good(1), good(2)];
      batch[at] = listen(NOW_S - at * 60, { track_name: '   ' });
      const result = validateSubmission(submit('import', batch), NOW_MS);
      expect(result).toEqual({
        ok: false,
        error: { status: 400, message: 'field track_metadata.track_name is empty.' },
      });
      expect(result).not.toHaveProperty('listens');
    }
    // The first failing listen names the error.
    const two = [good(0), listen(NOW_S + 7200), listen(NOW_S, { artist_name: 3 })];
    expect(errorOf(validateSubmission(submit('import', two), NOW_MS))).toBe('Value for key listened_at is too high.');
    // The same three listens, all valid, give three records.
    const ok = listensOf(validateSubmission(submit('import', [good(0), good(1), good(2)]), NOW_MS));
    expect(ok.map((l) => l.record?.track)).toEqual(['Track 0', 'Track 1', 'Track 2']);
  });
});

describe('classification of listens ListenBrainz accepts', () => {
  it('a batch of 3 whose second listen has a 300-scalar artist_name is valid: two listens are accept and one is ignore with reason artist_invalid', () => {
    const longArtist = '𝄞'.repeat(300); // 300 scalars, 600 UTF-16 units, 1,200 UTF-8 bytes
    const batch = [
      listen(NOW_S - 120, { track_name: 'First' }),
      listen(NOW_S - 60, { artist_name: longArtist, track_name: 'Second' }),
      listen(NOW_S, { track_name: 'Third' }),
    ];
    const listens = listensOf(validateSubmission(submit('import', batch), NOW_MS));
    expect(listens.map((l) => l.disposition.kind)).toEqual(['accept', 'ignore', 'accept']);

    const ignored = listens[1]!;
    expect(ignored.record).toBeNull();
    expect(ignored.track).toBeNull();
    expect(ignored.listenedAtSeconds).toBe(NOW_S - 60);
    if (ignored.disposition.kind !== 'ignore') throw new Error('expected ignore');
    expect(ignored.disposition.reason).toBe('artist_invalid');
    expect(ignored.disposition.failure.field).toBe('artist');
    expect(ignored.disposition.artistPreview).toBe('𝄞'.repeat(128));
    expect(Array.from(ignored.disposition.artistPreview)).toHaveLength(128);
    expect(ignored.disposition.trackPreview).toBe('Second');

    // The two others are complete records our own builder accepts at receipt time.
    const clock = fixedClock();
    for (const [i, track] of [
      [0, 'First'],
      [2, 'Third'],
    ] as const) {
      const v = listens[i]!;
      expect(v.record).toEqual({
        artist: 'Artist',
        track,
        listenedAt: new Date((NOW_S - (2 - i) * 60) * 1000).toISOString().replace('.000', ''),
      });
      const built = buildScrobbleRecord(v.record, PREFIX, clock);
      expect(built.ok).toBe(true);
    }

    // A 257-scalar track name is track_invalid.
    const longTrack = listensOf(
      validateSubmission(submit('single', [listen(NOW_S, { track_name: `${'é'.repeat(256)}x` })]), NOW_MS),
    )[0]!;
    expect(longTrack.disposition).toMatchObject({ kind: 'ignore', reason: 'track_invalid', artistPreview: 'Artist' });
    // A playing_now with an over-long name is ignored too.
    const playing = only(
      validateSubmission(
        submit('playing_now', [{ track_metadata: { artist_name: longArtist, track_name: 'T' } }]),
        NOW_MS,
      ),
    );
    expect(playing.disposition).toMatchObject({ kind: 'ignore', reason: 'artist_invalid' });
  });

  it('a listen at now+1000 s is defer with notBeforeMs at listened_at − 300 s, at now+300 s it is accept, and at now+3601 s the request is the too-high error', () => {
    const one = (at: number) => validateSubmission(submit('single', [listen(at)]), NOW_MS);

    const deferred = only(one(NOW_S + 1000));
    expect(deferred.disposition).toEqual({ kind: 'defer', notBeforeMs: (NOW_S + 1000 - 300) * 1000 });
    expect(deferred.record?.listenedAt).toBe('2026-01-15T12:16:40Z');
    // The record is invalid now, and valid once created at notBeforeMs.
    const clock = fixedClock();
    expect(buildScrobbleRecord(deferred.record, PREFIX, clock).ok).toBe(false);
    clock.set('2026-01-15T12:11:40Z');
    expect(clock.nowMs()).toBe((NOW_S + 700) * 1000);
    expect(buildScrobbleRecord(deferred.record, PREFIX, clock).ok).toBe(true);

    expect(only(one(NOW_S + 300)).disposition).toEqual({ kind: 'accept' });
    expect(only(one(NOW_S + 301)).disposition).toEqual({ kind: 'defer', notBeforeMs: (NOW_S + 1) * 1000 });
    expect(only(one(NOW_S + 3599)).disposition).toEqual({ kind: 'defer', notBeforeMs: (NOW_S + 3299) * 1000 });
    expect(errorOf(one(NOW_S + 3601))).toBe('Value for key listened_at is too high.');

    // In a batch, deferral is per listen and never affects the others.
    const mixed = listensOf(validateSubmission(submit('import', [listen(NOW_S), listen(NOW_S + 1000)]), NOW_MS));
    expect(mixed.map((l) => l.disposition.kind)).toEqual(['accept', 'defer']);
  });
});

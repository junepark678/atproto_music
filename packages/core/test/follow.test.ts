import {
  buildFollowRecord,
  MSG_DID,
  MSG_FOLLOW_TYPE,
  MSG_SELF_FOLLOW,
  validateFollowRecord,
} from '@atmusic/core/follow';
import { FIXTURE_PREFIX } from '@atmusic/core/namespace';
import { MSG_REQUIRED_STRING } from '@atmusic/core/scrobble';
import { fixedClock } from '@atmusic/core/test-support/clock';
import { MSG_BOUNDS } from '@atmusic/core/timestamp';
import { expect, it } from 'vitest';

const P = FIXTURE_PREFIX;
const RECEIPT_NS = 1_768_478_400_000_000_000n; // 2026-01-15T12:00:00Z
const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const err = (field: string, message: string) => ({ ok: false, reason: { field, code: 'invalid_field', message } });
const remote = (over: Record<string, unknown> = {}) => ({
  $type: `${P}.follow`,
  subject: BOB,
  createdAt: '2026-01-15T11:00:00Z',
  ...over,
});

it('follow validation and self-follow rejection', () => {
  const clock = fixedClock();

  // DID forms are accepted, locally and remotely.
  for (const subject of [BOB, 'did:web:example.com', 'did:web:localhost%3A8080']) {
    expect(buildFollowRecord({ actor: ALICE, subject }, P, clock)).toEqual({
      ok: true,
      record: { $type: 'com.example.atmusic.follow', subject, createdAt: '2026-01-15T12:00:00Z' },
    });
    const r = validateFollowRecord(remote({ subject }), P, RECEIPT_NS, ALICE);
    expect(r).toEqual({
      ok: true,
      row: {
        record: remote({ subject }),
        subject,
        createdAt: '2026-01-15T11:00:00.000000000Z',
        createdAtNs: 1_768_474_800_000_000_000n,
      },
    });
  }

  // Non-DIDs (URL, handle, uppercase method, empty) and a missing subject are rejected.
  for (const subject of ['https://bob.test', 'bob.test', '@bob.test', 'did:PLC:bbbb', '', 'did:plc:']) {
    expect(buildFollowRecord({ actor: ALICE, subject }, P, clock)).toEqual(err('subject', MSG_DID));
    expect(validateFollowRecord(remote({ subject }), P, RECEIPT_NS, ALICE)).toEqual(err('subject', MSG_DID));
  }
  const { subject: _omit, ...missing } = remote();
  expect(validateFollowRecord(missing, P, RECEIPT_NS, ALICE)).toEqual(err('subject', MSG_REQUIRED_STRING));
  expect(validateFollowRecord(remote({ subject: 42 }), P, RECEIPT_NS)).toEqual(err('subject', MSG_REQUIRED_STRING));
  expect(buildFollowRecord({ actor: ALICE, subject: undefined as unknown as string }, P, clock)).toEqual(
    err('subject', MSG_DID),
  );

  // Self-follow: the SPA never builds one, and ingestion excludes one for its repository.
  expect(buildFollowRecord({ actor: ALICE, subject: ALICE }, P, clock)).toEqual(err('subject', MSG_SELF_FOLLOW));
  expect(validateFollowRecord(remote({ subject: ALICE }), P, RECEIPT_NS, ALICE)).toEqual(
    err('subject', MSG_SELF_FOLLOW),
  );
  // The same record in someone else's repository is an ordinary follow of Alice.
  expect(validateFollowRecord(remote({ subject: ALICE }), P, RECEIPT_NS, BOB).ok).toBe(true);
  // Without the repository DID only syntax is checked (the oracle's FollowRecord::from_json).
  expect(validateFollowRecord(remote({ subject: ALICE }), P, RECEIPT_NS).ok).toBe(true);
  // An invalid actor is a programming error, never a silent pass.
  expect(() => buildFollowRecord({ actor: 'alice.test', subject: BOB }, P, clock)).toThrow(TypeError);

  // Collection and shape.
  expect(validateFollowRecord(remote({ $type: `${P}.scrobble` }), P, RECEIPT_NS)).toEqual(
    err('$type', MSG_FOLLOW_TYPE),
  );
  expect(validateFollowRecord(remote({ $type: 'app.bsky.graph.follow' }), P, RECEIPT_NS)).toEqual(
    err('$type', MSG_FOLLOW_TYPE),
  );
  expect(validateFollowRecord([remote()], P, RECEIPT_NS)).toEqual(err('body', 'expected a JSON object'));
  // Unknown fields are ignored and dropped from the validated record.
  const extended = validateFollowRecord(remote({ note: 'x' }), P, RECEIPT_NS, ALICE);
  expect(extended.ok && extended.row.record).toEqual(remote());
  // The built record round-trips through ingestion validation.
  const built = buildFollowRecord({ actor: ALICE, subject: BOB }, P, clock);
  if (!built.ok) throw new Error('unreachable');
  expect(validateFollowRecord(built.record, P, RECEIPT_NS, ALICE)).toMatchObject({ ok: true, row: { subject: BOB } });
});

it('follow createdAt now+300s accepted and now+301s rejected at 2026-01-15T12:00:00Z receipt', () => {
  const at = (createdAt: string, receipt = RECEIPT_NS) =>
    validateFollowRecord(remote({ createdAt }), P, receipt, ALICE);
  const boundary = at('2026-01-15T12:05:00Z');
  expect(boundary).toEqual({
    ok: true,
    row: {
      record: remote({ createdAt: '2026-01-15T12:05:00Z' }),
      subject: BOB,
      createdAt: '2026-01-15T12:05:00.000000000Z',
      createdAtNs: 1_768_478_700_000_000_000n,
    },
  });
  expect(at('2026-01-15T12:04:59.999999999Z').ok).toBe(true);
  expect(at('2026-01-15T12:05:01Z')).toEqual(err('createdAt', MSG_BOUNDS));
  expect(at('2026-01-15T12:05:00.000000001Z')).toEqual(err('createdAt', MSG_BOUNDS));
  expect(at('1970-01-01T00:00:00Z').ok).toBe(true);
  expect(at('1969-12-31T23:59:59Z')).toEqual(err('createdAt', MSG_BOUNDS));
  expect(at('2026-01-15T12:00:00+01:00')).toEqual(err('createdAt', 'expected an AT Protocol UTC datetime'));
  const { createdAt: _omit, ...missing } = remote();
  expect(validateFollowRecord(missing, P, RECEIPT_NS)).toEqual(err('createdAt', MSG_REQUIRED_STRING));
  // One second later the same record is inside the window.
  expect(at('2026-01-15T12:05:01Z', RECEIPT_NS + 1_000_000_000n).ok).toBe(true);

  // The SPA stamps createdAt from the injected clock, so its records sit at receipt time.
  const clock = fixedClock('2026-01-15T12:00:00Z');
  clock.advance(123);
  const built = buildFollowRecord({ actor: ALICE, subject: BOB }, P, clock);
  expect(built).toEqual({
    ok: true,
    record: { $type: `${P}.follow`, subject: BOB, createdAt: '2026-01-15T12:00:00.123Z' },
  });
});

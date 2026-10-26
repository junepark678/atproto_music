/// <reference types="vite/client" />
// W2-01: the cursor codec against the Rust oracle (ADR 0004 §10.4 golden parity,
// TESTING.md cursor assertions, case M3.1.3/cursor_binding).
//
// - tests/goldens/cursors.json is exported from crates/core/src/cursor.rs.
// - The RUST_*_PROBES tables below extend it. They were produced on 2026-10-25
//   by running the unmodified crates/core cursor code from a scratch Cargo
//   harness (PageCursor::new + CursorCodec::encode, CursorCodec::decode of
//   payloads signed with the primary derived key, CursorPosition::compare,
//   PageCursor::contains/advance) and are pasted verbatim: `sig` is the Rust token's HMAC segment (so equal
//   signatures mean byte-identical payloads), `ok` the Rust-decoded cursor, and
//   null means Rust returned invalid_cursor.

import {
  advanceCursor,
  type CursorBindingInput,
  CursorKeyError,
  comparePositions,
  cursorBindings,
  cursorContains,
  cursorPayloadJson,
  decodeCursor,
  deriveCursorKey,
  encodeCursor,
  InvalidCursorError,
  MAX_PAYLOAD_BYTES,
  MAX_TOKEN_BYTES,
  MSG_INVALID_KEY,
  type PageCursor,
  pageCursor,
} from '@atmusic/core/cursor';
import { ApiError } from '@atmusic/core/errors';
import { afterEach, expect, it, vi } from 'vitest';
import cursorsJson from '../../../tests/goldens/cursors.json?raw';

interface GoldenPosition {
  timestamp: string;
  uri: string;
}
interface GoldenBinding {
  query: 'history' | 'feed' | 'following' | 'followers';
  did: string | null;
  scope: string | null;
  viewer: string | null;
}
interface GoldenCursor {
  asOf: string;
  binding: GoldenBinding;
  upper: GoldenPosition;
  last: GoldenPosition;
}
interface GoldenValid extends GoldenCursor {
  id: string;
  key: 'primary' | 'other';
  decoded: GoldenCursor;
  payloadJson: string;
  token: string;
}
interface GoldenTampered {
  id: string;
  key: 'primary' | 'other';
  binding: GoldenBinding;
  token: string;
  expectedError: string;
}
const golden = JSON.parse(cursorsJson) as {
  keys: {
    context: string;
    primary: { applicationKeyHex: string; derivedKeyHex: string };
    other: { applicationKeyHex: string; derivedKeyHex: string };
  };
  invalidKeys: { applicationKeyHex: string; expectedError: string }[];
  valid: GoldenValid[];
  tampered: GoldenTampered[];
  canonicalization: {
    asOf: string;
    equalsValidId: string;
    upper: GoldenPosition;
    last: GoldenPosition;
    token: string;
  };
  advance: {
    fromId: string;
    newLast: GoldenPosition;
    decoded: GoldenCursor;
    token: string;
    advanceToTupleNotBelowLast: { newLast: GoldenPosition; expectedError: string };
  };
};

const ALICE = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const CAROL = 'did:plc:cccccccccccccccccccccccc';

// Building blocks of the probe payloads.
const A = ALICE;
const S = `at://${ALICE}/com.example.atmusic.scrobble/`;
const T9 = '2026-01-15T11:00:00.000000000Z';
const B = `{"query":"history","did":"${A}","scope":null,"viewer":null}`;
const UP = `{"timestamp":"${T9}","uri":"${S}r07"}`;
const LP = `{"timestamp":"${T9}","uri":"${S}r01"}`;
const ASOF = '"asOf":"2026-01-15T12:00:00.000000000Z"';
const HISTORY_ALICE: CursorBindingInput = { query: 'history', did: ALICE, scope: null, viewer: null };
const BASE: PageCursor = {
  binding: { query: 'history', did: ALICE, scope: null, viewer: null },
  upper: { timestamp: T9, uri: `${S}r07` },
  last: { timestamp: T9, uri: `${S}r01` },
  asOf: '2026-01-15T12:00:00.000000000Z',
};
const PROBE_AS_OF = '2026-01-15T12:00:00Z';

interface EncodeProbe {
  binding?: CursorBindingInput;
  upper: [string, string];
  last: [string, string];
  asOf?: string;
  sig: string | null;
}
interface DecodeProbe {
  payload?: string;
  payloadHex?: string;
  ok: PageCursor | null;
}
interface ContainsProbe {
  position: [string, string];
  contains: boolean;
  /** HMAC segment of the Rust token for `advance(position)`; null: Rust refused the advance. */
  advanceSig: string | null;
}
interface CompareProbe {
  a: [string, string];
  b: [string, string];
  order: -1 | 0 | 1 | null;
}

const RUST_ENCODE_PROBES: readonly EncodeProbe[] = [
  {
    upper: ['2026-01-15t11:00:00z', `${S}r07`],
    last: ['2026-01-15t11:00:00z', `${S}r07`],
    sig: '9L_oRfN9SxduDDKDZ41Q1JkLBbTk8PZSY4X3IGX9hZQ',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15t11:00:00z',
    sig: 'Koy0f3tuX4dIT08bqf8xkohzt-Fn7FYhZGoCkcTAwW4',
  },
  {
    upper: ['2026-01-15 11:00:00Z', `${S}r07`],
    last: ['2026-01-15 11:00:00Z', `${S}r07`],
    sig: '9L_oRfN9SxduDDKDZ41Q1JkLBbTk8PZSY4X3IGX9hZQ',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15 11:00:00Z',
    sig: 'Koy0f3tuX4dIT08bqf8xkohzt-Fn7FYhZGoCkcTAwW4',
  },
  {
    upper: ['2026-01-15T11:00:60Z', `${S}r07`],
    last: ['2026-01-15T11:00:60Z', `${S}r07`],
    sig: 'h1YBwoMNasW9yAxb1itclbhajxJUaC6owP5GA1kqfVU',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:60Z',
    sig: 'ymk7hZ6VDPFVTMQYJclIHOpjQkN5T918NdDijimL3C4',
  },
  {
    upper: ['2026-01-15T11:00:60.5Z', `${S}r07`],
    last: ['2026-01-15T11:00:60.5Z', `${S}r07`],
    sig: '-D1SivJ-c2f1FZu_X8yrD7j0LgnXQe_wQ9caF_SckWg',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:60.5Z',
    sig: 'AHkyK6LkIqyegKw6BvrErCpszdifMUxodAcErFlhhLg',
  },
  {
    upper: ['2026-01-15T23:59:60.999999999Z', `${S}r07`],
    last: ['2026-01-15T23:59:60.999999999Z', `${S}r07`],
    sig: '3l3HXF7hksnsbn43HK27EMuW74jf_vlU0KZmRZviyvk',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T23:59:60.999999999Z',
    sig: 'ZcaQPa8qSLJDjkZehX0VWFHdW1R0JkdsP3pufjKq7fk',
  },
  {
    upper: ['2026-01-15T11:00:00.1234567891Z', `${S}r07`],
    last: ['2026-01-15T11:00:00.1234567891Z', `${S}r07`],
    sig: 'n6QpCsfzATZ1CAJSZqRQmATMqgAV4WIwpkGPj16KR3E',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00.1234567891Z',
    sig: 'uO6zriOejSXm0B_Zls3GlKLlkN6Ivp5WGXv_ToniXB4',
  },
  {
    upper: ['2026-01-15T11:00:00\u221200:00', `${S}r07`],
    last: ['2026-01-15T11:00:00\u221200:00', `${S}r07`],
    sig: '9L_oRfN9SxduDDKDZ41Q1JkLBbTk8PZSY4X3IGX9hZQ',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00\u221200:00',
    sig: 'Koy0f3tuX4dIT08bqf8xkohzt-Fn7FYhZGoCkcTAwW4',
  },
  { upper: ['2026-01-15T11:00:00-00:00', `${S}r07`], last: ['2026-01-15T11:00:00-00:00', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00-00:00',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00+0000', `${S}r07`], last: ['2026-01-15T11:00:00+0000', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00+0000',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00+00', `${S}r07`], last: ['2026-01-15T11:00:00+00', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00+00',
    sig: null,
  },
  { upper: ['1969-12-31T23:59:59Z', `${S}r07`], last: ['1969-12-31T23:59:59Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '1969-12-31T23:59:59Z',
    sig: null,
  },
  {
    upper: ['1970-01-01T00:00:00Z', `${S}r07`],
    last: ['1970-01-01T00:00:00Z', `${S}r07`],
    sig: 'aWtG8EKlY7-JocXHWkEORQ_jOVdIZfUJYiorbsVKFfw',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '1970-01-01T00:00:00Z',
    sig: 'nNdQ04cVHLAUwEy6Pr_YMjJQlStGiqUj6Tl_SvruKRY',
  },
  {
    upper: ['9999-12-31T23:59:59.999999999Z', `${S}r07`],
    last: ['9999-12-31T23:59:59.999999999Z', `${S}r07`],
    sig: 'LaXYv51JXrJ4-zQHKBNv3h1-GKLilQ8nG0uFRyeZLfs',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '9999-12-31T23:59:59.999999999Z',
    sig: 'PxjNrcZdJ5-DAT42elkZlaGeRvcNVVGGF5YhVzAw9uk',
  },
  { upper: ['2026-02-29T00:00:00Z', `${S}r07`], last: ['2026-02-29T00:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-02-29T00:00:00Z',
    sig: null,
  },
  {
    upper: ['2024-02-29T00:00:00Z', `${S}r07`],
    last: ['2024-02-29T00:00:00Z', `${S}r07`],
    sig: 'mxakrGwoEV97TUfAiJOeQlc_5QbwcUZqaHloJvQgrpY',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2024-02-29T00:00:00Z',
    sig: 'waUQPsoqizZG-d7Kubeo69GgMbeL0Z7Tf4kVsNUVUwA',
  },
  { upper: ['2026-01-15T24:00:00Z', `${S}r07`], last: ['2026-01-15T24:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T24:00:00Z',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00.Z', `${S}r07`], last: ['2026-01-15T11:00:00.Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00.Z',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00+01:00', `${S}r07`], last: ['2026-01-15T11:00:00+01:00', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00+01:00',
    sig: null,
  },
  { upper: ['+2026-01-15T11:00:00Z', `${S}r07`], last: ['+2026-01-15T11:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '+2026-01-15T11:00:00Z',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00Z ', `${S}r07`], last: ['2026-01-15T11:00:00Z ', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00Z ',
    sig: null,
  },
  {
    upper: [`2026-01-15T11:00:00.${'0'.repeat(43)}Z`, `${S}r07`],
    last: [`2026-01-15T11:00:00.${'0'.repeat(43)}Z`, `${S}r07`],
    sig: '9L_oRfN9SxduDDKDZ41Q1JkLBbTk8PZSY4X3IGX9hZQ',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: `2026-01-15T11:00:00.${'0'.repeat(43)}Z`,
    sig: 'Koy0f3tuX4dIT08bqf8xkohzt-Fn7FYhZGoCkcTAwW4',
  },
  {
    upper: [`2026-01-15T11:00:00.${'0'.repeat(44)}Z`, `${S}r07`],
    last: [`2026-01-15T11:00:00.${'0'.repeat(44)}Z`, `${S}r07`],
    sig: null,
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: `2026-01-15T11:00:00.${'0'.repeat(44)}Z`,
    sig: null,
  },
  {
    upper: ['2026-01-15T11:00:00.000000000+00:00', `${S}r07`],
    last: ['2026-01-15T11:00:00.000000000+00:00', `${S}r07`],
    sig: '9L_oRfN9SxduDDKDZ41Q1JkLBbTk8PZSY4X3IGX9hZQ',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00.000000000+00:00',
    sig: 'Koy0f3tuX4dIT08bqf8xkohzt-Fn7FYhZGoCkcTAwW4',
  },
  { upper: ['2026-01-15T11:00:61Z', `${S}r07`], last: ['2026-01-15T11:00:61Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:61Z',
    sig: null,
  },
  { upper: ['2026-1-15T11:00:00Z', `${S}r07`], last: ['2026-1-15T11:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-1-15T11:00:00Z',
    sig: null,
  },
  { upper: ['20260-01-15T11:00:00Z', `${S}r07`], last: ['20260-01-15T11:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '20260-01-15T11:00:00Z',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00+24:00', `${S}r07`], last: ['2026-01-15T11:00:00+24:00', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00+24:00',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00+00:60', `${S}r07`], last: ['2026-01-15T11:00:00+00:60', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00+00:60',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00+00:0', `${S}r07`], last: ['2026-01-15T11:00:00+00:0', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00+00:0',
    sig: null,
  },
  { upper: ['2026-01-15T11:00Z', `${S}r07`], last: ['2026-01-15T11:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00Z',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00.5', `${S}r07`], last: ['2026-01-15T11:00:00.5', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00.5',
    sig: null,
  },
  { upper: ['0000-01-01T00:00:00Z', `${S}r07`], last: ['0000-01-01T00:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '0000-01-01T00:00:00Z',
    sig: null,
  },
  { upper: ['2026-13-01T00:00:00Z', `${S}r07`], last: ['2026-13-01T00:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-13-01T00:00:00Z',
    sig: null,
  },
  { upper: ['2026-04-31T00:00:00Z', `${S}r07`], last: ['2026-04-31T00:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-04-31T00:00:00Z',
    sig: null,
  },
  {
    upper: ['2026-01-15T11:00:00.0000000009Z', `${S}r07`],
    last: ['2026-01-15T11:00:00.0000000009Z', `${S}r07`],
    sig: '9L_oRfN9SxduDDKDZ41Q1JkLBbTk8PZSY4X3IGX9hZQ',
  },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00.0000000009Z',
    sig: 'Koy0f3tuX4dIT08bqf8xkohzt-Fn7FYhZGoCkcTAwW4',
  },
  { upper: ['2026-01-15T11:00:00,5Z', `${S}r07`], last: ['2026-01-15T11:00:00,5Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00,5Z',
    sig: null,
  },
  { upper: ['\uff12026-01-15T11:00:00Z', `${S}r07`], last: ['\uff12026-01-15T11:00:00Z', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '\uff12026-01-15T11:00:00Z',
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00+00:00:00', `${S}r07`], last: ['2026-01-15T11:00:00+00:00:00', `${S}r07`], sig: null },
  {
    upper: ['2026-01-16T00:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r07`],
    asOf: '2026-01-15T11:00:00+00:00:00',
    sig: null,
  },
  {
    upper: ['2026-01-15T11:00:00Z', 'at://x/"\\'],
    last: ['2026-01-15T11:00:00Z', 'at://x/"\\'],
    sig: 'bFzo1UNQWC331bqMe0vhbO0vIagwyMhT07Z61Y69688',
  },
  {
    upper: ['2026-01-15T11:00:00Z', 'at://\u00e9/\ud834\udd1e'],
    last: ['2026-01-15T11:00:00Z', 'at://\u00e9/\ud834\udd1e'],
    sig: 'CR0Y1899NGVdKB7dNMnFk67QqavPYt3NONP9J7_SXlU',
  },
  { upper: ['2026-01-15T11:00:00Z', 'at://a b'], last: ['2026-01-15T11:00:00Z', 'at://a b'], sig: null },
  { upper: ['2026-01-15T11:00:00Z', 'at://a\u0085b'], last: ['2026-01-15T11:00:00Z', 'at://a\u0085b'], sig: null },
  {
    upper: ['2026-01-15T11:00:00Z', 'at://a\ufeffb'],
    last: ['2026-01-15T11:00:00Z', 'at://a\ufeffb'],
    sig: '3EYSNuzEnPe-svgCK0E30q4aUaDEDGtgMyxjthiOfS4',
  },
  {
    upper: ['2026-01-15T11:00:00Z', 'at://a\u200bb'],
    last: ['2026-01-15T11:00:00Z', 'at://a\u200bb'],
    sig: 'enOdZ8QbLmO4_z-8_3pCoeKKJT10yNoYOUCOj361igw',
  },
  { upper: ['2026-01-15T11:00:00Z', 'at://a\u00a0b'], last: ['2026-01-15T11:00:00Z', 'at://a\u00a0b'], sig: null },
  { upper: ['2026-01-15T11:00:00Z', 'AT://x'], last: ['2026-01-15T11:00:00Z', 'AT://x'], sig: null },
  {
    upper: ['2026-01-15T11:00:00Z', 'at://'],
    last: ['2026-01-15T11:00:00Z', 'at://'],
    sig: 'kbjG92Nx7inGH5Ej2pX77BxEbvd2MbG8kUngfbrZMzY',
  },
  {
    upper: ['2026-01-15T11:00:00Z', `at://${'a'.repeat(4091)}`],
    last: ['2026-01-15T11:00:00Z', `at://${'a'.repeat(4091)}`],
    sig: 'VXhehtigSPKUKbsw3J8keuFD9wTz0svtBYrnMQ1ezzE',
  },
  {
    upper: ['2026-01-15T11:00:00Z', `at://${'a'.repeat(4092)}`],
    last: ['2026-01-15T11:00:00Z', `at://${'a'.repeat(4092)}`],
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00Z', 'at://a\u007fb'], last: ['2026-01-15T11:00:00Z', 'at://a\u007fb'], sig: null },
  { upper: ['2026-01-15T11:00:00Z', 'at:/x'], last: ['2026-01-15T11:00:00Z', 'at:/x'], sig: null },
  {
    upper: ['2026-01-15T11:00:00Z', `at://${'\u00e9'.repeat(2045)}a`],
    last: ['2026-01-15T11:00:00Z', `at://${'\u00e9'.repeat(2045)}a`],
    sig: '43wTPGbBD-6kD3NxEWlz-McjsLyBvBwPMxzmiHktG8k',
  },
  {
    upper: ['2026-01-15T11:00:00Z', `at://${'\u00e9'.repeat(2046)}`],
    last: ['2026-01-15T11:00:00Z', `at://${'\u00e9'.repeat(2046)}`],
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00Z', 'at://a\u2028b'], last: ['2026-01-15T11:00:00Z', 'at://a\u2028b'], sig: null },
  { upper: ['2026-01-15T11:00:00Z', 'at://a\u3000b'], last: ['2026-01-15T11:00:00Z', 'at://a\u3000b'], sig: null },
  {
    upper: ['2026-01-15T11:00:00Z', 'at://a\u180eb'],
    last: ['2026-01-15T11:00:00Z', 'at://a\u180eb'],
    sig: 'D5wtHPAlZSYixRnX53nfQ28FR1iL-iL6zMoE0FAKuT8',
  },
  { upper: ['2026-01-15T11:00:00Z', 'at://a\u001fb'], last: ['2026-01-15T11:00:00Z', 'at://a\u001fb'], sig: null },
  {
    upper: ['2026-01-15T11:00:00Z', 'at://<>{}|^`'],
    last: ['2026-01-15T11:00:00Z', 'at://<>{}|^`'],
    sig: '382cxDxYPs26aA094cMnXteWLhFxIicAQSTnw6Iz1QM',
  },
  {
    binding: { query: 'feed', did: null, scope: 'global', viewer: `${A}` },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'feed', did: null, scope: 'following', viewer: 'did:x' },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'feed', did: null, scope: 'following', viewer: 'did:web:example.com' },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: 'UO4hEpUuQyseCRRBhzc4oGrVoJukY6iKNCtIg60TsiE',
  },
  {
    binding: { query: 'feed', did: `${A}`, scope: 'global', viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'feed', did: null, scope: 'Global', viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'feed', did: null, scope: null, viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'history', did: `${A}`, scope: 'global', viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'history', did: `${A}`, scope: null, viewer: `${A}` },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'followers', did: 'did:example:%41b', scope: null, viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: 'uQw7RCZT1V-SuQS14rhfa4ZCkm6yrnUQLRRRg-sJ1Ik',
  },
  {
    binding: { query: 'followers', did: 'did:example:%4', scope: null, viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'following', did: 'did:example:ab:', scope: null, viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'following', did: null, scope: null, viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'history', did: `did:${'a'.repeat(2044)}`, scope: null, viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'history', did: `did:a:${'a'.repeat(2043)}`, scope: null, viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  {
    binding: { query: 'history', did: 'did:A:b', scope: null, viewer: null },
    upper: ['2026-01-15T11:00:00Z', `${S}r07`],
    last: ['2026-01-15T11:00:00Z', `${S}r01`],
    sig: null,
  },
  { upper: ['2026-01-15T11:00:00Z', `${S}r01`], last: ['2026-01-15T11:00:00Z', `${S}r07`], sig: null },
  { upper: ['2026-01-15T11:00:59.9Z', `${S}r07`], last: ['2026-01-15T11:00:60Z', `${S}r07`], sig: null },
];

const RUST_DECODE_PROBES: readonly DecodeProbe[] = [
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: BASE },
  { payload: ` { "version" : 1 ,\n\t"binding":${B},"upper":${UP},"last":${LP},${ASOF} }\r\n `, ok: BASE },
  { payload: `{${ASOF},"last":${LP},"upper":${UP},"binding":${B},"version":1}`, ok: BASE },
  { payload: `{"\\u0076ersion":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: BASE },
  { payload: `{"version":1,"binding":{"query":"history","did":"${A}"},"upper":${UP},"last":${LP},${ASOF}}`, ok: BASE },
  { payload: `{"version":1,"binding":{"did":"${A}","query":"history"},"upper":${UP},"last":${LP},${ASOF}}`, ok: BASE },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF},"version":1}`, ok: null },
  {
    payload: `{"version":1,"binding":{"query":"history","did":"${A}","scope":null,"viewer":null,"viewer":null},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  { payload: `{"version":1.0,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1e0,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":-0,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":01,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":"1","binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":2,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":0,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":256,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":null,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":-1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1E0,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":true,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}x`, ok: null },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}} `, ok: BASE },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}\u00a0`, ok: null },
  { payload: `\ufeff{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `[1,${B},${UP},${LP},"2026-01-15T12:00:00.000000000Z"]`, ok: BASE },
  { payload: `{"version":1,"binding":["history","${A}",null,null],"upper":${UP},"last":${LP},${ASOF}}`, ok: BASE },
  { payload: `{"version":1,"binding":["history","${A}"],"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1,"binding":${B},"upper":["${T9}","${S}r07"],"last":${LP},${ASOF}}`, ok: BASE },
  {
    payload: `{"version":1,"binding":{"query":{"history":null},"did":"${A}","scope":null,"viewer":null},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: BASE,
  },
  {
    payload: `{"version":1,"binding":{"query":"History","did":"${A}","scope":null,"viewer":null},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":{"query":"history","did":"${A}","scope":null,"viewer":null,"x":1},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":{"timestamp":"${T9}","uri":"${S}r07","x":null},"last":${LP},${ASOF}}`,
    ok: null,
  },
  { payload: `{"version":1,"binding":${B},"upper":null,"last":${LP},${ASOF}}`, ok: null },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\ud800"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\udc00"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\ud834\\udd1e"},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a\ud834\udd1e' },
      upper: { timestamp: `${T9}`, uri: `${S}r07` },
    },
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\u002f\\/"},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a//' },
      upper: { timestamp: `${T9}`, uri: `${S}r07` },
    },
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\u0000"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\u0001"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\x"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00+00:00","uri":"${S}r01"},${ASOF}}`,
    ok: BASE,
  },
  {
    payload: `{"version":1,"binding":{"query":"history","did":"did:plc:\\u0061aaaaaaaaaaaaaaaaaaaaaaa","scope":null,"viewer":null},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: BASE,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF},"x":[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]}`,
    ok: null,
  },
  { payload: '{}', ok: null },
  { payload: 'null', ok: null },
  { payload: '1', ok: null },
  { payload: '"x"', ok: null },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},"asOf":null}`, ok: null },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},"asOf":"2026-01-15T12:00:00+01:00"}`, ok: null },
  { payload: `{"version":1,"binding":${B},,"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},,${ASOF}}`, ok: null },
  { payload: `{"version" :1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: BASE },
  { payload: `{'version':1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\uD834\\uDD1E"},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a\ud834\udd1e' },
      upper: { timestamp: `${T9}`, uri: `${S}r07` },
    },
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\ud834x"},${ASOF}}`,
    ok: null,
  },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF},"binding":null}`, ok: null },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\u00e9"},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a\u00e9' },
      upper: { timestamp: `${T9}`, uri: `${S}r07` },
    },
  },
  { payload: `{"version":1.5,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1 ,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: BASE },
  { payload: `{"version":+1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  {
    payload: `{"version":1,"binding":{"query": { "history" : null } ,"did":"${A}"},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: BASE,
  },
  {
    payload: `{"version":1,"binding":{"query":{"history":{}},"did":"${A}"},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":{"query":{"history":null,"x":null},"did":"${A}"},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  { payload: `{"version":1,"binding":{"query":{},"did":"${A}"},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  {
    payload: `{"version":1,"binding":{"query":"hist\\u006fry","did":"${A}"},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: BASE,
  },
  {
    payload: `{"version":1,"binding":{"query":["history"],"did":"${A}"},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  { payload: `{"version":1,"binding":{"query":{"history":null}},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `[1,${B},${UP},${LP},"2026-01-15T12:00:00.000000000Z",null]`, ok: null },
  { payload: `[1,${B},${UP},${LP}]`, ok: null },
  { payload: `[ 1 , ${B} , ${UP} , ${LP} , "2026-01-15T12:00:00.000000000Z" ]`, ok: BASE },
  { payload: `{"version":1,"binding":${B},"upper":["${T9}","${S}r07",1],"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1,"binding":${B},"upper":{"timestamp":"${T9}"},"last":${LP},${ASOF}}`, ok: null },
  {
    payload: `{"version":1,"binding":${B},"upper":{"uri":"${S}r07","timestamp":"${T9}"},"last":${LP},${ASOF}}`,
    ok: BASE,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":{"timestamp":"${T9}","uri":"${S}r07","uri":"${S}r07"},"last":${LP},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\u007fb"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\tb"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\u0009b"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\uZZZZ"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\u00E9"},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a\u00e9' },
      upper: { timestamp: `${T9}`, uri: `${S}r07` },
    },
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\u00e9"},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a\u00e9' },
      upper: { timestamp: `${T9}`, uri: `${S}r07` },
    },
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\ud834\\u0041"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\ud834\\ud834"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\udd1e\\ud834"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\ud834"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\b"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\\\"},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a\\' },
      upper: { timestamp: `${T9}`, uri: `${S}r07` },
    },
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\""},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a"' },
      upper: { timestamp: `${T9}`, uri: `${S}r07` },
    },
  },
  {
    payload: `{"version":1,"binding":${B},"upper":${UP},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a\\'"},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":{"query":"history","did":"${A}","scope":nul,"viewer":null},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":{"query":"history","did":"${A}","scope":NULL,"viewer":null},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  {
    payload: `{"version":1,"binding":{"query":"history","did":"${A}","scope":nullx,"viewer":null},"upper":${UP},"last":${LP},${ASOF}}`,
    ok: null,
  },
  { payload: `{\n"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: BASE },
  { payload: `{"version":1\u3000,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1\u000b,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1\f,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1.,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1e,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1e+,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":0x1,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1_0,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":18446744073709551617,"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  { payload: `{"version":1${'0'.repeat(400)},"binding":${B},"upper":${UP},"last":${LP},${ASOF}}`, ok: null },
  {
    payload: `{"version":1,"binding":${B},"upper":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a/b"},"last":{"timestamp":"2026-01-15T11:00:00Z","uri":"at://a/b"},${ASOF}}`,
    ok: {
      asOf: '2026-01-15T12:00:00.000000000Z',
      binding: { did: `${A}`, query: 'history', scope: null, viewer: null },
      last: { timestamp: `${T9}`, uri: 'at://a/b' },
      upper: { timestamp: `${T9}`, uri: 'at://a/b' },
    },
  },
  { payload: `{"version":1,"binding":${B},"upper":${UP},"last":${LP},${ASOF},"\\u0076ersion":1}`, ok: null },
  {
    payloadHex:
      '7b2276657273696f6e223a312c2262696e64696e67223a7b227175657279223a22686973746f7279222c22646964223a226469643a706c633a616161616161616161616161616161616161616161616161222c2273636f7065223a6e756c6c2c22766965776572223a6e756c6c7d2c227570706572223a7b2274696d657374616d70223a22323032362d30312d31355431313a30303a30302e3030303030303030305a222c22757269223a2261743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f636f6d2e6578616d706c652e61746d757369632e7363726f62626c652f723037227d2c226c617374223a7b2274696d657374616d70223a22323032362d30312d31355431313a30303a30302e3030303030303030305a222c22757269223a2261743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f636f6d2e6578616d706c652e61746d757369632e7363726f62626c652f72ff31227d2c2261734f66223a22323032362d30312d31355431323a30303a30302e3030303030303030305a227d',
    ok: null,
  },
  {
    payloadHex:
      '7b2276657273696f6e223a312c2262696e64696e67223a7b227175657279223a22686973746f7279222c22646964223a226469643a706c633a616161616161616161616161616161616161616161616161222c2273636f7065223a6e756c6c2c22766965776572223a6e756c6c7d2c227570706572223a7b2274696d657374616d70223a22323032362d30312d31355431313a30303a30302e3030303030303030305a222c22757269223a2261743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f636f6d2e6578616d706c652e61746d757369632e7363726f62626c652f723037227d2c226c617374223a7b2274696d657374616d70223a22323032362d30312d31355431313a30303a30302e3030303030303030305a222c22757269223a2261743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f636f6d2e6578616d706c652e61746d757369632e7363726f62626c652f72c0af227d2c2261734f66223a22323032362d30312d31355431323a30303a30302e3030303030303030305a227d',
    ok: null,
  },
  {
    payloadHex:
      '7b2276657273696f6e223a312c2262696e64696e67223a7b227175657279223a22686973746f7279222c22646964223a226469643a706c633a616161616161616161616161616161616161616161616161222c2273636f7065223a6e756c6c2c22766965776572223a6e756c6c7d2c227570706572223a7b2274696d657374616d70223a22323032362d30312d31355431313a30303a30302e3030303030303030305a222c22757269223a2261743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f636f6d2e6578616d706c652e61746d757369632e7363726f62626c652f723037227d2c226c617374223a7b2274696d657374616d70223a22323032362d30312d31355431313a30303a30302e3030303030303030305a222c22757269223a2261743a2f2f6469643a706c633a6161616161616161616161616161616161616161616161612f636f6d2e6578616d706c652e61746d757369632e7363726f62626c652f72eda080227d2c2261734f66223a22323032362d30312d31355431323a30303a30302e3030303030303030305a227d',
    ok: null,
  },
];

const RUST_COMPARE_PROBES: readonly CompareProbe[] = [
  { a: ['2026-01-15T11:00:60.5Z', `${S}r07`], b: ['2026-01-15T11:01:00Z', `${S}r07`], order: -1 },
  { a: ['2026-01-15T11:00:60.5Z', `${S}r07`], b: ['2026-01-15T11:00:59.9Z', `${S}r07`], order: 1 },
  { a: ['2026-01-15T11:00:00.1Z', `${S}r07`], b: ['2026-01-15T11:00:00.100000000+00:00', `${S}r07`], order: 0 },
  { a: ['2026-01-15T11:00:00Z', 'at://\ue000'], b: ['2026-01-15T11:00:00Z', 'at://\ud83d\ude00'], order: -1 },
  { a: ['2026-01-15T11:00:00Z', 'at://b'], b: ['2026-01-15T11:00:00Z', 'at://ab'], order: 1 },
  { a: ['2026-01-15T11:00:00Z', 'at://a'], b: ['2026-01-15T11:00:00Z', 'at://a '], order: null },
  { a: ['x', 'at://a'], b: ['2026-01-15T11:00:00Z', 'at://a'], order: null },
];

// PageCursor::contains / advance on history_alice_page1 (upper = T9 r07,
// last = T9 r01): the row must be <= upper and strictly < last, so a tuple
// equal to `last` (in any UTC spelling) is excluded and cannot be advanced to.
const RUST_CONTAINS_PROBES: readonly ContainsProbe[] = [
  { position: [T9, `${S}r01`], contains: false, advanceSig: null },
  { position: ['2026-01-15t11:00:00z', `${S}r01`], contains: false, advanceSig: null },
  { position: ['2026-01-15T11:00:00+00:00', `${S}r01`], contains: false, advanceSig: null },
  { position: [T9, `${S}r00`], contains: true, advanceSig: 'vaM1zVDHGvfdA8qZZwafJpsbiypRqrHyT4cwkB020Vc' },
  { position: [T9, `${S}r0`], contains: true, advanceSig: 'A7yCGkx72MUxcZf42ocrB1kJpTf17Zm5OMBEaw5YeA8' },
  { position: [T9, `${S}r010`], contains: false, advanceSig: null },
  { position: [T9, `${S}r02`], contains: false, advanceSig: null },
  { position: [T9, `${S}r07`], contains: false, advanceSig: null },
  { position: [T9, `${S}r08`], contains: false, advanceSig: null },
  { position: ['2026-01-15T11:00:00.000000001Z', `${S}r00`], contains: false, advanceSig: null },
  {
    position: ['2026-01-15T10:59:59.999999999Z', `${S}r99`],
    contains: true,
    advanceSig: 'V_rKMrFq2KOC88om9MYALvSn00msIssRFBukd3vGD_E',
  },
  { position: ['2026-01-15T11:00:00.000000001Z', `${S}r07`], contains: false, advanceSig: null },
];

// --- helpers (independent of the module under test) -------------------------

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function unb64url(text: string): Uint8Array<ArrayBuffer> {
  const std = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The golden derived key imported directly: a forger that holds the real signing key. */
async function rawSigningKey(derivedKeyHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', hexBytes(derivedKeyHex), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function signedToken(key: CryptoKey, payload: Uint8Array<ArrayBuffer>): Promise<string> {
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  return `${b64url(payload)}.${b64url(signature)}`;
}

async function expectInvalidCursor(attempt: () => Promise<unknown> | unknown): Promise<void> {
  let caught: unknown;
  try {
    await attempt();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidCursorError);
  expect(caught).toBeInstanceOf(ApiError);
  const apiError = caught as ApiError;
  expect(apiError.code).toBe('invalid_cursor');
  expect(apiError.status).toBe(400);
  expect(apiError.message).toBe('invalid_cursor');
}

const keys = {
  primary: () => deriveCursorKey(hexBytes(golden.keys.primary.applicationKeyHex)),
  other: () => deriveCursorKey(hexBytes(golden.keys.other.applicationKeyHex)),
};

function goldenValid(id: string): GoldenValid {
  const v = golden.valid.find((entry) => entry.id === id);
  if (v === undefined) throw new Error(`missing golden ${id}`);
  return v;
}

function probePayload(probe: DecodeProbe): Uint8Array<ArrayBuffer> {
  return probe.payloadHex !== undefined ? hexBytes(probe.payloadHex) : utf8.encode(probe.payload ?? '');
}

afterEach(() => {
  vi.restoreAllMocks();
});

it('every cursors.json Rust token decodes to the same payload', async () => {
  const primary = await keys.primary();
  expect(golden.keys.context).toBe('atmusic:cursor:hmac-sha256:v1');
  expect(golden.valid.map((v) => v.id)).toEqual([
    'history_alice_page1',
    'feed_global_page1',
    'feed_following_alice_page1',
    'following_alice_page1',
    'followers_bob_page1',
    'history_alice_nanosecond_tuple',
  ]);

  for (const v of golden.valid) {
    const key = v.key === 'primary' ? primary : await keys.other();
    const decoded = await decodeCursor(key, v.token, v.binding);
    expect(decoded, v.id).toEqual(v.decoded);
    // The signed segment is exactly the Rust serde_json payload.
    expect(fromUtf8.decode(unb64url(v.token.split('.')[0] as string)), v.id).toBe(v.payloadJson);
    // A decoded cursor re-encodes to the identical token (round trip).
    expect(await encodeCursor(key, decoded), v.id).toBe(v.token);
  }

  // The advanced cursor and the canonicalization token decode too.
  const from = goldenValid(golden.advance.fromId);
  expect(await decodeCursor(primary, golden.advance.token, from.binding)).toEqual(golden.advance.decoded);
  const canonical = goldenValid(golden.canonicalization.equalsValidId);
  expect(await decodeCursor(primary, golden.canonicalization.token, canonical.binding)).toEqual(canonical.decoded);

  // Every payload spelling Rust's serde decoder accepts decodes to Rust's cursor:
  // reordered and escaped keys, whitespace, omitted Option fields, the struct
  // sequence form and the enum map form, non-canonical UTC timestamps.
  const signer = await rawSigningKey(golden.keys.primary.derivedKeyHex);
  const accepted = RUST_DECODE_PROBES.filter((probe) => probe.ok !== null);
  expect(accepted.length).toBe(29);
  for (const probe of accepted) {
    const token = await signedToken(signer, probePayload(probe));
    expect(await decodeCursor(primary, token, HISTORY_ALICE), probe.payload).toEqual(probe.ok);
  }
});

it('TS-encoded token equals Rust token byte-for-byte for the same inputs', async () => {
  const primary = await keys.primary();
  const other = await keys.other();

  // deriveCursorKey yields exactly the Rust derived key: tokens signed with it
  // equal tokens signed with golden derivedKeyHex imported as-is.
  for (const name of ['primary', 'other'] as const) {
    const material = golden.keys[name];
    const appKey = await crypto.subtle.importKey(
      'raw',
      hexBytes(material.applicationKeyHex),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const derived = new Uint8Array(await crypto.subtle.sign('HMAC', appKey, utf8.encode(golden.keys.context)));
    expect(toHex(derived)).toBe(material.derivedKeyHex);
    const viaDerive = await encodeCursor(name === 'primary' ? primary : other, BASE);
    const viaGoldenKey = await encodeCursor(await rawSigningKey(material.derivedKeyHex), BASE);
    expect(viaDerive).toBe(viaGoldenKey);
  }
  expect(await encodeCursor(other, BASE)).not.toBe(await encodeCursor(primary, BASE));

  for (const v of golden.valid) {
    const cursor = pageCursor(v.binding, v.upper, v.last, v.asOf);
    expect(cursorPayloadJson(cursor), v.id).toBe(v.payloadJson);
    expect(await encodeCursor(v.key === 'primary' ? primary : other, cursor), v.id).toBe(v.token);
  }

  // The Rust constructors produce the same bindings as the golden JSON.
  const bindingFor: Record<string, CursorBindingInput> = {
    history_alice_page1: cursorBindings.history(ALICE),
    feed_global_page1: cursorBindings.globalFeed(),
    feed_following_alice_page1: cursorBindings.followingFeed(ALICE),
    following_alice_page1: cursorBindings.following(ALICE),
    followers_bob_page1: cursorBindings.followers(BOB),
    history_alice_nanosecond_tuple: cursorBindings.history(ALICE),
  };
  for (const v of golden.valid) expect(bindingFor[v.id], v.id).toEqual(v.binding);

  // Equivalent UTC spellings canonicalize to the identical token.
  const c = golden.canonicalization;
  const canonicalId = goldenValid(c.equalsValidId);
  expect(c.token).toBe(canonicalId.token);
  expect(await encodeCursor(primary, pageCursor(canonicalId.binding, c.upper, c.last, c.asOf))).toBe(c.token);

  // advance keeps binding, anchor and asOf; a tuple not below `last` is refused.
  const from = await decodeCursor(primary, goldenValid(golden.advance.fromId).token, HISTORY_ALICE);
  const advanced = advanceCursor(from, golden.advance.newLast);
  expect(advanced).toEqual(golden.advance.decoded);
  expect(await encodeCursor(primary, advanced)).toBe(golden.advance.token);
  await expectInvalidCursor(() => advanceCursor(from, golden.advance.advanceToTupleNotBelowLast.newLast));

  // The `< last` bound is strict: a row equal to `last` is never re-served and
  // advancing to it (a non-advancing cursor) is refused; one URI code point
  // below `last` is in range; `upper` itself is above `last`, so out of range.
  expect(cursorContains(from, from.last)).toBe(false);
  await expectInvalidCursor(() => advanceCursor(from, from.last));
  expect(cursorContains(from, { timestamp: from.last.timestamp, uri: `${S}r00` })).toBe(true);
  expect(cursorContains(from, from.upper)).toBe(false);
  // Same verdicts as Rust PageCursor::contains/advance, including equal-instant
  // spellings of `last`; accepted advances sign to Rust's exact token.
  for (const probe of RUST_CONTAINS_PROBES) {
    const position = { timestamp: probe.position[0], uri: probe.position[1] };
    const label = JSON.stringify(probe.position);
    expect(cursorContains(from, position), label).toBe(probe.contains);
    if (probe.advanceSig === null) {
      await expectInvalidCursor(() => advanceCursor(from, position));
    } else {
      const moved = advanceCursor(from, position);
      expect(moved.upper, label).toEqual(from.upper);
      expect(moved.binding, label).toEqual(from.binding);
      expect(moved.asOf, label).toBe(from.asOf);
      expect((await encodeCursor(primary, moved)).split('.')[1], label).toBe(probe.advanceSig);
    }
  }
  expect(RUST_CONTAINS_PROBES.filter((probe) => probe.contains).length).toBe(3);
  // A fresh first page (last == upper) excludes the anchor row itself.
  const firstPage = pageCursor(HISTORY_ALICE, from.upper, from.upper, from.asOf);
  expect(cursorContains(firstPage, from.upper)).toBe(false);
  await expectInvalidCursor(() => advanceCursor(firstPage, from.upper));
  expect(cursorContains(firstPage, { timestamp: T9, uri: `${S}r06` })).toBe(true);

  // Rust-observed encode verdicts for chrono spellings, leap seconds, field
  // limits, whitespace/control characters and binding rules.
  let encoded = 0;
  for (const probe of RUST_ENCODE_PROBES) {
    const attempt = async () =>
      encodeCursor(
        primary,
        pageCursor(
          probe.binding ?? HISTORY_ALICE,
          { timestamp: probe.upper[0], uri: probe.upper[1] },
          { timestamp: probe.last[0], uri: probe.last[1] },
          probe.asOf ?? PROBE_AS_OF,
        ),
      );
    if (probe.sig === null) {
      await expectInvalidCursor(attempt);
    } else {
      expect((await attempt()).split('.')[1], JSON.stringify(probe)).toBe(probe.sig);
      encoded += 1;
    }
  }
  expect(encoded).toBe(37);
  expect(RUST_ENCODE_PROBES.length).toBe(113);

  // Tuple order equals CursorPosition::compare (instants, then URI code points).
  for (const probe of RUST_COMPARE_PROBES) {
    const a = { timestamp: probe.a[0], uri: probe.a[1] };
    const b = { timestamp: probe.b[0], uri: probe.b[1] };
    if (probe.order === null) await expectInvalidCursor(() => comparePositions(a, b));
    else expect(comparePositions(a, b), JSON.stringify(probe)).toBe(probe.order);
  }
});

it('one-bit tamper, wrong did/scope/viewer, version 2, malformed base64 → invalid_cursor', async () => {
  const primary = await keys.primary();
  const other = await keys.other();
  const signer = await rawSigningKey(golden.keys.primary.derivedKeyHex);
  const base = goldenValid('history_alice_page1');
  const [payloadSegment, signatureSegment] = base.token.split('.') as [string, string];
  const payload = unb64url(payloadSegment);
  const signature = unb64url(signatureSegment);
  const verify = vi.spyOn(crypto.subtle, 'verify');

  // Every Rust tampered token (one-bit flips, wrong key, wrong did/query/scope/
  // viewer, versions 0 and 2, unknown field, padding, separators, sizes).
  expect(golden.tampered.length).toBe(24);
  for (const t of golden.tampered) {
    expect(t.expectedError).toBe('invalid_cursor');
    await expectInvalidCursor(() => decodeCursor(t.key === 'primary' ? primary : other, t.token, t.binding));
  }

  // Every single-bit flip of the payload and of the signature.
  verify.mockClear();
  for (let bit = 0; bit < payload.length * 8; bit++) {
    const flipped = payload.slice();
    flipped[bit >> 3] = (flipped[bit >> 3] as number) ^ (1 << (bit & 7));
    await expectInvalidCursor(() => decodeCursor(primary, `${b64url(flipped)}.${signatureSegment}`, base.binding));
  }
  for (let bit = 0; bit < 256; bit++) {
    const flipped = signature.slice();
    flipped[bit >> 3] = (flipped[bit >> 3] as number) ^ (1 << (bit & 7));
    await expectInvalidCursor(() => decodeCursor(primary, `${payloadSegment}.${b64url(flipped)}`, base.binding));
  }
  // Each flip reached HMAC verification exactly once and failed there.
  expect(verify).toHaveBeenCalledTimes(payload.length * 8 + 256);

  // Wrong did / scope / viewer / query: each genuine token decodes only on its own binding.
  const candidates: CursorBindingInput[] = [];
  for (const did of [ALICE, BOB, CAROL]) {
    candidates.push(cursorBindings.history(did), cursorBindings.following(did), cursorBindings.followers(did));
    candidates.push(cursorBindings.followingFeed(did));
  }
  candidates.push(cursorBindings.globalFeed());
  for (const v of golden.valid) {
    let matched = 0;
    for (const candidate of candidates) {
      const same = (['query', 'did', 'scope', 'viewer'] as const).every(
        (field) => (candidate[field] ?? null) === v.binding[field],
      );
      if (same) {
        expect(await decodeCursor(primary, v.token, candidate)).toEqual(v.decoded);
        matched += 1;
      } else {
        await expectInvalidCursor(() => decodeCursor(primary, v.token, candidate));
      }
    }
    expect(matched, v.id).toBe(1);
  }
  // An invalid expected binding is itself invalid_cursor, even for a genuine token.
  for (const bad of [
    { query: 'history', did: 'alice' },
    { query: 'feed', scope: 'following' },
    { query: 'feed', scope: 'global', viewer: ALICE },
    { query: 'history', did: ALICE, scope: 'global' },
    { query: 'search', did: ALICE },
  ] as CursorBindingInput[]) {
    await expectInvalidCursor(() => decodeCursor(primary, base.token, bad));
  }

  // Correctly signed versions: 1 decodes (control), 0, 2 and 255 do not.
  const version = (n: string) => utf8.encode(base.payloadJson.replace('"version":1,', `"version":${n},`));
  expect(await decodeCursor(primary, await signedToken(signer, version('1')), base.binding)).toEqual(base.decoded);
  for (const n of ['2', '0', '255']) {
    await expectInvalidCursor(async () => decodeCursor(primary, await signedToken(signer, version(n)), base.binding));
  }

  // Every correctly signed payload Rust's decoder rejects: duplicate fields,
  // unknown fields, non-u8 or non-1 versions, trailing data, BOM, lone
  // surrogates, raw control characters, invalid UTF-8, last above upper.
  const rejected = RUST_DECODE_PROBES.filter((probe) => probe.ok === null);
  expect(rejected.length).toBe(79);
  for (const probe of rejected) {
    const token = await signedToken(signer, probePayload(probe));
    await expectInvalidCursor(() => decodeCursor(primary, token, HISTORY_ALICE));
  }

  // Signed garbage still fails, and only after one HMAC verification.
  verify.mockClear();
  await expectInvalidCursor(async () =>
    decodeCursor(primary, await signedToken(signer, utf8.encode('not json')), base.binding),
  );
  expect(verify).toHaveBeenCalledTimes(1);

  // Malformed base64url never reaches HMAC verification.
  const bump = (segment: string) => {
    // Same bytes, non-zero trailing bits: the last character's unused low bits set.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(segment.at(-1) as string);
    const unused = segment.length % 4 === 2 ? 0b1111 : 0b11;
    return segment.slice(0, -1) + alphabet[last | unused];
  };
  expect(payloadSegment.length % 4).not.toBe(0);
  expect(signatureSegment.length % 4).toBe(3);
  const malformed = [
    `${payloadSegment}.${signatureSegment}=`,
    `${payloadSegment}=.${signatureSegment}`,
    `${payloadSegment}.${bump(signatureSegment)}`,
    `${bump(payloadSegment)}.${signatureSegment}`,
    `${payloadSegment.slice(0, -1)}+.${signatureSegment}`,
    `${payloadSegment}.${signatureSegment.slice(0, -1)}/`,
    `${payloadSegment.slice(0, 20)} ${payloadSegment.slice(20)}.${signatureSegment}`,
    `${payloadSegment}\n.${signatureSegment}`,
    `${payloadSegment}.${signatureSegment.slice(0, -1)}`,
    `${payloadSegment}.${signatureSegment}A`,
    // A payload segment whose length is 1 mod 4 cannot be base64.
    `${payloadSegment}${'A'.repeat((5 - (payloadSegment.length % 4)) % 4)}.${signatureSegment}`,
    `${payloadSegment}é.${signatureSegment}`,
    `${payloadSegment}.${signatureSegment}.${signatureSegment}`,
    `${payloadSegment}${signatureSegment}`,
    '',
    '.',
    `.${signatureSegment}`,
    `${payloadSegment}.`,
    `${'A'.repeat(MAX_TOKEN_BYTES - signatureSegment.length)}.${signatureSegment}`,
  ];
  verify.mockClear();
  for (const token of malformed) {
    await expectInvalidCursor(() => decodeCursor(primary, token, base.binding));
  }
  expect(verify).not.toHaveBeenCalled();

  // A correctly signed payload over 16,384 bytes is refused before HMAC.
  const oversized = utf8.encode(`${base.payloadJson}${' '.repeat(MAX_PAYLOAD_BYTES + 1 - base.payloadJson.length)}`);
  expect(oversized.length).toBe(MAX_PAYLOAD_BYTES + 1);
  const oversizedToken = await signedToken(signer, oversized);
  expect(oversizedToken.length).toBeLessThan(MAX_TOKEN_BYTES);
  verify.mockClear();
  await expectInvalidCursor(() => decodeCursor(primary, oversizedToken, base.binding));
  expect(verify).not.toHaveBeenCalled();
  // At exactly 16,384 bytes the same padding is accepted (trailing whitespace is valid JSON).
  const atLimit = utf8.encode(`${base.payloadJson}${' '.repeat(MAX_PAYLOAD_BYTES - base.payloadJson.length)}`);
  expect(await decodeCursor(primary, await signedToken(signer, atLimit), base.binding)).toEqual(base.decoded);
});

it('key shorter than 32 bytes is rejected', async () => {
  const importKey = vi.spyOn(crypto.subtle, 'importKey');

  expect(golden.invalidKeys.length).toBe(1);
  for (const entry of golden.invalidKeys) {
    expect(entry.expectedError).toBe('invalid_key');
    const material = hexBytes(entry.applicationKeyHex);
    expect(material.length).toBe(31);
    await expect(deriveCursorKey(material)).rejects.toThrowError(new CursorKeyError());
    await expect(deriveCursorKey(material.buffer)).rejects.toBeInstanceOf(CursorKeyError);
  }
  for (let length = 0; length < 32; length++) {
    let caught: unknown;
    try {
      await deriveCursorKey(new Uint8Array(length).fill(7));
    } catch (error) {
      caught = error;
    }
    expect(caught, `length ${length}`).toBeInstanceOf(CursorKeyError);
    expect((caught as CursorKeyError).code).toBe('invalid_key');
    expect((caught as CursorKeyError).message).toBe(MSG_INVALID_KEY);
    expect(caught).not.toBeInstanceOf(ApiError);
  }
  // Short keys are refused before any key material reaches WebCrypto.
  expect(importKey).not.toHaveBeenCalled();

  // 32 bytes is the minimum: a non-extractable HMAC-SHA256 sign/verify key.
  const key32 = await deriveCursorKey(hexBytes(golden.keys.primary.applicationKeyHex));
  expect(importKey).toHaveBeenCalledTimes(2);
  expect(key32.type).toBe('secret');
  expect(key32.extractable).toBe(false);
  expect(key32.algorithm).toMatchObject({ name: 'HMAC', hash: { name: 'SHA-256' }, length: 256 });
  expect([...key32.usages].sort()).toEqual(['sign', 'verify']);
  expect(await encodeCursor(key32, BASE)).toBe(goldenValid('history_alice_page1').token);

  // Longer keys are used whole (no truncation to 32 bytes). The tail is 0xff
  // because HMAC zero-pads keys, so a zero tail would be the same key.
  const long = new Uint8Array(64).fill(0xff);
  long.set(hexBytes(golden.keys.primary.applicationKeyHex));
  const key64 = await deriveCursorKey(long);
  const token64 = await encodeCursor(key64, BASE);
  expect(token64).not.toBe(goldenValid('history_alice_page1').token);
  expect(await decodeCursor(key64, token64, HISTORY_ALICE)).toEqual(BASE);
  await expectInvalidCursor(() => decodeCursor(key32, token64, HISTORY_ALICE));

  // A key that is not an HMAC-SHA256 CryptoKey is refused as a key error.
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  await expect(encodeCursor(aes as CryptoKey, BASE)).rejects.toBeInstanceOf(CursorKeyError);
  await expect(
    decodeCursor(aes as CryptoKey, goldenValid('history_alice_page1').token, HISTORY_ALICE),
  ).rejects.toBeInstanceOf(CursorKeyError);
});

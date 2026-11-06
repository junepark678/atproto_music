// AT Protocol datetimes as BigInt nanoseconds since the Unix epoch (ADR 0004
// §4.3, §9.1). Ports `validate_timestamp` (crates/core/src/scrobble.rs) and the
// chrono `SecondsFormat::Nanos` storage canonicalizer used by cursor.rs and
// crates/storage, so every verdict and rendering equals tests/goldens/timestamps.json.
//
// - Accepted spelling is the RFC 3339 / ISO 8601 / WHATWG intersection:
//   `YYYY-MM-DDTHH:MM:SS[.f+](Z|+00:00)`, uppercase `T` and `Z`, seconds 00..59.
// - Fraction digits beyond the ninth are truncated (as chrono does). At exactly
//   receipt + 300 s a nonzero sub-nanosecond tail still rejects.
// - Storage (and DTO) form is fixed-width: `YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ`
//   (30 characters), so text order equals time order.
// - Record `createdAt` uses chrono `SecondsFormat::AutoSi`: no fraction, or
//   3, 6 or 9 digits, whichever is shortest without losing precision.

import type { Clock } from './deps';

export const NS_PER_MS = 1_000_000n;
export const NS_PER_SECOND = 1_000_000_000n;
/** Records may be dated at most this long after their receipt time (inclusive). */
export const FUTURE_TOLERANCE_SECONDS = 300;
export const STORAGE_LENGTH = 30;

const NS_PER_DAY = 86_400n * NS_PER_SECOND;
/** 0000-01-01T00:00:00Z and 10000-01-01T00:00:00Z: the four-digit-year range. */
const MIN_NS = -62_167_219_200n * NS_PER_SECOND;
const MAX_NS_EXCLUSIVE = 253_402_300_800n * NS_PER_SECOND;

export const MSG_AT_DATETIME = 'expected an AT Protocol UTC datetime';
export const MSG_RFC3339 = 'expected a UTC RFC3339 timestamp';
export const MSG_BOUNDS = 'timestamp must be between 1970-01-01 and receipt time plus 300 seconds';

export interface TimestampFailure {
  field: string;
  code: 'invalid_field';
  message: string;
}

export type TimestampResult = { ok: true; ns: bigint } | { ok: false; reason: TimestampFailure };

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/;
const encoder = new TextEncoder();

/** Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant, days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

interface Parsed {
  ns: bigint;
  /** A nonzero digit appeared after the ninth fractional digit. */
  subNanosecondTail: boolean;
}

type ParseOutcome = { ok: true; value: Parsed } | { ok: false; message: string };

/** The Rust two-step parse: AT-datetime prefilter, then strict RFC 3339 with a UTC offset. */
function parseAtDatetime(value: string): ParseOutcome {
  // The prefilter inspects UTF-8 bytes exactly as Rust does (`value.as_bytes()`).
  const bytes = encoder.encode(value);
  const at = (i: number) => bytes[i];
  const s10 = at(17);
  const s1 = at(18);
  if (
    bytes.length < 20 ||
    at(10) !== 0x54 /* T */ ||
    s10 === undefined ||
    s1 === undefined ||
    s10 < 0x30 ||
    s10 > 0x35 ||
    s1 < 0x30 ||
    s1 > 0x39 ||
    !(value.endsWith('Z') || value.endsWith('+00:00'))
  ) {
    return { ok: false, message: MSG_AT_DATETIME };
  }
  const m = SHAPE.exec(value);
  if (m === null) return { ok: false, message: MSG_RFC3339 };
  const [, ys, mos, ds, hs, mis, ss, fraction = ''] = m;
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mis);
  const second = Number(ss);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59) {
    return { ok: false, message: MSG_RFC3339 };
  }
  // Seconds 60..69 never pass the prefilter; 00..59 are all valid here.
  const nanos = BigInt(fraction.slice(0, 9).padEnd(9, '0'));
  const subNanosecondTail = /[1-9]/.test(fraction.slice(9));
  const seconds = daysFromCivil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
  return { ok: true, value: { ns: BigInt(seconds) * NS_PER_SECOND + nanos, subNanosecondTail } };
}

/**
 * Parse an AT Protocol UTC datetime into nanoseconds since the epoch, or null
 * when it is not one. Digits beyond nanosecond precision are truncated. No
 * receipt-time bounds are applied (see `validateTimestamp`).
 */
export function parseRfc3339(value: string): bigint | null {
  const parsed = parseAtDatetime(value);
  return parsed.ok ? parsed.value.ns : null;
}

/**
 * `validate_timestamp`: syntax, then 1970-01-01 ≤ t ≤ receipt + 300 s
 * (inclusive at nanosecond precision). Messages equal the Rust oracle.
 */
export function validateTimestamp(field: string, value: string, receiptNs: bigint): TimestampResult {
  const parsed = parseAtDatetime(value);
  if (!parsed.ok) return { ok: false, reason: { field, code: 'invalid_field', message: parsed.message } };
  const { ns, subNanosecondTail } = parsed.value;
  const latest = addSeconds(receiptNs, FUTURE_TOLERANCE_SECONDS);
  if (ns < 0n || ns > latest || (ns === latest && subNanosecondTail)) {
    return { ok: false, reason: { field, code: 'invalid_field', message: MSG_BOUNDS } };
  }
  return { ok: true, ns };
}

function split(ns: bigint): { date: string; time: string; nanos: bigint } {
  if (typeof ns !== 'bigint' || ns < MIN_NS || ns >= MAX_NS_EXCLUSIVE) {
    throw new RangeError(`timestamp ${String(ns)} ns is outside years 0000..9999`);
  }
  let days = ns / NS_PER_DAY;
  let rem = ns % NS_PER_DAY;
  if (rem < 0n) {
    days -= 1n;
    rem += NS_PER_DAY;
  }
  const secondsOfDay = Number(rem / NS_PER_SECOND);
  const nanos = rem % NS_PER_SECOND;
  const [year, month, day] = civilFromDays(Number(days));
  const two = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${String(year).padStart(4, '0')}-${two(month)}-${two(day)}`,
    time: `${two(Math.floor(secondsOfDay / 3600))}:${two(Math.floor(secondsOfDay / 60) % 60)}:${two(secondsOfDay % 60)}`,
    nanos,
  };
}

/** The 30-character storage form `YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ`. */
export function toStorage(ns: bigint): string {
  const { date, time, nanos } = split(ns);
  return `${date}T${time}.${nanos.toString().padStart(9, '0')}Z`;
}

/** DTO render. Rust DTOs serialize the stored column verbatim, so this equals `toStorage`. */
export function toDto(ns: bigint): string {
  return toStorage(ns);
}

/** chrono `SecondsFormat::AutoSi` with `Z`: the record `createdAt` spelling. */
export function toRecordDatetime(ns: bigint): string {
  const { date, time, nanos } = split(ns);
  let fraction = '';
  if (nanos !== 0n) {
    const digits = nanos.toString().padStart(9, '0');
    if (nanos % 1_000_000n === 0n) fraction = `.${digits.slice(0, 3)}`;
    else if (nanos % 1000n === 0n) fraction = `.${digits.slice(0, 6)}`;
    else fraction = `.${digits}`;
  }
  return `${date}T${time}${fraction}Z`;
}

/** Epoch milliseconds (a safe integer) to nanoseconds. */
export function fromMs(ms: number): bigint {
  if (!Number.isSafeInteger(ms)) throw new RangeError(`epoch ms must be a safe integer, got ${ms}`);
  return BigInt(ms) * NS_PER_MS;
}

/** Nanoseconds to epoch milliseconds, rounding toward negative infinity. */
export function toMs(ns: bigint): number {
  let ms = ns / NS_PER_MS;
  if (ns % NS_PER_MS < 0n) ms -= 1n;
  return Number(ms);
}

export function addSeconds(ns: bigint, seconds: number): bigint {
  if (!Number.isSafeInteger(seconds)) throw new RangeError(`seconds must be a safe integer, got ${seconds}`);
  return ns + BigInt(seconds) * NS_PER_SECOND;
}

/** The injected clock's current instant in nanoseconds. */
export function nowNs(clock: Clock): bigint {
  return fromMs(clock.nowMs());
}

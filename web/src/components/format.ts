// Text formatting shared by the screens. Times use the browser's selected
// display zone (or its automatic zone); API timestamps remain UTC instants.

import { ApiDecodeError, ApiError, ApiNetworkError } from '../api/client';
import { WriteError } from '../api/writes';
import { activeTimeZone } from '../state/time-zone';

export interface LocalTimeOptions {
  /** Append the short zone name (e.g. "GMT+9") where the reader must know the zone. */
  zone?: boolean;
}

/** Epoch ms → a local date and time, e.g. `Jan 15, 2026, 8:00 PM`. */
export function formatLocalTimeMs(ms: number, options: LocalTimeOptions = {}): string {
  const timeZone = activeTimeZone();
  const text = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(ms);
  return options.zone ? `${text} ${zoneName(ms)}` : text;
}

/** A UTC RFC 3339 timestamp → local date and time (the raw value when it does not parse). */
export function formatLocalTime(timestamp: string, options: LocalTimeOptions = {}): string {
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? timestamp : formatLocalTimeMs(ms, options);
}

/** Epoch ms or a timestamp → a local calendar date, e.g. `Jan 15, 2026`. */
export function formatLocalDate(value: string | number): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms)
    ? String(value)
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: activeTimeZone() }).format(ms);
}

/** The viewer's short zone name at `ms`, e.g. `GMT+9` or `PST`. */
export function zoneName(ms: number): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short', timeZone: activeTimeZone() })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? '';
}

const pad = (n: number) => String(n).padStart(2, '0');

function wallClockParts(ms: number, timeZone: string | undefined) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

/** Epoch ms → a `datetime-local` input value in the selected zone (`2026-01-15T20:00:00`). */
export function toLocalInput(ms: number): string {
  const p = wallClockParts(ms, activeTimeZone());
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

function offsetAt(instantMs: number, timeZone: string | undefined): number {
  const p = wallClockParts(instantMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * A `datetime-local` value (selected zone) → a UTC RFC 3339 timestamp with
 * whole seconds. A value that already carries a zone (`Z` or an offset) is
 * kept as that instant; a value that does not parse is returned unchanged so
 * the core validator reports it.
 */
export function localInputToUtc(value: string): string {
  const trimmed = value.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  let ms = m
    ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] === undefined ? 0 : +m[6])
    : /(Z|[+-]\d{2}:\d{2})$/i.test(trimmed)
      ? Date.parse(trimmed)
      : Number.NaN;
  if (m && !Number.isNaN(ms)) {
    const timeZone = activeTimeZone();
    // Fixed point offset iteration handles ordinary dates and DST transitions.
    // For gaps/overlaps where the mapping is not unique, the bounded iteration
    // produces a stable deterministic instant.
    for (let i = 0; i < 4; i++)
      ms =
        Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, m[6] === undefined ? 0 : +m[6]) - offsetAt(ms, timeZone);
  }
  if (Number.isNaN(ms)) return trimmed;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

const DID_TOKEN = /did:(?:plc|web):[A-Za-z0-9._:%-]*[A-Za-z0-9_%-]/g;

/**
 * Text that came from the server (job and operation errors, validation
 * reasons) with every DID replaced by "an account": DIDs are never shown to
 * the user outside of URLs.
 */
export function scrubDids(text: string): string {
  return text.replace(DID_TOKEN, 'an account');
}

/** `n scrobble(s)`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A user-safe sentence for a failed API call. Server text is never echoed. */
export function describeFailure(error: unknown): string {
  return scrubDids(failureText(error));
}

function failureText(error: unknown): string {
  if (error instanceof WriteError) {
    if (error.status === 409 && error.code === 'idempotency_conflict')
      return 'This action key was already used for different content. Try the action again once; it will receive a new key.';
    if (error.status === 429)
      return `Too many writes right now.${error.retryAfter ? ` Try again after ${error.retryAfter}.` : ' Try again shortly.'}`;
    if (error.status === 503 && error.code === 'publication_disabled')
      return 'Publishing is disabled for this deployment. Your action was not queued.';
    if (error.status === 507 || error.code === 'insufficient_storage')
      return 'The server has no space to queue this action. Nothing was published.';
  }
  if (error instanceof ApiError) {
    const ref = ` (${error.code}, request ${error.requestId})`;
    if (error.status === 429) {
      const wait =
        error.retryAfterSeconds !== null ? ` Try again in ${plural(error.retryAfterSeconds, 'second')}.` : '';
      return `Too many requests.${wait}${ref}`;
    }
    if (error.status === 503) return `The service is temporarily unavailable. Try again shortly.${ref}`;
    if (error.status >= 500) return `The server could not answer.${ref}`;
    if (error.status === 404) return `Nothing was found here.${ref}`;
    return `The request was refused.${ref}`;
  }
  if (error instanceof ApiNetworkError) return 'The server could not be reached. Check your connection.';
  if (error instanceof ApiDecodeError) return 'The server sent a response this app does not understand.';
  return 'Something went wrong.';
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

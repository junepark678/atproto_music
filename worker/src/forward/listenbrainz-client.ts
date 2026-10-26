// The outbound ListenBrainz client of forwarding and linking (ADR 0005
// §12.1, §12.3; N3-08). It talks to `LISTENBRAINZ_API_ROOT` with the user's
// linked token (`Authorization: Token <t>`), always through policyFetch
// (N1-05): https only, default port, no IP literal, redirects refused, a 10 s
// deadline and bounded bodies.
//
//   GET  1/validate-token                   linking: {valid, user_name}
//   POST 1/submit-listens                   single | import (≤ 100) | playing_now
//   POST 1/feedback/recording-feedback      {recording_mbid, score}
//
// Answers are classified, never thrown: `ok` (2xx), `status` (any other HTTP
// status, with ListenBrainz's `error` text), `network` (a TransportError).
// Every answer carries what its X-RateLimit-* headers said, so the pacer can
// hold the key. A token never appears in an outcome or a thrown error.

import { isTransportError } from '../node/pinned-transport';
import type { BoundPolicyFetch, PolicyCaps } from '../node/policy-fetch';
import { type ListenbrainzRateObservation, listenbrainzRateOf } from './upstream-pacing';

/** 100 listens with their metadata stay far below 1 MiB. */
export const LISTENBRAINZ_CAPS: Readonly<PolicyCaps> = Object.freeze({
  maxRequestBytes: 1_048_576,
  maxResponseBytes: 262_144,
});

/** At most this many listens per `import` submission. */
export const LISTENBRAINZ_MAX_IMPORT = 100;
/** The longest upstream error text kept. */
export const MAX_UPSTREAM_ERROR_CHARS = 256;

export type ListenType = 'single' | 'import' | 'playing_now';

export interface ListenbrainzClientOptions {
  /** LISTENBRAINZ_API_ROOT, e.g. https://api.listenbrainz.org/ */
  apiRoot: string;
  /** policyFetch with LISTENBRAINZ_CAPS bound. */
  fetch: BoundPolicyFetch;
}

export type ListenbrainzOutcome<T> =
  | { ok: true; value: T; rate: ListenbrainzRateObservation }
  | { ok: false; kind: 'status'; status: number; error: string; rate: ListenbrainzRateObservation }
  | { ok: false; kind: 'network'; error: string };

export interface TrackMetadata {
  artist_name: string;
  track_name: string;
  release_name?: string;
  additional_info?: Record<string, unknown>;
}

export interface ListenPayload {
  /** UNIX seconds; absent for playing_now. */
  listened_at?: number;
  track_metadata: TrackMetadata;
}

export type ValidateTokenResult = { valid: true; userName: string } | { valid: false };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorText(body: unknown, status: number): string {
  const raw = isObject(body) && typeof body.error === 'string' ? body.error : `HTTP ${status}`;
  return [...raw].slice(0, MAX_UPSTREAM_ERROR_CHARS).join('');
}

export class ListenbrainzClient {
  readonly apiRoot: string;
  private readonly fetch: BoundPolicyFetch;

  constructor(options: ListenbrainzClientOptions) {
    this.apiRoot = options.apiRoot;
    this.fetch = options.fetch;
  }

  private async exchange(path: string, token: string, init: RequestInit): Promise<ListenbrainzOutcome<unknown>> {
    let res: Response;
    let text: string;
    try {
      res = await this.fetch(new URL(path, this.apiRoot).href, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Token ${token}`,
          accept: 'application/json',
        },
      });
      text = await res.text();
    } catch (error) {
      if (isTransportError(error)) return { ok: false, kind: 'network', error: error.code };
      throw error;
    }
    const rate = listenbrainzRateOf(res.headers);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, value: body, rate };
    return { ok: false, kind: 'status', status: res.status, error: errorText(body, res.status), rate };
  }

  /** GET 1/validate-token: whether `token` is valid and whose it is. */
  async validateToken(token: string): Promise<ListenbrainzOutcome<ValidateTokenResult>> {
    const out = await this.exchange('1/validate-token', token, { method: 'GET' });
    if (!out.ok) return out;
    const body = out.value;
    if (isObject(body) && body.valid === true && typeof body.user_name === 'string' && body.user_name !== '') {
      return { ok: true, value: { valid: true, userName: body.user_name }, rate: out.rate };
    }
    if (isObject(body) && body.valid === false) return { ok: true, value: { valid: false }, rate: out.rate };
    return { ok: false, kind: 'status', status: 502, error: 'malformed validate-token answer', rate: out.rate };
  }

  /** POST 1/submit-listens. */
  async submit(
    token: string,
    listenType: ListenType,
    payload: readonly ListenPayload[],
  ): Promise<ListenbrainzOutcome<null>> {
    if (payload.length < 1) throw new RangeError('a submission needs at least one listen');
    if (listenType !== 'import' && payload.length !== 1) throw new RangeError(`${listenType} takes exactly one listen`);
    if (payload.length > LISTENBRAINZ_MAX_IMPORT) {
      throw new RangeError(`an import takes at most ${LISTENBRAINZ_MAX_IMPORT} listens`);
    }
    const out = await this.exchange('1/submit-listens', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listen_type: listenType, payload }),
    });
    return out.ok ? { ok: true, value: null, rate: out.rate } : out;
  }

  /** POST 1/feedback/recording-feedback (score 1 = love, 0 = remove). */
  async feedback(token: string, recordingMbid: string, score: 1 | 0 | -1): Promise<ListenbrainzOutcome<null>> {
    const out = await this.exchange('1/feedback/recording-feedback', token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recording_mbid: recordingMbid, score }),
    });
    return out.ok ? { ok: true, value: null, rate: out.rate } : out;
  }
}

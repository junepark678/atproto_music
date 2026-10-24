// Worker bindings, vars and secrets (ADR 0004 §1.1, §4.2). Frozen in Wave 0.
// Every var is a string because wrangler `vars` are strings; worker/src/config.ts
// is the only place that interprets them.

import type { IndexRpc } from './do/contracts';

/** The IndexDO stub type: IndexRpc over Workers JS RPC. */
export type IndexNamespace = DurableObjectNamespace<IndexRpc & Rpc.DurableObjectBranded>;

export interface EnvVars {
  /** `https://<host>` with no path, port, query or credentials. */
  PUBLIC_ORIGIN: string;
  /** Owned NSID prefix; empty disables ingestion and publication (namespace gate). */
  LEXICON_PREFIX: string;
  /** Reviewable evidence that the operator controls the prefix's domain. */
  NAMESPACE_OWNERSHIP_REF: string;
  /** `socket` | `pulse` | `off`. */
  INGEST_MODE: string;
  /** Comma-separated `wss://` Jetstream hosts, rotated on reconnect. */
  JETSTREAM_URLS: string;
  /** Integer hours a stored cursor may age before gap recovery. */
  JETSTREAM_LOOKBACK_HOURS: string;
  /** `https://` relay for listReposByCollection discovery. */
  RELAY_URL: string;
  /** `paid` | `free`: selects the per-alarm slice budgets. */
  PLAN: string;
  /** DurableObjectLocationHint for the singleton IndexDO. */
  DO_LOCATION_HINT: string;
}

export interface EnvSecrets {
  /** Required: hex-encoded cursor HMAC application key, at least 32 bytes. */
  CURSOR_KEY: string;
  /** Optional: enables /internal/admin/* when set. */
  ADMIN_TOKEN?: string;
}

export interface EnvBindings {
  INDEX: IndexNamespace;
  ASSETS: Fetcher;
}

export interface Env extends EnvVars, EnvSecrets, EnvBindings {}

export const ENV_VAR_NAMES: readonly (keyof EnvVars)[] = [
  'PUBLIC_ORIGIN',
  'LEXICON_PREFIX',
  'NAMESPACE_OWNERSHIP_REF',
  'INGEST_MODE',
  'JETSTREAM_URLS',
  'JETSTREAM_LOOKBACK_HOURS',
  'RELAY_URL',
  'PLAN',
  'DO_LOCATION_HINT',
];

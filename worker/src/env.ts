// Node process settings shared by the host parser and route context.

/** Process configuration inputs interpreted by worker/src/config.ts. */

export interface EnvVars {
  /** `https://<host>` with no path, port, query or credentials. */
  PUBLIC_ORIGIN: string;
  /** Owned NSID prefix; empty disables ingestion and publication (namespace gate). */
  LEXICON_PREFIX: string;
  /** Reviewable evidence that the operator controls the prefix's domain. */
  NAMESPACE_OWNERSHIP_REF: string;
  /** SHA-256 reference to the reviewed, publicly retrieved production schema manifest; absent keeps publication disabled. */
  NAMESPACE_PUBLICATION_REF: string;
  /** Separate owner-reviewed five-schema manifest digest; absent keeps batch writes disabled. */
  NAMESPACE_BATCH_PUBLICATION_REF?: string;
  /** `socket` | `off`. */
  INGEST_MODE: string;
  /** Comma-separated `wss://` Jetstream hosts, rotated on reconnect. */
  JETSTREAM_URLS: string;
  /** Integer hours a stored cursor may age before gap recovery. */
  JETSTREAM_LOOKBACK_HOURS: string;
  /** `https://` relay for listReposByCollection discovery. */
  RELAY_URL: string;
}

export interface EnvSecrets {
  /** Required: hex-encoded cursor HMAC application key, at least 32 bytes. */
  CURSOR_KEY: string;
}

export interface Env extends EnvVars, EnvSecrets {}

export const ENV_VAR_NAMES: readonly (keyof EnvVars)[] = [
  'PUBLIC_ORIGIN',
  'LEXICON_PREFIX',
  'NAMESPACE_OWNERSHIP_REF',
  'NAMESPACE_PUBLICATION_REF',
  'NAMESPACE_BATCH_PUBLICATION_REF',
  'INGEST_MODE',
  'JETSTREAM_URLS',
  'JETSTREAM_LOOKBACK_HOURS',
  'RELAY_URL',
];

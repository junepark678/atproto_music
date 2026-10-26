// TypeScript shapes of every API payload in docs/planning/API.md as amended by
// ADR 0004 §9 (api/openapi.yaml 1.1.0). Frozen in Wave 0. ADR 0005 B14
// (api/openapi.yaml 1.2.0) adds, additively only, the optional Scrobble
// fields, the extended Capability union and the v1.2 DTOs at the end.
//
// Kept DTOs are byte-for-byte the v1 shapes: every object is closed, and an
// absent optional field is omitted, never null or "". Timestamps in responses
// use the Rust DTO rendering (tests/goldens/timestamps.json).

import type { ErrorCode } from './errors';

/** UTC RFC 3339 timestamp string. */
export type Timestamp = string;
/** Syntactic AT Protocol DID (did:plc or did:web). */
export type Did = string;
/** Full record AT URI: at://<did>/<collection>/<rkey>. */
export type AtUri = string;
/** CIDv1 dag-cbor sha2-256 string. */
export type Cid = string;
/** AT Protocol handle. */
export type Handle = string;

// ---------------------------------------------------------------------------
// Kept DTOs
// ---------------------------------------------------------------------------

export type IndexingState = 'current' | 'recovering' | 'stale' | 'suppressed';

export interface Indexing {
  state: IndexingState;
  caughtUp: boolean;
  lastIndexedAt: Timestamp | null;
  lagSeconds: number | null;
}

export interface Scrobble {
  uri: AtUri;
  cid: Cid;
  did: Did;
  revision: string;
  artist: string;
  track: string;
  album?: string;
  listenedAt: Timestamp;
  createdAt: Timestamp;
  durationSeconds?: number;
  recordingMbid?: string;
  indexedAt: Timestamp;
  // v1.2 additive optional fields (ADR 0005 §6.2); omitted when the record has none.
  albumArtist?: string;
  /** 1–9999. */
  trackNumber?: number;
  /** 1–10 distinct UUIDs. */
  artistMbids?: string[];
  releaseMbid?: string;
  releaseGroupMbid?: string;
  /** Uppercase, `^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$`. */
  isrc?: string;
  submissionClient?: string;
  /** Lowercase DNS name. */
  musicService?: string;
}

/** `GET /api/v1/scrobbles/{id}`. */
export interface ScrobbleResult {
  scrobble: Scrobble;
}

export interface Follow {
  uri: AtUri;
  cid: Cid;
  actor: Did;
  subject: Did;
  createdAt: Timestamp;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  asOf: Timestamp;
  indexing: Indexing;
}

export type ScrobblePage = Page<Scrobble>;
export type FollowPage = Page<Follow>;

export interface Profile {
  did: Did;
  handle: Handle | null;
  joinedAt: Timestamp;
  indexedAt: Timestamp | null;
  totalScrobbles: number;
  followerCount: number;
  followingCount: number;
  indexing: Indexing;
}

export type StatsWindow = 'all' | '7d' | '30d' | '365d';
export const STATS_WINDOWS: readonly StatsWindow[] = ['all', '7d', '30d', '365d'];

export interface TopArtist {
  artist: string;
  scrobbleCount: number;
}

export interface TopTrack {
  artist: string;
  track: string;
  scrobbleCount: number;
}

export interface TopAlbum {
  artist: string;
  album: string;
  scrobbleCount: number;
}

export interface Statistics {
  did: Did;
  window: StatsWindow;
  asOf: Timestamp;
  totalScrobbles: number;
  distinctArtists: number;
  distinctTracks: number;
  topArtists: TopArtist[];
  topTracks: TopTrack[];
  topAlbums: TopAlbum[];
}

export type MetaStage = 'scaffold' | 'backend' | 'product';

/** The v1.2 capabilities (ADR 0005 B14, B18), also listed per account in `Account.capabilities`. */
export type AccountCapability = 'writes' | 'lastfm' | 'listenbrainz' | 'imports' | 'forwarding';
export const ACCOUNT_CAPABILITIES: readonly AccountCapability[] = [
  'writes',
  'lastfm',
  'listenbrainz',
  'imports',
  'forwarding',
];

/**
 * A20: `publication` is advertised only with an owned (non-fixture) prefix.
 * v1.2 adds the `AccountCapability` values.
 */
export type Capability = 'read' | 'stats' | 'follows' | 'notify' | 'indexing' | 'publication' | AccountCapability;

export interface Meta {
  name: 'atproto_music';
  version: string;
  stage: MetaStage;
  capabilities: string[];
  lexiconPrefix: string | null;
  indexing: Indexing;
}

/** `GET /api/v1/resolve?handle=` (OpenAPI component `ResolvedIdentity`). */
export interface Resolve {
  did: Did;
  handle: Handle;
  verified: true;
}

export interface HealthLive {
  status: 'live';
}

export interface HealthReady {
  status: 'ready';
}

export type Health = HealthLive | HealthReady;

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  requestId: string;
  fields?: Record<string, string>;
}

export interface ErrorEnvelope {
  error: ErrorBody;
}

/** `/oauth/client-metadata.json`: a build-time static asset, not an envelope. */
export interface OAuthClientMetadata {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  tos_uri?: string;
  policy_uri?: string;
  redirect_uris: string[];
  scope: string;
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
  token_endpoint_auth_method: 'none' | 'private_key_jwt';
  application_type?: 'web' | 'native';
  dpop_bound_access_tokens: true;
}

export type FeedScope = 'global' | 'following';

// ---------------------------------------------------------------------------
// Added by ADR 0004 §9.4
// ---------------------------------------------------------------------------

/** N1 `POST /api/v1/notify`: exactly one of `uri` or `did`; unknown fields are 422. */
export type NotifyInput = { uri: AtUri; did?: never } | { did: Did; uri?: never };

/** N1 success: 202. */
export interface NotifyAccepted {
  state: 'queued';
}

export type RecordStatusState = 'indexed' | 'pending' | 'absent' | 'excluded' | 'unknown';

/** N2 `GET /api/v1/records/status?uri=` (no-store). */
export interface RecordStatus {
  uri: AtUri;
  state: RecordStatusState;
  cid?: Cid;
  revision?: string;
  reason?: string;
  indexing: Indexing;
}

/** N3 `GET /api/v1/users/{did}/export`: attachment `music-export.json`, no-store. */
export interface Export {
  schemaVersion: 1;
  did: Did;
  exportedAt: Timestamp;
  indexing: Indexing;
  scrobbles: Scrobble[];
  follows: Follow[];
}

// ---------------------------------------------------------------------------
// Added by ADR 0005 B14 (api/openapi.yaml 1.2.0)
// ---------------------------------------------------------------------------

/** `^[A-Za-z0-9_-]{1,64}$`. */
export type OperationId = string;
/** `^[A-Za-z0-9_-]{1,64}$`: app passwords, tokens, links and import jobs. */
export type CredentialId = string;
/** Lowercase `^[a-z0-9][a-z0-9._-]{1,63}$` (ADR 0005 §9). */
export type Username = string;
/** A sanitized failure code, `^[a-z0-9_]{1,64}$`. */
export type ErrorSlug = string;

export type OperationKind =
  | 'scrobble.create'
  | 'scrobble.delete'
  | 'follow.put'
  | 'follow.delete'
  | 'settings.put'
  | 'love.put'
  | 'love.delete';
export const OPERATION_KINDS: readonly OperationKind[] = [
  'scrobble.create',
  'scrobble.delete',
  'follow.put',
  'follow.delete',
  'settings.put',
  'love.put',
  'love.delete',
];

export type OperationOrigin = 'web' | 'lastfm' | 'listenbrainz' | 'import';
export const OPERATION_ORIGINS: readonly OperationOrigin[] = ['web', 'lastfm', 'listenbrainz', 'import'];

export type OperationState = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
export const OPERATION_STATES: readonly OperationState[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
];

interface OperationBase {
  id: OperationId;
  kind: OperationKind;
  origin: OperationOrigin;
  /** 0–10. */
  attempts: number;
  uri?: AtUri;
  cid?: Cid;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * `GET /api/v1/operations/{id}`: one server outbox operation (ADR 0005 §5.8),
 * visible to its owner only. `error` is required when failed, absent when
 * queued, running or cancelled, and optional when succeeded or blocked.
 */
export type Operation =
  | (OperationBase & { state: 'failed'; error: ErrorSlug })
  | (OperationBase & { state: 'queued' | 'running' | 'cancelled'; error?: never })
  | (OperationBase & { state: 'succeeded' | 'blocked'; error?: ErrorSlug });

/** 202 from every v1.2 write route: durably queued in the server outbox, not yet on the PDS. */
export interface Accepted {
  operation: Operation;
}

export type SessionStatus = 'active' | 'reauth_required';

/** `GET /api/v1/auth/session`: the cookie session. */
export interface Session {
  did: Did;
  handle: Handle | null;
  username: Username;
  /** 64 lowercase hex characters; sent back as X-CSRF-Token. */
  csrfToken: string;
  status: SessionStatus;
  expiresAt: Timestamp;
}

export type OAuthStatus = 'active' | 'reauth_required' | 'signed_out';

/** `GET`/`PATCH /api/v1/account`. */
export interface Account {
  did: Did;
  handle: Handle | null;
  username: Username;
  oauthStatus: OAuthStatus;
  shareNowPlaying: boolean;
  /** 10–90. */
  importSharePercent: number;
  /** Distinct values. */
  capabilities: AccountCapability[];
}

export type LinkService = 'lastfm' | 'listenbrainz';
export type LinkStatus = 'active' | 'revoked' | 'error';

/** A linked Last.fm or ListenBrainz account; its credential is stored sealed and never returned. */
export interface Link {
  id: CredentialId;
  service: LinkService;
  /** 1–128 characters. */
  remoteUser: string;
  forwardScrobbles: boolean;
  forwardNowPlaying: boolean;
  status: LinkStatus;
  lastError: ErrorSlug | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type ImportSource = 'lastfm_api' | 'lastfm_json' | 'listenbrainz_api' | 'listenbrainz_zip';
export type ImportState = 'waiting_index' | 'fetching' | 'writing' | 'paused' | 'done' | 'failed' | 'cancelled';

/** Progress of one import job (ADR 0005 §11.4). Counters are non-negative integers. */
export interface ImportJob {
  id: CredentialId;
  source: ImportSource;
  /** At most 128 characters; null for an upload. */
  remoteUser: string | null;
  state: ImportState;
  fetched: number;
  staged: number;
  duplicates: number;
  invalid: number;
  written: number;
  failed: number;
  etaSeconds: number | null;
  error: ErrorSlug | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** An app password or a ListenBrainz token: metadata only. */
export interface CredentialSummary {
  id: CredentialId;
  /** 1–64 scalars, at most 256 UTF-8 bytes. */
  label: string;
  createdAt: Timestamp;
  lastUsedAt: Timestamp | null;
}

export interface LastfmAppSummary {
  /** `^[0-9a-f]{32}$`, an api_key this server issued. */
  apiKey: string;
  name: string;
  createdAt: Timestamp;
}

export interface LastfmSessionSummary {
  id: CredentialId;
  /** 1–64 characters. */
  apiKey: string;
  /** 1–128 characters. */
  clientName: string;
  createdAt: Timestamp;
  lastUsedAt: Timestamp | null;
}

/** `GET /api/v1/account/credentials`: no secret, hash or ciphertext is ever returned. */
export interface Credentials {
  appPasswords: CredentialSummary[];
  listenbrainzTokens: CredentialSummary[];
  lastfmApps: LastfmAppSummary[];
  lastfmSessions: LastfmSessionSummary[];
}

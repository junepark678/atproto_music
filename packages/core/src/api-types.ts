// TypeScript shapes of every API payload in docs/planning/API.md as amended by
// ADR 0004 §9 (api/openapi.yaml 1.1.0). Frozen in Wave 0.
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

/** A20: `publication` is advertised only with an owned (non-fixture) prefix. */
export type Capability = 'read' | 'stats' | 'follows' | 'notify' | 'indexing' | 'publication';

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

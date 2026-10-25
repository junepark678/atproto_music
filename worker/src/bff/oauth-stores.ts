// The OAuth library's state and session stores, sealed at rest (ADR 0005 §5.5,
// §3.8, §13; N2-03).
//
// **oauth_states** (OAuthStateStore) is keyed by SHA-256 of the state key. Its
// value — the library's NodeSavedState: issuer, the private DPoP JWK, the auth
// method, the PKCE verifier and our app state — is AES-256-GCM ciphertext under
// the `oauth-state` key (HKDF info `state`) with AAD = the hex key hash, so a
// ciphertext copied to another row fails to open. `session_binding` holds
// SHA-256 of the `__Host-atmusic_oauth` login-binding cookie (§5.6), carried in
// from `authorize` inside the app state. A state lives 600 s and is single use:
// `get` deletes the row whether or not it is still valid.
//
// **oauth_sessions** (OAuthSessionStore) is keyed by DID. Its value — the
// library's NodeSavedSession: token set, private DPoP JWK, auth method — is
// ciphertext under the `oauth-session` key (info `tokens`) with AAD = the DID.
// The row also records `client_kid` (the signing key the session is bound to,
// §5.4), `generation`, `last_refresh_ms` and `status`.
//
// **No compare-and-swap, and set() never throws** (§5.5, review round 1 #12).
// When the library's `sessionStore.set()` throws after a refresh it revokes the
// freshly issued tokens upstream and deletes the session
// (session-getter.js:190-212; the callback path does the same,
// oauth-client.js:213-215), so a transient SQLITE_FULL would sign users out.
// Instead `set()` writes unconditionally (incrementing `generation`, kept for
// diagnostics only); concurrent refreshes are already serialised by
// requestLocalLock in this single process. On a failed write the session is
// held in an in-memory write-behind map that `get()` reads first,
// `oauth_store_write_failed` is logged (DID and error class only, no secret),
// `degraded()` turns true (readiness and adminStatus report
// `oauth_store_degraded`), and the write is retried on every get(), set() and
// keepalive run (`flush()`) until it succeeds. If the process stops first, the
// rotated refresh token is lost and the next refresh is `invalid_grant`, i.e.
// `reauth_required` for that DID only.
//
// A value that fails to open (BoxError: wrong or missing key, tampered row) is
// treated as missing, which the library turns into `reauth_required`; the row
// is left in place, so a restore with the right key can still read it.
//
// Deleting a session row is journaled (`oauth_session`, the revocation journal
// of N1-08) in the same transaction, except while the callback replaces the
// previous session of the DID that is signing in again (the `quiet` predicate),
// which the new session supersedes at once.
//
// **Conditional deletion (review round 1 of N2-03).** The library's own
// `revoke(sub)` deletes whatever session the DID has once its upstream request
// returns, which may be a session a concurrent sign-in stored meanwhile. Our
// `revoke()` therefore takes a `snapshot(did)` before its upstream request and
// afterwards calls `delIfUnchanged(snapshot)`, which deletes (and journals, in
// one transaction) only when no set() or del() of that DID happened since and
// the row still holds the snapshot's ciphertext. Every set() and del() bumps an
// in-memory per-DID version for this check; `generation` cannot serve, since
// a row deleted and inserted again starts at 1 again.

import { createHash } from 'node:crypto';
import type { Clock } from '@atmusic/core/deps';
import type {
  NodeSavedSession,
  NodeSavedSessionStore,
  NodeSavedState,
  NodeSavedStateStore,
} from '@atproto/oauth-client-node';
import type { Revocations } from '../app/revocations';
import { type Box, BoxError, oauthSessionAad, oauthStateAad } from '../crypto/box';
import type { Logger } from '../do/contracts';
import type { Db } from '../do/db';

/** ADR §5.5: covers the reference AS's 5-minute PAR and authorization inactivity windows. */
export const OAUTH_STATE_TTL_MS = 600_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(text: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(text).digest());
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/** A standalone ArrayBuffer copy, the BLOB form the Db facade binds. */
function blob(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);
}

function errorClass(error: unknown): { error: string; code?: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { error: name, code } : { error: name };
}

// ---------------------------------------------------------------------------
// App state: what authorize() hands the state store through the library
// ---------------------------------------------------------------------------

/**
 * The library's opaque `appState` for one authorization flow. It is never sent
 * to the AS (the library sends its own random `state`), and it is sealed with
 * the rest of the state value.
 */
export interface AuthorizeAppState {
  v: 1;
  /** A random id of this flow, so a failed authorize can delete exactly its row. */
  flow: string;
  /** hex SHA-256 of the `__Host-atmusic_oauth` cookie value. */
  binding: string;
  /** The DID sign-in started for (handle-resolved when it started from a handle). */
  did: string;
  /** The handle sign-in started from, lowercase; null when it started from a DID. */
  handle: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function encodeAppState(state: AuthorizeAppState): string {
  return JSON.stringify(state);
}

export function decodeAppState(text: string | null | undefined): AuthorizeAppState | null {
  if (typeof text !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (
    s.v !== 1 ||
    typeof s.flow !== 'string' ||
    s.flow === '' ||
    typeof s.binding !== 'string' ||
    !HEX64.test(s.binding) ||
    typeof s.did !== 'string' ||
    !s.did.startsWith('did:') ||
    (s.handle !== null && typeof s.handle !== 'string')
  ) {
    return null;
  }
  return { v: 1, flow: s.flow, binding: s.binding, did: s.did, handle: s.handle as string | null };
}

// ---------------------------------------------------------------------------
// oauth_states
// ---------------------------------------------------------------------------

export interface OAuthStoreDeps {
  db: Db;
  clock: Clock;
  box: Box;
  log: Logger;
}

export type StateInspection =
  | { status: 'ok'; binding: Uint8Array; app: AuthorizeAppState }
  | { status: 'expired' }
  | { status: 'unknown' };

interface StateRow {
  ciphertext: ArrayBuffer;
  session_binding: ArrayBuffer;
  expires_at_ms: number;
}

export class OAuthStateStore implements NodeSavedStateStore {
  /** flow id → hex key hash of the row the flow's authorize stored. */
  private readonly flows = new Map<string, string>();

  constructor(private readonly deps: OAuthStoreDeps) {}

  private keyHash(key: string): Uint8Array {
    if (typeof key !== 'string' || key === '') throw new TypeError('OAuth state key must be a non-empty string');
    return sha256(key);
  }

  private open(keyHash: Uint8Array, ciphertext: ArrayBuffer): NodeSavedState | undefined {
    try {
      const text = this.deps.box.openText('oauth-state', new Uint8Array(ciphertext), oauthStateAad(hex(keyHash)));
      return JSON.parse(text) as NodeSavedState;
    } catch (error) {
      if (!(error instanceof BoxError) && !(error instanceof SyntaxError)) throw error;
      this.deps.log.log('warn', 'oauth_state_unreadable', errorClass(error));
      return undefined;
    }
  }

  set(key: string, value: NodeSavedState): void {
    const app = decodeAppState(value.appState);
    if (app === null) throw new TypeError('an OAuth state needs the login binding of authorize()');
    const keyHash = this.keyHash(key);
    const sealed = this.deps.box.seal('oauth-state', JSON.stringify(value), oauthStateAad(hex(keyHash)));
    this.deps.db.run(
      'INSERT OR REPLACE INTO oauth_states (key_hash, ciphertext, key_id, session_binding, expires_at_ms) VALUES (?, ?, ?, ?, ?)',
      blob(keyHash),
      blob(sealed),
      this.deps.box.currentKeyId,
      blob(Buffer.from(app.binding, 'hex')),
      this.deps.clock.nowMs() + OAUTH_STATE_TTL_MS,
    );
    this.flows.set(app.flow, hex(keyHash));
  }

  /** Single use: the row is deleted whatever it holds; an expired or unreadable state is missing. */
  get(key: string): NodeSavedState | undefined {
    const keyHash = this.keyHash(key);
    const row = this.deps.db.one<Pick<StateRow, 'ciphertext' | 'expires_at_ms'>>(
      'DELETE FROM oauth_states WHERE key_hash = ? RETURNING ciphertext, expires_at_ms',
      blob(keyHash),
    );
    if (row === null) return undefined;
    if (this.deps.clock.nowMs() >= row.expires_at_ms) return undefined;
    return this.open(keyHash, row.ciphertext);
  }

  del(key: string): void {
    this.deps.db.run('DELETE FROM oauth_states WHERE key_hash = ?', blob(this.keyHash(key)));
  }

  /**
   * The binding and app state of a pending flow, without consuming it (the
   * callback checks the login binding before the library runs). An expired or
   * unreadable row is deleted here.
   */
  inspect(key: string): StateInspection {
    const keyHash = this.keyHash(key);
    const row = this.deps.db.one<StateRow>(
      'SELECT ciphertext, session_binding, expires_at_ms FROM oauth_states WHERE key_hash = ?',
      blob(keyHash),
    );
    if (row === null) return { status: 'unknown' };
    if (this.deps.clock.nowMs() >= row.expires_at_ms) {
      this.del(key);
      return { status: 'expired' };
    }
    const value = this.open(keyHash, row.ciphertext);
    const app = decodeAppState(value?.appState);
    if (app === null) {
      this.del(key);
      return { status: 'unknown' };
    }
    return { status: 'ok', binding: new Uint8Array(row.session_binding), app };
  }

  /** Delete the row a failed authorize stored for `flow`. Returns whether one was deleted. */
  discardFlow(flow: string): boolean {
    const keyHashHex = this.flows.get(flow);
    this.flows.delete(flow);
    if (keyHashHex === undefined) return false;
    return (
      this.deps.db.run('DELETE FROM oauth_states WHERE key_hash = ?', blob(Buffer.from(keyHashHex, 'hex')))
        .rowsWritten > 0
    );
  }

  /** The flow's authorize succeeded; stop tracking it. */
  forgetFlow(flow: string): void {
    this.flows.delete(flow);
  }

  /** The expiry-sweep step (ADR §3.3): delete every expired state. */
  sweepExpired(nowMs = this.deps.clock.nowMs()): number {
    return this.deps.db.run('DELETE FROM oauth_states WHERE expires_at_ms <= ?', nowMs).rowsWritten;
  }
}

// ---------------------------------------------------------------------------
// oauth_sessions
// ---------------------------------------------------------------------------

export interface OAuthSessionStoreDeps extends OAuthStoreDeps {
  revocations: Revocations;
}

export interface OAuthSessionRowInfo {
  did: string;
  client_kid: string;
  generation: number;
  last_refresh_ms: number;
  status: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface Held {
  session: NodeSavedSession;
  /** When set() was called: the refresh time the row records once the write succeeds. */
  atMs: number;
}

/** What `snapshot(did)` saw: the session `revoke()` sets out to revoke. */
export interface OAuthSessionSnapshot {
  readonly did: string;
  /** The session (held or stored), or undefined when the DID has none. */
  readonly session: NodeSavedSession | undefined;
  /** @internal the store's per-DID version when the snapshot was taken. */
  readonly version: number;
  /** @internal the held entry, if the session was only in memory. */
  readonly held: Held | undefined;
  /** @internal the stored ciphertext, or null when there was no row. */
  readonly ciphertext: Uint8Array | null;
}

/** `delIfUnchanged`: deleted the snapshot's session, found none, or found a newer one and kept it. */
export type ConditionalDeleteOutcome = 'deleted' | 'absent' | 'superseded';

export class OAuthSessionStore implements NodeSavedSessionStore {
  private readonly held = new Map<string, Held>();
  /** Bumped by every set() and del() of a DID (the conditional-delete check). */
  private readonly versions = new Map<string, number>();
  /** DIDs whose deletions are not journaled right now (the callback's replacement of the old session). */
  quiet: (did: string) => boolean = () => false;

  constructor(private readonly deps: OAuthSessionStoreDeps) {}

  /** True while a session update is only in memory (readiness and adminStatus: `oauth_store_degraded`). */
  degraded(): boolean {
    return this.held.size > 0;
  }

  /** DIDs whose newest session is only in memory. */
  heldDids(): string[] {
    return [...this.held.keys()];
  }

  private write(did: string, session: NodeSavedSession, atMs: number): void {
    const sealed = this.deps.box.seal('oauth-session', JSON.stringify(session), oauthSessionAad(did));
    const auth = session.authMethod;
    const kid = auth.method === 'private_key_jwt' ? auth.kid : 'none';
    const now = this.deps.clock.nowMs();
    this.deps.db.run(
      `INSERT INTO oauth_sessions
         (did, ciphertext, key_id, client_kid, generation, last_refresh_ms, status, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, 1, ?, 'active', ?, ?)
       ON CONFLICT(did) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         key_id = excluded.key_id,
         client_kid = excluded.client_kid,
         generation = oauth_sessions.generation + 1,
         last_refresh_ms = excluded.last_refresh_ms,
         status = 'active',
         updated_at_ms = excluded.updated_at_ms`,
      did,
      blob(sealed),
      this.deps.box.currentKeyId,
      kid,
      atMs,
      now,
      now,
    );
  }

  /** Retry every held write. Returns true when nothing is held any more. Never throws. */
  flush(): boolean {
    for (const [did, h] of [...this.held]) {
      try {
        this.write(did, h.session, h.atMs);
      } catch (error) {
        this.deps.log.log('warn', 'oauth_store_write_failed', { did, retry: true, ...errorClass(error) });
        continue;
      }
      // Only drop it if no newer set() replaced it meanwhile (writes are synchronous, so none can).
      if (this.held.get(did) === h) this.held.delete(did);
      this.deps.log.log('info', 'oauth_store_write_recovered', { did, held: this.held.size });
    }
    return this.held.size === 0;
  }

  private bump(did: string): void {
    this.versions.set(did, (this.versions.get(did) ?? 0) + 1);
  }

  private storedCiphertext(did: string): Uint8Array | null {
    const row = this.deps.db.one<{ ciphertext: ArrayBuffer }>(
      'SELECT ciphertext FROM oauth_sessions WHERE did = ?',
      did,
    );
    return row === null ? null : new Uint8Array(row.ciphertext);
  }

  /** Writes unconditionally; on a storage failure keeps the session in memory. Never throws. */
  set(did: string, session: NodeSavedSession): void {
    this.bump(did);
    const atMs = this.deps.clock.nowMs();
    this.flush();
    try {
      this.write(did, session, atMs);
      this.held.delete(did);
    } catch (error) {
      this.held.set(did, { session, atMs });
      this.deps.log.log('error', 'oauth_store_write_failed', { did, held: this.held.size, ...errorClass(error) });
    }
  }

  get(did: string): NodeSavedSession | undefined {
    this.flush();
    const held = this.held.get(did);
    if (held !== undefined) return held.session;
    const row = this.deps.db.one<{ ciphertext: ArrayBuffer }>(
      'SELECT ciphertext FROM oauth_sessions WHERE did = ?',
      did,
    );
    if (row === null) return undefined;
    let session: NodeSavedSession;
    try {
      session = JSON.parse(
        this.deps.box.openText('oauth-session', new Uint8Array(row.ciphertext), oauthSessionAad(did)),
      ) as NodeSavedSession;
    } catch (error) {
      if (!(error instanceof BoxError) && !(error instanceof SyntaxError)) throw error;
      this.deps.log.log('warn', 'oauth_session_unreadable', { did, ...errorClass(error) });
      return undefined;
    }
    if (session?.tokenSet?.sub !== did) {
      this.deps.log.log('warn', 'oauth_session_unreadable', { did, error: 'sub_mismatch' });
      return undefined;
    }
    return session;
  }

  /** Delete the session (held and stored); the deletion is journaled unless `quiet(did)`. */
  del(did: string): void {
    this.bump(did);
    this.held.delete(did);
    const journal = !this.quiet(did);
    this.deps.db.tx(() => {
      const deleted = this.deps.db.all<{ one: number }>(
        'DELETE FROM oauth_sessions WHERE did = ? RETURNING 1 AS one',
        did,
      ).length;
      if (deleted > 0 && journal) this.deps.revocations.record({ kind: 'oauth_session', did });
    });
  }

  /** Whether the DID has a session, held or stored. */
  has(did: string): boolean {
    return this.held.has(did) || this.storedCiphertext(did) !== null;
  }

  /** The DID's current session and the version it is at (see the header). Never throws for a storage read of a held session. */
  snapshot(did: string): OAuthSessionSnapshot {
    const session = this.get(did); // flushes first
    return {
      did,
      session,
      version: this.versions.get(did) ?? 0,
      held: this.held.get(did),
      ciphertext: this.storedCiphertext(did),
    };
  }

  /**
   * Delete the snapshot's session only if it is still the DID's session: no
   * set() or del() since the snapshot, the held entry is the same one, and
   * the row holds the same ciphertext (a held session that was flushed since
   * counts as the same). Synchronous, so nothing interleaves with the check.
   * The deletion is always journaled in the same transaction: it is a
   * revocation (sign-out, keepalive, reconciliation, a failed binding check),
   * never the callback's replacement of the previous session.
   */
  delIfUnchanged(snap: OAuthSessionSnapshot): ConditionalDeleteOutcome {
    const { did } = snap;
    this.flush();
    if ((this.versions.get(did) ?? 0) !== snap.version) return 'superseded';
    const held = this.held.get(did);
    if (held !== undefined && held !== snap.held) return 'superseded';
    let outcome = 'absent' as ConditionalDeleteOutcome;
    this.deps.db.tx(() => {
      const current = this.storedCiphertext(did);
      // A held snapshot may have been flushed since (a new ciphertext of the same session).
      if (
        snap.held === undefined &&
        current !== null &&
        (snap.ciphertext === null || !sameBytes(current, snap.ciphertext))
      ) {
        outcome = 'superseded';
        return;
      }
      const deleted =
        current === null
          ? 0
          : this.deps.db.all<{ one: number }>(
              'DELETE FROM oauth_sessions WHERE did = ? AND ciphertext = ? RETURNING 1 AS one',
              did,
              blob(current),
            ).length;
      const droppedHeld = held !== undefined;
      if (deleted > 0 || droppedHeld) {
        outcome = 'deleted';
        this.deps.revocations.record({ kind: 'oauth_session', did });
      }
    });
    if (outcome === 'deleted') {
      this.held.delete(did);
      this.bump(did);
    }
    return outcome;
  }

  /**
   * When the DID's current session was last refreshed (stored), counting a
   * session held in memory by its set() time; null when the DID has none.
   * Keepalive checks it under the DID's lock so a session stored after the run
   * selected the DID (a re-sign-in) is never mistaken for the due one.
   */
  lastRefreshMs(did: string): number | null {
    const held = this.held.get(did);
    if (held !== undefined) return held.atMs;
    return this.info(did)?.last_refresh_ms ?? null;
  }

  /** Row metadata (no ciphertext), for keepalive, reconcile and adminStatus. */
  info(did: string): OAuthSessionRowInfo | null {
    return this.deps.db.one<OAuthSessionRowInfo>(
      'SELECT did, client_kid, generation, last_refresh_ms, status, created_at_ms, updated_at_ms FROM oauth_sessions WHERE did = ?',
      did,
    );
  }
}

// ---------------------------------------------------------------------------
// Clock-driven memory caches for the library (metadata, DPoP nonces)
// ---------------------------------------------------------------------------

/**
 * A small TTL cache on the injected clock, used for the library's
 * authorization-server and protected-resource metadata caches and its DPoP
 * nonce cache (whose defaults expire on the real monotonic clock).
 */
export class ClockTtlStore<V extends NonNullable<unknown> | null> {
  private readonly entries = new Map<string, { value: V; expiresAtMs: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number,
    private readonly max = 100,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (e === undefined) return undefined;
    if (this.clock.nowMs() >= e.expiresAtMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAtMs: this.clock.nowMs() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  del(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

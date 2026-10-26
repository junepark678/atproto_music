// Issued Last.fm applications: per-user `{api_key, shared_secret}` pairs
// (ADR 0005 §7.3 "Issued applications", §7.4, §13; N2-09).
//
// A user creates a pair in Settings (N3-10) for a client that lets them enter
// both. The api_key is 32 hex characters, the shape real Last.fm keys have;
// it identifies the app and is not a secret. The shared secret is 32 hex
// characters, returned once by `createLastfmApp` and stored **sealed** with
// the box (purpose `lastfm-app`, AAD `lastfm-app/<api_key>/<did>`), because
// the signature check (§7.4, N2-07) must recover it: with an issued key,
// `api_sig` is mandatory and verified. A sealed value copied to another row
// (another api_key or DID) fails to open.
//
// `deleteLastfmApp` journals `{kind: 'lastfm_app', id: <api_key>, did}`
// inside the deleting transaction, before it commits (ADR §14.5).

import type { LastfmAppRow } from '../app/rows';
import { type Box, lastfmAppAad } from '../crypto/box';
import { newLastfmApiKey, newLastfmSharedSecret } from '../crypto/tokens';
import type { Db } from '../do/db';
import { type CredentialDeps, CredentialError, normaliseLabel, requireAccount, toBlob } from './accounts';

export interface LastfmAppDeps extends CredentialDeps {
  box: Box;
}

export interface CreatedLastfmApp {
  apiKey: string;
  /** The shared secret: shown to the user once; stored only sealed. */
  sharedSecret: string;
  name: string;
  createdAtMs: number;
}

export interface LastfmAppInfo {
  apiKey: string;
  name: string;
  createdAtMs: number;
}

/** What a signature check needs of an issued key. */
export interface IssuedAppSecret {
  apiKey: string;
  did: string;
  name: string;
  /** The recovered shared secret. Never log or return it. */
  secret: string;
}

/** Attempts at a fresh api_key before giving up (a 128-bit collision never happens in practice). */
const MAX_KEY_ATTEMPTS = 4;

/** Create an issued app for a signed-in DID. The secret is in the result only. */
export function createLastfmApp(deps: LastfmAppDeps, input: { did: string; name: string }): CreatedLastfmApp {
  const name = normaliseLabel(input.name);
  if (name === null) throw new CredentialError('name_invalid', 'an issued app needs a name');
  return deps.db.tx(() => {
    requireAccount(deps.db, input.did);
    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
      const apiKey = newLastfmApiKey(deps.random);
      if (deps.db.one('SELECT 1 AS one FROM lastfm_apps WHERE api_key = ?', apiKey) !== null) continue;
      const sharedSecret = newLastfmSharedSecret(deps.random);
      const sealed = deps.box.seal('lastfm-app', sharedSecret, lastfmAppAad(apiKey, input.did));
      const now = deps.clock.nowMs();
      deps.db.run(
        'INSERT INTO lastfm_apps (api_key, did, name, secret_ciphertext, key_id, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
        apiKey,
        input.did,
        name,
        toBlob(sealed),
        deps.box.currentKeyId,
        now,
      );
      return { apiKey, sharedSecret, name, createdAtMs: now };
    }
    throw new CredentialError('id_exhausted', 'could not allocate a fresh api_key');
  });
}

/** True when `apiKey` is an issued app key (the §7.4 policy makes its signature mandatory). */
export function isIssuedApiKey(db: Db, apiKey: string): boolean {
  return db.one('SELECT 1 AS one FROM lastfm_apps WHERE api_key = ?', apiKey) !== null;
}

/**
 * The issued app `apiKey` with its secret opened for a signature check, or
 * null when no such app exists. A row whose sealed secret does not open (a
 * removed key, tampering, a copied value) throws the BoxError: the caller
 * must refuse the request rather than treat the key as unknown, because an
 * unknown key's signature is not verified (§7.4).
 */
export function issuedAppSecret(deps: { db: Db; box: Box }, apiKey: string): IssuedAppSecret | null {
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 64) return null;
  const row = deps.db.one<Pick<LastfmAppRow, 'api_key' | 'did' | 'name' | 'secret_ciphertext'>>(
    'SELECT api_key, did, name, secret_ciphertext FROM lastfm_apps WHERE api_key = ?',
    apiKey,
  );
  if (row === null) return null;
  const secret = deps.box.openText(
    'lastfm-app',
    new Uint8Array(row.secret_ciphertext),
    lastfmAppAad(row.api_key, row.did),
  );
  return { apiKey: row.api_key, did: row.did, name: row.name, secret };
}

/** The DID's issued apps, newest first, without secrets. */
export function listLastfmApps(db: Db, did: string): LastfmAppInfo[] {
  return db
    .all<Pick<LastfmAppRow, 'api_key' | 'name' | 'created_at_ms'>>(
      'SELECT api_key, name, created_at_ms FROM lastfm_apps WHERE did = ? ORDER BY created_at_ms DESC, api_key',
      did,
    )
    .map((r) => ({ apiKey: r.api_key, name: r.name, createdAtMs: r.created_at_ms }));
}

/** The app's display name, for the approval page and session `client_name`; null when not issued. */
export function issuedAppName(db: Db, apiKey: string): string | null {
  return db.one<{ name: string }>('SELECT name FROM lastfm_apps WHERE api_key = ?', apiKey)?.name ?? null;
}

/** Delete issued app `apiKey` of `did`, journaling the revocation before the delete commits. False when there is none. */
export function deleteLastfmApp(
  deps: Pick<CredentialDeps, 'db' | 'revocations'>,
  did: string,
  apiKey: string,
): boolean {
  return deps.db.tx(() => {
    const gone = deps.db.all<{ api_key: string }>(
      'DELETE FROM lastfm_apps WHERE api_key = ? AND did = ? RETURNING api_key',
      apiKey,
      did,
    );
    if (gone.length === 0) return false;
    deps.revocations.record({ kind: 'lastfm_app', id: apiKey, did });
    return true;
  });
}

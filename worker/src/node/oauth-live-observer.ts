// Host-private observation for the release-bound Node OAuth acceptance gate.
// This module is mounted only on the protected Unix admin socket. It never
// returns access tokens, refresh tokens, cookies, or DPoP key material.

import type { Clock, Random } from '@atmusic/core/deps';
import { followRkey, newTid } from '@atmusic/core/record-key';
import type { OAuthSession } from '@atproto/oauth-client-node';
import { type NodeSavedSession, OAuthResponseError } from '@atproto/oauth-client-node';
import type { OAuthService } from '../bff/oauth-client';

const CAPTURE_TTL_MS = 10 * 60_000;
const NSID = '[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+';
const SAFE_SCOPE_TOKEN = new RegExp(
  `^(?:atproto|transition:[a-zA-Z0-9._:-]{1,128}|repo:${NSID}(?:\\?action=(?:create|update|delete)(?:&action=(?:create|update|delete))*)?|repo\\?(?:collection=${NSID})(?:&collection=${NSID})*(?:&action=(?:create|update|delete))*)$`,
);

type Capture = {
  saved: NodeSavedSession;
  server: OAuthSession['server'];
  expiresAt: number;
};

export interface OAuthLiveObserver {
  capture(did: string): Promise<Record<string, unknown>>;
  exerciseCrud(did: string, followSubject: string): Promise<Record<string, unknown>>;
  verifyAfterSignOut(did: string): Promise<Record<string, unknown>>;
}

type RecordValue = Record<string, unknown>;

type RecordIntent = {
  collection: string;
  rkey: string;
  initial: RecordValue;
  updated: RecordValue;
  marker: string;
};

function asRecord(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RecordValue) : null;
}

export function createOAuthLiveObserver(options: {
  oauth(): OAuthService | null;
  nowMs(): number;
  prefix: string | null;
  clock: Clock;
  random: Random;
}): OAuthLiveObserver {
  const captures = new Map<string, Capture>();

  function service(): OAuthService {
    const oauth = options.oauth();
    if (!oauth) throw new Error('OAuth service is not composed');
    return oauth;
  }

  function expired(capture: Capture): boolean {
    return capture.expiresAt <= options.nowMs();
  }

  async function xrpc(
    session: OAuthSession,
    method: string,
    body?: RecordValue,
  ): Promise<{ response: Response; json: RecordValue | null }> {
    const response = await session.fetchHandler(`/xrpc/${method}`, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    let json: RecordValue | null = null;
    try {
      json = asRecord(await response.json());
    } catch {
      // Only status and validated fields enter evidence.
    }
    return { response, json };
  }

  async function readRecord(
    session: OAuthSession,
    did: string,
    intent: RecordIntent,
  ): Promise<{ status: number; error: string | null; value: RecordValue | null; cid: string | null }> {
    const query = new URLSearchParams({ repo: did, collection: intent.collection, rkey: intent.rkey });
    const { response, json } = await xrpc(session, `com.atproto.repo.getRecord?${query}`);
    return {
      status: response.status,
      error: typeof json?.error === 'string' ? json.error : null,
      value: json ? asRecord(json.value) : null,
      cid: typeof json?.cid === 'string' ? json.cid : null,
    };
  }

  function hasMarker(intent: RecordIntent, record: RecordValue | null): boolean {
    if (record === null) return false;
    if (intent.collection.endsWith('.scrobble') || intent.collection.endsWith('.love')) {
      return (
        record.artist === intent.marker &&
        (record.track === intent.marker || record.track === `${intent.marker}-updated`)
      );
    }
    if (intent.collection.endsWith('.follow')) {
      return (
        record.subject === intent.initial.subject &&
        (record.createdAt === intent.initial.createdAt || record.createdAt === intent.updated.createdAt)
      );
    }
    if (intent.collection.endsWith('.settings')) {
      return (
        (record.indexing === intent.initial.indexing || record.indexing === intent.updated.indexing) &&
        (record.createdAt === intent.initial.createdAt || record.createdAt === intent.updated.createdAt)
      );
    }
    return record.createdAt === intent.initial.createdAt || record.createdAt === intent.updated.createdAt;
  }

  async function deleteOwnedRecord(session: OAuthSession, did: string, intent: RecordIntent): Promise<boolean> {
    const current = await readRecord(session, did, intent);
    if (current.status === 400 && current.error === 'RecordNotFound' && current.value === null) return true;
    if (current.status !== 200 || current.cid === null || !hasMarker(intent, current.value)) return false;
    const deleted = await xrpc(session, 'com.atproto.repo.deleteRecord', {
      repo: did,
      collection: intent.collection,
      rkey: intent.rkey,
      swapRecord: current.cid,
    });
    if (deleted.response.status !== 200) return false;
    const absence = await readRecord(session, did, intent);
    return absence.status === 400 && absence.error === 'RecordNotFound' && absence.value === null;
  }

  async function runCrud(did: string, followSubject: string): Promise<Record<string, unknown>> {
    if (!options.prefix) return { status: 'prefix_unavailable' };
    const oauth = service();
    const saved = oauth.sessionStore.snapshot(did).session;
    const capture = captures.get(did);
    if (!saved || !capture || expired(capture) || saved.tokenSet.sub !== did)
      return { status: 'capture_missing_or_expired' };
    const session = await oauth.restore(did, false);
    const prefix = options.prefix;
    const now = new Date(options.nowMs()).toISOString();
    const later = new Date(options.nowMs() + 1).toISOString();
    const marker = `atmusic-oauth-${newTid(options.clock, options.random)}`;
    const specs: RecordIntent[] = [
      {
        collection: `${prefix}.scrobble`,
        rkey: newTid(options.clock, options.random),
        marker,
        initial: { $type: `${prefix}.scrobble`, artist: marker, track: marker, listenedAt: now, createdAt: now },
        updated: {
          $type: `${prefix}.scrobble`,
          artist: marker,
          track: `${marker}-updated`,
          listenedAt: now,
          createdAt: later,
        },
      },
      {
        collection: `${prefix}.follow`,
        rkey: await followRkey(followSubject),
        marker,
        initial: { $type: `${prefix}.follow`, subject: followSubject, createdAt: now },
        updated: { $type: `${prefix}.follow`, subject: followSubject, createdAt: later },
      },
      {
        collection: `${prefix}.settings`,
        rkey: 'self',
        marker,
        initial: { $type: `${prefix}.settings`, indexing: 'enabled', createdAt: now },
        updated: { $type: `${prefix}.settings`, indexing: 'disabled', createdAt: later },
      },
      {
        collection: `${prefix}.love`,
        rkey: newTid(options.clock, options.random),
        marker,
        initial: { $type: `${prefix}.love`, artist: marker, track: marker, createdAt: now },
        updated: { $type: `${prefix}.love`, artist: marker, track: `${marker}-updated`, createdAt: later },
      },
    ];
    const output: Record<string, unknown>[] = [];
    const owned: RecordIntent[] = [];
    let failed = false;

    for (const intent of specs) {
      let createdCid: string | null = null;
      let updatedCid: string | null = null;
      let createdStatus = 0;
      let updatedStatus = 0;
      let deleteStatus = 0;
      let verified = false;
      try {
        const before = await readRecord(session, did, intent);
        if (before.status !== 400 || before.error !== 'RecordNotFound' || before.value !== null) {
          failed = true;
          output.push({
            collection: intent.collection,
            create: { status: before.status, cid: 'none' },
            update: { status: 0, cid: 'none' },
            delete: { status: 0 },
            verified: false,
          });
          continue;
        }
        // The rkey was absent and this intent carries a unique marker. If the
        // request loses its response after a server-side commit, cleanup can
        // recover ownership from that record before conditionally deleting it.
        owned.push(intent);
        const created = await xrpc(session, 'com.atproto.repo.createRecord', {
          repo: did,
          collection: intent.collection,
          rkey: intent.rkey,
          record: intent.initial,
        });
        createdStatus = created.response.status;
        createdCid = typeof created.json?.cid === 'string' ? created.json.cid : null;
        if (createdStatus !== 200) throw new Error('create');
        if (createdCid === null) throw new Error('create');
        const createdRead = await readRecord(session, did, intent);
        if (createdRead.status !== 200 || createdRead.cid !== createdCid || !hasMarker(intent, createdRead.value))
          throw new Error('create_verify');

        const updated = await xrpc(session, 'com.atproto.repo.putRecord', {
          repo: did,
          collection: intent.collection,
          rkey: intent.rkey,
          record: intent.updated,
          swapRecord: createdCid,
        });
        updatedStatus = updated.response.status;
        updatedCid = typeof updated.json?.cid === 'string' ? updated.json.cid : null;
        if (updatedStatus !== 200 || updatedCid === null || updatedCid === createdCid) throw new Error('update');
        const updatedRead = await readRecord(session, did, intent);
        if (updatedRead.status !== 200 || updatedRead.cid !== updatedCid || !hasMarker(intent, updatedRead.value))
          throw new Error('update_verify');

        const deleted = await xrpc(session, 'com.atproto.repo.deleteRecord', {
          repo: did,
          collection: intent.collection,
          rkey: intent.rkey,
          swapRecord: updatedCid,
        });
        deleteStatus = deleted.response.status;
        if (deleteStatus !== 200) throw new Error('delete');
        const absent = await readRecord(session, did, intent);
        if (absent.status !== 400 || absent.error !== 'RecordNotFound' || absent.value !== null)
          throw new Error('delete_verify');
        verified = true;
      } catch {
        failed = true;
      }
      output.push({
        collection: intent.collection,
        create: { status: createdStatus, cid: createdCid ?? 'none' },
        update: { status: updatedStatus, cid: updatedCid ?? 'none' },
        delete: { status: deleteStatus },
        verified,
      });
    }

    let cleanupVerified = true;
    for (const intent of owned) {
      // Already-deleted records count as clean; partially completed operations
      // are removed only when their current content carries this run's marker.
      const current = await readRecord(session, did, intent).catch(() => null);
      if (current?.status === 400 && current.error === 'RecordNotFound' && current.value === null) continue;
      const cleaned = await deleteOwnedRecord(session, did, intent).catch(() => false);
      if (!cleaned) cleanupVerified = false;
    }
    return { status: failed ? 'failed' : 'passed', crud: output, cleanupVerified };
  }

  return {
    async capture(did) {
      try {
        const oauth = service();
        for (const [key, value] of captures) if (expired(value)) captures.delete(key);
        const before = oauth.sessionStore.snapshot(did);
        const saved = before.session;
        if (!saved || saved.tokenSet.sub !== did) {
          captures.delete(did);
          return { status: 'no_session' };
        }
        if (!saved.tokenSet.refresh_token) {
          captures.delete(did);
          return { status: 'no_refresh_token' };
        }
        if (!captures.has(did) && captures.size >= 2) return { status: 'capture_capacity' };

        const session = await oauth.restore(did, false);
        const after = oauth.sessionStore.snapshot(did);
        if (
          after.session === undefined ||
          after.version !== before.version ||
          after.session.tokenSet.refresh_token !== saved.tokenSet.refresh_token
        ) {
          captures.delete(did);
          return { status: 'session_changed' };
        }
        const tokenInfo = await session.getTokenInfo(false);
        if (tokenInfo.sub !== did || tokenInfo.iss !== saved.tokenSet.iss) {
          captures.delete(did);
          return { status: 'session_binding_mismatch' };
        }
        let issuerHost: string;
        try {
          const issuer = new URL(tokenInfo.iss);
          if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.port) {
            captures.delete(did);
            return { status: 'issuer_invalid' };
          }
          issuerHost = issuer.hostname.toLowerCase();
        } catch {
          captures.delete(did);
          return { status: 'issuer_invalid' };
        }
        const scopeTokens = tokenInfo.scope.split(/\s+/).filter(Boolean);
        if (
          tokenInfo.scope.length > 4096 ||
          scopeTokens.length === 0 ||
          scopeTokens.length > 128 ||
          scopeTokens.some((token) => !SAFE_SCOPE_TOKEN.test(token))
        ) {
          captures.delete(did);
          return { status: 'scope_unrecognized' };
        }

        captures.set(did, {
          saved,
          server: session.server,
          expiresAt: options.nowMs() + CAPTURE_TTL_MS,
        });

        return {
          status: 'captured',
          tokenSub: tokenInfo.sub,
          issuerHost,
          grantedScope: tokenInfo.scope,
          sealedSessionObserved: true,
          clientAuthMethod: saved.authMethod.method,
          dpopBound: saved.tokenSet.token_type === 'DPoP',
          refreshTokenPresent: true,
        };
      } catch {
        captures.delete(did);
        return { status: 'capture_failed' };
      }
    },

    async exerciseCrud(did, followSubject) {
      try {
        if (did === followSubject) return { status: 'invalid_follow_subject' };
        return await runCrud(did, followSubject);
      } catch {
        return { status: 'crud_failed', crud: [], cleanupVerified: false };
      }
    },

    async verifyAfterSignOut(did) {
      const capture = captures.get(did);
      captures.delete(did);
      if (!capture || expired(capture)) {
        return {
          status: 'capture_missing_or_expired',
          localSessionAbsent: false,
          refreshRejected: false,
          refreshError: 'not_observed',
        };
      }
      let localSessionAbsent = false;
      try {
        localSessionAbsent = !service().sessionStore.has(did);
      } catch {
        return {
          status: 'local_session_check_failed',
          localSessionAbsent: false,
          refreshRejected: false,
          refreshError: 'not_observed',
        };
      }
      if (!localSessionAbsent) {
        return {
          status: 'local_session_still_present',
          localSessionAbsent: false,
          refreshRejected: false,
          refreshError: 'not_observed',
        };
      }
      try {
        await capture.server.refresh(capture.saved.tokenSet);
        return {
          status: 'refresh_still_valid',
          localSessionAbsent: true,
          refreshRejected: false,
          refreshError: 'none',
        };
      } catch (error) {
        if (error instanceof OAuthResponseError && error.status === 400 && error.error === 'invalid_grant') {
          return { status: 'revoked', localSessionAbsent: true, refreshRejected: true, refreshError: 'invalid_grant' };
        }
        // Do not expose an exception string, response body, endpoint, or token.
        return { status: 'refresh_error', localSessionAbsent: true, refreshRejected: false, refreshError: 'other' };
      }
    },
  };
}

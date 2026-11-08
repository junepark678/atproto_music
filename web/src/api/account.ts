import type { Did } from '@atmusic/core/api-types';
import { sessionClient, sessionFetch } from '../session/client';

export type Link = {
  id: string;
  service: 'lastfm' | 'listenbrainz';
  remoteUser: string;
  forwardScrobbles: boolean;
  forwardNowPlaying: boolean;
  status: 'active' | 'revoked' | 'error';
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sync?: {
    backfill: { state: 'pending' | 'running' | 'done' | 'skipped'; done: number; total: number };
    pullEnabled: boolean;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    lastError?: string | null;
    lastPulledAt?: string;
    queued: number;
    failed: number;
    /** Exposed by the continuous-pull implementation when its OAuth session has expired. */
    needsReauth?: boolean;
  };
};
export type ImportJob = {
  id: string;
  source: 'lastfm_api' | 'lastfm_json' | 'listenbrainz_api' | 'listenbrainz_zip';
  remoteUser: string | null;
  state: 'waiting_index' | 'fetching' | 'writing' | 'paused' | 'done' | 'failed' | 'cancelled';
  fetched: number;
  staged: number;
  duplicates: number;
  invalid: number;
  written: number;
  failed: number;
  etaSeconds: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
export type CredentialMeta = { id: string; label: string; createdAt: string; lastUsedAt: string | null };
export type Credentials = {
  appPasswords: CredentialMeta[];
  listenbrainzTokens: CredentialMeta[];
  lastfmApps: { apiKey: string; name: string; createdAt: string }[];
  lastfmSessions: { id: string; apiKey: string; clientName: string; createdAt: string; lastUsedAt: string | null }[];
};
export type CreatedSecret =
  | { id: string; label: string; password: string; createdAt: string }
  | { id: string; label: string; token: string; createdAt: string };
export type CreatedLastfmApp = { apiKey: string; sharedSecret: string; name: string; createdAt: string };
async function get<T>(path: string): Promise<T> {
  const r = await sessionFetch(path, { method: 'GET', cache: 'no-store' });
  if (!r.ok) throw new Error(`${path} (${r.status})`);
  return r.json() as Promise<T>;
}
async function mutate<T = void>(path: string, method: string, expectedDid: Did, body?: unknown): Promise<T> {
  const r = await sessionClient().mutate(
    path,
    {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    },
    expectedDid,
  );
  if (!r.ok) throw new Error(`${path} (${r.status})`);
  return (r.status === 204 ? undefined : r.json()) as Promise<T>;
}
const segment = (s: string) => encodeURIComponent(s);
export const listLinks = () => get<{ items: Link[] }>('/api/v1/links');
export const patchLink = (
  id: string,
  patch: Partial<Pick<Link, 'forwardScrobbles' | 'forwardNowPlaying'>> & { pullEnabled?: boolean },
  expectedDid: Did,
) => mutate<Link>(`/api/v1/links/${segment(id)}`, 'PATCH', expectedDid, patch);
export const startLastfmLink = (expectedDid: Did) =>
  mutate<{ authorizeUrl: string }>('/api/v1/links/lastfm/start', 'POST', expectedDid);
export const addListenbrainzLink = (token: string, expectedDid: Did) =>
  mutate<Link>('/api/v1/links/listenbrainz', 'POST', expectedDid, { token });
export const unlink = (id: string, expectedDid: Did) => mutate(`/api/v1/links/${segment(id)}`, 'DELETE', expectedDid);
export const startImport = (source: 'lastfm' | 'listenbrainz', username: string, expectedDid: Did) =>
  mutate<ImportJob>('/api/v1/imports', 'POST', expectedDid, { source, username });
export const listImports = () => get<{ items: ImportJob[] }>('/api/v1/imports');
export const cancelImport = (id: string, expectedDid: Did) =>
  mutate<ImportJob>(`/api/v1/imports/${segment(id)}/cancel`, 'POST', expectedDid);
export const resumeImport = (id: string, expectedDid: Did) =>
  mutate<ImportJob>(`/api/v1/imports/${segment(id)}/resume`, 'POST', expectedDid);
export async function uploadImport(
  source: 'lastfm_json' | 'listenbrainz_zip',
  body: BodyInit,
  expectedDid: Did,
): Promise<ImportJob> {
  const path = `/api/v1/imports/upload?source=${encodeURIComponent(source)}`;
  const r = await sessionClient().mutate(path, { method: 'POST', body }, expectedDid);
  if (!r.ok) throw new Error(`${path} (${r.status})`);
  return r.json() as Promise<ImportJob>;
}
export const listCredentials = () => get<Credentials>('/api/v1/account/credentials');
export const getAccount = () => get<{ shareNowPlaying: boolean }>('/api/v1/account');
export const setShareNowPlaying = (shareNowPlaying: boolean, expectedDid: Did) =>
  mutate<{ shareNowPlaying: boolean }>('/api/v1/account', 'PATCH', expectedDid, { shareNowPlaying });
export const createAppPassword = (label: string, expectedDid: Did) =>
  mutate<Extract<CreatedSecret, { password: string }>>('/api/v1/account/app-passwords', 'POST', expectedDid, { label });
export const revokeAppPassword = (id: string, expectedDid: Did) =>
  mutate(`/api/v1/account/app-passwords/${segment(id)}`, 'DELETE', expectedDid);
export const createListenbrainzToken = (label: string, expectedDid: Did) =>
  mutate<Extract<CreatedSecret, { token: string }>>('/api/v1/account/listenbrainz-tokens', 'POST', expectedDid, {
    label,
  });
export const revokeListenbrainzToken = (id: string, expectedDid: Did) =>
  mutate(`/api/v1/account/listenbrainz-tokens/${segment(id)}`, 'DELETE', expectedDid);
export const createLastfmApp = (name: string, expectedDid: Did) =>
  mutate<CreatedLastfmApp>('/api/v1/account/lastfm-apps', 'POST', expectedDid, { name });
export const revokeLastfmSession = (id: string, expectedDid: Did) =>
  mutate(`/api/v1/account/lastfm-sessions/${segment(id)}`, 'DELETE', expectedDid);
export const approveLastfmAuthorization = (apiKey: string, expectedDid: Did, token?: string) =>
  mutate<{ token: string }>(
    '/api/v1/lastfm/authorize',
    'POST',
    expectedDid,
    token === undefined ? { apiKey } : { apiKey, token },
  );

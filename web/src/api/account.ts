import { sessionClient, sessionFetch } from '../session/client';

export type Link = { id: string; service: 'lastfm' | 'listenbrainz'; remoteUser: string; forwardScrobbles: boolean; forwardNowPlaying: boolean; status: 'active' | 'revoked' | 'error'; lastError: string | null; createdAt: string; updatedAt: string };
export type ImportJob = { id: string; source: 'lastfm_api' | 'lastfm_json' | 'listenbrainz_api' | 'listenbrainz_zip'; remoteUser: string | null; state: 'waiting_index' | 'fetching' | 'writing' | 'paused' | 'done' | 'failed' | 'cancelled'; fetched: number; staged: number; duplicates: number; invalid: number; written: number; failed: number; etaSeconds: number | null; error: string | null; createdAt: string; updatedAt: string };
export type CredentialMeta = { id: string; label: string; createdAt: string; lastUsedAt: string | null };
export type Credentials = { appPasswords: CredentialMeta[]; listenbrainzTokens: CredentialMeta[]; lastfmApps: { apiKey: string; name: string; createdAt: string }[]; lastfmSessions: { id: string; apiKey: string; clientName: string; createdAt: string; lastUsedAt: string | null }[] };
export type CreatedSecret = { id: string; label: string; password: string; createdAt: string } | { id: string; label: string; token: string; createdAt: string };
export type CreatedLastfmApp = { apiKey: string; sharedSecret: string; name: string; createdAt: string };
async function get<T>(path: string): Promise<T> { const r = await sessionFetch(path, { method: 'GET', cache: 'no-store' }); if (!r.ok) throw new Error(`${path} (${r.status})`); return r.json() as Promise<T>; }
async function mutate<T = void>(path: string, method: string, body?: unknown): Promise<T> { const r = await sessionClient().mutate(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }); if (!r.ok) throw new Error(`${path} (${r.status})`); return (r.status === 204 ? undefined : r.json()) as Promise<T>; }
const segment = (s: string) => encodeURIComponent(s);
export const listLinks = () => get<{ items: Link[] }>('/api/v1/links');
export const startLastfmLink = () => mutate<{ authorizeUrl: string }>('/api/v1/links/lastfm/start', 'POST');
export const addListenbrainzLink = (token: string) => mutate<Link>('/api/v1/links/listenbrainz', 'POST', { token });
export const unlink = (id: string) => mutate(`/api/v1/links/${segment(id)}`, 'DELETE');
export const startImport = (source: 'lastfm' | 'listenbrainz', username: string) => mutate<ImportJob>('/api/v1/imports', 'POST', { source, username });
export const listImports = () => get<{ items: ImportJob[] }>('/api/v1/imports');
export const cancelImport = (id: string) => mutate<ImportJob>(`/api/v1/imports/${segment(id)}/cancel`, 'POST');
export const resumeImport = (id: string) => mutate<ImportJob>(`/api/v1/imports/${segment(id)}/resume`, 'POST');
export async function uploadImport(source: 'lastfm_json' | 'listenbrainz_zip', body: BodyInit): Promise<ImportJob> { const path = `/api/v1/imports/upload?source=${encodeURIComponent(source)}`; const r = await sessionClient().mutate(path, { method: 'POST', body }); if (!r.ok) throw new Error(`${path} (${r.status})`); return r.json() as Promise<ImportJob>; }
export const listCredentials = () => get<Credentials>('/api/v1/account/credentials');
export const createAppPassword = (label: string) => mutate<Extract<CreatedSecret, { password: string }>>('/api/v1/account/app-passwords', 'POST', { label });
export const revokeAppPassword = (id: string) => mutate(`/api/v1/account/app-passwords/${segment(id)}`, 'DELETE');
export const createListenbrainzToken = (label: string) => mutate<Extract<CreatedSecret, { token: string }>>('/api/v1/account/listenbrainz-tokens', 'POST', { label });
export const revokeListenbrainzToken = (id: string) => mutate(`/api/v1/account/listenbrainz-tokens/${segment(id)}`, 'DELETE');
export const createLastfmApp = (name: string) => mutate<CreatedLastfmApp>('/api/v1/account/lastfm-apps', 'POST', { name });
export const revokeLastfmSession = (id: string) => mutate(`/api/v1/account/lastfm-sessions/${segment(id)}`, 'DELETE');
export const approveLastfmAuthorization = (apiKey: string, token?: string) => mutate<{ token: string }>('/api/v1/lastfm/authorize', 'POST', token === undefined ? { apiKey } : { apiKey, token });

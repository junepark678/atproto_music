import { sessionClient } from '../session/client';

export interface ServerOperation {
  id: string;
  kind: 'scrobble.create' | 'scrobble.delete' | 'follow.put' | 'follow.delete' | 'settings.put' | 'love.put' | 'love.delete';
  origin: 'web' | 'lastfm' | 'listenbrainz' | 'import';
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  attempts: number;
  uri?: string;
  cid?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Accepted { operation: ServerOperation }

export class WriteError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfter: string | null) {
    super(code); this.name = 'WriteError';
  }
}

export interface WriteIntent { readonly key: string }
const storageKey = 'atmusic:write-intent:';
export function createWriteIntent(id = crypto.randomUUID()): WriteIntent {
  const key = sessionStorage.getItem(`${storageKey}${id}`) ?? crypto.randomUUID();
  sessionStorage.setItem(`${storageKey}${id}`, key);
  return { key };
}

async function send(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown, intent = createWriteIntent()): Promise<Accepted> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'Idempotency-Key': intent.key };
  const response = await sessionClient().mutate(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    let code = 'request_failed';
    try { code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? code; } catch { /* use status fallback */ }
    throw new WriteError(response.status, code, response.headers.get('retry-after'));
  }
  return await response.json() as Accepted;
}

export const writes = {
  scrobble: (body: unknown, intent?: WriteIntent) => send('/api/v1/scrobbles', 'POST', body, intent),
  deleteScrobble: (id: string, intent?: WriteIntent) => send(`/api/v1/scrobbles/${encodeURIComponent(id)}`, 'DELETE', undefined, intent),
  follow: (did: string, intent?: WriteIntent) => send(`/api/v1/follows/${encodeURIComponent(did)}`, 'PUT', {}, intent),
  unfollow: (did: string, intent?: WriteIntent) => send(`/api/v1/follows/${encodeURIComponent(did)}`, 'DELETE', undefined, intent),
  indexing: (indexing: 'enabled' | 'disabled', intent?: WriteIntent) => send('/api/v1/account/indexing', 'PUT', { indexing }, intent),
};

export async function getOperation(id: string, signal?: AbortSignal): Promise<ServerOperation> {
  const response = await fetch(`/api/v1/operations/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Operation request failed (${response.status})`);
  return await response.json() as ServerOperation;
}

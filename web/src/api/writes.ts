import { sessionClient, sessionFetch } from '../session/client';

export interface ServerOperation {
  id: string;
  kind:
    | 'scrobble.create'
    | 'scrobble.delete'
    | 'follow.put'
    | 'follow.delete'
    | 'settings.put'
    | 'love.put'
    | 'love.delete';
  origin: 'web' | 'lastfm' | 'listenbrainz' | 'import';
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  attempts: number;
  uri?: string;
  cid?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Accepted {
  operation: ServerOperation;
}

const kinds = new Set([
  'scrobble.create',
  'scrobble.delete',
  'follow.put',
  'follow.delete',
  'settings.put',
  'love.put',
  'love.delete',
]);
const origins = new Set(['web', 'lastfm', 'listenbrainz', 'import']);
const states = new Set(['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled']);
function decodeOperation(value: unknown): ServerOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operation response');
  const op = value as Record<string, unknown>;
  const keys = new Set(['id', 'kind', 'origin', 'state', 'attempts', 'uri', 'cid', 'error', 'createdAt', 'updatedAt']);
  if (
    Object.keys(op).some((key) => !keys.has(key)) ||
    typeof op.id !== 'string' ||
    !kinds.has(String(op.kind)) ||
    !origins.has(String(op.origin)) ||
    !states.has(String(op.state)) ||
    !Number.isInteger(op.attempts) ||
    typeof op.createdAt !== 'string' ||
    typeof op.updatedAt !== 'string'
  )
    throw new Error('Invalid operation response');
  for (const key of ['uri', 'cid', 'error'])
    if (op[key] !== undefined && typeof op[key] !== 'string') throw new Error('Invalid operation response');
  return op as unknown as ServerOperation;
}
function decodeAccepted(value: unknown): Accepted {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('operation' in value)
  )
    throw new Error('Invalid accepted response');
  return { operation: decodeOperation((value as { operation: unknown }).operation) };
}

export class WriteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter: string | null,
  ) {
    super(code);
    this.name = 'WriteError';
  }
}

export interface WriteIntent {
  readonly key: string;
}
const storageKey = 'atmusic:write-intent:';
export function createWriteIntent(id: string = crypto.randomUUID()): WriteIntent {
  const slot = `${storageKey}${id}`;
  const key = sessionStorage.getItem(slot) ?? crypto.randomUUID();
  sessionStorage.setItem(slot, key);
  return { key };
}

async function send(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
  intent = createWriteIntent(),
): Promise<Accepted> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'Idempotency-Key': intent.key };
  const response = await sessionClient().mutate(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let code = 'request_failed';
    try {
      code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? code;
    } catch {
      /* use status fallback */
    }
    if (response.status === 409) removeIntent(intent);
    throw new WriteError(response.status, code, response.headers.get('retry-after'));
  }
  removeIntent(intent);
  return decodeAccepted(await response.json());
}

function removeIntent(intent: WriteIntent): void {
  for (let index = 0; index < sessionStorage.length; index++) {
    const slot = sessionStorage.key(index);
    if (slot?.startsWith(storageKey) && sessionStorage.getItem(slot) === intent.key) {
      sessionStorage.removeItem(slot);
      break;
    }
  }
}

export const writes = {
  scrobble: (body: unknown, intent?: WriteIntent) => send('/api/v1/scrobbles', 'POST', body, intent),
  deleteScrobble: (id: string, intent = createWriteIntent(`delete:${encodeURIComponent(id)}`)) =>
    send(`/api/v1/scrobbles/${encodeURIComponent(id)}`, 'DELETE', undefined, intent),
  follow: (did: string, intent = createWriteIntent(`follow:${did}`)) =>
    send(`/api/v1/follows/${encodeURIComponent(did)}`, 'PUT', undefined, intent),
  unfollow: (did: string, intent = createWriteIntent(`unfollow:${did}`)) =>
    send(`/api/v1/follows/${encodeURIComponent(did)}`, 'DELETE', undefined, intent),
  indexing: (indexing: 'enabled' | 'disabled', intent = createWriteIntent(`indexing:${indexing}`)) =>
    send('/api/v1/account/indexing', 'PUT', { indexing }, intent),
};

export async function getOperation(id: string, signal?: AbortSignal): Promise<ServerOperation> {
  const response = await sessionFetch(`/api/v1/operations/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error(`Operation request failed (${response.status})`);
  return decodeOperation(await response.json());
}

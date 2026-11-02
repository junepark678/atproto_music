import type { Did } from '@atmusic/core/api-types';
import { createWriteIntent, getOperation, type ServerOperation, type WriteIntent, writes } from '../api/writes';
import type { OutboxOperation } from '../outbox/overlay';
import type { Session } from '../session/client';
import { sessionFetch } from '../session/client';

type Listener = () => void;
function localKind(kind: ServerOperation['kind']): OutboxOperation['kind'] {
  return (
    {
      'scrobble.create': 'scrobble_create',
      'scrobble.delete': 'scrobble_delete',
      'follow.put': 'follow_create',
      'follow.delete': 'follow_delete',
      'settings.put': 'settings_put',
      'love.put': 'settings_put',
      'love.delete': 'settings_delete',
    } as const
  )[kind] as OutboxOperation['kind'];
}

export class OutboxService {
  readonly did: Did;
  readonly prefix: string;
  readonly session: Session;
  #rows: OutboxOperation[] = [];
  #listeners = new Set<Listener>();
  #controllers = new Set<AbortController>();
  #sequence = 0;
  #stopped = false;
  #pendingScrobble: { body: string; intent: WriteIntent } | null = null;

  constructor(session: Session, prefix: string) {
    this.session = session;
    this.did = session.did;
    this.prefix = prefix;
    try {
      const saved = sessionStorage.getItem(this.#storageKey);
      if (saved) {
        const rows = JSON.parse(saved) as OutboxOperation[];
        if (Array.isArray(rows)) {
          this.#rows = rows.filter((row) => row.did === this.did);
          this.#sequence = this.#rows.reduce((max, row) => Math.max(max, row.seq), 0);
        }
      }
    } catch {
      /* browser storage is an optimization; server operation state remains authoritative */
    }
  }
  async list(): Promise<OutboxOperation[]> {
    return [...this.#rows].sort((a, b) => a.seq - b.seq);
  }
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  async scrobble(
    input: Record<string, unknown>,
  ): Promise<{ ok: true; op: OutboxOperation } | { ok: false; reason: { field: string; message: string } }> {
    const body = JSON.stringify(input);
    if (this.#pendingScrobble?.body !== body) this.#pendingScrobble = { body, intent: createWriteIntent() };
    const intent = this.#pendingScrobble.intent;
    const accepted = await writes.scrobble(input, intent);
    this.#pendingScrobble = null;
    const op = this.#add(accepted.operation, {
      artist: input.artist,
      track: input.track,
      album: input.album,
      ...input,
    });
    return { ok: true, op };
  }
  async deleteScrobble(uri: string): Promise<OutboxOperation> {
    const accepted = await writes.deleteScrobble(uri);
    return this.#add(accepted.operation);
  }
  async follow(subject: Did): Promise<OutboxOperation> {
    const accepted = await writes.follow(subject);
    return this.#add(accepted.operation, undefined, subject);
  }
  async unfollow(subject: Did): Promise<OutboxOperation> {
    const accepted = await writes.unfollow(subject);
    return this.#add(accepted.operation, undefined, subject);
  }
  async disconnect(): Promise<OutboxOperation> {
    const accepted = await writes.indexing('disabled');
    return this.#add(accepted.operation, { indexing: 'disabled' });
  }
  async reconnect(): Promise<OutboxOperation> {
    const accepted = await writes.indexing('enabled');
    return this.#add(accepted.operation, { indexing: 'enabled' });
  }

  async refresh(): Promise<void> {
    if (this.#stopped) return;
    const pending = this.#rows.filter(
      (row) => row.state === 'queued' || row.state === 'running' || row.state === 'published',
    );
    await Promise.all(
      pending.map(async (row) => {
        const controller = new AbortController();
        this.#controllers.add(controller);
        try {
          const server = await getOperation(row.id, controller.signal);
          if (server.state === 'failed' || server.state === 'blocked' || server.state === 'cancelled') {
            row.state = 'failed';
            row.failureCode = server.error ?? server.state;
          } else if (server.state === 'succeeded') {
            row.state = 'published';
            if (server.uri) row.uri = server.uri;
            if (server.uri) {
              try {
                const status = await sessionFetch(`/api/v1/records/status?uri=${encodeURIComponent(server.uri)}`, {
                  credentials: 'same-origin',
                  cache: 'no-store',
                  signal: controller.signal,
                });
                if (status.ok) {
                  const record = (await status.json()) as { state: string; reason?: string };
                  if (
                    row.kind === 'scrobble_delete' || row.kind === 'follow_delete' || row.kind === 'settings_delete'
                      ? record.state === 'absent'
                      : record.state === 'indexed'
                  ) {
                    row.state = 'indexed';
                    row.dueAt = null;
                  } else if (record.state === 'excluded') {
                    row.state = 'failed';
                    row.failureCode = 'record_excluded';
                    row.reason = record.reason;
                    row.dueAt = null;
                  }
                }
              } catch {
                /* keep published while the index catches up */
              }
            }
          }
          row.updatedAt = Date.now();
        } catch {
          /* transient poll failure leaves the last server state visible */
        } finally {
          this.#controllers.delete(controller);
        }
      }),
    );
    this.#persist();
    this.#notify();
  }

  #add(server: ServerOperation, record?: Record<string, unknown>, subject?: Did): OutboxOperation {
    const existing = this.#rows.find((row) => row.id === server.id);
    if (existing) return existing;
    const kind = localKind(server.kind);
    const collection = kind.startsWith('scrobble') ? 'scrobble' : kind.startsWith('follow') ? 'follow' : 'settings';
    const row: OutboxOperation = {
      id: server.id,
      did: this.did,
      kind,
      uri: server.uri ?? `at://${this.did}/${this.prefix}.${collection}/${server.id}`,
      ...(record ? { record } : {}),
      ...(subject ? { subject } : {}),
      state: server.state === 'succeeded' ? 'published' : server.state === 'failed' ? 'failed' : 'queued',
      ...(server.error ? { failureCode: server.error } : {}),
      seq: ++this.#sequence,
      dueAt: Date.now() + 2_000,
      attempts: server.attempts,
      notified: true,
      polls: 0,
      createdAt: Date.parse(server.createdAt),
      updatedAt: Date.parse(server.updatedAt),
    };
    this.#rows.push(row);
    this.#persist();
    this.#notify();
    return row;
  }
  get #storageKey(): string {
    return `atmusic:server-operations:${this.did}`;
  }
  #persist(): void {
    try {
      sessionStorage.setItem(this.#storageKey, JSON.stringify(this.#rows.slice(-100)));
    } catch {
      /* sessionStorage may be unavailable */
    }
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

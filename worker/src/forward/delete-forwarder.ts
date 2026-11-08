import type { Clock, Random } from '@atmusic/core/deps';
import type { LinkedAccountRow } from '../app/rows';
import type { Box } from '../crypto/box';
import type { Db } from '../do/db';
import { openLinkCredential, revokeLink } from './links';
import type { ListenbrainzClient, ListenWindowEntry } from './listenbrainz-client';
import type { UpstreamPacing } from './upstream-pacing';

export const DELETE_MAX_ATTEMPTS = 32;
export const DELETE_MAX_REQUESTS_PER_RUN = 1;
const PAGE_SIZE = 1000;
type Candidate = ListenWindowEntry;
interface Progress {
  offset: number;
  candidates: Candidate[];
}
function progress(text: string | null): Progress {
  if (text === null) return { offset: 0, candidates: [] };
  try {
    const p = JSON.parse(text) as Progress;
    if (Number.isSafeInteger(p.offset) && p.offset >= 0 && Array.isArray(p.candidates)) return p;
  } catch {
    /* treat corrupt continuation as empty, never a target */
  }
  return { offset: 0, candidates: [] };
}
function sameCredential(db: Db, row: LinkedAccountRow): boolean {
  const live = db.one<{ generation: number; credential_ciphertext: ArrayBuffer; key_id: string; status: string }>(
    'SELECT generation,credential_ciphertext,key_id,status FROM linked_accounts WHERE id=?',
    row.id,
  );
  return (
    live?.generation === row.generation &&
    live.key_id === row.key_id &&
    live.status === 'active' &&
    Buffer.from(live.credential_ciphertext).equals(Buffer.from(row.credential_ciphertext))
  );
}
function retryAt(now: number, attempts: number, random: Random): number {
  const base = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(attempts, 10));
  return now + Math.floor(base + random.float() * base * 0.25);
}
function norm(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('und');
}
function choose(
  candidates: Candidate[],
  row: { listened_at: number; artist: string; track: string },
): Candidate | 'ambiguous' | null {
  const matching = new Map<string, Candidate>();
  for (const c of candidates) {
    if (norm(c.artist) !== norm(row.artist) || norm(c.track) !== norm(row.track)) continue;
    if (c.listenedAt < row.listened_at - 1 || c.listenedAt > row.listened_at + 1) continue;
    const identity = `${c.listenedAt}\0${c.recordingMsid ?? ''}`;
    matching.set(identity, c);
  }
  const exact = [...matching.values()].filter((c) => c.listenedAt === row.listened_at);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return 'ambiguous';
  const near = [...matching.values()];
  return near.length === 1 ? near[0]! : near.length === 0 ? null : 'ambiguous';
}

export interface DeleteForwardDeps {
  db: Db;
  clock: Clock;
  random: Random;
  box: Box;
  client: ListenbrainzClient;
  pacing: UpstreamPacing;
}
export interface DeleteForwardReport {
  requests: number;
  state: string | null;
  nextDueMs: number | null;
}

/** One durable lookup or delete request at most. Each network result is fenced by current generation and credential. */
export async function runDeleteSlice(deps: DeleteForwardDeps, now = deps.clock.nowMs()): Promise<DeleteForwardReport> {
  const row = deps.db.one<{
    id: string;
    link_id: string;
    generation: number;
    did: string;
    identity_key: string;
    listened_at: number;
    artist_key: string;
    track_key: string;
    artist: string;
    track: string;
    attempts: number;
    due_at: number;
    deadline_at: number;
    target_msid: string | null;
    target_listened_at: number | null;
    last_error: string | null;
  }>(
    "SELECT q.* FROM listenbrainz_deletes q JOIN linked_accounts l ON l.id=q.link_id AND l.generation=q.generation WHERE q.state='queued' AND q.due_at<=? AND l.status='active' ORDER BY q.due_at,q.created_at_ms LIMIT 1",
    now,
  );
  if (!row) return { requests: 0, state: null, nextDueMs: null };
  if (row.deadline_at <= now) {
    deps.db.run(
      "UPDATE listenbrainz_deletes SET state='expired',last_error='retry_deadline',updated_at_ms=? WHERE id=? AND state='queued'",
      now,
      row.id,
    );
    return { requests: 0, state: 'expired', nextDueMs: null };
  }
  if (row.attempts >= DELETE_MAX_ATTEMPTS) {
    deps.db.run(
      "UPDATE listenbrainz_deletes SET state='failed',last_error='attempt_limit',updated_at_ms=? WHERE id=? AND state='queued'",
      now,
      row.id,
    );
    return { requests: 0, state: 'failed', nextDueMs: null };
  }
  const link = deps.db.one<LinkedAccountRow>(
    "SELECT * FROM linked_accounts WHERE id=? AND generation=? AND status='active'",
    row.link_id,
    row.generation,
  );
  if (!link) return { requests: 0, state: 'stale', nextDueMs: null };
  const pacerKey = `link:${link.id}:generation:${link.generation}`;
  if (!deps.pacing.tryListenbrainz(pacerKey, now))
    return { requests: 0, state: 'paced', nextDueMs: deps.pacing.listenbrainzAvailableAt(pacerKey) };
  let token: string;
  try {
    token = openLinkCredential(deps.box, link);
  } catch {
    deps.db.run(
      "UPDATE listenbrainz_deletes SET state='failed',last_error='credential_unreadable',updated_at_ms=? WHERE id=? AND generation=?",
      now,
      row.id,
      row.generation,
    );
    return { requests: 0, state: 'failed', nextDueMs: null };
  }
  const after = (rate: { remaining: number | null; resetInS: number | null }, exhausted = false) =>
    deps.pacing.observeListenbrainz(pacerKey, deps.clock.nowMs(), rate, exhausted);
  const finishRequest = (rate: { remaining: number | null; resetInS: number | null }) => {
    deps.db.run(
      'UPDATE listenbrainz_deletes SET attempts=attempts+1,updated_at_ms=? WHERE id=? AND generation=?',
      deps.clock.nowMs(),
      row.id,
      row.generation,
    );
    after(rate);
  };
  if (row.target_msid !== null && row.target_listened_at !== null) {
    const out = await deps.client.deleteListen(token, {
      listened_at: row.target_listened_at,
      recording_msid: row.target_msid,
    });
    if (!sameCredential(deps.db, link)) return { requests: 1, state: 'stale_response', nextDueMs: null };
    if (out.ok) {
      finishRequest(out.rate);
      deps.db.run(
        "UPDATE listenbrainz_deletes SET state='sent',last_error=NULL,updated_at_ms=? WHERE id=? AND generation=? AND target_msid=? AND target_listened_at=?",
        deps.clock.nowMs(),
        row.id,
        row.generation,
        row.target_msid,
        row.target_listened_at,
      );
      return { requests: 1, state: 'sent', nextDueMs: null };
    }
    if (out.kind === 'status') {
      after(out.rate, out.status === 429);
      if (out.status === 401) {
        if (revokeLink(deps.db, link, 'credential_revoked', deps.clock.nowMs()))
          deps.db.run(
            "UPDATE listenbrainz_deletes SET state='failed',attempts=attempts+1,last_error='credential_revoked',updated_at_ms=? WHERE id=? AND generation=?",
            deps.clock.nowMs(),
            row.id,
            row.generation,
          );
      } else if (out.status === 400)
        deps.db.run(
          "UPDATE listenbrainz_deletes SET state='failed',attempts=attempts+1,last_error='upstream_400',updated_at_ms=? WHERE id=? AND generation=?",
          deps.clock.nowMs(),
          row.id,
          row.generation,
        );
      else {
        const due = retryAt(deps.clock.nowMs(), row.attempts, deps.random);
        deps.db.run(
          'UPDATE listenbrainz_deletes SET attempts=attempts+1,due_at=?,last_error=?,updated_at_ms=? WHERE id=? AND generation=? AND deadline_at>?',
          due,
          out.status === 429 ? 'rate_limited' : `http_${out.status}`,
          deps.clock.nowMs(),
          row.id,
          row.generation,
          deps.clock.nowMs(),
        );
      }
    } else {
      const due = retryAt(deps.clock.nowMs(), row.attempts, deps.random);
      deps.db.run(
        "UPDATE listenbrainz_deletes SET attempts=attempts+1,due_at=?,last_error='network',updated_at_ms=? WHERE id=? AND generation=? AND deadline_at>?",
        due,
        deps.clock.nowMs(),
        row.id,
        row.generation,
        deps.clock.nowMs(),
      );
    }
    return {
      requests: 1,
      state: 'retry',
      nextDueMs:
        deps.db.one<{ due_at: number }>('SELECT due_at FROM listenbrainz_deletes WHERE id=?', row.id)?.due_at ?? null,
    };
  }
  const p = progress(row.last_error);
  const out = await deps.client.listWindowPage(link.remote_user, token, row.listened_at - 2, PAGE_SIZE, p.offset);
  if (!sameCredential(deps.db, link)) return { requests: 1, state: 'stale_response', nextDueMs: null };
  if (!out.ok) {
    if (out.kind === 'status' && out.status === 401) {
      if (revokeLink(deps.db, link, 'credential_revoked', deps.clock.nowMs()))
        deps.db.run(
          "UPDATE listenbrainz_deletes SET state='failed',last_error='credential_revoked' WHERE id=? AND generation=?",
          row.id,
          row.generation,
        );
    } else {
      const due = retryAt(deps.clock.nowMs(), row.attempts, deps.random);
      deps.db.run(
        "UPDATE listenbrainz_deletes SET attempts=attempts+1,due_at=?,last_error='lookup_retry',updated_at_ms=? WHERE id=? AND generation=?",
        due,
        deps.clock.nowMs(),
        row.id,
        row.generation,
      );
    }
    return {
      requests: 1,
      state: 'lookup_retry',
      nextDueMs:
        deps.db.one<{ due_at: number }>('SELECT due_at FROM listenbrainz_deletes WHERE id=?', row.id)?.due_at ?? null,
    };
  }
  finishRequest(out.rate);
  const candidates = [
    ...p.candidates,
    ...out.value.filter(
      (c) =>
        norm(c.artist) === norm(row.artist) &&
        norm(c.track) === norm(row.track) &&
        c.listenedAt >= row.listened_at - 1 &&
        c.listenedAt <= row.listened_at + 1,
    ),
  ];
  if (out.value.length === PAGE_SIZE) {
    deps.db.run(
      "UPDATE listenbrainz_deletes SET last_error=?,due_at=?,updated_at_ms=? WHERE id=? AND generation=? AND state='queued'",
      JSON.stringify({ offset: p.offset + PAGE_SIZE, candidates }),
      deps.clock.nowMs() + 1000,
      deps.clock.nowMs(),
      row.id,
      row.generation,
    );
    return { requests: 1, state: 'lookup_more', nextDueMs: deps.clock.nowMs() + 1000 };
  }
  const selected = choose(candidates, row);
  if (selected === null || selected === 'ambiguous' || selected.recordingMsid === null) {
    deps.db.run(
      "UPDATE listenbrainz_deletes SET state='ignored',last_error=?,updated_at_ms=? WHERE id=? AND generation=?",
      selected === 'ambiguous' ? 'ambiguous_match' : 'no_match',
      deps.clock.nowMs(),
      row.id,
      row.generation,
    );
    return { requests: 1, state: 'ignored', nextDueMs: null };
  }
  deps.db.run(
    "UPDATE listenbrainz_deletes SET target_msid=?,target_listened_at=?,last_error=NULL,due_at=?,updated_at_ms=? WHERE id=? AND generation=? AND state='queued'",
    selected.recordingMsid,
    selected.listenedAt,
    deps.clock.nowMs() + 1000,
    deps.clock.nowMs(),
    row.id,
    row.generation,
  );
  return { requests: 1, state: 'target_persisted', nextDueMs: deps.clock.nowMs() + 1000 };
}

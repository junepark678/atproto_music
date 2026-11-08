import type { Clock, Random } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import type { LinkedAccountRow } from '../app/rows';
import type { Box } from '../crypto/box';
import type { Db } from '../do/db';
import { openLinkCredential, revokeLink } from './links';
import type { ListenbrainzClient, ListenWindowEntry } from './listenbrainz-client';
import type { UpstreamPacing } from './upstream-pacing';
import { listenbrainzPacingKey } from './upstream-pacing';

export const DELETE_MAX_ATTEMPTS = 32;
export const DELETE_MAX_REQUESTS_PER_RUN = 1;
const PAGE_SIZE = 1000;
const MAX_LOOKUP_CANDIDATES = 4000;
type Candidate = ListenWindowEntry;
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
function choose(
  candidates: Candidate[],
  row: { listened_at: number; artist_key: string; track_key: string },
): Candidate | 'ambiguous' | null {
  const matching = new Map<string, Candidate>();
  for (const c of candidates) {
    let keys: readonly [string, string];
    try {
      keys = trackKey(c.artist, c.track);
    } catch {
      continue;
    }
    if (keys[0] !== row.artist_key || keys[1] !== row.track_key) continue;
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
    lookup_min_ts: number | null;
    lookup_candidates: string | null;
    lookup_last_earliest: number | null;
    lookup_last_max: number | null;
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
  const pacerKey = listenbrainzPacingKey(link);
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
    let resultState = 'retry';
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
        resultState = 'failed';
      } else if (out.status === 400) {
        deps.db.run(
          "UPDATE listenbrainz_deletes SET state='failed',attempts=attempts+1,last_error='upstream_400',updated_at_ms=? WHERE id=? AND generation=?",
          deps.clock.nowMs(),
          row.id,
          row.generation,
        );
        resultState = 'failed';
      } else {
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
      state: resultState,
      nextDueMs:
        deps.db.one<{ due_at: number }>('SELECT due_at FROM listenbrainz_deletes WHERE id=?', row.id)?.due_at ?? null,
    };
  }
  let priorCandidates: Candidate[] = [];
  try {
    const parsed: unknown = row.lookup_candidates === null ? [] : JSON.parse(row.lookup_candidates);
    if (!Array.isArray(parsed) || parsed.length > MAX_LOOKUP_CANDIDATES) throw new Error('bad_progress');
    priorCandidates = parsed as Candidate[];
  } catch {
    deps.db.run(
      "UPDATE listenbrainz_deletes SET state='failed',last_error='lookup_progress_invalid',updated_at_ms=? WHERE id=? AND generation=?",
      now,
      row.id,
      row.generation,
    );
    return { requests: 0, state: 'failed', nextDueMs: null };
  }
  const minTs = row.lookup_min_ts ?? row.listened_at - 2;
  const out = await deps.client.listWindowPage(link.remote_user, token, minTs, PAGE_SIZE);
  if (!sameCredential(deps.db, link)) return { requests: 1, state: 'stale_response', nextDueMs: null };
  if (!out.ok) {
    if (out.kind === 'status' && out.status === 401) {
      if (revokeLink(deps.db, link, 'credential_revoked', deps.clock.nowMs()))
        deps.db.run(
          "UPDATE listenbrainz_deletes SET state='failed',attempts=attempts+1,last_error='credential_revoked',updated_at_ms=? WHERE id=? AND generation=?",
          deps.clock.nowMs(),
          row.id,
          row.generation,
        );
    } else if (out.kind === 'status' && out.status === 400) {
      deps.db.run(
        "UPDATE listenbrainz_deletes SET state='failed',attempts=attempts+1,last_error='upstream_400',updated_at_ms=? WHERE id=? AND generation=?",
        deps.clock.nowMs(),
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
  const candidates = [...priorCandidates];
  const seen = new Set(candidates.map((c) => `${c.listenedAt}\0${c.recordingMsid ?? ''}`));
  for (const c of out.value) {
    if (c.listenedAt < row.listened_at - 1 || c.listenedAt > row.listened_at + 1) continue;
    const tuple = `${c.listenedAt}\0${c.recordingMsid ?? ''}`;
    if (!seen.has(tuple)) {
      seen.add(tuple);
      candidates.push(c);
    }
  }
  // ListenBrainz selects the earliest page after exclusive min_ts, then
  // returns it newest-first. The page maximum is therefore the only safe
  // forward cursor. If a full page ends inside the target window, more rows
  // may share that second; min_ts cannot disambiguate them, so ignore safely.
  const pageMax = out.value.reduce((max, c) => Math.max(max, c.listenedAt), Number.NEGATIVE_INFINITY);
  const complete = out.value.length < PAGE_SIZE || pageMax > row.listened_at + 1;
  if (!complete) {
    if (
      candidates.length > MAX_LOOKUP_CANDIDATES ||
      !Number.isFinite(pageMax) ||
      pageMax === row.lookup_last_max ||
      pageMax >= row.listened_at - 1
    ) {
      deps.db.run(
        "UPDATE listenbrainz_deletes SET state='ignored',last_error='ambiguous_saturated',updated_at_ms=? WHERE id=? AND generation=?",
        deps.clock.nowMs(),
        row.id,
        row.generation,
      );
      return { requests: 1, state: 'ignored', nextDueMs: null };
    }
    deps.db.run(
      "UPDATE listenbrainz_deletes SET lookup_min_ts=?,lookup_candidates=?,lookup_last_earliest=?,due_at=?,updated_at_ms=? WHERE id=? AND generation=? AND state='queued'",
      // `min_ts` is exclusive. Continue after this page's newest second.
      pageMax,
      JSON.stringify(candidates),
      pageMax,
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

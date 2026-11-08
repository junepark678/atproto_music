// Timer-only linked Last.fm polling. All upstream reads use the caller's
// policyFetch transport; every response is fenced by link generation, account,
// pull-enabled flag, and the sealed credential bytes before durable writes.

import type { Clock, Random } from '@atmusic/core/deps';
import { trackKey } from '@atmusic/core/music-key';
import type { LinkedAccountRow } from '../app/rows';
import type { Box } from '../crypto/box';
import type { ModuleDeps } from '../do/contracts';
import type { Db } from '../do/db';
import { type LinkDeps, openLinkCredential } from '../forward/links';
import type { Pacer } from '../imports/jobs';
import {
  fetchLastfmPullPage,
  isNowPlaying,
  LASTFM_PAGE_LIMIT,
  mapLastfmRow,
  pageTracks,
} from '../imports/lastfm-source';
import { recordingByMbid } from '../musicbrainz/store';
import type { BoundPolicyFetch } from '../node/policy-fetch';
import { seedIndexedListenSecondSlice, seedLegacyListenSecondSlice } from '../outbox/listen-second-receipts';
import type { PulledLove } from './pull-staging';
import {
  PULL_GLOBAL_MAX_BYTES,
  PULL_GLOBAL_MAX_ITEMS,
  PULL_LINK_MAX_BYTES,
  PULL_LINK_MAX_ITEMS,
  type PulledListen,
  stageLovePage,
  stagePullPage,
} from './pull-staging';
import { type PullWriterAvailabilitySource, writePullSlice } from './pull-writer';

export const LINKED_PULL_JITTER = 0.1;
export const LINKED_PULL_MAX_REQUESTS_PER_RUN = 3;
export const LINKED_PULL_RETRY_BASE_MS = 30_000;
export const LINKED_PULL_RETRY_CAP_MS = 3_600_000;
export const LINKED_PULL_MAX_FAILURES = 8;
const TERMINAL_HOLDS = new Set([
  'reauth_required',
  'upstream_unauthorized',
  'retry_exhausted',
  'remote_user_not_found',
  'lastfm_key_rejected',
  'lastfm_error',
]);

type PullState = {
  listen_watermark_ms: number;
  poll_next_at_ms: number | null;
  retry_at_ms: number | null;
  failures: number;
  hold_reason: string | null;
  listen_round_upper_ms: number | null;
  listen_round_floor_ms: number | null;
  listen_round_page: number | null;
  love_boundary_ms: number | null;
  love_boundary_key: string | null;
  love_round_upper_ms: number | null;
  love_round_floor_ms: number | null;
  love_round_page: number | null;
  poll_phase: 'listen' | 'love';
  listen_floor_at_ms: number | null;
  love_floor_at_ms: number | null;
};
type PullLink = LinkedAccountRow;

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function current(db: Db, snapshot: PullLink): boolean {
  const link = db.one<PullLink>('SELECT * FROM linked_accounts WHERE id=?', snapshot.id);
  if (
    !link ||
    link.did !== snapshot.did ||
    link.generation !== snapshot.generation ||
    link.service !== snapshot.service ||
    link.remote_user !== snapshot.remote_user ||
    link.status !== 'active' ||
    link.pull_enabled !== 1 ||
    link.key_id !== snapshot.key_id
  )
    return false;
  const a = bytes(link.credential_ciphertext);
  const b = bytes(snapshot.credential_ciphertext);
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function dueJitter(random: Random, intervalMs: number): number {
  return Math.max(1, Math.round(intervalMs * (1 + (random.float() * 2 - 1) * LINKED_PULL_JITTER)));
}

function safeReason(error: unknown): string {
  const name = error instanceof Error ? error.name : 'unknown';
  return name === 'BoxError' ? 'credential_unavailable' : 'upstream_retry';
}

function setHold(db: Db, link: PullLink, reason: string, now: number, due: number | null): void {
  db.run(
    'UPDATE linked_pull_state SET hold_reason=?,poll_next_at_ms=?,updated_at_ms=? WHERE link_id=? AND generation=?',
    reason,
    due,
    now,
    link.id,
    link.generation,
  );
}

function retry(db: Db, link: PullLink, state: PullState, reason: string, now: number): number | null {
  const failures = Math.min(LINKED_PULL_MAX_FAILURES, state.failures + 1);
  const due =
    failures >= LINKED_PULL_MAX_FAILURES
      ? null
      : now + Math.min(LINKED_PULL_RETRY_CAP_MS, LINKED_PULL_RETRY_BASE_MS * 2 ** (failures - 1));
  db.run(
    'UPDATE linked_pull_state SET failures=?,retry_at_ms=?,poll_next_at_ms=?,hold_reason=?,updated_at_ms=? WHERE link_id=? AND generation=?',
    failures,
    due,
    due,
    failures >= LINKED_PULL_MAX_FAILURES ? 'retry_exhausted' : reason,
    now,
    link.id,
    link.generation,
  );
  return due;
}

export interface LinkedPullPollerDeps {
  moduleDeps: ModuleDeps;
  db: Db;
  clock: Clock;
  random: Random;
  box: Box;
  fetch: BoundPolicyFetch;
  apiRoot: string;
  apiKey: string | null;
  sharedSecret: string | null;
  intervalMs: number;
  pacer: Pacer;
  writerAvailability: PullWriterAvailabilitySource;
}

export interface LinkedPullPollReport {
  requested: number;
  staged: number;
  held: string | null;
  nextDueMs: number | null;
}

function stateOf(db: Db, link: PullLink): PullState | null {
  return db.one<PullState>(
    `SELECT listen_watermark_ms,poll_next_at_ms,retry_at_ms,failures,hold_reason,listen_floor_at_ms,love_floor_at_ms,
      listen_round_upper_ms,listen_round_floor_ms,listen_round_page,love_boundary_ms,love_boundary_key,
      love_round_upper_ms,love_round_floor_ms,love_round_page,poll_phase
     FROM linked_pull_state WHERE link_id=? AND generation=?`,
    link.id,
    link.generation,
  );
}

function ensureState(db: Db, link: PullLink, now: number): PullState {
  let state = stateOf(db, link);
  if (state === null) {
    // Existing links first seen at rollout start here, never at epoch zero.
    db.run(
      `INSERT OR IGNORE INTO linked_pull_state(link_id,generation,source_service,source_account,listen_watermark_ms,
        listen_floor_at_ms,love_floor_at_ms,love_boundary_ms,poll_next_at_ms,updated_at_ms)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      link.id,
      link.generation,
      link.service,
      link.remote_user,
      now,
      now,
      now,
      now,
      now,
      now,
    );
    state = stateOf(db, link);
  } else if (state.listen_floor_at_ms === null || state.love_floor_at_ms === null) {
    db.run(
      `UPDATE linked_pull_state SET poll_next_at_ms=coalesce(poll_next_at_ms,?),
        listen_floor_at_ms=coalesce(listen_floor_at_ms,?),love_floor_at_ms=coalesce(love_floor_at_ms,?),
        listen_watermark_ms=max(listen_watermark_ms,?),love_boundary_ms=coalesce(love_boundary_ms,?),
        updated_at_ms=? WHERE link_id=? AND generation=?`,
      now,
      now,
      now,
      now,
      now,
      now,
      link.id,
      link.generation,
    );
    state = stateOf(db, link);
  } else if (state.poll_next_at_ms === null && !TERMINAL_HOLDS.has(state.hold_reason ?? '')) {
    // A null due time paired with a terminal hold is deliberate. Migrated
    // writer holds still need a timer visit so a restored session can resume.
    db.run(
      'UPDATE linked_pull_state SET poll_next_at_ms=?,updated_at_ms=? WHERE link_id=? AND generation=? AND poll_next_at_ms IS NULL',
      now,
      now,
      link.id,
      link.generation,
    );
    state = stateOf(db, link);
  }
  if (state === null) throw new Error('linked pull state disappeared');
  return state;
}

function pullListenItems(tracks: readonly unknown[], floorMs: number, upperMs: number): PulledListen[] {
  const items: PulledListen[] = [];
  for (const raw of tracks) {
    if (isNowPlaying(raw)) continue;
    const mapped = mapLastfmRow(raw);
    if (mapped.entry?.kind !== 'listen' || mapped.second === null) continue;
    const at = mapped.second * 1000;
    if (at < floorMs || at > upperMs) continue;
    const artist = mapped.entry.input.artist;
    const track = mapped.entry.input.track;
    const [artistKey, trackKeyValue] = trackKey(artist, track);
    items.push({
      itemKey: mapped.id,
      listenedAtMs: at,
      artistKey,
      trackKey: trackKeyValue,
      payload: {
        artist,
        track,
        listenedAt: mapped.entry.input.listenedAt,
        ...(mapped.entry.input.album === undefined ? {} : { album: mapped.entry.input.album }),
        ...(mapped.entry.input.recordingMbid === undefined ? {} : { recordingMbid: mapped.entry.input.recordingMbid }),
      },
    });
  }
  return items;
}

function pullLoveItems(tracks: readonly unknown[], floorMs: number, upperMs: number, db: Db): PulledLove[] {
  const items: PulledLove[] = [];
  for (const raw of tracks) {
    if (isNowPlaying(raw) || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const mapped = mapLastfmRow(raw);
    const second = mapped.second;
    if (second === null) continue;
    const at = second * 1000;
    if (at < floorMs || at > upperMs) continue;
    const artistValue = record.artist;
    const artistObject =
      artistValue !== null && typeof artistValue === 'object' ? (artistValue as Record<string, unknown>) : null;
    let artist =
      typeof artistValue === 'string' ? artistValue : typeof artistObject?.name === 'string' ? artistObject.name : null;
    let track = typeof record.name === 'string' ? record.name : null;
    const recordingMbid = typeof record.mbid === 'string' && record.mbid !== '' ? record.mbid : null;
    if ((!artist || !track) && recordingMbid !== null) {
      const local = recordingByMbid(db, recordingMbid);
      if (local !== null) {
        artist ??= local.artistCredit;
        track ??= local.title;
      }
    }
    items.push({
      itemKey: mapped.id,
      artist,
      track,
      recordingMbid,
      payload: { artist, track, ...(recordingMbid === null ? {} : { recordingMbid }) },
    });
  }
  return items;
}

function currentLinks(db: Db): PullLink[] {
  return db.all<PullLink>(
    `SELECT * FROM linked_accounts WHERE service='lastfm' AND status='active' AND pull_enabled=1
     ORDER BY coalesce((SELECT poll_next_at_ms FROM linked_pull_state p WHERE p.link_id=linked_accounts.id
       AND p.generation=linked_accounts.generation),0),id LIMIT 1000`,
  );
}

async function runLovePage(
  deps: LinkedPullPollerDeps,
  link: PullLink,
  state: PullState,
  credential: string,
  now: number,
): Promise<{ requested: number; staged: number; held: string | null; nextDueMs: number | null }> {
  let upper = state.love_round_upper_ms;
  let floor = state.love_round_floor_ms;
  let page = state.love_round_page ?? 1;
  if (upper === null || floor === null) {
    upper = now;
    floor = Math.max(state.love_floor_at_ms ?? link.updated_at_ms, state.love_boundary_ms ?? 0);
    deps.db.tx(() => {
      if (!current(deps.db, link)) return;
      deps.db.run(
        `UPDATE linked_pull_state SET love_round_upper_ms=?,love_round_floor_ms=?,love_round_page=1,
          poll_next_at_ms=?,updated_at_ms=? WHERE link_id=? AND generation=?`,
        upper,
        floor,
        now,
        now,
        link.id,
        link.generation,
      );
    });
    page = 1;
  }
  const paceAt = deps.pacer.take(now);
  if (paceAt !== null) {
    deps.db.run(
      'UPDATE linked_pull_state SET poll_next_at_ms=?,updated_at_ms=? WHERE link_id=? AND generation=?',
      paceAt,
      now,
      link.id,
      link.generation,
    );
    return { requested: 0, staged: 0, held: null, nextDueMs: paceAt };
  }
  const response = await fetchLastfmPullPage(
    { fetch: deps.fetch, apiRoot: deps.apiRoot, apiKey: deps.apiKey!, sharedSecret: deps.sharedSecret! },
    { method: 'user.getLovedTracks', user: link.remote_user, sk: credential, page },
  );
  if (!current(deps.db, link)) return { requested: 1, staged: 0, held: null, nextDueMs: null };
  if (response.kind === 'reauth') {
    setHold(deps.db, link, 'upstream_unauthorized', now, null);
    return { requested: 1, staged: 0, held: 'upstream_unauthorized', nextDueMs: null };
  }
  if (response.kind === 'retry') {
    const due = retry(deps.db, link, state, 'upstream_retry', now);
    return { requested: 1, staged: 0, held: 'upstream_retry', nextDueMs: due };
  }
  if (response.kind === 'fail') {
    setHold(deps.db, link, response.reason, now, null);
    return { requested: 1, staged: 0, held: response.reason, nextDueMs: null };
  }
  const validSeconds = response.tracks
    .map((raw) => mapLastfmRow(raw).second)
    .filter((second): second is number => second !== null);
  const items = pullLoveItems(response.tracks, floor, upper, deps.db);
  // Loved tracks are newest first. Fetch through the prior completed boundary,
  // including every page at that second; known local loves never end the scan.
  const crossedFloor = validSeconds.some((second) => second * 1000 < floor);
  const complete = crossedFloor || response.page >= response.totalPages || response.tracks.length < LASTFM_PAGE_LIMIT;
  stageLovePage(deps.db, {
    linkId: link.id,
    generation: link.generation,
    sourceService: 'lastfm',
    sourceAccount: link.remote_user,
    did: link.did,
    credentialCiphertext: bytes(link.credential_ciphertext),
    proposedCursor: complete ? null : String(page + 1),
    proposedBoundaryMs: state.love_boundary_ms ?? floor,
    proposedBoundaryKey: state.love_boundary_key,
    nowMs: now,
    items,
    loveRound: {
      upperMs: complete ? null : upper,
      floorMs: complete ? null : floor,
      nextPage: complete ? null : page + 1,
      committedBoundaryMs: complete ? upper : null,
      committedBoundaryKey: complete ? null : null,
    },
  });
  const due = complete ? now + dueJitter(deps.random, deps.intervalMs) : now + 1;
  deps.db.run(
    `UPDATE linked_pull_state SET poll_phase=?,poll_next_at_ms=?,failures=0,retry_at_ms=NULL,hold_reason=NULL,
      updated_at_ms=? WHERE link_id=? AND generation=?`,
    complete ? 'listen' : 'love',
    due,
    now,
    link.id,
    link.generation,
  );
  const writer = await writePullSlice(deps.moduleDeps, {
    linkId: link.id,
    generation: link.generation,
    available: deps.writerAvailability,
    limit: 100,
    credentialCiphertext: bytes(link.credential_ciphertext),
  });
  return { requested: 1, staged: items.length, held: writer.held, nextDueMs: due };
}

/** One bounded timer run. It uses at most one remote request currently; remaining budget is reserved for follow-up pagers. */
export async function runLinkedLastfmPull(
  deps: LinkedPullPollerDeps,
  now = deps.clock.nowMs(),
): Promise<LinkedPullPollReport> {
  const links = currentLinks(deps.db);
  let nextDueMs: number | null = null;
  let requested = 0;
  let staged = 0;
  let held: string | null = null;
  for (const link of links) {
    if (!current(deps.db, link)) continue;
    let state = ensureState(deps.db, link, now);
    if (state.poll_next_at_ms === null) continue;
    nextDueMs = nextDueMs === null ? state.poll_next_at_ms : Math.min(nextDueMs, state.poll_next_at_ms);
    if (state.poll_next_at_ms > now) continue;
    if (deps.apiKey === null || deps.sharedSecret === null) {
      held = 'lastfm_not_configured';
      const due = now + deps.intervalMs;
      setHold(deps.db, link, held, now, due);
      nextDueMs = due;
      continue;
    }

    // Repair old opaque receipts only in the background timer, never in a user request.
    await seedLegacyListenSecondSlice(deps.db, now);
    if (!current(deps.db, link)) continue;
    await seedIndexedListenSecondSlice(deps.db, link.did, now);
    if (!current(deps.db, link)) continue;
    if (deps.db.one('SELECT 1 AS hit FROM listen_keys WHERE did=? AND listen_second IS NULL LIMIT 1', link.did)) {
      held = 'legacy_dedupe_coverage';
      setHold(deps.db, link, held, now, now + 60_000);
      continue;
    }

    let credential: string;
    try {
      const linkDeps: LinkDeps = { db: deps.db, clock: deps.clock, random: deps.random, box: deps.box };
      credential = openLinkCredential(linkDeps.box, link);
    } catch (error) {
      held = safeReason(error);
      setHold(deps.db, link, held, now, null);
      continue;
    }
    if (!current(deps.db, link)) continue;
    const stagedBefore = deps.db.one<{ n: number; bytes: number }>(
      'SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS bytes FROM linked_pull_items WHERE link_id=? AND generation=?',
      link.id,
      link.generation,
    )!;
    let priorWriterHeld: string | null = null;
    if (stagedBefore.n > 0) {
      const writer = await writePullSlice(deps.moduleDeps, {
        linkId: link.id,
        generation: link.generation,
        available: deps.writerAvailability,
        limit: 100,
        credentialCiphertext: bytes(link.credential_ciphertext),
      });
      priorWriterHeld = writer.held;
      if (!current(deps.db, link)) continue;
    }
    const stagedLink = deps.db.one<{ n: number; bytes: number }>(
      'SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS bytes FROM linked_pull_items WHERE link_id=? AND generation=?',
      link.id,
      link.generation,
    )!;
    const stagedGlobal = deps.db.one<{ n: number; bytes: number }>(
      'SELECT count(*) AS n,coalesce(sum(payload_bytes),0) AS bytes FROM linked_pull_items',
    )!;
    if (
      stagedLink.n >= PULL_LINK_MAX_ITEMS ||
      stagedLink.bytes >= PULL_LINK_MAX_BYTES ||
      stagedGlobal.n >= PULL_GLOBAL_MAX_ITEMS ||
      stagedGlobal.bytes >= PULL_GLOBAL_MAX_BYTES
    ) {
      held = priorWriterHeld ?? 'staging_capacity';
      setHold(deps.db, link, held, now, now + 60_000);
      nextDueMs = now + 60_000;
      break;
    }
    if (state.poll_phase === 'love') {
      try {
        const result = await runLovePage(deps, link, state, credential, now);
        requested += result.requested;
        staged += result.staged;
        held = result.held;
        nextDueMs = result.nextDueMs;
      } catch (error) {
        if (!current(deps.db, link)) continue;
        held = error instanceof Error && error.message.includes('capacity') ? 'staging_capacity' : safeReason(error);
        if (held === 'staging_capacity') setHold(deps.db, link, held, now, now + 60_000);
        else nextDueMs = retry(deps.db, link, state, held, now) ?? nextDueMs;
      }
      break;
    }
    const page = state.listen_round_page ?? 1;
    let upper = state.listen_round_upper_ms;
    let floor = state.listen_round_floor_ms;
    if (upper === null || floor === null) {
      upper = now;
      floor = Math.max(state.listen_floor_at_ms ?? link.updated_at_ms, state.listen_watermark_ms - 3_600_000);
      deps.db.tx(() => {
        if (!current(deps.db, link)) return;
        deps.db.run(
          `UPDATE linked_pull_state SET listen_round_upper_ms=?,listen_round_floor_ms=?,listen_round_page=1,
             poll_next_at_ms=?,updated_at_ms=? WHERE link_id=? AND generation=?`,
          upper,
          floor,
          now,
          now,
          link.id,
          link.generation,
        );
      });
      state = stateOf(deps.db, link)!;
    }
    const paceAt = deps.pacer.take(now);
    if (paceAt !== null) {
      deps.db.run(
        'UPDATE linked_pull_state SET poll_next_at_ms=?,updated_at_ms=? WHERE link_id=? AND generation=?',
        paceAt,
        now,
        link.id,
        link.generation,
      );
      nextDueMs = paceAt;
      break;
    }
    try {
      const response = await fetchLastfmPullPage(
        { fetch: deps.fetch, apiRoot: deps.apiRoot, apiKey: deps.apiKey, sharedSecret: deps.sharedSecret },
        {
          method: 'user.getRecentTracks',
          user: link.remote_user,
          sk: credential,
          page,
          from: Math.floor(floor / 1000),
          to: Math.floor(upper / 1000),
        },
      );
      requested++;
      if (!current(deps.db, link)) continue;
      if (response.kind === 'reauth') {
        held = 'upstream_unauthorized';
        setHold(deps.db, link, held, now, null);
        continue;
      }
      if (response.kind === 'retry') {
        held = 'upstream_retry';
        nextDueMs = retry(deps.db, link, state, held, now) ?? nextDueMs;
        continue;
      }
      if (response.kind === 'fail') {
        held = response.reason;
        setHold(deps.db, link, held, now, null);
        continue;
      }
      const rows = pageTracks({ recenttracks: { track: response.tracks } });
      const items = pullListenItems(rows, floor, upper);
      const complete = response.page >= response.totalPages || response.tracks.length < LASTFM_PAGE_LIMIT;
      const outcomes = stagePullPage(deps.db, {
        linkId: link.id,
        generation: link.generation,
        sourceService: 'lastfm',
        sourceAccount: link.remote_user,
        did: link.did,
        credentialCiphertext: bytes(link.credential_ciphertext),
        proposedCursor: complete ? null : String(page + 1),
        proposedWatermarkMs: complete ? upper : state.listen_watermark_ms,
        nowMs: now,
        items,
        listenRound: {
          upperMs: complete ? null : upper,
          floorMs: complete ? null : floor,
          nextPage: complete ? null : page + 1,
        },
      });
      staged += outcomes.filter((outcome) => outcome === 'accepted').length;
      const due = now + 1;
      deps.db.run(
        `UPDATE linked_pull_state SET failures=0,retry_at_ms=NULL,hold_reason=NULL,poll_phase=?,poll_next_at_ms=?,
          updated_at_ms=? WHERE link_id=? AND generation=?`,
        complete ? 'love' : 'listen',
        due,
        now,
        link.id,
        link.generation,
      );
      const writer = await writePullSlice(deps.moduleDeps, {
        linkId: link.id,
        generation: link.generation,
        available: deps.writerAvailability,
        limit: 100,
        credentialCiphertext: bytes(link.credential_ciphertext),
      });
      if (writer.held !== null) held = writer.held;
      else if (priorWriterHeld !== null) held = priorWriterHeld;
      nextDueMs = due;
      break;
    } catch (error) {
      if (!current(deps.db, link)) continue;
      held = error instanceof Error && error.message.includes('capacity') ? 'staging_capacity' : safeReason(error);
      if (held === 'staging_capacity') setHold(deps.db, link, held, now, now + 60_000);
      else nextDueMs = retry(deps.db, link, state, held, now) ?? nextDueMs;
      break;
    }
  }
  return { requested, staged, held, nextDueMs };
}

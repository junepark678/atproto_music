# Plan: cross-store consistency (PDS ⇄ Last.fm ⇄ ListenBrainz) and now playing over the compat APIs

Status: **plan**. Written 2026-11-13 by the orchestrating planner (Opus 5.5), based on two read-only discovery reports:
- `discovery-consistency.md`, which builds the full origin × operation matrix with citations;
- `discovery-nowplaying.md`.

Both were run against master `62481fa` and the open follow-up stack head `c01fd6a` (PR #210). This plan extends
`PLAN-sync-nowplaying-musicbrainz.md`. Its cross-cutting rules (§1) all still apply: egress, contracts, migrations and tests.

## Owner goal (2026-11-13)

1. Records on ListenBrainz, Last.fm and the atproto PDS must be **fully consistent** with each other. A best-effort gap
   is fine, but **convergence within 3 hours**.
2. **Deletions propagate.**
3. Now playing must work when a client talks directly to our endpoints (`music.214510.xyz`: the Last.fm-compatible
   `track.updateNowPlaying` and the ListenBrainz-compatible `playing_now`). It must not depend on atproto ingestion.

## 0. Ground truth

- **Nothing periodically reconciles.**
  - No timer compares the stores.
  - The only self-healing is backfill re-arming after a snapshot, and that covers creates only.
- **Retry design breaks the 3 h bound.**
  - `forward_outbox` rows go terminal `failed/retry_exhausted` after `MAX_FORWARD_ATTEMPTS = 8`. That is about 64–79 min of
    outage (`worker/src/forward/forward-outbox.ts:74,352`), and `BACKOFF_CAP_MS` is 6 h (`:72`).
  - The pull poller goes terminal `retry_exhausted` after 8 failures and stays stopped until the owner relinks.
  - `LINKED_PULL_INTERVAL_MS` may be set as high as 24 h (`worker/src/node/config.ts:62`).
- **Deletions and unloves made directly on Last.fm or ListenBrainz are never detected.** The pull is creates-only, and its
  floor is the watermark minus 1 h.
- **Deletes made in the PDS by other apps reach upstream only with live Jetstream evidence**, which has a 6 h window and
  is unsigned (see A1-7). The B21 draft forbids deriving deletes from snapshots.
- **ListenBrainz deletes need a `sent` forward row.** Listens we pulled from ListenBrainz therefore can never be deleted
  there, and imported loves exclude their source service when unloved.
- **Upstream limits:**
  - Last.fm has **no public delete-scrobble API**. `library.removeScrobble` exists only on our own compat server.
  - Last.fm rejects scrobbles older than about 14 days.
  - ListenBrainz `delete-listen` is accepted but applied asynchronously ("usually shortly after the hour").
  - ListenBrainz feedback needs a recording MBID or MSID.
- **Now playing: the live build is the blocker.**
  - The live build is `c147690`, which has no read API and no card.
  - Master stores now playing from both compat entry points, forwards it through `forward_outbox`, and shows it on
    the profile.
  - Still missing:
    - the owner's own row on Feed;
    - an immediate forward kick (it waits up to the 10 s idle poll);
    - priority over imports and backfill in the Last.fm 1 req/s bucket (forwards are dropped after 60 s);
    - an end-to-end test;
    - log visibility.

## 1. Consistency model (binding planner rulings)

- **R1. Identity.**
  - A listen is the canonical `(artist, track, listened_at second)` tuple. A love is the canonical `(artist, track)` key.
  - Consistency is defined over identities. A metadata-only edit (album, MBIDs) is not a divergence.
  - An identity-changing edit is a delete of the old identity plus a create of the new one. This includes the queued
    LOVE-UPDATE-CALLER policy (new love, then unlove the old one only when no local survivor remains).
- **R2. Authority.**
  - **Creates are a union.** An identity live in any store and never deleted anywhere ends up in all of them, within each
    store's reachable domain (R5).
  - **Deletion wins.** A deletion observed in any store tombstones the identity locally and propagates to every store
    that supports deletes. A tombstoned identity is never re-created by pull or reconcile.
- **R3. Signed state is the authority; relays are latency.**
  - Every upstream effect must be justified by verified PDS state: signed proofs or signed snapshots. This covers forwards,
    upstream deletes and unloves.
  - Jetstream claims may only make an effect happen sooner, never decide whether it happens. Binding for #211/A1-7, see
    `codex-blockers-brief.md`, "ruling v2".
- **R4. Upstream-observed deletions need repeated, complete evidence.**
  - Treat an identity as deleted upstream only when all of these hold:
    - it was previously seen present on that service (ledger, §2.2);
    - it is now absent in **two consecutive complete scans** at least 45 min apart;
    - it lies outside a settle margin. ListenBrainz ingest lag and Last.fm lag are both undocumented, so start at 1 h.
  - Never act on an incomplete scan (a page error, saturation, a truncated window).
  - **Mass-deletion guard:**
    - If one scan removes more than max(10 identities, 5 % of the window's previously-seen set), halt absence-based
      deletes for that link, set a link warning, and surface it in Settings.
    - Cap deletes at 50 per link per run.
- **R5. Reachable domains (disclosed residuals, not bugs).**
  - **Last.fm deletes are impossible.**
    - An identity deleted elsewhere stays on Last.fm. It is tombstoned so it is never re-imported.
    - It is listed in Settings → Linked accounts as "still on Last.fm — delete manually", with a link to the Last.fm
      library page. Once a later scan sees it gone, it drops off the list.
  - **Last.fm creates only within 13 days of `listened_at`.**
  - **ListenBrainz loves need a recording MBID or MSID.** We use the MSID when we hold one (§2.3).
- **R6. Convergence bound.** All four limbs below assume the upstream is reachable.

  | Scope | Bound |
  |---|---|
  | Listens dated within the **hot window** (30 days) and all loves | ≤ 3 h |
  | Older listens | ≤ 24 h |

  The 3 h bound is made of four limbs:

  | Limb | Bound | Mechanism |
  |---|---|---|
  | Detection | ≤ 1 h | Jetstream immediate, pull 10 min, hourly reconcile |
  | Delivery after recovery | ≤ 1 h | the 1 h backoff cap |
  | Two-scan confirmation | ≤ 1 h | for upstream deletions only |
  | ListenBrainz async delete | ≤ 1 h | outside our control |

  The bound breaks in two cases, both reported in the UI:
  - an upstream outage longer than the bound;
  - a mass-deletion guard trip.
- **R7. Upstream deletions apply to the PDS through the existing owner-authorised delete path** (`outbox/delete-ops.ts`,
  `batch-delete-ops.ts`, tombstones). That path already propagates to the other service.
  - The first release that contains absence-based deletes ships them in **report-only** mode, controlled by the per-link
    setting `syncUpstreamDeletions: 'report' | 'apply'`, default `report`. In report mode the reconcile run logs and shows
    what it would delete.
  - The owner switches to `apply` after reviewing a few days of reports.
  - PDS-originated deletions (Jetstream and signed absence) are not gated; they are already signed.

## 2. Work packages

Bases:
- **C0** is the current merge program.
- **C1–C3** start from master after the follow-up stack (#187, #197–#211, #189, #191) has merged. The stack predates
  master's pull-poller changes (#190/#201).
- **NP** can start from master now.

### C0. Land the current stack (in progress)

#211 (A1-7 under ruling v2), #191 round 2, then #187 → #197…#211 → #189. Then deploy, which needs owner approval.

### C1. Quick wins: retry, pull holds, detection cadence (no migration)

1. **G1, outbox retry.**
   - Transient failures never go terminal before age expiry (13 d Last.fm, 30 d ListenBrainz). Transient means: network
     error, timeout, 5xx, 429, and Last.fm codes 8/11/16/29.
   - `BACKOFF_CAP_MS` drops from 6 h to 1 h.
   - Permanent refusals stay terminal and show in link sync status.
   - Amend ADR 0005 §12.3 ("eight attempts").
2. **G2, pull poller.**
   - Transient failures retry indefinitely at a 1 h cap.
   - Auth and not-found holds stay terminal and are surfaced.
   - Clamp `MAX_LINKED_PULL_INTERVAL_MS` to 1 h.
3. **G9, ListenBrainz delete `no_match`.** Retry with backoff for 2 h before going `ignored`.
4. **G15, periodic signed resnapshot of the owner's repo.**
   - Run it on the snapshot machinery, at most hourly for the hot window and daily for everything.
   - Sol and Astra choose the cheapest signed mechanism: a full CAR snapshot, or `listRecords` candidates confirmed by
     signed `sync.getRecord` inclusion/non-inclusion proofs.
   - Snapshot completion already re-arms backfill, which covers creates.

### C2. Reconciler: creates both directions, plus the upstream presence ledger (migration 58, additive)

1. **New `reconcile` extension timer**, per link, hourly with jitter.
   - Hot window: the last 30 days.
   - Deep sweep: the full history, resumable across runs with a per-run request cap and a cursor, completing at least
     daily.
   - Loves are a full-set diff every run.
   - It shares the existing pacing buckets at low priority. Now playing and live forwards always go first.
2. **Ledger.**
   - Key: `upstream_presence(link_id, generation, identity_key)`.
   - Columns: first and last seen, consecutive absent count, last complete scan id.
   - Add a `reconcile_runs` table with window, completeness and counts.
   - Pulled items and sent forwards both mark "present on service". This closes **G8**: pulled ListenBrainz listens
     become deletable, and source exclusion applies to creates only, never to delete or unlove.
3. **Create decisions.**
   - **In the PDS, never seen upstream, eligible:** queue a forward under a repair-epoch dedupe key (additive, per §1 of
     the sync plan).
   - **Upstream, never in the PDS, not tombstoned:** pull it through the existing import writer.
   - An identity with a permanent upstream refusal for the same payload is not re-queued.
4. **G11.** ListenBrainz love feedback falls back to `recording_msid` when we hold one, from pulled listens or the delete
   lookup.
5. **G13.** Verify first, with a test, what happens to sent forwards when an API-origin PDS write ends `failed`. Then
   either cancel unsent forwards and repair, or extend the PDS retry.

### C3. Deletions everywhere

1. **G7, PDS-side deletions.**
   - An identity that was projected and is now absent in signed PDS state (C1.4) is a deletion, unless a pending local
     operation explains it. Require two consecutive signed observations.
   - It tombstones and propagates: ListenBrainz delete, Last.fm unlove for loves, and the manual list for Last.fm listens.
   - This **amends the B21 draft** ("snapshot absences do not invent deletes"). It also subsumes A2-4 and the
     signed-transition follow-up for A1-7.
2. **G4, upstream deletions.**
   - Absence-based, under R4, R7 and the guards.
   - Starts in report-only mode.
3. **G12, identity edits**, including LOVE-UPDATE-CALLER.
4. **G5 UI.** The "still on Last.fm — delete manually" list, and per-link reconcile status: last complete scan, pending
   repairs, guard trips.
5. **Queued under-sends now in scope:**
   - A2-4, A2-6, A2-7;
   - A1-5's pre-link survivor scan (performance only).

### NP. Now playing over the compat endpoints

1. Show the owner's own now playing on Feed (E2).
2. Kick the **`forward`** timer, not `outbox`, after a now-playing enqueue (E3).
3. Now playing takes the first Last.fm token, ahead of import, backfill and reconcile traffic (E4).
4. Forwarding follows each link's `forward_now_playing`, independent of `share_now_playing`. The share setting covers our
   own site only (E5, planner default).
5. Add a journey test: compat now playing → store → read API → fake Last.fm and ListenBrainz forward (E7).
6. Log `forward.nowplaying` outcomes as kind, status and service only, and log the ListenBrainz `listen_type`
   annotation (E8). Never log track names.
7. Fix the extra upstream now playing after `started_at_ms` is rewritten (E11).
8. **ADR 0005:**
   - §7.8 stays "never a PDS record" (E10).
   - Drop the "web form" claim from §12.2 (E12).
   - The UI keeps 30 s polling (E9).

## 3. Acceptance (each package)

- Every gap closed has a deterministic test. Use `fixedClock` and fake upstreams on `.test` hosts.
- **Convergence tests** cover each origin → each store, deletes included, and assert the R6 bounds in simulated time:
  - a 2 h outage followed by recovery;
  - an incomplete scan (no deletion);
  - a mass-deletion guard trip;
  - a tombstone blocking re-import;
  - Last.fm manual-delete listing.
- Readiness for every PR, unchanged:
  - exact-head `bash scripts/check-ts.sh`;
  - Astra ACCEPT;
  - hosted checks green on the same SHA;
  - a Codex review with no unresolved valid findings.
- ADR amendment drafts: G1 (§12.3), G7 (B21), R3 (relay trust), R5 residuals. Owner publishes them.

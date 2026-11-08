# Plan: linked-account sync, detailed now playing, MusicBrainz metadata

Status: **plan**, written 2026-11-08 by the orchestrating planner (Opus 5.5) from three read-only discovery reports against master `c147690`. Line numbers below refer to that commit.

Owner request:

1. Linking an account should keep all records in sync, on a best-effort basis.
2. Currently-playing information should be more detailed, especially "playing since".
3. Song metadata should be synced from MusicBrainz, on a best-effort basis.

## 0. Ground truth (discovery summary)

**Forwarding** (`worker/src/forward/*`, `worker/src/outbox/forward-enqueue.ts:101`)
- Forwarding is live, one-way and only covers what our own API, compat and web paths accept: scrobbles, love/unlove and now playing.
- Records that arrive through Jetstream from other clients are never forwarded. Neither are scrobbleBatch records or deletes.
- There is no backfill when a link is created and no per-link cursor (`linked_accounts`, `worker/src/do/schema.ts:524-537`).
- Imports are one-shot and user-started. Their origin `import` is never forwarded.
- Nothing calls `noteLinkError` (`worker/src/forward/links.ts:296`). The UI shows only `link.status`.
- The outbox has no maximum attempt count; a row leaves only when it ages out.

**Now playing** (`worker/src/do/read/now-playing.ts`, `now_playing` at `schema.ts:491-503`)
- There is one row per DID, holding `started_at_ms` (the server's receive time), duration, album, album artist, recording MBID, client and source.
- These fields are dropped: track number, release, release-group and artist MBIDs, ISRC, `submission_client_version` and `music_service`. `media_player` is never mapped.
- On a same-track resubmission, Last.fm refreshes the expiry and ListenBrainz keeps the row as it is.
- A scrobble never touches `now_playing`.
- `/api/v1` has no now-playing endpoint and the web app shows none. `shareNowPlaying` exists in the API (`worker/src/http/account.ts:54`) but has no UI.

**MusicBrainz**
- Nothing in the repo calls MusicBrainz today.
- Every egress uses `policyFetch` (`worker/src/node/policy-fetch.ts`): https only, no redirects, a 10 s deadline and byte caps, over the pinned transport. Raw `fetch` is banned.
- Upstream roots are config values validated by `upstream()` (`worker/src/node/config.ts:362-379`). Pacing is in `worker/src/forward/upstream-pacing.ts`. Extension timers are a closed list (`worker/src/do/timers.ts:77`).
- Migrations are append-only; the latest is 14. `scrobbles` and `loves` are `derived` tables, rebuilt from PDS records, so enrichment cannot live in their columns.
- The CSP is `img-src 'self' data:`.
- Suspected drift to verify: `scrobbleDto` (`worker/src/http/scrobbles-read.ts:70-87`) seems to omit v1.2 fields that the schema declares.

## 1. Cross-cutting rules (every slice)

- **Best effort.**
  - A user write or read never blocks or fails because of sync or enrichment.
  - All upstream work runs in extension timers with persisted state, backoff and bounded retries.
  - Failures show up as per-link or per-track state, never as request errors.
- **No server rewrites of user PDS records** for enrichment.
  - The server writes to the PDS only to create records for listens and loves pulled from a linked service (S3), and only through the existing import and outbox write path.
- **Egress.**
  - Every new request goes through `policyFetch` and the pinned transport, with its own caps.
  - New roots are validated with `upstream()` and documented in `config/atmusic.env.example`, `docs/operations.md` and ADR 0005 §3.8.
  - Enrichment requests (MusicBrainz, Cover Art Archive) carry no user identity: no DID, handle, token or IP.
  - Sync requests to a linked service carry only what that service requires: the remote username and the link's own credentials. They never carry the atproto DID, the handle or a viewer's IP.
  - User-Agent text names the repository URL, never a personal email.
- **UI.** Never render a DID as text; show handles, and DIDs may appear only in hrefs. Use the `web/src/components/format.ts` helpers for local time. Pass server error text through `scrubDids`. No new runtime dependencies.
- **Contracts.**
  - Additions are additive and optional only. Update `api/openapi.yaml`, `packages/core/src/api-types.ts`, `api/examples/` and `docs/planning/API.md`, and run `scripts/validate_contracts.py`.
  - Draft the ADR amendments in `docs/planning/AMENDMENTS-node.md` and ADR 0005 §16, explicitly amending the "not forwarded" text in §11.2.5 and §12.2:
    - **B21:** sync
    - **B22:** now playing
    - **B23:** MusicBrainz
  - Mark all three as drafts. Publishing them is an owner action.
- **Migrations.**
  - Append-only. Never edit an applied migration.
  - Add every new table to `TABLES` and `TABLE_CLASS`.
  - The tracks run in parallel, so the slice that lands second renumbers its migration when it rebases.
- **Tests.**
  - Use `fixedClock` and `seededRandom`. Fake upstreams sit on reserved `.test` hosts, wired through `routerTransport` and fakes beside `worker/test/node/support/fake-{lastfm,listenbrainz}.ts`.
  - Extend the features test so each new client provably gets the pinned transport.
  - A slice is ready for review only after `npm run typecheck`, `npm run lint` and `bash scripts/check-ts.sh` pass. A filtered run that executes zero tests is never evidence.

## 2. Track N: detailed now playing

### N1 Backend (base: this plan's branch)

1. **Migration.** Add nullable `now_playing` columns:
   - `updated_at_ms`, `track_number`
   - `release_mbid`, `release_group_mbid`, `artist_mbids` (JSON text), `isrc`
   - `submission_client_version`, `music_service`, `media_player`, `scrobbled_at_ms`

   Do **not** store `origin_url`; ADR 0005 already refuses it for privacy.
2. **Ingestion.**
   - Persist the fields that `lastfm/write-methods.ts` and `packages/core/src/protocol-map.ts` already map.
   - Also map ListenBrainz `media_player`, `submission_client_version` and `music_service` / `music_service_name`. The fixture `worker/test/node/listenbrainz/fixtures/web-scrobbler-playing-now.body` must keep them.
   - A same-track submission on either protocol keeps `started_at_ms`, bumps `updated_at_ms` and the expiry, and merges in any newly supplied non-null fields. ListenBrainz moves from `'keep'` to this behaviour.
3. **Playing-since accuracy.** When `acceptListens` accepts a scrobble whose artist and track keys match the current now-playing row:
   - set `scrobbled_at_ms`;
   - if its `listenedAt` is earlier than `started_at_ms`, and the gap is no more than `duration_seconds` (or 600 s without one), set `started_at_ms` to `listenedAt`. Scrobble timestamps are the track's real start time.
4. **API.**
   - `GET /api/v1/users/{did}/now-playing` returns `{ nowPlaying: NowPlaying | null, serverTime }` with `Cache-Control: no-store`.
   - Visitors get `currentNowPlaying` visibility. A signed-in owner reading their own entry gets it even when sharing is off, with `shared: false`.
   - `NowPlaying` is `{ artist, track, album?, albumArtist?, trackNumber?, durationSeconds?, recordingMbid?, releaseMbid?, releaseGroupMbid?, artistMbids?, isrc?, startedAt, updatedAt, expiresAt, scrobbledAt?, client?: { name, version? }, musicService?, mediaPlayer?, source: 'lastfm' | 'listenbrainz' | 'web', shared? }`. Times are ISO.
   - `GET /api/v1/feed/now-playing` (signed in) lists the followed accounts that are playing now, each with its handle, capped at 50.
5. **Compat.** ListenBrainz `playing-now` `additional_info` gains the newly stored fields. Last.fm output is unchanged, because its format has no slot for them.
6. **Docs.** Contracts and amendment B22.

**Acceptance:**
- Each field round-trips on both protocols.
- Same-track refresh works on both protocols.
- A scrobble corrects the start time and sets `scrobbledAt`.
- Both the share flag and the owner's private view are covered.
- The feed endpoint returns only followed accounts and respects their share flags.
- Expiry is covered, and contract validation passes.

### N2 Web (base: N1). Design direction (Opus, binding)

**`NowPlayingCard`** sits on the profile route, above the stats.
- **Layout.** A 64 px art tile on the left. Until M4 lands, it is a neutral glyph tile with no external images. The right side has:
  - an overline "Now playing" with a small equalizer glyph, static under `prefers-reduced-motion`;
  - the track title, strong;
  - an "artist — album" line;
  - a meta line.
- **Meta line.**
  - "Playing since 14:32", in local time, rendered as `<time datetime=ISO>`.
  - "· for 3 min", the elapsed time. It ticks every 15 s and is corrected for skew using `serverTime`.
  - "· via Web Scrobbler 3.1 · Spotify", built from the client name and version and the music service.
  - A small "Scrobbled" chip when `scrobbledAt` is set.
- **Progress.**
  - Shown only when `durationSeconds` is known. Text reads "1:23 / 3:45" and is clamped at 100%.
  - `role="progressbar"` with `aria-valuenow`, `aria-valuemax` and `aria-valuetext`.
  - With no duration there is no bar, and nothing pretends to be one.
- **Owner with sharing off.** A muted badge "Only you can see this" linking to settings.
- **Empty state.** Visitors see nothing. The owner sees one muted line, "Nothing playing right now".
- **Refresh.** Poll every 30 s while the document is visible, refresh at once when it becomes visible, and stop while hidden.

**Feed rail "Listening now".** A compact list of followed accounts that are playing: `@handle`, "track — artist", "since 14:32". Handles only. When a handle is unknown, use the copy "this account".

**Settings.** A toggle "Share what I'm playing now", bound to `PATCH` `shareNowPlaying`. Helper text: "Others can see your current track on your profile. Your scrobbles aren't affected."

**Style.** Use the existing `screens.css` tokens. No new dependencies.

**Tests.**
- Vitest: elapsed ticking under fake timers, progress ARIA, the sharing-off badge, and no DID text.
- Playwright: a profile showing a now-playing entry, plus an update to the accessibility spec.

## 3. Track M: MusicBrainz metadata

The owner's word is "synced". Our definition: canonical MusicBrainz data is resolved, stored, kept fresh and attached to every read surface. The user's own submitted names stay authoritative for display. MusicBrainz data fills gaps (album, duration, MBIDs, cover art) and provides links. Records are never rewritten on the PDS.

### M1 Enrichment core and `/api/v1` (base: this plan's branch)

1. **Config.**
   - `MUSICBRAINZ_API_ROOT`, default `https://musicbrainz.org/ws/2/`.
   - `MUSICBRAINZ_ENABLED`, default `true`, as an operator kill switch.
   - MusicBrainz requests only send the User-Agent `atmusic/<version> ( https://github.com/junepark678/atproto_music )`.
2. **Client.** Add `worker/src/musicbrainz/client.ts`.
   - It runs over `BoundPolicyFetch` with its own `MB_CAPS`.
   - Outcomes are `ok`, `not_found`, `status`, `network` and `malformed`.
   - It uses `fmt=json`, and Lucene-escapes the search terms.
3. **Pacing.**
   - Add a MusicBrainz lane in `upstream-pacing.ts`: global, 1 request/s, never sleeping, in the same style as the existing lanes.
   - It honours 503 and `Retry-After`.
   - Backoff state persists across restarts through the table's `next_attempt_ms`.
4. **Storage** (new migration).
   - Create `mb_tracks`, keyed by `(artist_key, track_key, album_key)`, with `''` for no album. Columns:
     - lookup state: `status` (`pending`, `matched`, `unmatched` or `failed`), `priority`, `attempts`, `next_attempt_ms`, `last_attempt_ms`;
     - what was submitted: `submitted_recording_mbid`;
     - how it matched: `matched_by` (`mbid` or `search`), `score`;
     - the match: `recording_mbid`, `title`, `artist_credit`, `artist_mbids` (JSON), `release_mbid`, `release_title`, `release_group_mbid`, `duration_ms`, `isrcs` (JSON), `first_release_date`;
     - timestamps: `synced_at_ms`, `created_at_ms`.
   - Index `(status, next_attempt_ms, priority)`.
   - Class the table **non-derived**: it cannot be rebuilt from PDS records, and refetching at 1 request/s takes hours. Confirm this matches backup and restore semantics.
5. **Enqueue.** This is an insert-or-ignore with no egress. It happens:
   - on every scrobble, batch listen and love projection (`do/write/apply-record.ts`), which covers both our own writes and Jetstream;
   - on a now-playing upsert, at high priority;
   - in a low-priority background seeding of distinct keys from `scrobbles`, chunked per timer run.
6. **Resolver timer `musicbrainz`.** It needs an `EXTENSION_TIMER_NAMES` entry, registration in `node/features.ts`, and the features-test transport proof.
   - **Submitted recording MBID.** If one exists, call `GET recording/{mbid}?inc=artists+releases+release-groups+isrcs`. A 404 falls through to search.
   - **Search.** Run `recording?query=recording:"T" AND artist:"A" [AND release:"R"]&limit=5`.
     - Accept the top candidate only when its score is at least 90, the music key of its title equals `track_key`, and the music key of a credited artist name equals `artist_key`.
     - Choose the release whose title key equals `album_key`. Otherwise take the earliest official release in an Album release group, and otherwise the earliest official release.
   - **Outcome schedule.**

     | Outcome | Next step |
     | --- | --- |
     | Matched | Refresh after 90 days at the lowest priority. This is the "sync". |
     | Unmatched | Retry after 30 days. |
     | 5xx, 503 or network error | Back off `60 s · 2^n`, capped at 24 h. |
     | 8 failed attempts | Mark `failed` and retry after 30 days. |

   - **Budget.** At most 1 request/s, and a few requests per run. Re-arm at the pacer's available-at time.
7. **Read side.**
   - Add an optional object to `/api/v1` `Scrobble` (history, feed, recent), `Love` and `NowPlaying`:
     `musicbrainz: { recordingMbid, title, artistCredit, artistMbids, releaseMbid?, releaseTitle?, releaseGroupMbid?, durationSeconds?, matchedBy, syncedAt }`
     It joins on `(artist_key, track_key, album_key)`. `NowPlaying` gets it only if N1 has landed; otherwise this moves to M2.
   - Top artists, tracks and albums gain optional MBIDs where they are unambiguous.
   - In a separate commit, confirm and fix the `scrobbleDto` v1.2 drift.
8. **Docs.** Amendment B23, operations docs and the env example.

**Acceptance** (each against a fake MusicBrainz server):
- MBID lookup.
- Search match and low-score rejection.
- Artist-credit match.
- 503 with `Retry-After`.
- One request per second under `fixedClock`.
- Persistence across a restart.
- The kill switch.
- Enqueue from a Jetstream projection.
- The read APIs carry `musicbrainz`.
- Contracts validate.
- The pinned-transport proof.

### M2 Propagation (base: M1; rebase onto N1 if it has merged)

- **Compat.**
  - Fill the Last.fm `mbid` leaves (track, artist and album) when the stored value is empty, and the `track.getInfo` duration.
  - Add ListenBrainz `mbid_mapping` to listens. Update the goldens.
- **Forwarding.**
  - A ListenBrainz love or unlove with no submitted MBID falls back to the matched recording MBID.
  - If the lookup is still pending, defer the row for up to 24 h. Do not ignore it.
  - Rows are marked `ignored` with `no_recording_mbid` only after the track resolves as unmatched.
- **Now playing.** `NowPlaying.musicbrainz`, if M1 didn't already add it.

### M3 Web display (base: M2)

- **Scrobble rows, stats lists and the now-playing card.**
  - When the submitted album is missing, show the MusicBrainz album, muted, with `title="From MusicBrainz"`.
  - Show the duration where it is useful.
  - Link the track, artist and album to `https://musicbrainz.org/{recording|artist|release}/{mbid}` with `rel="noopener noreferrer"` and a small external-link affordance.
- The submitted names stay the primary text.

### M4 Cover art (optional; base: M3)

- **Fetch.**
  - After a match, a background job fetches the Cover Art Archive `release/{mbid}/front-250`, falling back to `release-group/{mbid}/front-250`.
  - It uses `policyFetch` with manual following of at most two redirects, each to an https `archive.org` / `*.archive.org` host.
  - Responses are capped at 512 KB and must be `image/jpeg`, `image/png` or `image/webp`.
- **Storage.**
  - Store the images in a blob table `mb_cover_art`.
  - Evict least-recently-used images under `COVER_ART_CACHE_MB` (default 200).
- **Serving.**
  - `GET /api/v1/cover-art/{releaseMbid}` serves from our origin with long-lived caching, and returns 404 when nothing is cached. The request path never makes an outbound request.
  - The CSP stays `img-src 'self' data:`, and viewers never contact archive.org.
- The UI art tiles use these images.

## 4. Track S: linked-account sync

**Definition of "in sync, best effort":**

- **(a)** Every listen and love we index, however it arrived, reaches each linked service that can represent it.
- **(b)** New listens and loves made directly on a linked service reach the user's atproto repo.
- **(c)** History is pushed when a link is created, within each service's limits.
- **(d)** Deletes propagate where the service can represent them.
- **(e)** The user can see the sync state.

**Out of scope:**
- Follows and settings, which have no upstream equivalent.
- Last.fm deletes and unlove detection, because Last.fm has no API for either.

### S1 Forward everything we index (base: this plan's branch)

- **Projection hook.** Forward from the projection (`do/write/apply-record.ts`) for:
  - scrobbles;
  - scrobbleBatch, per listen;
  - love creates and deletes;

  that arrive from other clients through **live** Jetstream commits. Exclude snapshot, repair and discovery backfill, which belong to S2.
- **Exactly once: the replay contract** (planner ruling, 2026-11-08, replacing the earlier "ledger with an age bound" idea).
  - **Admission marker.** Every listen and love identity gets one durable, compact *admission marker*, attached to its existing durable identity (`listen_keys` / `record_state`). It is written in the same transaction as the first API or compat acceptance, import, or projection. It records:
    - the acceptance sequence or time;
    - the path: `api`, `import`, `live` or `snapshot`;
    - the import source service, if any.
  - **Admission happens at most once per identity lifetime.** Live forwarding enqueues only on the first admission through the `api` or `live` path, for the links active at that moment. A replay of a known identity, at any lateness, enqueues nothing.
  - **The marker lives as long as the identity.** It lasts exactly as long as the indexer keeps that record identity or its tombstone. Forwarding suppression therefore matches the indexer's own resurrection suppression. If the indexer would re-project an identity as new, forwarding treats it as new too.
  - **No cutoff by age.** There is no TTL, no "echo horizon" and no listen-age exclusion used for dedupe. A replay suppressed beyond the identity's lifetime is out of contract and must not be promised. No new ListenBrainz age limit; Last.fm keeps its 13-day limit when sending.
  - **Link generations.** Each link has a generation that changes when the remote account changes, and forward rows carry it. For each link generation, every indexed identity is forwarded at most once, either by live admission or by S2 backfill, and the admission marker decides which. Backfill covers what live admission did not enqueue for that generation: identities admitted before the generation started, and `snapshot`-path identities admitted after it.
  - **Outbox cleanup.** Per-link send state stays in `forward_outbox`. Because re-admission is blocked by the marker, not by outbox rows, terminal outbox rows may be removed by a periodic, bounded, indexed sweep after their terminal age. There is never a global scan on each success. This sweep is optional for S1.
  - **Storage reporting.** Report marker and outbox row counts and bytes in the operator metrics and admin socket. There is no hard quota beyond existing disk checks.
- **Imported listens.** Still never forwarded to the service they came from.
  - Forward them to other services only where the per-listen import source is known. Otherwise keep today's exclusion.
- **Love deletes.** Deleting a love from another client forwards an unlove, keeping the love-head ordering.
- **Error state.**
  - Wire `noteLinkError` for persistent non-revocation failures, such as a run of consecutive failures or a rejected key.
  - Clear it on the next success.
  - Record `last_success_ms` and `last_failure_ms`.
- Age limits are unchanged; Last.fm still takes only 13 days.

### S2 Backfill, sync state and relink (base: S1)

- **Migration.** New `linked_accounts` columns:
  - backfill: `backfill_state` (`pending`, `running`, `done` or `skipped`), `backfill_cursor`, `backfill_total`, `backfill_done`;
  - pull: `pull_enabled` (default 1), `pull_watermark_ms`, `last_pull_ms`;
  - `sync_remote_user`.
- **When backfill starts.** On link creation, on a relink to a different `remote_user`, and when `forwardScrobbles` turns on.
- **How it runs.** The job enqueues historical forward rows newest first, in chunks of about 500 per run. They are low priority, so live scrobbles and now playing go first.
  - **Last.fm:** scrobbles from the last 13 days, plus every love (`track.love`).
  - **ListenBrainz:** every scrobble (`listen_type: import`, 100 per request), plus loves that have a recording MBID. With M2, matched MBIDs count too.
  - Backfill rows age from their enqueue time, not their listen time, so they don't expire on arrival.
  - Listens imported from the same service are excluded.
- **Relink.**
  - With a different `remote_user`: expire the held rows meant for the old account, reset the cursor and watermark, and run the backfill again.
  - With the same `remote_user`: resume as today.
- **API.** `Link` gains an optional `sync` object:
  `{ backfill: { state, done, total }, pullEnabled, lastSuccessAt?, lastFailureAt?, lastError?, lastPulledAt?, queued, failed }`
  `PATCH` accepts `pullEnabled`. Document it in OpenAPI, API.md and the examples.

### S3 Continuous pull from the linked service (base: S2)

- **Poller.** A per-link poller on an extension timer.
  - It runs every 10 min (configurable) with jitter, for links where `pull_enabled` is set.
  - New links default to on, and existing links switch on at rollout.
- **Last.fm.**
  - `user.getRecentTracks` from the watermark minus a 1 h overlap, skipping the now-playing item.
  - `user.getLovedTracks` newest first, scanning down to the boundary of the last *completed* scan: the upstream timestamp of the newest love that scan saw, ties at that timestamp included. A love we already know locally is not a stopping point, because it may have been created here and forwarded. Loves are creates only; Last.fm unloves cannot be detected incrementally.
- **ListenBrainz.**
  - `/1/user/{name}/listens?min_ts=` the watermark minus 3600. With `min_ts`, ListenBrainz returns the earliest page first and lists it in descending order, so page forward until caught up.
  - `/1/feedback/user/{name}/get-feedback?score=1`, using the same completed-scan boundary as Last.fm, with metadata requested. If an item still has no artist and track, resolve it through the MusicBrainz recording seam when M1 or M2 provides one. Otherwise skip it and count it, and never create a love without artist and track.
- **Tombstones.** A listen or love deleted locally is recorded as a tombstone: the DID, the listen second and keys, or the love key or MBID. A pull never recreates a tombstoned item, including one that Last.fm cannot delete, or that ListenBrainz has not finished deleting.
- **Echo prevention.**
  - A pulled listen is a duplicate when the DID already has **any** listen at the same `listenedAt` second, whatever its artist and track keys. The listen may be indexed, pending in the outbox or in `listen_keys`. This covers Last.fm corrections.
  - Loves match on the love key or the recording MBID.
- **Write path.**
  - Reuse the import writer (scrobbleBatch through the outbox, origin `import`, source service recorded). That needs a live OAuth write session.
  - With no session, hold the items and expose `needsReauth` in the link sync state.
  - Advance the watermark only past items that were staged durably.
- **Cross-forwarding.** Pulled items are forwarded to the user's *other* linked services, never back to their source.
- **Watermark start.** The link's creation time, or the rollout time for existing links. Full history stays the explicit one-shot import.
- **Pacing.** Last.fm uses the shared global bucket, and pulls yield to forwarding. ListenBrainz uses its per-key bucket.
- **Tests:**
  - overlap dedupe;
  - an echo after a Last.fm correction;
  - a missing session;
  - cross-forwarding;
  - forward, then pull, produces no new record;
  - pause and resume through `pullEnabled`.

### S4 ListenBrainz delete propagation (base: S3)

- **What triggers it.** A scrobble or batch listen that is deleted, through our API or a Jetstream delete, and that went to a ListenBrainz link.
- **Lookup.** Find the `recording_msid` via `/1/user/{name}/listens` within ±1 s of the listen time, matched on the artist and track keys.
- **Delete.** Send `POST /1/delete-listen {listened_at, recording_msid}`. ListenBrainz deletes asynchronously: HTTP 200 only means the request was accepted, so mark the row `sent` and don't poll to confirm. S3 tombstones stop the listen from being pulled back meanwhile.
- **Ambiguity.** If the lookup finds more than one candidate, or none, mark the row `ignored`. Never delete an arbitrary match.
- **Retries.** Back off on transport failures and retry for up to 7 days.
- **Last.fm.** Record `unsupported`, since there is no API.
- **Before implementing.** Check the live ListenBrainz API documentation for `delete-listen` and the listens response shape. If they differ from this description, report back rather than guessing.

### S5 Web link sync status (base: S2; can merge after S3)

**Design direction (Opus, binding)** for `web/src/routes/settings-links.tsx`. Each link card shows:

- **Status pill:** Active, Needs reconnect or Error.
- **"Last synced"**, in local time, or "Not yet".
- **History progress.** While the backfill runs: "Sending history: 1,240 of 3,000", with an accessible progress bar.
- **Toggles:**
  - "Send scrobbles and loves", which is `forwardScrobbles`;
  - "Send now playing", which is `forwardNowPlaying`;
  - "Bring in new scrobbles from <service>", which is `pullEnabled`.
- **Errors.** The last error in plain words, passed through `scrubDids`. When `needsReauth` is set, show "Reconnect your account to keep importing."
- **Limits.** One muted line, shown only for Last.fm: "Last.fm accepts scrobbles from the last 14 days and doesn't support deleting them."

The copy stays short, and no DIDs are shown.

## 5. Sequencing, ownership and PRs

- **Leads.** There are two backend leads, each on Sol:
  - Lead 1 owns Tracks N and M.
  - Lead 2 owns Track S.
- **Each lead:**
  - fans implementation out to Luna in worktrees;
  - gets Astra reviews (correctness, security, acceptance) and routes findings back through Sol to Luna;
  - runs the UI slices (N2, M3, S5) through Luna, using the design direction above as written. A design question goes back to the orchestrator; it is not improvised.
- **Parallel start.** N1, M1 and S1 start immediately.
- **PRs.**
  - Every slice gets its own PR, stacked as listed.
  - Each stays a draft until its scoped acceptance evidence is recorded in the PR body, then is marked ready.
  - Commit small and push often. Stage only the slice's files. Run the secret scan (`scripts/test/secret-scan.test.ts`) before each push.
  - Never force-push to master or to someone else's branch.

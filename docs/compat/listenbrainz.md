# ListenBrainz-compatible API

This is the client-facing specification of the ListenBrainz-compatible API that atmusic serves under `/1/` ([ADR 0005 §8](../adr/0005-local-node-host-and-compat-apis.md#8-listenbrainz-compatible-api-workersrclistenbrainz)). Where this page and the ADR disagree, the ADR wins and this page is a bug.

Examples use the production origin `https://music.214510.xyz`.

## Endpoint and tokens

- **API root:** `https://music.214510.xyz/`; every endpoint is under `/1/`. HTTPS on port 443 only.
- **Tokens** are issued by atmusic, not by ListenBrainz: create one under Settings → Credentials (a UUID, shown once; you can hold several, each labelled). A MetaBrainz token, including a `meba_` OAuth token, is not valid here.
- **Header:** `Authorization: Token <token>`. The scheme is matched case-insensitively (Pano sends `token`), and `Bearer` is accepted too.
- Every `/1/` response sends `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Max-Age: 21600`; `OPTIONS` answers 200. Cookies are never read on `/1/`.

## Client setup

| Client | Setting | Value |
| --- | --- | --- |
| Pano Scrobbler | ListenBrainz (custom) API root | `https://music.214510.xyz/` (Pano appends `1/`), and your token |
| multi-scrobbler | ListenBrainz client `url` | `https://music.214510.xyz/` (it appends `1/`), and your token |
| Jellyfin (ListenBrainz plugin) | API URL | `https://music.214510.xyz/` (the plugin appends `1/`), and your token |
| Music Assistant | ListenBrainz API URL | `https://music.214510.xyz/` (it appends `1/`), and your token |
| Navidrome | `ND_LISTENBRAINZ_BASEURL` | `https://music.214510.xyz/1/` (the base already includes `/1/`); link your token in Navidrome's personal settings |
| Web Scrobbler | Custom ListenBrainz entry, API URL | `https://music.214510.xyz/1/submit-listens`, and your token |

### Web Scrobbler: scrobbles and now playing only

Web Scrobbler sends scrobbles and now playing to the custom URL, but its **love and unlove ignore the custom URL** and call `api.listenbrainz.org` with your token. A love from Web Scrobbler therefore never reaches atmusic, and the token we issued is sent to MetaBrainz. **Do not use love with the custom ListenBrainz entry.** If you did, revoke that token under Settings → Credentials and create a new one: MetaBrainz rejects our tokens, but the value has still left atmusic.

## Authentication errors

All are 401 with ListenBrainz's own texts: no header "You need to provide an Authorization header."; a header without a space "Provided Authorization header is invalid."; an unknown token "Invalid authorization token.".

`GET /1/validate-token` reads the header when it starts with `token ` (any case), otherwise `?token=`:

- valid: 200 `{"code":200,"message":"Token valid.","valid":true,"user_name":"<username>"}`;
- invalid: 200 `{"code":200,"message":"Token invalid.","valid":false}`;
- none: 400 `{"code":400,"error":"You need to provide an Authorization token."}`.

`valid` is a JSON boolean.

## POST /1/submit-listens

The token and its rate limit are checked **before any body byte is read**: an unauthenticated or rate-limited submit gets its 401 or 429 at once.

**Envelope checks**, in ListenBrainz's order and with its messages, all 400 `{"code":400,"error":"…"}`: a body over 10,240,000 bytes; unparsable JSON; a top level that is not an object; `payload` not a list; an empty payload; more than 1,000 listens; a body larger than 10,240 bytes per listen; a bad `listen_type` (`single`, `import` or `playing_now`); `single` or `playing_now` with more than one listen; a missing key ("Invalid JSON document submitted.").

**Per-listen checks** follow ListenBrainz's `validate_listen`: `listened_at` coerced to an integer, at least 1033430400 and at most now + 3,600 s ("Value for key listened_at is too high."); no `listened_at` on `playing_now`; only the allowed keys; `artist_name` and `track_name` required non-empty strings after trimming; an empty `release_name` is removed; `duration` and `duration_ms` not both, each in range; empty or null MBIDs removed, other invalid ones "`<key>` MBID format invalid."; at most 50 tags of at most 64 characters (validated, then not stored); NUL anywhere rejected. The offending listen is not echoed in the error.

**Success:** 200 `{"status":"ok"}`. `single` and `import` (a client's offline-cache flush, not an import job) are queued as scrobbles; `playing_now` sets your now playing for `duration`, else `duration_ms`/1000, else 600 s (an identical current track is ignored but still answers ok). With the server's publication gate closed: 503 `{"code":503,"error":"Cannot submit listens to queue, please try again later."}`. Over your daily limit (3,000 per rolling 24 h): 429 "Daily listen limit exceeded." with `Retry-After` and the `X-RateLimit-*` headers.

Mapped fields: `release_name` → album, `additional_info.release_artist_name` → album artist, `tracknumber`, `artist_mbids`, `recording_mbid`, `release_mbid`, `release_group_mbid`, `isrc` (uppercased), `duration` or `duration_ms` (rounded half up), `submission_client` (plus `submission_client_version`) and `music_service`. Not stored: `tags`, `origin_url`, `spotify_id`, `media_player*`, `work_mbids`, `track_mbid`.

### Deviations from ListenBrainz

These follow from listens becoming signed records on your own PDS. **None of them turns an accepted request into an error:** a 400 is returned only for input ListenBrainz itself rejects, because clients treat a 400 as fatal (Web Scrobbler drops the whole batch as an authentication error).

- **Listens up to +3,600 s are accepted.** ListenBrainz accepts `listened_at` up to one hour ahead; our record format allows at most 300 s after creation. A listen between now + 300 s and now + 3,600 s is answered 200 at once, and its record is written once it becomes valid: the write is deferred until `listened_at − 300 s`. Duplicate detection and forwarding happen immediately.
- **Names ListenBrainz accepts but our validator refuses** (for example more than 256 characters, or malformed text) are answered 200 and **not written**. Each such listen is listed for 30 days under `GET /api/v1/account/ignored-listens` (Settings) with the reason and the first 128 characters of the names; the other listens of the request are processed normally. A batch of three with one over-long name answers 200, writes two and lists one.
- **`return_msid`** is honoured for `playing_now` only, as ListenBrainz does: `{"status":"ok","recording_msid":"<msid>"}`. For `single` and `import` it is ignored and the answer is `{"status":"ok"}`.
- **Feedback score -1 ("hate") clears a love**; we have no hate state.
- MSIDs are a pure function of the normalised artist and track (UUIDv5), so equal metadata always has the same `recording_msid`. There is no MusicBrainz mapping: `mbid_mapping` is never returned.
- Statistics are computed on read and anchored on now, so ListenBrainz's "if today is Monday, use last week" behaviour does not occur.

## Reads

Reads show only indexed, proof-verified listens. `{user}` is a DID, a username or a verified handle; unknown users are 404 `{"code":404,"error":"Cannot find user: <user>"}`, and `user_id` echoes the path as typed.

| Endpoint | Notes |
| --- | --- |
| `GET /1/user/{user}/listens` | `min_ts`, `max_ts` (exclusive; `max_ts <= min_ts` is 400), `count` (default 25, capped at 1,000; negative is 400). Newest first. `{payload: {count, listens, latest_listen_ts, oldest_listen_ts, user_id}}`; each listen `{listened_at, inserted_at, recording_msid, user_name, track_metadata {artist_name, track_name, release_name?, additional_info}}` |
| `GET /1/user/{user}/playing-now` | `{payload: {count, user_id, playing_now: true, listens: [...]}}`, or count 0 |
| `GET /1/user/{user}/listen-count` | `{payload: {count}}` |
| `GET /1/stats/user/{user}/artists`, `/releases`, `/release-groups`, `/recordings` | `range` (`this_week`, `week`, `this_month`, `month`, `quarter`, `half_yearly`, `this_year`, `year`, `all_time`; invalid is 400 "Invalid range: x"), `count` (default 25, cap 1,000), `offset`; 204 with an empty body when the range has no listens |
| `GET /1/stats/user/{user}/listening-activity` | Buckets per range: days, months, or years with listens |
| `GET /1/stats/user/{user}/daily-activity` | Every weekday with 24 hourly buckets, zero-filled, UTC |
| `GET /1/feedback/user/{user}/get-feedback` | `score`, `count`, `offset`, `metadata` |
| `GET /1/user/{user}/following`, `/followers` | From the music follow records |

Not implemented (404): `artist-map`, `era-activity`, `genre-activity`, `artist-evolution-activity`, `/1/stats/sitewide/*`, `/1/metadata/*`, `/1/latest-import`, `/1/export/*` and playlists.

## Writes besides submit-listens (token required)

- `POST /1/feedback/recording-feedback {recording_msid | recording_mbid, score}`: 1 loves, 0 unloves, -1 clears a love. An MSID is resolved through your indexed listens, your current now playing and your scrobbles not yet indexed, so a love right after a scrobble works; an MSID with nothing to match answers 200 `{"status":"ok"}` and stores nothing.
- `POST /1/delete-listen {listened_at, recording_msid}`: deletes your newest matching record at that second; `{"status":"ok"}`.
- `POST /1/playing-now/delete {client?}`: no current entry is 200 "Playing now already cleared"; an entry from a different stored client is 404; otherwise the entry is cleared, 200 "Playing now cleared successfully".

## Rate limits

30 requests per 10 s per IP for unauthenticated requests (an IPv6 /64 counts as one address) and 100 requests per 10 s per token; a request with a valid token is limited by its token only. Every answer carries `X-RateLimit-Limit`, `-Remaining`, `-Reset`, `-Reset-In` and `Access-Control-Expose-Headers`. Over the limit: 429 `{"code":429,"error":"You have exceeded your rate limit. See the X-RateLimit-* response headers for more information on your current rate limit."}`.

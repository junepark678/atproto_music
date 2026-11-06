# Last.fm 2.0-compatible API

This is the client-facing specification of the Last.fm-compatible API that atmusic serves at `/2.0/` ([ADR 0005 §7](../adr/0005-local-node-host-and-compat-apis.md#7-lastfm-20-compatible-api-workersrclastfm)). It is what a scrobbler author or a user configuring a client needs. Where this page and the ADR disagree, the ADR wins and this page is a bug.

Examples use the production origin `https://music.214510.xyz`. The lexicon prefix is deploy-time configuration (`dev.pythonplayer123.music` in production).

## Endpoint

- **API root:** `https://music.214510.xyz/2.0/`. The slash-less `/2.0` is the same endpoint.
- **Authorization page:** `https://music.214510.xyz/api/auth/` and `https://music.214510.xyz/api/auth` (both work, with or without the slash). Both answer 302 to the approval page `/lastfm/authorize`, keeping the query string byte for byte.
- HTTPS on port 443 only: the service listens on a loopback address behind the owner's tunnel or reverse proxy, and nothing else is public.

### Clients built on `lastfm-ts-api` (multi-scrobbler and others)

`lastfm-ts-api` always uses `node:https` and takes only a hostname, a path and a timeout. **Every `lastfm-ts-api` client, including multi-scrobbler, must use `https://music.214510.xyz/2.0/`** (hostname `music.214510.xyz`, path `/2.0/`). It cannot use the loopback address `http://127.2.0.1:8888`, any `http://` URL, or any port other than 443.

## Client setup

| Client | Account type or field | Value |
| --- | --- | --- |
| Pano Scrobbler | GNU FM | API root `https://music.214510.xyz/` (Pano appends `/2.0/`); sign in through the browser (web flow), or with your username and an **app password** (mobile flow) |
| multi-scrobbler | Last.fm-compatible (`lastfm`/`librefm` source or client) | `urlBase: https://music.214510.xyz/2.0/`; its authorization opens `https://music.214510.xyz/api/auth?api_key=…&cb=…`, which works without the slash |
| Any desktop client using `auth.getToken` | API root | `https://music.214510.xyz/2.0/`; the client opens `https://music.214510.xyz/api/auth/?api_key=K&token=T` and you approve it |
| Clients that let you enter an api_key and secret | API key and secret | Create a pair under Settings → Credentials (an *issued app*); the client must then sign every write with that secret |

Navidrome, Jellyfin, Music Assistant and Web Scrobbler talk to the ListenBrainz-compatible API instead; see [listenbrainz.md](listenbrainz.md).

## Transport

- Read methods accept GET or POST. Write and auth methods (`track.scrobble`, `track.updateNowPlaying`, `track.love`, `track.unlove`, `library.removeScrobble`, `auth.getMobileSession`) require POST; a GET answers error **3** "Invalid Method - this method must be called with POST".
- Parameters come from the query string and an `application/x-www-form-urlencoded` UTF-8 body. Names are case-sensitive. A parameter that appears twice, anywhere, is error **6**. Bodies are capped at 1 MiB.
- **Format:** `format=json` (query or body) gives JSON; otherwise an `Accept` header containing `application/json` gives JSON; otherwise XML. `raw=true` drops the `<lfm>` wrapper in XML. `callback` (JSONP) is ignored: the answer is plain JSON with `X-Content-Type-Options: nosniff`.
- **Content types:** `text/xml; charset=utf-8` and `application/json; charset=utf-8`.
- **CORS:** read methods send `Access-Control-Allow-Origin: *`; write and auth methods send no CORS headers. Cookies are never read on `/2.0/`.

### Encoding

- JSON: a leaf element with attributes is `{…attributes, "#text": text}` (an empty text is still `"#text":""`); container attributes are under `"@attr"`. Every list is always a JSON array, `[]` for none and a one-element array for one item: `recenttracks.track`, `trackscrobbles.track`, `lovedtracks.track`, `toptracks.track`, `topartists.artist`, `topalbums.album`, `weeklychartlist.chart`, `weeklyartistchart.artist`, `weeklyalbumchart.album`, `weeklytrackchart.track`, `friends.user`, `artists.artist`, `toptags.tag`, `album.tracks.track`, `similar.artist` and `image`. Every paged container carries `@attr {user, page, perPage, totalPages, total}`, also when empty. Only `scrobbles.scrobble` is an object when one entry was submitted, as on Last.fm.
- Every number is a string, except `scrobbles.@attr.accepted` and `ignored`, `user.registered.#text` and `session.subscriber`.
- XML escapes `& < > " '` and drops characters XML 1.0 does not allow.
- Success is `<lfm status="ok">…</lfm>`. `track.love` and `track.unlove` answer `<lfm status="ok"/>` (XML) or `{}` (JSON).
- Errors are `<lfm status="failed"><error code="N">text</error></lfm>` or `{"error": N, "message": "text"}`. Read `lfm/@status` or the JSON `error` member; the HTTP status (table below) is a convenience.

## Authentication

**api_key.** Any non-empty `api_key` of at most 64 characters identifies the client; a missing one is error **10**. The key never grants access on its own: writes and auth calls are authorised by credentials this server issued (a session key, an approved token, or an app password). Your Bluesky or PDS password is never used and must never be entered into a scrobbler.

**Signatures (`api_sig`)** are checked only for the `auth.*` methods and the write methods; read methods ignore `api_sig` whether present, absent or wrong. The signature is MD5, in lowercase or uppercase hex, of every received parameter except `api_sig`, `format` and `callback` (including `method`), sorted by name in byte order (so `artist[10]` sorts before `artist[1]`), concatenated as `name` + `value` with the decoded UTF-8 values, followed by the secret. We sign exactly what was received, so parameters a client leaves out are simply absent.

- With an **issued app key** (Settings → Credentials) or a **known public pair** (by default Pano Scrobbler's), `api_sig` must verify, else **13**.
- With any **other api_key** the client signed with its own embedded secret, which we cannot know: `api_sig` must be present and 32 hex characters, else **13**, and it is not verified. Authorisation then rests on the session key, token or app password.

### Desktop flow

1. `auth.getToken` (signed) returns `<token>`: 32 hex characters, valid 60 minutes, single use, bound to the calling `api_key`.
2. The client opens `https://music.214510.xyz/api/auth/?api_key=K&token=T`. Signed in to atmusic, you see the client's name (labelled **unverified** unless it is an app you issued, with the time the token was requested) and approve it.
3. `auth.getSession {token}` (signed, the same `api_key`) returns `<session><name>{username}</name><key>{sk}</key><subscriber>0</subscriber></session>`, or `{"session":{"name","key","subscriber":0}}`. Errors: unknown or consumed token, or another `api_key`, **4**; not yet approved **14**; expired **15**.

### Web flow

`https://music.214510.xyz/api/auth?api_key=K&cb=URL` (with or without the slash). After you approve, the page sends you to `cb` with `?token=T`, or `&token=T` when `cb` already has a query (multi-scrobbler sends `cb=http://localhost:9078/librefm/callback?state=x`). The client then calls `auth.getSession`. `cb` must be an absolute URL; `javascript:`, `data:`, `vbscript:` and `file:` are refused, app links such as `pano://` are allowed, and the page shows the destination host before you approve. Denying stays on the page.

### Mobile flow

`auth.getMobileSession {username, password}`, POST and signed. `username` is your atmusic username, your verified handle or your DID. `password` is an **app password** created under Settings → Credentials (24 characters, shown once). Wrong credentials are **4**; `authToken` (the deprecated `md5(password)` form) is **4** "authToken is not supported; use password"; more than 10 failures per (username, IP) or 30 per IP in 15 minutes is **29**.

### Session keys

`sk` values are 32 hex characters, never expire, and are listed under Settings → Credentials with the client name, creation time and last use; revoke them there. A missing or unknown `sk` on an authenticated method is **9**. On a read method an `sk` only identifies you (for `user.getInfo` without `user`, or the `loved` flags), and an unknown one is ignored.

## Methods

| Method | HTTP | Auth | Notes |
| --- | --- | --- | --- |
| `auth.getToken` | GET/POST | sig | Desktop flow |
| `auth.getSession` | GET/POST | sig, `token` | Desktop and web flows |
| `auth.getMobileSession` | POST | sig, `username`, `password` | App password |
| `track.scrobble` | POST | sk, sig | Below |
| `track.updateNowPlaying` | POST | sk, sig | Below |
| `track.love`, `track.unlove` | POST | sk, sig | `artist`, `track`; answers `<lfm status="ok"/>` / `{}` |
| `library.removeScrobble` | POST | sk, sig | GNU FM extension (Pano): `artist`, `track`, `timestamp` |
| `user.getRecentTracks` | GET/POST | none | `user`, `limit` (default 50, 1–200), `page`, `from`, `to` (exclusive), `extended` |
| `user.getTrackScrobbles` | GET/POST | none | `user`, `artist`, `track`, `limit`, `page`, `from`, `to`; the recent-tracks shape under `trackscrobbles` |
| `user.getInfo` | GET/POST | none (`sk` means yourself when `user` is missing) | Profile and all-time counts |
| `user.getTopArtists`, `user.getTopAlbums`, `user.getTopTracks` | GET/POST | none | `period` (`overall`, `7day`, `1month`, `3month`, `6month`, `12month`), `limit` (default 50, at most 1000), `page` |
| `user.getLovedTracks` | GET/POST | none | `limit` (default 50, at most 1000), `page` |
| `user.getWeeklyChartList` | GET/POST | none | Weeks start on Sundays at 12:00 UTC |
| `user.getWeeklyArtistChart`, `user.getWeeklyAlbumChart`, `user.getWeeklyTrackChart` | GET/POST | none | `from`, `to`; default the most recent complete week |
| `user.getFriends` | GET/POST | none | The accounts the user follows, paged |
| `library.getArtists` | GET/POST | none | Artist play counts, paged |
| `track.getInfo` | GET/POST | none | `artist`+`track` or `mbid`, `username`; `duration` in milliseconds; with `username`, `userplaycount` and `userloved` |
| `artist.getInfo`, `album.getInfo` | GET/POST | none | `username` adds `stats.userplaycount`; albums list their tracks |
| `user.getTopTags`, `artist.getTopTags`, `track.getTopTags`, `album.getTopTags` | GET/POST | none | Always valid empty lists |

Any other method, or a missing `method`, is error **3** (this covers `geo.*`, `chart.*`, `tag.*` and `artist.getSimilar`).

Reads show only data that has been indexed after its signed proof. A scrobble you just sent appears once it is on your PDS and indexed; pending operations and staged imports are never shown. Unknown, inactive or suppressed users are **6** "User not found". The `user` parameter is a DID, a username, or a verified handle; a dotted value is a username only while it is still its owner's verified handle. User URLs are `https://music.214510.xyz/u/<did>`; artist, track and album URLs are Last.fm-style `https://www.last.fm/music/…` links; images are the four sizes with empty text.

### track.scrobble

- Entries are indexed `[0]` to `[49]`, or one unindexed set. Mixing both forms, an index of 50 or more, or more than 50 entries is **6**; a missing `artist`, `track` or `timestamp` in any entry is **6** and nothing is stored.
- Each entry is accepted or ignored individually; the answer is still `status="ok"` with `@attr accepted` and `ignored`. `ignoredMessage@code`: **1** invalid artist (empty after trimming, over 256 characters, malformed text), **2** invalid track, **3** timestamp before 2002-10-01 ("too old"), **4** timestamp more than 300 s after receipt ("too new"), **5** over your daily limit (3,000 per rolling 24 h). `corrected` is always `"0"`; we never correct metadata.
- Optional fields (`album`, `albumArtist`, `trackNumber`, `mbid`, `duration`) that are invalid are dropped, never fatal. `context`, `streamId` and `chosenByUser` are not stored.
- A resent scrobble (same second, artist and track) is accepted again without a second record.
- "Accepted" means durably queued, not yet on your PDS, as on Last.fm. With the server's publication gate closed every scrobble is error **11**. If your atmusic sign-in needs renewing, scrobbles are still accepted and wait until you sign in again.

### track.updateNowPlaying

Sets your now-playing track until `started + duration` (when `duration` is between 30 and 5,400 s) or for 600 s. Repeating the same track only refreshes it. The answer is `<nowplaying>` with `track`, `artist`, `album`, `albumArtist` (each `corrected="0"`) and `ignoredMessage code="0"`. Now playing is never a PDS record, is never retried, and is visible to others only when "share now playing" is on (the default).

### library.removeScrobble

Removes your scrobble of `artist` and `track` at `timestamp`: the newest indexed record at that second, or one of your own scrobbles that is still queued (cancelled before it reaches the PDS) or being written (deleted after it lands). When nothing matches the answer is error **7** "Invalid resource specified", as GNU FM answers; Pano treats 7 (and 3) as success, so a double tap or a retry never shows a failed unscrobble.

## Error codes

| Code | Message | HTTP |
| --- | --- | --- |
| 2 | Invalid service | 400 |
| 3 | Invalid Method | 400 |
| 4 | Authentication Failed | 403 |
| 5 | Invalid format | 400 |
| 6 | Invalid parameters (unknown users and tracks use a specific message) | 400 |
| 7 | Invalid resource specified (`library.removeScrobble` with no match) | 400 |
| 8 | Operation failed | 500 |
| 9 | Invalid session key - Please re-authenticate | 403 |
| 10 | Invalid API key | 403 |
| 11 | Service Offline | 503 |
| 13 | Invalid method signature supplied | 403 |
| 14 | This token has not been authorized | 403 |
| 15 | This token has expired | 403 |
| 16 | There was a temporary error processing your request | 503 |
| 26 | Suspended API key | 403 |
| 29 | Rate Limit Exceeded (with `Retry-After`) | 429 |

Rate limits: 60 read requests per minute per IP, 120 write requests per minute per session key, and the `auth.getMobileSession` failure limits above.

## Not supported

- **Audioscrobbler 1.2 / 1.2.1** (mpdscribble, Quod Libet): a 1.2 handshake needs a stored password equivalent. `/audioscrobbler/` and a root handshake (`/?hs=true`) answer, as plain text with status 200, `FAILED Protocol 1.2 is not supported; use the Last.fm 2.0 or ListenBrainz API`.
- Tags, similar artists, biographies and charts beyond your own: tag methods return empty lists, and the other methods are error 3.

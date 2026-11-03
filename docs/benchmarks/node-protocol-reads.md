# Node protocol-read benchmark

- Generated: 2026-11-03T07:40:03.625Z
- Receipt: `worker/test/bench/protocol-reads.bench.test.ts`
- Schema: `atmusic/protocol-reads-benchmark@2`
- Dataset: 100,000 listens, seed 24301, fixed clock 2026-01-15T12:00:00Z; apply-path parity sample 100 records; 256 operations (250 succeeded scrobble creates, 6 scrobble deletes); 99,995 visible / 5 hidden listens

The main fixture inserts the 100,000-listen projection through direct SQL after production record normalization, then seeds a deterministic history of succeeded create operations and delete operations spanning queued, running, blocked, failed, succeeded with matching CID, and succeeded with stale CID. The operation count is deliberately bounded for a reproducible measurement and is reported explicitly; it does not claim to model a user's lifetime operation history. The parity sample compares signed repository verification and the production apply path against equivalent direct inserts. Reads are measured through the Node HTTP composition; fixture setup, cache invalidation, and report writing are outside each timed sample. Each read has ten samples. Requests are top tracks (period=overall), recent tracks (page 500, limit 200), ListenBrainz recordings (range=all_time, count=100), and listening activity (range=year). The ListenBrainz stats query-plan sample is a cold cache miss and its timing samples clear the cache before each request.

Timings are observations from this run. Budget comparisons are informational and are not acceptance assertions. The ADR §10.3 report-only budgets are uncached top tracks p95 <250 ms, cached top tracks p95 <20 ms, and recent tracks page 500 p95 <100 ms. With ten samples, nearest-rank p95 is the slowest sample. No budget is specified for the ListenBrainz reads.

| Read | Runs | p50 (ms) | p95 (ms) | Report-only p95 budget |
|---|---:|---:|---:|---:|
| top-tracks cached | 10 | 3.22 | 3.87 | < 20 ms |
| top-tracks uncached | 10 | 506.28 | 733.56 | < 250 ms |
| recent-tracks page 500 | 10 | 256.31 | 355.51 | < 100 ms |
| ListenBrainz all_time stats | 10 | 541.11 | 752.16 | not specified |
| ListenBrainz listening-activity year | 10 | 109.21 | 354.59 | not specified |

## Saved pre-index comparison

The saved pre-index v2 receipt was generated at 2026-11-03T07:14:07.984Z; this post-index receipt was generated at 2026-11-03T07:40:03.625Z. Dataset fields match, including the bounded 256-operation history. The runs were not made under controlled load. This comparison does not establish lifetime scaling, performance with 100,000 operations, or migration cost. The query plans below preserve the current executed SQL and probes; the saved baseline receipt preserves its original plans.

| Read | Pre-index p50 (ms) | Pre-index p95 (ms) | Post-index p50 (ms) | Post-index p95 (ms) |
|---|---:|---:|---:|---:|
| top-tracks uncached | 9138.39 | 10007.29 | 506.28 | 733.56 |
| recent-tracks page 500 | 9187.24 | 12125.75 | 256.31 | 355.51 |
| ListenBrainz all_time stats | 10010.04 | 11783.65 | 541.11 | 752.16 |
| ListenBrainz listening-activity year | 4156.52 | 4749.52 | 109.21 | 354.59 |

The historical zero-operation v1 run (2026-11-03T04:29:17.913Z) recorded p50s of 466.45 ms (uncached top tracks), 81.42 ms (recent page 500), 461.27 ms (ListenBrainz all_time), and 80.04 ms (activity year). That receipt lacks the v2 operations metadata and is descriptive context only.

## Query plans

### topTracks

#### Statement 1

```sql
WITH w AS MATERIALIZED (SELECT s.uri, s.listened_at, s.artist_key, s.track_key,
      s.album_key, s.album_artist_key, s.duration_seconds FROM scrobbles s JOIN users u
    ON u.did = s.did AND (u.active = 1 AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = u.did))
    AND NOT EXISTS (
      SELECT 1 FROM operations AS d
      WHERE d.did = s.did AND d.rkey = s.rkey
        AND d.kind = 'scrobble.delete'
        AND (
          d.state IN ('queued', 'running', 'blocked', 'failed')
          OR (d.state = 'succeeded' AND d.swap_cid = s.cid)
        )
    )
    WHERE s.did = ? AND s.listened_at < ?)
        SELECT count(*) AS listens,
               count(DISTINCT artist_key) AS artists,
               count(DISTINCT hex(artist_key) || ':' || hex(track_key)) AS tracks,
               count(DISTINCT CASE WHEN album_key IS NOT NULL
                 THEN hex(coalesce(album_artist_key, artist_key)) || ':' || hex(album_key) END) AS albums
        FROM w
```

- MATERIALIZE w
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_scrobble_delete_target (did=? AND rkey=?)
- USE TEMP B-TREE FOR count(DISTINCT)
- USE TEMP B-TREE FOR count(DISTINCT)
- USE TEMP B-TREE FOR count(DISTINCT)
- SCAN w

#### Statement 2

```sql
WITH w AS (SELECT s.uri, s.listened_at, s.artist_key, s.track_key,
      s.album_key, s.album_artist_key, s.duration_seconds FROM scrobbles s JOIN users u
    ON u.did = s.did AND (u.active = 1 AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = u.did))
    AND NOT EXISTS (
      SELECT 1 FROM operations AS d
      WHERE d.did = s.did AND d.rkey = s.rkey
        AND d.kind = 'scrobble.delete'
        AND (
          d.state IN ('queued', 'running', 'blocked', 'failed')
          OR (d.state = 'succeeded' AND d.swap_cid = s.cid)
        )
    )
    WHERE s.did = ? AND s.listened_at < ?),
        g AS (SELECT artist_key, track_key, count(*) AS c, max(listened_at || ' ' || uri) AS newest,
                     max(CASE WHEN duration_seconds IS NOT NULL THEN listened_at || ' ' || uri END) AS newest_dur
              FROM w GROUP BY artist_key, track_key)
        SELECT g.artist_key AS artist_key, g.track_key AS track_key, g.c AS c, d.listened_at AS newest_at,
               d.artist AS artist, d.track AS track, d.album AS album, d.recording_mbid AS recording_mbid,
               d.release_mbid AS release_mbid, d.artist_mbids AS artist_mbids, dd.duration_seconds AS duration_seconds
        FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
        LEFT JOIN scrobbles dd ON dd.uri = substr(g.newest_dur, 32)
        ORDER BY g.c DESC, g.artist_key ASC, g.track_key ASC LIMIT ? OFFSET ?
```

- CO-ROUTINE g
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_scrobble_delete_target (did=? AND rkey=?)
- USE TEMP B-TREE FOR GROUP BY
- SCAN g
- SEARCH d USING INDEX sqlite_autoindex_scrobbles_1 (uri=?)
- SEARCH dd USING INDEX sqlite_autoindex_scrobbles_1 (uri=?) LEFT-JOIN
- USE TEMP B-TREE FOR ORDER BY

### recentTracks

#### Statement 1

```sql
SELECT count(*) AS n FROM scrobbles s JOIN users u
    ON u.did = s.did AND (u.active = 1 AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = u.did))
    AND NOT EXISTS (
      SELECT 1 FROM operations AS d
      WHERE d.did = s.did AND d.rkey = s.rkey
        AND d.kind = 'scrobble.delete'
        AND (
          d.state IN ('queued', 'running', 'blocked', 'failed')
          OR (d.state = 'succeeded' AND d.swap_cid = s.cid)
        )
    ) WHERE s.did = ?
```

- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_stats (did=?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_scrobble_delete_target (did=? AND rkey=?)

#### Statement 2

```sql
SELECT s.* FROM scrobbles s JOIN users u
    ON u.did = s.did AND (u.active = 1 AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = u.did))
    AND NOT EXISTS (
      SELECT 1 FROM operations AS d
      WHERE d.did = s.did AND d.rkey = s.rkey
        AND d.kind = 'scrobble.delete'
        AND (
          d.state IN ('queued', 'running', 'blocked', 'failed')
          OR (d.state = 'succeeded' AND d.swap_cid = s.cid)
        )
    ) WHERE s.did = ?
     ORDER BY s.listened_at DESC, s.uri DESC LIMIT ? OFFSET ?
```

- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_scrobble_delete_target (did=? AND rkey=?)

### listenbrainzAllTime

#### Statement 1

```sql
WITH w AS MATERIALIZED (SELECT s.uri, s.listened_at, s.artist_key, s.track_key,
      s.album_key, s.album_artist_key, s.duration_seconds FROM scrobbles s JOIN users u
    ON u.did = s.did AND (u.active = 1 AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = u.did))
    AND NOT EXISTS (
      SELECT 1 FROM operations AS d
      WHERE d.did = s.did AND d.rkey = s.rkey
        AND d.kind = 'scrobble.delete'
        AND (
          d.state IN ('queued', 'running', 'blocked', 'failed')
          OR (d.state = 'succeeded' AND d.swap_cid = s.cid)
        )
    )
    WHERE s.did = ? AND s.listened_at < ? AND s.listened_at >= ?)
        SELECT count(*) AS listens,
               count(DISTINCT artist_key) AS artists,
               count(DISTINCT hex(artist_key) || ':' || hex(track_key)) AS tracks,
               count(DISTINCT CASE WHEN album_key IS NOT NULL
                 THEN hex(coalesce(album_artist_key, artist_key)) || ':' || hex(album_key) END) AS albums
        FROM w
```

- MATERIALIZE w
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at>? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_scrobble_delete_target (did=? AND rkey=?)
- USE TEMP B-TREE FOR count(DISTINCT)
- USE TEMP B-TREE FOR count(DISTINCT)
- USE TEMP B-TREE FOR count(DISTINCT)
- SCAN w

#### Statement 2

```sql
WITH w AS (SELECT s.uri, s.listened_at, s.artist_key, s.track_key,
      s.album_key, s.album_artist_key, s.duration_seconds FROM scrobbles s JOIN users u
    ON u.did = s.did AND (u.active = 1 AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = u.did))
    AND NOT EXISTS (
      SELECT 1 FROM operations AS d
      WHERE d.did = s.did AND d.rkey = s.rkey
        AND d.kind = 'scrobble.delete'
        AND (
          d.state IN ('queued', 'running', 'blocked', 'failed')
          OR (d.state = 'succeeded' AND d.swap_cid = s.cid)
        )
    )
    WHERE s.did = ? AND s.listened_at < ? AND s.listened_at >= ?),
        g AS (SELECT artist_key, track_key, count(*) AS c, max(listened_at || ' ' || uri) AS newest,
                     max(CASE WHEN duration_seconds IS NOT NULL THEN listened_at || ' ' || uri END) AS newest_dur
              FROM w GROUP BY artist_key, track_key)
        SELECT g.artist_key AS artist_key, g.track_key AS track_key, g.c AS c, d.listened_at AS newest_at,
               d.artist AS artist, d.track AS track, d.album AS album, d.recording_mbid AS recording_mbid,
               d.release_mbid AS release_mbid, d.artist_mbids AS artist_mbids, dd.duration_seconds AS duration_seconds
        FROM g JOIN scrobbles d ON d.uri = substr(g.newest, 32)
        LEFT JOIN scrobbles dd ON dd.uri = substr(g.newest_dur, 32)
        ORDER BY g.c DESC, g.artist_key ASC, g.track_key ASC LIMIT ? OFFSET ?
```

- CO-ROUTINE g
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at>? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_scrobble_delete_target (did=? AND rkey=?)
- USE TEMP B-TREE FOR GROUP BY
- SCAN g
- SEARCH d USING INDEX sqlite_autoindex_scrobbles_1 (uri=?)
- SEARCH dd USING INDEX sqlite_autoindex_scrobbles_1 (uri=?) LEFT-JOIN
- USE TEMP B-TREE FOR ORDER BY

### listeningActivityYear

#### Statement 1

```sql
SELECT substr(s.listened_at, 1, 7) AS p, count(*) AS c FROM scrobbles s JOIN users u
    ON u.did = s.did AND (u.active = 1 AND NOT EXISTS (SELECT 1 FROM suppression x WHERE x.did = u.did))
    AND NOT EXISTS (
      SELECT 1 FROM operations AS d
      WHERE d.did = s.did AND d.rkey = s.rkey
        AND d.kind = 'scrobble.delete'
        AND (
          d.state IN ('queued', 'running', 'blocked', 'failed')
          OR (d.state = 'succeeded' AND d.swap_cid = s.cid)
        )
    )
     WHERE s.did = ? AND s.listened_at < ? AND s.listened_at >= ? GROUP BY substr(s.listened_at, 1, 7)
```

- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at>? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_scrobble_delete_target (did=? AND rkey=?)
- USE TEMP B-TREE FOR GROUP BY

Plan source: EXPLAIN QUERY PLAN; Node v26.12.1; node:sqlite 3.54.1; linux/x64

# Node protocol-read benchmark

Generated: 2026-11-03T02:56:46.243Z  
Receipt: `worker/test/bench/protocol-reads.bench.test.ts`  
Dataset: 100,000 listens, seed 24301, fixed clock 2026-01-15T12:00:00Z; apply-path parity sample 100 records

The main fixture inserts the 100,000-listen projection through direct SQL after production record normalization. The parity sample compares signed repository verification and the production apply path against equivalent direct inserts. Reads are measured through the Node HTTP composition; fixture setup, cache invalidation, and report writing are outside each timed sample. Each read has ten samples. Requests are top tracks (period=overall), recent tracks (page 500, limit 200), ListenBrainz recordings (range=all_time, count=100), and listening activity (range=year). The ListenBrainz stats query-plan sample is a cold cache miss and its timing samples clear the cache before each request.

Timings are observations from this run. Budget comparisons are informational and are not acceptance assertions. The ADR §10.3 report-only budgets are uncached top tracks p95 <250 ms, cached top tracks p95 <20 ms, and recent tracks page 500 p95 <100 ms. No budget is specified for the ListenBrainz reads.

| Read | Runs | p50 (ms) | p95 (ms) | Report-only p95 budget |
|---|---:|---:|---:|---:|
| top-tracks cached | 10 | 3.22 | 4.04 | < 20 ms |
| top-tracks uncached | 10 | 613.63 | 832.21 | < 250 ms |
| recent-tracks page 500 | 10 | 85.57 | 126.32 | < 100 ms |
| ListenBrainz all_time stats | 10 | 513.29 | 623.99 | not specified |
| ListenBrainz listening-activity year | 10 | 81.91 | 103.49 | not specified |

## Query plans

### topTracks

#### Statement 1

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
    WHERE s.did = ? AND s.listened_at < ?)
        SELECT (SELECT count(*) FROM w) AS listens,
               (SELECT count(DISTINCT artist_key) FROM w) AS artists,
               (SELECT count(*) FROM (SELECT 1 FROM w GROUP BY artist_key, track_key)) AS tracks,
               (SELECT count(*) FROM (SELECT 1 FROM w WHERE album_key IS NOT NULL
                  GROUP BY coalesce(album_artist_key, artist_key), album_key)) AS albums
```

- SCAN CONSTANT ROW
- SCALAR SUBQUERY 4
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_did_state (did=?)
- SCALAR SUBQUERY 5
- USE TEMP B-TREE FOR count(DISTINCT)
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_did_state (did=?)
- SCALAR SUBQUERY 7
- CO-ROUTINE (subquery-6)
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_did_state (did=?)
- USE TEMP B-TREE FOR GROUP BY
- SCAN (subquery-6)
- SCALAR SUBQUERY 9
- CO-ROUTINE (subquery-8)
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_did_state (did=?)
- USE TEMP B-TREE FOR GROUP BY
- SCAN (subquery-8)

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
- SEARCH d USING INDEX operations_did_state (did=?)
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
- SEARCH d USING INDEX operations_did_state (did=?)

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
- SEARCH d USING INDEX operations_did_state (did=?)

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
        SELECT (SELECT count(*) FROM w) AS listens,
               (SELECT count(DISTINCT artist_key) FROM w) AS artists,
               (SELECT count(*) FROM (SELECT 1 FROM w GROUP BY artist_key, track_key)) AS tracks,
               (SELECT count(*) FROM (SELECT 1 FROM w WHERE album_key IS NOT NULL
                  GROUP BY coalesce(album_artist_key, artist_key), album_key)) AS albums
```

- SCAN CONSTANT ROW
- SCALAR SUBQUERY 4
- MATERIALIZE w
- SEARCH u USING INDEX sqlite_autoindex_users_1 (did=?)
- CORRELATED SCALAR SUBQUERY 1
- SEARCH x USING COVERING INDEX sqlite_autoindex_suppression_1 (did=?)
- SEARCH s USING INDEX scrobbles_owner_time (did=? AND listened_at>? AND listened_at<?)
- CORRELATED SCALAR SUBQUERY 2
- SEARCH d USING INDEX operations_did_state (did=?)
- SCAN w
- SCALAR SUBQUERY 5
- USE TEMP B-TREE FOR count(DISTINCT)
- SCAN w
- SCALAR SUBQUERY 7
- CO-ROUTINE (subquery-6)
- SCAN w
- USE TEMP B-TREE FOR GROUP BY
- SCAN (subquery-6)
- SCALAR SUBQUERY 9
- CO-ROUTINE (subquery-8)
- SCAN w
- USE TEMP B-TREE FOR GROUP BY
- SCAN (subquery-8)

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
- SEARCH d USING INDEX operations_did_state (did=?)
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
- SEARCH d USING INDEX operations_did_state (did=?)
- USE TEMP B-TREE FOR GROUP BY

Plan source: EXPLAIN QUERY PLAN; Node v26.12.1; node:sqlite 3.54.1; linux/x64

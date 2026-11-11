import json
import pathlib
import re
import sqlite3

root = pathlib.Path(__file__).resolve().parents[3]
source = (root / "worker/src/forward/love-api-recipients.ts").read_text()
query = re.search(r"`(SELECT r.link_id,r.generation,d.artist_key[\s\S]*?)`", source)[1]
proposal = (root / "docs/planning/finding32-source-origin-revised57-proposal.sql").read_text()
old_prefix_query = """SELECT r.link_id,r.generation,d.artist_key,d.track_key,d.authorization_uri,d.authorization_rev
FROM love_api_recipients r
JOIN linked_accounts l ON l.id=r.link_id AND l.did=r.did AND l.generation=r.generation
LEFT JOIN love_api_unlove_decisions d ON d.did=r.did AND d.uri=r.uri AND d.incarnation_key=r.incarnation_key
  AND d.link_id=r.link_id AND d.generation=r.generation
WHERE r.did=? AND r.uri=? AND r.incarnation_key=? AND r.state IN ('present','sealed')
  AND (d.did IS NULL OR (d.authorization_uri=? AND d.authorization_rev=? AND d.artist_key=? AND d.track_key=?))"""


def build(size, current_row=False, matching=True):
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(
        "CREATE TABLE linked_accounts(id TEXT PRIMARY KEY,did TEXT,service TEXT,generation INTEGER,UNIQUE(did,service));"
        "CREATE TABLE live_pending_removals(uri TEXT,member_uri TEXT,removed_cid TEXT,window_lo TEXT,window_hi TEXT,replaced_by_cid TEXT,PRIMARY KEY(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid));"
        "CREATE TABLE linked_love_intents(did TEXT,recording_mbid TEXT,intent TEXT,love_key TEXT,operation_id TEXT);"
        "CREATE TABLE operations(did TEXT,kind TEXT,record_json TEXT,state TEXT);"
    )
    db.executescript(proposal)
    db.execute("INSERT INTO linked_accounts VALUES('link','did','lastfm',?)", (size + 1,))
    db.execute("INSERT INTO love_api_comparison_facts VALUES('uri','rev',1,'delete','',10000,0,1)")
    for generation in range(1, size + 1):
        db.execute(
            "INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,sent_operation_id,created_at_ms,updated_at_ms) VALUES('did','uri','inc','link',?,?,'sealed','other',1,1)",
            (generation, generation),
        )
        db.execute(
            "INSERT INTO love_api_unlove_decisions(did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,payload_json,authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms) VALUES('did','uri','inc','link',?,'a','t','artist','track','{\"artist\":\"a\",\"track\":\"t\",\"origin\":\"web\"}','uri','rev','delete','',10000,1,1)",
            (generation,),
        )
    if current_row:
        incarnation = "inc" if matching else "other-inc"
        db.execute(
            "INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,sent_operation_id,created_at_ms,updated_at_ms) VALUES('did','uri',?,'link',?,?,'sealed','other',1,1)",
            (incarnation, size + 1, size + 1),
        )
        db.execute(
            "INSERT INTO love_api_unlove_decisions(did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,payload_json,authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms) VALUES('did','uri',?,'link',?,'a','t','artist','track','{\"artist\":\"a\",\"track\":\"t\",\"origin\":\"web\"}','uri','rev','delete','',10000,1,1)",
            (incarnation, size + 1),
        )
    db.commit()
    return db


def run(db, statement, did="did", uri="uri", incarnation="inc"):
    ticks = [0]

    def tick():
        ticks[0] += 1
        return 0

    args = (did, uri, incarnation, did, uri, "rev", "artist", "track")
    if statement == old_prefix_query:
        args = (did, uri, incarnation, uri, "rev", "artist", "track")
    db.set_progress_handler(tick, 1)
    rows = db.execute(statement, args).fetchall()
    db.set_progress_handler(None, 0)
    plan = [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + statement, args)]
    return {"steps": ticks[0], "rows": len(rows), "plan": plan}


result = []
for size in (100, 1000, 10000):
    old_only = build(size)
    current_hit = build(size, current_row=True)
    current_miss = build(size, current_row=True, matching=False)
    result.append(
        {
            "size": size,
            "old_generations_only": run(old_only, query),
            "current_hit_after_history": run(current_hit, query),
            "incarnation_miss": run(current_hit, query, incarnation="absent-inc"),
            "did_miss": run(current_hit, query, did="did:other"),
            "uri_miss": run(current_hit, query, uri="other-uri"),
            "current_incarnation_miss": run(current_miss, query),
            "old_prefix_control": run(old_only, old_prefix_query),
        }
    )
print(json.dumps(result))
for name in ("old_generations_only", "current_hit_after_history", "incarnation_miss", "did_miss", "uri_miss", "current_incarnation_miss"):
    values = [row[name]["steps"] for row in result]
    assert values[-1] <= values[0] * 2, f"{name} production query cost grows with generation history: {values}"
assert [row["old_generations_only"]["rows"] for row in result] == [0, 0, 0]
assert [row["current_hit_after_history"]["rows"] for row in result] == [1, 1, 1]
assert [row["current_incarnation_miss"]["rows"] for row in result] == [0, 0, 0]
assert result[-1]["old_prefix_control"]["steps"] > result[0]["old_prefix_control"]["steps"] * 20

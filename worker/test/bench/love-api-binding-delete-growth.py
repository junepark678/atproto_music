import json
import pathlib
import re
import sqlite3

root = pathlib.Path(__file__).resolve().parents[3]
source = (root / "worker/src/forward/love-api-maintenance.ts").read_text()
sql = re.search(r"LOVE_API_BINDING_RECLAIM_DELETE_SQL = `([\s\S]*?)`", source)[1]
old_sql = """DELETE FROM love_api_bindings WHERE did=? AND operation_id=? AND binding_seq=?
AND NOT EXISTS(SELECT 1 FROM love_api_unlove_decisions d
 JOIN love_api_recipients r ON r.did=d.did AND r.uri=d.uri AND r.incarnation_key=d.incarnation_key
 AND r.link_id=d.link_id AND r.generation=d.generation
 WHERE d.did=? AND d.uri=? AND d.incarnation_key=? AND r.sent_operation_id=?)"""
proposal = (root / "docs/planning/finding32-source-origin-revised57-proposal.sql").read_text()


def build(n):
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(
        "CREATE TABLE linked_accounts(id TEXT PRIMARY KEY,did TEXT,service TEXT,generation INTEGER,UNIQUE(did,service));"
        "CREATE TABLE live_pending_removals(uri TEXT,member_uri TEXT,removed_cid TEXT,window_lo TEXT,window_hi TEXT,replaced_by_cid TEXT,PRIMARY KEY(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid));"
        "CREATE TABLE linked_love_intents(did TEXT,recording_mbid TEXT,intent TEXT,love_key TEXT,operation_id TEXT);"
        "CREATE TABLE operations(did TEXT,kind TEXT,state TEXT,record_json TEXT);"
    )
    db.executescript(proposal)
    db.execute("INSERT INTO linked_accounts VALUES('link','did','lastfm',?)", (n + 1,))
    db.execute("INSERT INTO love_api_bindings VALUES('did','needle','web','uri','inc',1,1)")
    db.execute("INSERT INTO love_api_bindings VALUES('did','other','web','uri','inc',2,1)")
    db.execute("INSERT INTO love_api_comparison_facts VALUES('uri','rev',1,'delete','',10000,0,1)")
    for generation in range(1, n + 1):
        db.execute(
            "INSERT INTO love_api_recipients(did,uri,incarnation_key,link_id,generation,aggregate_seq,state,sent_operation_id,created_at_ms,updated_at_ms) VALUES('did','uri','inc','link',?,?,'sealed','other',1,1)",
            (generation, generation),
        )
        db.execute(
            "INSERT INTO love_api_unlove_decisions(did,uri,incarnation_key,link_id,generation,artist,track,artist_key,track_key,payload_json,authorization_uri,authorization_rev,fact_action,fact_cid,expires_at_ms,due_at_ms,created_at_ms) VALUES('did','uri','inc','link',?,'a','t','a','t','{\"artist\":\"a\",\"track\":\"t\",\"origin\":\"web\"}','uri','rev','delete','',10000,1,1)",
            (generation,),
        )
    db.commit()
    return db


def measure(db, statement, incarnation, include_old=False):
    ticks = [0]
    db.execute("SAVEPOINT probe")

    def tick():
        ticks[0] += 1
        return 0

    db.set_progress_handler(tick, 1)
    args = ("did", "needle", 1, "did", "uri", incarnation)
    if include_old:
        args += ("needle",)
    deleted = db.execute(statement, args).rowcount
    db.set_progress_handler(None, 0)
    db.execute("ROLLBACK TO probe")
    db.execute("RELEASE probe")
    return {"vm_steps": ticks[0], "deleted": deleted}


results = []
for count in (100, 1000, 10000):
    db = build(count)
    current_hit = measure(db, sql, "inc")
    current_miss = measure(db, sql, "other")
    old_hit = measure(db, old_sql, "inc", include_old=True)
    plan = [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql, ("did", "needle", 1, "did", "uri", "inc"))]
    results.append({"decisions": count, "matching": current_hit, "nonmatching": current_miss, "oldMatching": old_hit, "plan": plan})

print(json.dumps(results))
assert results[-1]["matching"]["vm_steps"] <= results[0]["matching"]["vm_steps"] * 2
assert results[-1]["nonmatching"]["vm_steps"] <= results[0]["nonmatching"]["vm_steps"] * 2
assert results[-1]["oldMatching"]["vm_steps"] > results[0]["oldMatching"]["vm_steps"] * 50
assert all(row["matching"]["deleted"] == 0 and row["nonmatching"]["deleted"] == 1 for row in results)

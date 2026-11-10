import json
import sqlite3
import sys

query = json.load(sys.stdin)
proposal = query["ddl"]
used_sql = query["usedSql"]
old_sql = """SELECT 1 FROM love_api_recipients r
WHERE r.did=? AND r.uri=? AND r.incarnation_key=? AND r.sent_operation_id=?
  AND r.state IN ('present','sealed')
UNION ALL
SELECT 1 FROM love_api_recipients r
JOIN love_api_recipient_members m ON m.link_id=r.link_id AND m.generation=r.generation
  AND m.operation_id=? AND m.did=r.did AND m.uri=r.uri AND m.incarnation_key=r.incarnation_key
WHERE r.did=? AND r.uri=? AND r.incarnation_key=? AND r.state IN ('present','sealed')
LIMIT 1"""
results = []
for count in (100, 1000, 10000):
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""CREATE TABLE linked_accounts (
      id TEXT PRIMARY KEY, did TEXT NOT NULL, service TEXT NOT NULL,
      generation INTEGER NOT NULL, UNIQUE(did,service));""")
    db.executescript("""CREATE TABLE live_pending_removals (
      uri TEXT, member_uri TEXT, removed_cid TEXT, window_lo TEXT, window_hi TEXT,
      replaced_by_cid TEXT, PRIMARY KEY(uri,member_uri,removed_cid,window_lo,window_hi,replaced_by_cid));
      CREATE TABLE linked_love_intents(did TEXT,recording_mbid TEXT,intent TEXT,love_key TEXT,operation_id TEXT);
      CREATE TABLE operations(did TEXT,kind TEXT,state TEXT,record_json TEXT);""")
    db.executescript(proposal)
    db.execute("INSERT INTO linked_accounts VALUES('link','did','lastfm',1)")
    for generation in range(2, count + 2):
        db.execute("""INSERT INTO love_api_recipients
          (did,uri,incarnation_key,link_id,generation,aggregate_seq,state,created_at_ms,updated_at_ms)
          VALUES('did','uri','inc','link',?,?,'released',1,1)""", (generation, generation))
    db.execute("""INSERT INTO love_api_recipients
      (did,uri,incarnation_key,link_id,generation,aggregate_seq,state,sent_operation_id,created_at_ms,updated_at_ms)
      VALUES('did','uri','inc','link',1,?,'sealed','needle',1,1)""", (count + 2,))

    def measure(sql, params):
        ticks = [0]
        def tick():
            ticks[0] += 1
            return 0
        db.set_progress_handler(tick, 1)
        rows = db.execute(sql, params).fetchall()
        db.set_progress_handler(None, 0)
        plan = [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql, params)]
        return {"steps": ticks[0], "rows": len(rows), "plan": plan}

    params = ("did", "uri", "inc", "did", "needle", "needle")
    results.append({
        "history": count,
        "currentDependent": measure(used_sql, params),
        "releasedOnly": measure(used_sql, ("did", "uri", "inc", "did", "absent", "absent")),
        "oldPrefixNegativeControl": measure(old_sql, ("did", "uri", "inc", "absent", "absent", "did", "uri", "inc")),
    })
print(json.dumps({"sqlite": sqlite3.sqlite_version, "results": results}))
assert len({item["currentDependent"]["steps"] for item in results}) == 1
assert max(item["releasedOnly"]["steps"] for item in results) <= min(item["releasedOnly"]["steps"] for item in results) * 1.2
assert results[-1]["oldPrefixNegativeControl"]["steps"] > results[0]["oldPrefixNegativeControl"]["steps"] * 50
assert all(item["currentDependent"]["rows"] == 1 for item in results)
assert all(item["releasedOnly"]["rows"] == 0 for item in results)

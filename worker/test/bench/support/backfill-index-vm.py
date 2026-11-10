"""Count work for production SQL on a file migrated by the Node adapter.

The caller supplies the production-owned queries on stdin. Large synthetic
fixtures live only in worker-bench; no elapsed-time assertion is used.
"""

import json
import sqlite3
import sys

queries = json.load(sys.stdin)
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA foreign_keys=OFF")
bridge_sql = queries["bridge"]
provenance_sql = queries["provenance"]
bridge_args = ("did:test", "at://did:test/love/r", "inc", 1)


def work(sql, args):
    db.execute(sql, args).fetchall()  # Warm schema/statement metadata first.
    steps = 0

    def step():
        nonlocal steps
        steps += 1

    db.set_progress_handler(step, 1)
    try:
        rows = db.execute(sql, args).fetchall()
    finally:
        db.set_progress_handler(None, 0)
    return steps, rows


def plan(sql, args):
    return [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql, args)]


results = []
for size in [1_000, 10_000]:
    db.execute("DELETE FROM love_import_bridges")
    db.execute("DELETE FROM operations")
    db.executemany(
        """INSERT INTO love_import_bridges
           (did,operation_id,uri,incarnation_key,source_service,state,created_at_ms)
           VALUES('did:test',?,'at://did:test/love/r','inc','listenbrainz_zip','bound',1)""",
        [(str(i),) for i in range(size)],
    )
    db.executemany(
        """INSERT INTO operations
           (id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
           VALUES(?,'did:test','love.put','web',0,'love',?,'succeeded',0,1,1)""",
        [(str(i), str(i)) for i in range(size)],
    )
    entry = {
        "size": size,
        "bridgePlan": plan(bridge_sql, bridge_args),
        "provenancePlan": plan(provenance_sql, ("did:test", "love", "missing")),
    }
    assert "<expr>=?" in " ".join(entry["bridgePlan"])
    assert "did=? AND collection=? AND rkey=?" in " ".join(entry["provenancePlan"])
    entry["miss"] = work(bridge_sql, bridge_args)
    assert entry["miss"][1] == []
    entry["same"] = work(bridge_sql, bridge_args[:-1] + (2,))
    assert entry["same"][1] == [(1,)]
    for source in [None, "spotify", "lastfm_json"]:
        db.execute(
            """INSERT INTO love_import_bridges
               VALUES('did:test','tail','at://did:test/love/r','inc',?,'bound',2)""",
            (source,),
        )
        entry[str(source)] = work(bridge_sql, bridge_args)
        assert entry[str(source)][1] == [(1,)]
        db.execute("DELETE FROM love_import_bridges WHERE operation_id='tail'")
    entry["provenanceMiss"] = work(provenance_sql, ("did:test", "love", "missing"))
    for suffix, origin, timestamp in [("old", "web", 2), ("new", "import", 3)]:
        db.execute(
            """INSERT INTO operations
               (id,did,kind,origin,priority,collection,rkey,state,due_at,created_at_ms,updated_at_ms)
               VALUES(?,'did:test','love.put',?,0,'love','target','succeeded',0,?,?)""",
            (suffix, origin, timestamp, timestamp),
        )
    entry["provenanceFound"] = work(provenance_sql, ("did:test", "love", "target"))
    assert entry["provenanceFound"][1] == [("import", None)]
    for op, incarnation, state in [("noise", "other-inc", "bound"), ("consumed", "inc", "consumed")]:
        db.execute(
            """INSERT INTO love_import_bridges
               VALUES('did:test',?,'at://did:test/love/r',?,NULL,?,2)""",
            (op, incarnation, state),
        )
    assert work(bridge_sql, bridge_args)[1] == []

    # Each deliberate regression must grow with the unrelated history while
    # the production query's indexed work remains flat.
    db.execute("DROP INDEX operations_record_target")
    entry["noIndexProvenanceVM"] = work(provenance_sql, ("did:test", "love", "missing"))[0]
    db.execute("CREATE INDEX operations_record_target ON operations(did,collection,rkey,created_at_ms)")
    old_sql = """SELECT source_service FROM love_import_bridges INDEXED BY love_import_bridges_incarnation
                 WHERE did=? AND uri=? AND incarnation_key=? AND state='bound'"""
    entry["oldMaterializeVM"] = work(old_sql, bridge_args[:3])[0]
    drift = bridge_sql.replace("THEN 1", "THEN 1+0")
    assert drift != bridge_sql
    entry["driftPlan"] = plan(drift, bridge_args)
    entry["driftVM"] = work(drift, bridge_args)[0]
    assert "<expr>=?" not in " ".join(entry["driftPlan"])
    results.append(entry)

for name in ["miss", "same", "None", "spotify", "lastfm_json", "provenanceMiss", "provenanceFound"]:
    assert results[1][name][0] <= results[0][name][0] * 2, (name, results)
    assert results[1][name][0] < 100, (name, results)
assert results[0]["provenanceMiss"][1] == results[1]["provenanceMiss"][1] == []
for negative in ["oldMaterializeVM", "driftVM", "noIndexProvenanceVM"]:
    assert results[1][negative] > results[0][negative] * 8, (negative, results)
print(json.dumps(results))
db.close()

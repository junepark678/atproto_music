"""VM-step growth evidence for the exact B1 receipt and gap SQL."""

import json
import sqlite3
import sys

queries = json.load(sys.stdin)
db = sqlite3.connect(sys.argv[1])
db.execute("PRAGMA foreign_keys=ON")


def plan(sql, args):
    return [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql, args)]


def work(sql, args):
    if not sql.lstrip().upper().startswith("DELETE"):
        db.execute(sql, args).fetchall()
    steps = 0

    def tick():
        nonlocal steps
        steps += 1

    db.set_progress_handler(tick, 1)
    try:
        rows = db.execute(sql, args).fetchall()
        changes = db.execute("SELECT changes()").fetchone()[0]
    finally:
        db.set_progress_handler(None, 0)
    return {"steps": steps, "rows": len(rows), "changes": changes}


results = []
for size in (1_000, 100_000):
    db.execute("DELETE FROM forward_outbox")
    db.execute("DELETE FROM forward_receipts")
    db.execute("DELETE FROM forward_link_gaps")
    db.execute("DELETE FROM forward_admissions")
    links = [("bench-a", "did:bench:a"), ("bench-b", "did:bench:b")]
    for link_id, did in links:
        db.execute(
            "INSERT OR IGNORE INTO linked_accounts(id,did,service,remote_user,credential_ciphertext,key_id,created_at_ms,updated_at_ms) VALUES(?,?,'lastfm',?,X'00','bench',1,1)",
            (link_id, did, link_id),
        )
    for link_index, (link_id, did) in enumerate(links):
        receipts = []
        outbox = []
        for i in range(size):
            key = f"receipt-{i:06d}"
            receipts.append((link_id, 1, "scrobble", key, i, None))
            outbox.append(
                (
                    f"{link_id}-row-{i}",
                    link_id,
                    did,
                    "scrobble",
                    key,
                    "{}",
                    "queued" if i == size - 1 else "sent",
                    0,
                    0,
                    i,
                    i,
                )
            )
        db.executemany(
            "INSERT INTO forward_receipts(link_id,generation,kind,dedupe_key,created_at_ms,retired_at_ms) VALUES(?,?,?,?,?,?)",
            receipts,
        )
        db.executemany(
            "INSERT INTO forward_outbox(id,link_id,generation,did,kind,dedupe_key,payload_json,state,attempts,due_at,created_at_ms,updated_at_ms) VALUES(?,?,1,?,?,?,?,?,?,?,?,?)",
            outbox,
        )
        gaps = [
            (link_id, 1, i, i + 1 if i < 9_999 else None, "disabled", i, i if i < 9_999 else None)
            for i in range(10_000)
        ]
        db.executemany(
            "INSERT INTO forward_link_gaps(link_id,generation,from_seq,to_seq,reason,opened_at_ms,closed_at_ms) VALUES(?,?,?,?,?,?,?)",
            gaps,
        )
        admissions = [(did, f"admission-{i:06d}", "live", None, i, link_index * size + i + 1) for i in range(size)]
        db.executemany(
            "INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq) VALUES(?,?,?,?,?,?)",
            admissions,
        )
    db.commit()

    link_id = "bench-a"
    hit_key = f"receipt-{size - 1:06d}"
    miss_key = "receipt-not-present"
    release_sql = queries["release"]
    plans = {
        "receipt": plan(queries["receipt"], (link_id, 1, "scrobble", hit_key)),
        "outbox": plan(queries["outbox"], (link_id, "scrobble", hit_key)),
        "release": plan(release_sql, (link_id, 1, "scrobble", miss_key, miss_key)),
        "gapOwner": plan(queries["gapOwner"], (link_id, 1, 5_000, 5_000)),
        "newestGap": plan(queries["newestGap"], (link_id, 1)),
        "highWater": plan(queries["highWater"], ()),
    }
    assert all("SCAN" not in " ".join(lines).upper() for lines in plans.values()), plans
    assert all("TEMP B-TREE" not in " ".join(lines).upper() for lines in plans.values()), plans
    measurements = {
        "receiptHit": work(queries["receipt"], (link_id, 1, "scrobble", hit_key)),
        "receiptMiss": work(queries["receipt"], (link_id, 1, "scrobble", miss_key)),
        "outboxHit": work(queries["outbox"], (link_id, "scrobble", hit_key)),
        "gapOwner": work(queries["gapOwner"], (link_id, 1, 5_000, 5_000)),
        "newestGap": work(queries["newestGap"], (link_id, 1)),
        "highWater": work(queries["highWater"], ()),
        "release": work(release_sql, (link_id, 1, "scrobble", hit_key, hit_key)),
    }
    negative = work(
        "SELECT dedupe_key FROM forward_receipts NOT INDEXED WHERE dedupe_key LIKE '%definitely-absent%'",
        (),
    )
    negative_plan = plan(
        "SELECT dedupe_key FROM forward_receipts NOT INDEXED WHERE dedupe_key LIKE '%definitely-absent%'",
        (),
    )
    assert "SCAN forward_receipts" in " ".join(negative_plan)
    assert negative["rows"] == 0
    measurements["negativeControl"] = negative
    results.append({"sizePerLink": size, "plans": plans, "measurements": measurements})

db.close()
print(json.dumps(results))

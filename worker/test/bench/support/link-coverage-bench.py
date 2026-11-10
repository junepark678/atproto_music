"""VM work for exact B1 SQL at receipt and closed-gap growth points."""

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
    return {"steps": steps, "rows": len(rows), "changes": changes, "values": rows}


def bulk_fixture(receipt_size, gap_size):
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
        for index in range(receipt_size):
            key = f"receipt-{index:06d}"
            receipts.append((link_id, 1, "scrobble", key, index, None))
            outbox.append(
                (
                    f"{link_id}-row-{index}",
                    link_id,
                    did,
                    "scrobble",
                    key,
                    "{}",
                    "queued" if index == receipt_size - 1 else "sent",
                    0,
                    0,
                    index,
                    index,
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
            (link_id, 1, index * 2, index * 2 + 1, "disabled", index, index)
            for index in range(gap_size)
        ]
        db.executemany(
            "INSERT INTO forward_link_gaps(link_id,generation,from_seq,to_seq,reason,opened_at_ms,closed_at_ms) VALUES(?,?,?,?,?,?,?)",
            gaps,
        )
        admissions = [
            (did, f"admission-{index:06d}", "live", None, index, link_index * receipt_size + index + 1)
            for index in range(receipt_size)
        ]
        db.executemany(
            "INSERT INTO forward_admissions(did,identity_key,path,source_service,created_at_ms,admission_seq) VALUES(?,?,?,?,?,?)",
            admissions,
        )
    db.commit()


results = []
for receipt_size in (1_000, 100_000):
    for gap_size in (1_000, 10_000, 50_000):
        bulk_fixture(receipt_size, gap_size)
        link_id = "bench-a"
        hit_key = f"receipt-{receipt_size - 1:06d}"
        miss_key = "receipt-not-present"
        release_sql = queries["release"]

        # The last gap is closed for this miss. The nearest-predecessor query
        # returns only that candidate; endpoint ownership is decided in code.
        after_all_seq = gap_size * 2 + 2
        between_seq = (gap_size // 2) * 2
        oldest_seq = 1
        middle_seq = (gap_size // 2) * 2 + 1
        newest_seq = (gap_size - 1) * 2 + 1
        latest_gap = work(queries["newestGap"], (link_id, 1))

        plans = {
            "receipt": plan(queries["receipt"], (link_id, 1, "scrobble", hit_key)),
            "outbox": plan(queries["outbox"], (link_id, "scrobble", hit_key)),
            "release": plan(release_sql, (link_id, 1, "scrobble", hit_key, hit_key)),
            "gapOwner": plan(queries["gapOwner"], (link_id, 1, after_all_seq)),
            "newestGap": plan(queries["newestGap"], (link_id, 1)),
            "highWater": plan(queries["highWater"], ()),
        }
        assert all(
            all("SCAN CONSTANT ROW" in line.upper() for line in lines if "SCAN" in line.upper())
            for lines in plans.values()
        ), plans
        assert all("TEMP B-TREE" not in " ".join(lines).upper() for lines in plans.values()), plans

        measurements = {
            "receiptHit": work(queries["receipt"], (link_id, 1, "scrobble", hit_key)),
            "receiptMiss": work(queries["receipt"], (link_id, 1, "scrobble", miss_key)),
            "outboxHit": work(queries["outbox"], (link_id, "scrobble", hit_key)),
            "release": work(release_sql, (link_id, 1, "scrobble", hit_key, hit_key)),
            "ownerAfterAll": work(queries["gapOwner"], (link_id, 1, after_all_seq)),
            "ownerBetween": work(queries["gapOwner"], (link_id, 1, between_seq)),
            "ownerOldestHit": work(queries["gapOwner"], (link_id, 1, oldest_seq)),
            "ownerMiddleHit": work(queries["gapOwner"], (link_id, 1, middle_seq)),
            "ownerNewestHit": work(queries["gapOwner"], (link_id, 1, newest_seq)),
            "newestClosed": latest_gap,
            "highWater": work(queries["highWater"], ()),
        }
        for key, seq in (("ownerAfterAll", after_all_seq), ("ownerBetween", between_seq)):
            values = measurements[key]["values"]
            measurements[key]["owned"] = bool(values and values[0][0] is not None and seq <= values[0][0])
        for key, seq in (("ownerOldestHit", oldest_seq), ("ownerMiddleHit", middle_seq), ("ownerNewestHit", newest_seq)):
            values = measurements[key]["values"]
            measurements[key]["owned"] = bool(values and values[0][0] is not None and seq <= values[0][0])

        # Negative controls retain the former residual-filter form. It uses
        # the same composite index seek but must scan older intervals on misses.
        old_owner_sql = """SELECT 1 FROM forward_link_gaps WHERE link_id=? AND generation=?
            AND from_seq<? AND (to_seq IS NULL OR to_seq>=?) ORDER BY from_seq DESC LIMIT 1"""
        old_newest_sql = """SELECT from_seq FROM forward_link_gaps
            WHERE link_id=? AND generation=? AND to_seq IS NULL ORDER BY from_seq DESC LIMIT 1"""
        old_owner = work(old_owner_sql, (link_id, 1, after_all_seq, after_all_seq))
        old_between = work(old_owner_sql, (link_id, 1, between_seq, between_seq))
        old_newest = work(old_newest_sql, (link_id, 1))
        assert old_owner["rows"] == 0 and old_between["rows"] == 0 and old_newest["rows"] == 0
        measurements["negativeOwnerAfterAll"] = old_owner
        measurements["negativeOwnerBetween"] = old_between
        measurements["negativeNewestAllClosed"] = old_newest
        db.execute(
            "UPDATE forward_link_gaps SET to_seq=NULL,closed_at_ms=NULL WHERE link_id=? AND generation=? AND from_seq=?",
            (link_id, 1, (gap_size - 1) * 2),
        )
        newest_open_lookup = work(queries["newestGap"], (link_id, 1))
        measurements["newestOpen"] = {
            "steps": newest_open_lookup["steps"],
            "rows": newest_open_lookup["rows"],
            "toSeqIsNull": newest_open_lookup["values"][0][1] is None,
        }

        # Receipt release is destructive; all other measurements are reads.
        assert measurements["receiptHit"]["rows"] == 1
        assert measurements["receiptMiss"]["rows"] == 0
        assert measurements["outboxHit"]["rows"] == 1
        assert measurements["release"]["changes"] == 1
        assert measurements["ownerAfterAll"]["owned"] is False
        assert measurements["ownerBetween"]["owned"] is False
        assert all(measurements[key]["owned"] is True for key in ("ownerOldestHit", "ownerMiddleHit", "ownerNewestHit"))
        assert measurements["newestClosed"]["values"][0][1] is not None
        assert measurements["newestOpen"]["toSeqIsNull"] is True
        results.append({"receiptSize": receipt_size, "gapSize": gap_size, "plans": plans, "measurements": measurements})

db.close()
print(json.dumps(results))

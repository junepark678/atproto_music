"""Measure SQLite VM work for production recipient seeks and rejected old scans."""

import json
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
queries = json.load(sys.stdin)
link_id = queries["linkId"]
key_args = (link_id, "unlove", queries["exactMissKey"])


def work(sql, args):
    db.execute(sql, args).fetchall()
    steps = 0

    def tick():
        nonlocal steps
        steps += 1

    db.set_progress_handler(tick, 1)
    try:
        rows = db.execute(sql, args).fetchall()
    finally:
        db.set_progress_handler(None, 0)
    return steps, rows


def plan(sql, args):
    return [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql, args)]


exact_sql = queries["exactSql"]
exact_miss = work(exact_sql, key_args)
exact_hit = work(exact_sql, (link_id, "unlove", queries["exactHitKey"]))
exact_love_hit = work(exact_sql, (link_id, "love", queries["exactLoveHitKey"]))
old_effect = work(queries["oldEffectSql"], (link_id, "not-present"))
old_bridge = work(
    queries["oldBridgeSql"],
    (queries["did"], queries["uri"], queries["incarnationKey"]),
)
bridge_miss = work(
    queries["oldBridgeSql"],
    (queries["did"], "at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/com.example.atmusic.love/other", queries["incarnationKey"]),
)

out = {
    "size": queries["size"],
    "exactPlan": plan(exact_sql, key_args),
    "oldEffectPlan": plan(queries["oldEffectSql"], (link_id, "not-present")),
    "oldBridgePlan": plan(queries["oldBridgeSql"], (queries["did"], queries["uri"], queries["incarnationKey"])),
    "exactMissSteps": exact_miss[0],
    "exactMissRows": len(exact_miss[1]),
    "exactHitSteps": exact_hit[0],
    "exactHitRows": len(exact_hit[1]),
    "exactLoveHitSteps": exact_love_hit[0],
    "exactLoveHitRows": len(exact_love_hit[1]),
    "oldEffectSteps": old_effect[0],
    "oldEffectRows": len(old_effect[1]),
    "oldBridgeSteps": old_bridge[0],
    "oldBridgeRows": len(old_bridge[1]),
    "bridgeMissSteps": bridge_miss[0],
    "bridgeMissRows": len(bridge_miss[1]),
}
assert out["exactMissRows"] == 0
assert out["exactHitRows"] == 1
assert out["exactLoveHitRows"] == 1
assert out["oldEffectRows"] == 0
assert out["oldBridgeRows"] == queries["size"]
assert out["bridgeMissRows"] == 0
print(json.dumps(out))

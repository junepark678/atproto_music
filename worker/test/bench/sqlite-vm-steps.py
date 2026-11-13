import json
import sqlite3
import sys

payload = json.load(sys.stdin)
connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
connection.row_factory = sqlite3.Row


def measure(sql):
    ticks = [0]

    def progress():
        ticks[0] += 1
        return 0

    connection.set_progress_handler(progress, 1)
    rows = [dict(row) for row in connection.execute(sql, payload["params"])]
    connection.set_progress_handler(None, 0)
    return {"steps": ticks[0], "rows": rows}


production_sql = payload["sql"]
count_sql = production_sql.replace(
    "EXISTS(SELECT 1 FROM love_api_recipient_members m",
    "(SELECT count(*) FROM love_api_recipient_members m",
)
assert count_sql != production_sql
print(
    json.dumps(
        {
            "foreignKeys": [list(row) for row in connection.execute("PRAGMA foreign_key_check")],
            "current": measure(production_sql),
            "count": measure(count_sql),
        }
    )
)
connection.close()

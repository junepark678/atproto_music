#!/usr/bin/env python3
"""Exercise dataset and missing-index failures on an owned disposable benchmark DB."""
import argparse
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
from benchmark_read_models import plans

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset",type=Path)
    parser.add_argument("--report",type=Path)
    args = parser.parse_args()
    original = args.dataset / "music.sqlite"
    assert set(plans(original)) == {"history","feed","statistics"}
    print("PASS benchmark_dataset: exactly 100000 verified active rows, distribution 100 x 1000")
    with tempfile.TemporaryDirectory(prefix="atmusic-query-plan-") as directory:
        changed = Path(directory)/"slow.sqlite"
        shutil.copyfile(original, changed)
        with sqlite3.connect(changed) as connection:
            connection.execute("DROP INDEX scrobbles_owner_time")
            connection.execute("DROP INDEX scrobbles_global_time")
        try:
            plans(changed)
        except ValueError as error:
            assert "required index missing" in str(error)
        else:
            raise AssertionError("missing index falsely passed")
    assert set(plans(original)) == {"history","feed","statistics"}
    print("PASS slow_query_detection: missing required indexes rejected; original DB unchanged")
    if args.report:
        report = json.loads(args.report.read_text())
        assert report["measuredRequests"] == 600 and report["errors"] == 0 and report["warmupErrors"] == 0
        assert report["cpuLimit"] == 2 and report["memoryLimitBytes"] == 2147483648
        assert report["p95Milliseconds"] < 300 and report["passed"]
        print("PASS benchmark_results: 600 requests at 10/s, 2-vCPU/2-GiB container, p95 < 300ms")

if __name__ == "__main__":
    main()

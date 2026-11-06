#!/usr/bin/env python3
"""Reject a nominally successful cargo run that executed no tests."""
from pathlib import Path
import re
import sys


def executed_tests(output):
    summaries = re.findall(
        r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;", output
    )
    return sum(int(passed) + int(failed) for passed, failed in summaries)


def main():
    output = Path(sys.argv[1]).read_text()
    count = executed_tests(output)
    if count == 0:
        raise SystemExit("FAIL: cargo executed zero tests; filtered/skipped cases are not evidence")
    print(f"PASS: cargo executed {count} tests (ignored and filtered tests excluded)")


if __name__ == "__main__":
    main()

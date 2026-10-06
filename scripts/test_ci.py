#!/usr/bin/env python3
"""Verify CI failure propagation in disposable copies, never production sources."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from test_counts import executed_tests

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


def expect_failure(command, directory):
    result = subprocess.run(
        command, cwd=directory, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env={**os.environ, "CARGO_TARGET_DIR": str(ROOT / "target" / "ci-negative"),
             "CARGO_PROFILE_DEV_DEBUG": "0", "CARGO_PROFILE_TEST_DEBUG": "0",
             "CARGO_PROFILE_DEV_INCREMENTAL": "false", "CARGO_PROFILE_TEST_INCREMENTAL": "false"},
    )
    require(result.returncode != 0, f"negative check unexpectedly passed: {command}")
    return result.stdout


def main():
    scaffold = ROOT / "crates/server/tests/scaffold.rs"
    original = scaffold.read_bytes()
    digest = hashlib.sha256(original).digest()
    subprocess.run(["cargo", "fmt", "--all", "--check"], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix="atmusic-ci-") as directory:
        copy = Path(directory) / "source"
        shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(".git", "target", "work", "__pycache__"))
        source = copy / "crates/server/tests/scaffold.rs"
        source.write_bytes(original + b"\nfn intentionally_unformatted(){let _value=1;}\n")
        expect_failure(["cargo", "fmt", "--all", "--check"], copy)
        print("PASS ci_format_failure: malformed disposable source exits nonzero")

        text = original.decode()
        marker = "assert_eq!(status, 503);"
        require(marker in text, "readiness assertion to invert is missing")
        source.write_text(text.replace(marker, "assert_eq!(status, 504);", 1))
        output = expect_failure(
            ["bash", "scripts/check.sh"], copy
        )
        require(executed_tests(output) >= 4, "negative readiness test did not execute router tests")
        require("liveness_does_not_claim_readiness ... FAILED" in output,
                "inverted readiness assertion was not the observed test failure")
        print("PASS ci_assertion_failure: inverted readiness assertion fails the executed suite")

    require(hashlib.sha256(scaffold.read_bytes()).digest() == digest,
            "negative CI verification changed repository source")
    for output in ["", "test result: ok. 0 passed; 0 failed; 0 ignored; 5 filtered out;", "running 0 tests"]:
        require(executed_tests(output) == 0, "zero-test detection is invalid")
    require(executed_tests("test result: ok. 4 passed; 0 failed; 2 ignored; 7 filtered out;") == 4,
            "ignored or filtered tests were counted as executed")
    with tempfile.TemporaryDirectory(prefix="atmusic-counts-") as directory:
        log = Path(directory) / "tests.log"
        log.write_text("test result: ok. 0 passed; 0 failed; 0 ignored; 5 filtered out;")
        expect_failure(["python3", str(ROOT / "scripts/test_counts.py"), str(log)], ROOT)
    print("PASS meaningful_test_counts: zero-test runs fail, ignored/filtered cases excluded")


if __name__ == "__main__":
    main()

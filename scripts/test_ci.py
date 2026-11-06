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
    env = {
        **os.environ,
        "CARGO_TARGET_DIR": str(ROOT / "target" / "ci-negative"),
        "CARGO_PROFILE_DEV_DEBUG": "0",
        "CARGO_PROFILE_TEST_DEBUG": "0",
        "CARGO_PROFILE_DEV_INCREMENTAL": "false",
        "CARGO_PROFILE_TEST_INCREMENTAL": "false",
    }
    # CI installs the contract validator under work/, which is intentionally
    # excluded from the disposable copy. Preserve that venv for the copied
    # scripts/check.sh invocation instead of letting the copy fall back to the
    # system Python without attrs.
    common = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    candidates = [
        env.get("VIRTUAL_ENV"),
        str(ROOT / ".venv"),
        str(ROOT / "work" / "contracts-venv"),
        str(Path(common.stdout.strip()).parent / ".venv") if common.returncode == 0 else None,
    ]
    venv = next(
        (Path(candidate) for candidate in candidates if candidate and (Path(candidate) / "bin" / "activate").is_file()),
        None,
    )
    if venv is not None:
        env["VIRTUAL_ENV"] = str(venv)
        env["PATH"] = f"{venv / 'bin'}:{env.get('PATH', '')}"
    result = subprocess.run(
        command, cwd=directory, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env={**env, "CARGO_TARGET_DIR": str(Path(directory) / "target"),
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
        shutil.copytree(
            ROOT,
            copy,
            symlinks=True,
            ignore=shutil.ignore_patterns(".git", "target", "work", "__pycache__", ".venv"),
        )
        source = copy / "crates/server/tests/scaffold.rs"
        source.write_bytes(original + b"\nfn intentionally_unformatted(){let _value=1;}\n")
        expect_failure(["cargo", "fmt", "--all", "--check"], copy)
        print("PASS ci_format_failure: malformed disposable source exits nonzero")

        text = original.decode()
        marker = "assert_eq!(status, 503);"
        require(marker in text, "readiness assertion to invert is missing")
        source.write_text(text.replace(marker, "assert_eq!(status, 504);", 1))
        output = expect_failure(
            ["cargo", "test", "--locked", "-p", "atmusic-server", "--test", "scaffold"], copy
        )
        require(
            executed_tests(output) >= 4,
            "negative readiness test did not execute router tests; "
            f"disposable check output:\n{output[-6000:]}",
        )
        require("liveness_does_not_claim_readiness ... FAILED" in output,
                f"inverted readiness assertion was not the observed test failure:\n{output}")
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

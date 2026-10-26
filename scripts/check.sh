#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/validate_plan.py
python3 scripts/validate_contracts.py
python3 scripts/validate_read_fixture.py
python3 scripts/test_live_evidence.py
python3 scripts/test_audit_release.py
python3 scripts/live/oauth_check_test.py
python3 scripts/acceptance/test_backend.py
cargo fmt --all --check
python3 scripts/validate_build.py
cargo clippy --locked --workspace --all-targets -- -D warnings
test_output=$(mktemp)
trap 'rm -f "$test_output"' EXIT
cargo test --locked --workspace --all-targets 2>&1 | tee "$test_output"
python3 scripts/test_counts.py "$test_output"

#!/usr/bin/env bash
# Regenerate the Rust-oracle goldens into a temporary directory and diff them against the
# committed tests/goldens (README.md is hand-written and excluded). Exits nonzero on any drift:
# a changed byte, a missing file or an extra file.
#
#   bash scripts/check_goldens.sh             # check the committed goldens
#   bash scripts/check_goldens.sh --self-test # also prove that a one-byte mutation is detected
#   GOLDENS_DIR=/path bash scripts/check_goldens.sh   # compare against another directory
#
# Wired into the Rust CI job by W0-01's ci.yml or W7-01; until then it is run manually.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
goldens="${GOLDENS_DIR:-$root/tests/goldens}"
self_test=0
case "${1:-}" in
  "") ;;
  --self-test) self_test=1 ;;
  *) echo "usage: $0 [--self-test]" >&2; exit 2 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

generate() {
  local out="$1"
  mkdir -p "$out"
  (
    cd "$root"
    cargo run --locked -q -p atmusic-core --example export_goldens -- --out "$out"
    cargo run --locked -q -p atmusic-atproto --example export_signed_cars -- --out "$out"
  )
}

# compare EXPECTED ACTUAL -> 0 when identical (README.md excluded), 1 on drift.
compare() {
  local expected="$1" actual="$2" report
  if report="$(diff -r --brief -x README.md "$expected" "$actual" 2>&1)"; then
    return 0
  fi
  echo "$report" | head -n 40
  # Show a bounded text diff for drifted JSON files to make the failure actionable.
  diff -r -u -x README.md -x '*.car' "$expected" "$actual" 2>/dev/null | head -n 60 || true
  return 1
}

flip_byte() {
  python3 - "$1" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
data = bytearray(path.read_bytes())
data[len(data) // 2] ^= 0x01
path.write_bytes(bytes(data))
PY
}

if [ ! -d "$goldens" ]; then
  echo "FAIL check_goldens: $goldens does not exist" >&2
  exit 1
fi

generate "$work/generated"

if compare "$goldens" "$work/generated"; then
  echo "PASS check_goldens: regenerated Rust-oracle goldens are byte-identical to ${goldens#"$root"/}"
else
  echo "FAIL check_goldens: Rust-oracle goldens drifted from ${goldens#"$root"/}; regenerate with the commands in tests/goldens/README.md and review the diff" >&2
  exit 1
fi

if [ "$self_test" -eq 1 ]; then
  for target in music_keys.json signed_cars/manifest.json signed_cars/secp256k1_full_repo.car; do
    rm -rf "$work/mutated"
    cp -R "$goldens" "$work/mutated"
    flip_byte "$work/mutated/$target"
    if compare "$work/mutated" "$work/generated" >/dev/null; then
      echo "FAIL check_goldens self-test: a one-byte mutation of $target was not detected" >&2
      exit 1
    fi
    echo "PASS check_goldens self-test: one-byte mutation of $target detected (nonzero)"
  done
  rm -rf "$work/mutated"
  cp -R "$goldens" "$work/mutated"
  rm "$work/mutated/windows.json"
  if compare "$work/mutated" "$work/generated" >/dev/null; then
    echo "FAIL check_goldens self-test: a missing golden file was not detected" >&2
    exit 1
  fi
  echo "PASS check_goldens self-test: missing windows.json detected (nonzero)"
fi

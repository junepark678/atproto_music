#!/usr/bin/env python3
"""Execute deterministic federation fixtures, or explain why live execution is blocked."""
import argparse
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fixture", action="store_true", help="run signed port-zero fixture writers")
    mode.add_argument("--live", action="store_true", help="require real external federation acceptance")
    args = parser.parse_args()
    if args.fixture:
        result = subprocess.run(["cargo", "test", "--locked", "-p", "atmusic-server", "--test", "federation_faults", "--", "--nocapture"], cwd=ROOT)
        if result.returncode == 0:
            print("FIXTURE SUCCESS: generated signatures and controlled endpoints; no live federation evidence")
        return result.returncode
    # The DNS-pinned Rustls/WSS adapter has deterministic transport coverage.
    # Exact current-head trust enables signed snapshots and PDS publication.
    # Older events and subscription coverage still need a safe recovery policy.
    missing = ["historical_event_trust_or_safe_current_head_recovery (not implemented)",
               "production_relay_progress_and_subscription_coverage (not implemented)",
               "live_federation_acceptance_runner (not implemented)"]
    for name in ("ATMUSIC_PUBLIC_ORIGIN", "ATMUSIC_LEXICON_PREFIX", "ATMUSIC_NAMESPACE_OWNER_DOMAIN",
                 "ATMUSIC_NAMESPACE_OWNERSHIP_REFERENCE", "ATMUSIC_RELAY_URL", "ATMUSIC_FEDERATION_DIDS",
                 "ATMUSIC_FEDERATION_PDS_ENDPOINTS", "ATMUSIC_FEDERATION_RELAY_COVERAGE_EVIDENCE"):
        if not os.environ.get(name):
            missing.append(name)
    print("BLOCKED: live federation did not execute")
    for name in missing:
        print(f"- {name}")
    return 2

if __name__ == "__main__":
    raise SystemExit(main())

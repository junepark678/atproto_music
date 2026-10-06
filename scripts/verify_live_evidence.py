#!/usr/bin/env python3
"""Validate the live evidence inventory; this command never executes live tests."""
import argparse
from datetime import datetime
import hashlib
import ipaddress
import json
from pathlib import Path
import re
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_EVIDENCE = ("oauth", "localWrite", "externalWrite", "follow", "stats", "delete", "restore")


def secure_url(value, schemes, origin=False):
    if not isinstance(value, str):
        return False
    try:
        parsed = urlparse(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return False
    if not hostname or port is not None and not 1 <= port <= 65535:
        return False
    host = hostname.rstrip(".").lower()
    if any(host == reserved or host.endswith("." + reserved) for reserved in ("example.com", "example.net", "example.org")):
        return False
    if host.rsplit(".", 1)[-1] in {"example", "invalid", "test", "localhost", "local", "onion", "arpa"}:
        return False
    try:
        if not ipaddress.ip_address(host).is_global:
            return False
    except ValueError:
        pass
    return bool(parsed.scheme in schemes and parsed.hostname and not parsed.username
                and not parsed.password and not parsed.fragment
                and (not origin or (parsed.path in ("", "/") and not parsed.query)))


def problems(manifest, artifact_sha256=None):
    missing = []
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        return ["schemaVersion (expected 1)"]
    if manifest.get("fixtureOnly") is not False:
        missing.append("live evidence (fixture-only inventories cannot satisfy acceptance)")
    prerequisites = manifest.get("prerequisites")
    if not isinstance(prerequisites, dict):
        prerequisites = {}
    identities = prerequisites.get("dedicatedIdentities")
    if not isinstance(identities, list) or len(set(str(v) for v in identities)) < 2 or not all(
        isinstance(value, str) and re.fullmatch(r"did:(?:plc:[a-z2-7]{24}|web:[^\s/?#]+)", value)
        for value in identities
    ):
        missing.append("prerequisites.dedicatedIdentities (two dedicated test DIDs)")
    elif set(identities) & {f"did:plc:{letter * 24}" for letter in "abc"}:
        missing.append("prerequisites.dedicatedIdentities (reserved fixture DIDs are not live identities)")
    prefix = prerequisites.get("ownedLexiconPrefix")
    if not isinstance(prefix, str) or not re.fullmatch(r"[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}", prefix) or prefix.startswith(("com.example.", "org.example.", "net.example.")):
        missing.append("prerequisites.ownedLexiconPrefix (owned production namespace)")
    if not secure_url(prerequisites.get("publicHttpsOrigin"), {"https"}, origin=True):
        missing.append("prerequisites.publicHttpsOrigin (public HTTPS callback origin)")
    endpoints = prerequisites.get("pdsEndpoints")
    if not isinstance(endpoints, list) or len(set(str(value) for value in endpoints)) < 2 or not all(secure_url(value, {"https"}) for value in endpoints):
        missing.append("prerequisites.pdsEndpoints (two distinct HTTPS PDS endpoints)")
    if prerequisites.get("independentPdsOperatorsVerified") is not True:
        missing.append("prerequisites.independentPdsOperatorsVerified")
    if not secure_url(prerequisites.get("relayUrl"), {"https", "wss"}):
        missing.append("prerequisites.relayUrl")
    if prerequisites.get("relayCoverageVerified") is not True:
        missing.append("prerequisites.relayCoverageVerified (coverage of both external PDSs)")
    checksum = manifest.get("artifactSha256")
    if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
        missing.append("artifactSha256")
    elif artifact_sha256 is not None and checksum != artifact_sha256:
        missing.append("artifactSha256 (does not match the inspected artifact)")
    entries = manifest.get("evidence")
    if not isinstance(entries, dict):
        entries = {}
    for name in REQUIRED_EVIDENCE:
        entry = entries.get(name)
        if not isinstance(entry, dict):
            missing.append(f"evidence.{name}")
            continue
        if entry.get("result") != "passed":
            missing.append(f"evidence.{name}.result")
        if entry.get("artifactSha256") != checksum or not isinstance(checksum, str):
            missing.append(f"evidence.{name}.artifactSha256")
        if not isinstance(entry.get("commit"), str) or not re.fullmatch(r"[0-9a-f]{40}", entry["commit"]):
            missing.append(f"evidence.{name}.commit")
        try:
            recorded = datetime.fromisoformat(entry.get("recordedAt", "").replace("Z", "+00:00"))
            if recorded.tzinfo is None:
                raise ValueError("timezone required")
        except (AttributeError, TypeError, ValueError):
            missing.append(f"evidence.{name}.recordedAt")
        for field in ("testCommand", "independentEvidence", "cleanup"):
            if not isinstance(entry.get(field), str) or not entry[field].strip():
                missing.append(f"evidence.{name}.{field}")
        if entry.get("fixtureOnly") is not False:
            missing.append(f"evidence.{name}.liveEvidence")
    return missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", nargs="?", type=Path, default=ROOT / "docs/verification/live-evidence.json")
    parser.add_argument("--artifact", type=Path, help="require evidence to match this artifact checksum")
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text())
        checksum = hashlib.sha256(args.artifact.read_bytes()).hexdigest() if args.artifact else None
    except (OSError, ValueError):
        raise SystemExit("BLOCKED: live evidence inventory or artifact is unavailable/invalid; no live tests ran")
    missing = problems(manifest, checksum)
    if missing:
        print("BLOCKED: live evidence inventory is incomplete; no live tests ran")
        for problem in missing:
            print(f"- {problem}")
        raise SystemExit(2)
    print("PASS: recorded live evidence inventory is complete for one artifact")
    print("This validates inventory fields only; inspect the referenced independent verification evidence.")


if __name__ == "__main__":
    main()

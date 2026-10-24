#!/usr/bin/env python3
"""Validate the Workers live evidence inventory (ADR 0004 §10.4, A19; W6-05).

This command never executes a live test. It classifies recorded evidence as
PASS (exit 0), FAIL (exit 1) or BLOCKED (exit 2):

- PASS: every required gate (oauth, ingest, pdsCompat, ssrfProbe, socketSoak)
  has a `passed` result for one Worker version id and one bundle SHA-256, with
  complete provenance and the gate's required results.
- FAIL: at least one gate recorded a `failed` result with valid provenance. A
  failure is definitive for that version, whatever else is missing.
- BLOCKED: anything else. A gate whose script reported `blocked` (missing
  prerequisites), a gate with no evidence, and evidence that is malformed,
  fixture-only, or not bound to the release under review (a missing or
  different version id or bundle hash) all leave the gate open.

Schema (schemaVersion 2; docs/verification/workers-live.md):

    {"schemaVersion": 2, "fixtureOnly": false,
     "release": {"workerVersionId": <uuid>, "bundleSha256": <64 hex>, "commit": <40 hex>},
     "prerequisites": {"ownedLexiconPrefix", "publicHttpsOrigin",
                       "identities": [{"did", "pds"}, {"did", "pds"}],
                       "independentPdsOperatorsVerified": true,
                       "jetstreamCoverageVerified": true, "adminTokenConfigured": true},
     "gates": {"<gate>": <the JSON document the gate script printed>}}

Each gate document carries schemaVersion, gate, result, fixtureOnly:false,
recordedAt, testCommand, workerVersionId, bundleSha256, commit, origin,
lexiconPrefix, pds [{endpoint, implementation, version}], subjects [{did,
uri}], results, cleanup, and `missing` (blocked) or `failures` (failed).

`--gate FILE` classifies one gate document on its own. The verifier checks
recorded fields and their consistency only; it cannot establish that cited
external evidence is authentic.
"""
import argparse
from datetime import datetime
import hashlib
import ipaddress
import json
from pathlib import Path
import re
import sys
from typing import NamedTuple
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_VERSION = 2
REQUIRED_GATES = ("oauth", "ingest", "pdsCompat", "ssrfProbe", "socketSoak")
OUTCOMES = ("passed", "failed", "blocked")
PDS_GATES = ("oauth", "ingest", "pdsCompat")
EXIT_CODES = {"passed": 0, "failed": 1, "blocked": 2}
MIN_SOAK_HOURS = 24
SSRF_LABELS = ("rfc1918", "loopback", "metadata")

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
COMMIT_RE = re.compile(r"[0-9a-f]{40}")
TID_RE = re.compile(r"[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}")
DID_RE = re.compile(r"did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+)")
CID_RE = re.compile(r"b[a-z2-7]{20,}")
PREFIX_RE = re.compile(r"[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,}")
FIXTURE_DIDS = {f"did:plc:{letter * 24}" for letter in "abcde"}
FIXTURE_PREFIX = "com.example.atmusic"


class Verdict(NamedTuple):
    status: str
    problems: list
    gates: dict


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
    if host.rsplit(".", 1)[-1] in {"example", "invalid", "test", "localhost", "local", "onion", "arpa", "internal"}:
        return False
    try:
        if not ipaddress.ip_address(host).is_global:
            return False
    except ValueError:
        pass
    return bool(parsed.scheme in schemes and parsed.hostname and not parsed.username
                and not parsed.password and not parsed.fragment
                and (not origin or (parsed.path in ("", "/") and not parsed.query)))


def _host(url):
    try:
        return (urlparse(url).hostname or "").rstrip(".").lower()
    except ValueError:
        return ""


def _origin(url):
    return url.rstrip("/") if isinstance(url, str) else url


def owned_prefix(value):
    return (isinstance(value, str) and PREFIX_RE.fullmatch(value) is not None and value != FIXTURE_PREFIX
            and not value.startswith(("com.example.", "org.example.", "net.example.")))


def live_did(value):
    return isinstance(value, str) and DID_RE.fullmatch(value) is not None and value not in FIXTURE_DIDS


def _timestamp(value):
    try:
        recorded = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError):
        return False
    return recorded.tzinfo is not None


def _nonempty(value):
    return isinstance(value, str) and value.strip() != ""


def _int(value, minimum=0):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def release_problems(release):
    if not isinstance(release, dict):
        return ["release (workerVersionId, bundleSha256, commit)"]
    problems = []
    if not isinstance(release.get("workerVersionId"), str) or not UUID_RE.fullmatch(release["workerVersionId"]):
        problems.append("release.workerVersionId (Worker version id, a UUID)")
    if not isinstance(release.get("bundleSha256"), str) or not SHA256_RE.fullmatch(release["bundleSha256"]):
        problems.append("release.bundleSha256 (bundle SHA-256 from check-bundle.ts --release)")
    if not isinstance(release.get("commit"), str) or not COMMIT_RE.fullmatch(release["commit"]):
        problems.append("release.commit (40-hex source commit)")
    return problems


def prerequisite_problems(prereq):
    if not isinstance(prereq, dict):
        prereq = {}
    problems = []
    if not owned_prefix(prereq.get("ownedLexiconPrefix")):
        problems.append("prerequisites.ownedLexiconPrefix (owned production namespace)")
    if not secure_url(prereq.get("publicHttpsOrigin"), {"https"}, origin=True):
        problems.append("prerequisites.publicHttpsOrigin (deployed public HTTPS origin)")
    identities = prereq.get("identities")
    valid = isinstance(identities, list) and len(identities) == 2 and all(
        isinstance(i, dict) and live_did(i.get("did")) and secure_url(i.get("pds"), {"https"}, origin=True)
        for i in identities)
    if not valid:
        problems.append("prerequisites.identities (two dedicated live DIDs, each with its public HTTPS PDS)")
    elif identities[0]["did"] == identities[1]["did"] or _host(identities[0]["pds"]) == _host(identities[1]["pds"]):
        problems.append("prerequisites.identities (two different DIDs on two different PDS hosts)")
    for flag in ("independentPdsOperatorsVerified", "jetstreamCoverageVerified", "adminTokenConfigured"):
        if prereq.get(flag) is not True:
            problems.append(f"prerequisites.{flag}")
    return problems


def provenance_problems(name, entry, release):
    """Fields every recorded gate result needs, bound to the release under review."""
    where = f"gates.{name}"
    problems = []
    if entry.get("schemaVersion") != SCHEMA_VERSION:
        problems.append(f"{where}.schemaVersion (expected {SCHEMA_VERSION})")
    if entry.get("gate") != name:
        problems.append(f"{where}.gate (names {entry.get('gate')!r})")
    if entry.get("fixtureOnly") is not False:
        problems.append(f"{where}.fixtureOnly (fixture evidence never closes a live gate)")
    version = entry.get("workerVersionId")
    if not isinstance(version, str) or not UUID_RE.fullmatch(version):
        problems.append(f"{where}.workerVersionId (missing or not a Worker version id)")
    elif isinstance(release, dict) and version != release.get("workerVersionId"):
        problems.append(f"{where}.workerVersionId (recorded for another Worker version)")
    bundle = entry.get("bundleSha256")
    if not isinstance(bundle, str) or not SHA256_RE.fullmatch(bundle):
        problems.append(f"{where}.bundleSha256 (missing or not a SHA-256)")
    elif isinstance(release, dict) and bundle != release.get("bundleSha256"):
        problems.append(f"{where}.bundleSha256 (recorded for another bundle)")
    commit = entry.get("commit")
    if not isinstance(commit, str) or not COMMIT_RE.fullmatch(commit):
        problems.append(f"{where}.commit")
    elif isinstance(release, dict) and commit != release.get("commit"):
        problems.append(f"{where}.commit (recorded for another commit)")
    if not _timestamp(entry.get("recordedAt")):
        problems.append(f"{where}.recordedAt (timezone-qualified date)")
    if not _nonempty(entry.get("testCommand")):
        problems.append(f"{where}.testCommand")
    return problems


def _pds_problems(where, entry, prereq):
    pds = entry.get("pds")
    if not isinstance(pds, list) or len(pds) < 2 or not all(
            isinstance(p, dict) and secure_url(p.get("endpoint"), {"https"}, origin=True)
            and _nonempty(p.get("implementation")) and _nonempty(p.get("version")) for p in pds):
        return [f"{where}.pds (endpoint, implementation and version for both PDSs)"]
    if len({_host(p["endpoint"]) for p in pds}) < 2:
        return [f"{where}.pds (both PDSs on one host)"]
    expected = {_host(i.get("pds")) for i in prereq.get("identities", []) if isinstance(i, dict)}
    if expected and not expected <= {_host(p["endpoint"]) for p in pds}:
        return [f"{where}.pds (does not cover the prerequisite PDSs)"]
    return []


def _identity_dids(prereq):
    return {i.get("did") for i in prereq.get("identities", []) if isinstance(i, dict)}


def _subject_problems(where, entry, prereq, need_uri, prefix):
    subjects = entry.get("subjects")
    if not isinstance(subjects, list) or not subjects or not all(
            isinstance(s, dict) and live_did(s.get("did")) for s in subjects):
        return [f"{where}.subjects (DID and AT URI of each subject)"]
    problems = []
    dids = {s["did"] for s in subjects}
    expected = _identity_dids(prereq)
    if expected and not expected <= dids:
        problems.append(f"{where}.subjects (do not cover both prerequisite identities)")
    for subject in subjects:
        uri = subject.get("uri")
        if uri is None and not need_uri:
            continue
        match = re.fullmatch(r"at://(did:[a-z]+:[A-Za-z0-9._:%-]+)/([a-zA-Z0-9.-]+)/([A-Za-z0-9._~:-]+)", uri or "")
        if not match or match.group(1) != subject["did"]:
            problems.append(f"{where}.subjects (AT URI {uri!r} is not a record of {subject['did']})")
        elif need_uri and prefix and not match.group(2).startswith(prefix + "."):
            problems.append(f"{where}.subjects ({uri} is outside the owned namespace)")
    return problems


def _results_problems(name, entry, prefix):
    where = f"gates.{name}.results"
    results = entry.get("results")
    if not isinstance(results, dict) or not results:
        return [where]
    problems = []
    if name == "oauth":
        sign_ins = results.get("signIns")
        if not isinstance(sign_ins, list) or len(sign_ins) < 2:
            return [f"{where}.signIns (one per PDS)"]
        for item in sign_ins:
            if not isinstance(item, dict) or not live_did(item.get("did")):
                problems.append(f"{where}.signIns (DID)")
            elif item.get("repoScopesGranted") is not True or item.get("transitionGeneric") is not False:
                problems.append(f"{where}.signIns ({item['did']}: granular repo: scopes not granted)")
            elif not _nonempty(item.get("grantedScope")) or f"repo:{prefix}.scrobble" not in item["grantedScope"]:
                problems.append(f"{where}.signIns ({item['did']}: grantedScope lacks repo:{prefix}.scrobble)")
    elif name == "ingest":
        published = []
        for key in ("localPublish", "externalPublish"):
            item = results.get(key)
            if not isinstance(item, dict) or not isinstance(item.get("cid"), str) or not CID_RE.fullmatch(item["cid"]):
                problems.append(f"{where}.{key} (written CID)")
                continue
            if item.get("verifiedCid") != item["cid"] or item.get("indexedCid") != item["cid"]:
                problems.append(f"{where}.{key} (indexed, written and independently verified CIDs differ)")
            if not isinstance(item.get("verifiedRev"), str) or not TID_RE.fullmatch(item["verifiedRev"]):
                problems.append(f"{where}.{key}.verifiedRev (independently fetched revision)")
            if not _int(item.get("lagMs")):
                problems.append(f"{where}.{key}.lagMs")
            published.append(item.get("uri"))
        deletes = results.get("deleteReconcile")
        if not isinstance(deletes, list) or len(deletes) < 2:
            problems.append(f"{where}.deleteReconcile (both records deleted and reconciled)")
        else:
            for item in deletes:
                if not isinstance(item, dict) or item.get("absentVerified") is not True:
                    problems.append(f"{where}.deleteReconcile (absence not independently verified)")
                elif not isinstance(item.get("verifiedRev"), str) or not TID_RE.fullmatch(item["verifiedRev"]) \
                        or not _int(item.get("lagMs")):
                    problems.append(f"{where}.deleteReconcile ({item.get('uri')}: verifiedRev and lagMs)")
            if sorted(str(d.get("uri")) for d in deletes if isinstance(d, dict)) != sorted(str(u) for u in published):
                problems.append(f"{where}.deleteReconcile (does not cover the published records)")
    elif name == "pdsCompat":
        per_pds = results.get("perPds")
        if not isinstance(per_pds, list) or len(per_pds) < 2:
            return [f"{where}.perPds (one per PDS)"]
        for item in per_pds:
            if not isinstance(item, dict) or not all(isinstance(item.get(k), bool) for k in (
                    "getRecordInclusion", "getRecordExclusion", "getBlocks", "getRepoStatus")):
                problems.append(f"{where}.perPds (four capability results)")
            elif item["getRecordInclusion"] is not True or item["getRepoStatus"] is not True:
                problems.append(f"{where}.perPds ({item.get('endpoint')}: mandatory getRecord/getRepoStatus missing)")
    elif name == "ssrfProbe":
        targets = results.get("targets")
        if not isinstance(targets, list) or not targets:
            return [f"{where}.targets"]
        labels = set()
        for item in targets:
            target = item.get("target") if isinstance(item, dict) else None
            if not isinstance(target, dict) or not isinstance(item.get("raw"), list) or not item["raw"]:
                problems.append(f"{where}.targets (target and raw fetch outcomes)")
                continue
            if (item.get("safeFetch") or {}).get("outcome") != "refused":
                problems.append(f"{where}.targets ({target.get('host')}: SafeFetch did not refuse)")
            if target.get("kind") == "controlledName":
                labels.add(target.get("label"))
        for label in SSRF_LABELS:
            if label not in labels:
                problems.append(f"{where}.targets (no controlled DNS name for {label})")
    elif name == "socketSoak":
        if not _number(results.get("durationHours")) or results["durationHours"] < MIN_SOAK_HOURS:
            problems.append(f"{where}.durationHours (at least {MIN_SOAK_HOURS} h)")
        if results.get("decision") not in ("socket", "pulse"):
            problems.append(f"{where}.decision (socket or pulse)")
        if not _int(results.get("reconnectsLowerBound")):
            problems.append(f"{where}.reconnectsLowerBound")
        if not _number((results.get("lagMs") or {}).get("p95")):
            problems.append(f"{where}.lagMs.p95")
        if not _int((results.get("analytics") or {}).get("doRequests")):
            problems.append(f"{where}.analytics.doRequests (billed DO requests)")
        if not _number(results.get("cpuMsPerAlarmUpperBound")):
            problems.append(f"{where}.cpuMsPerAlarmUpperBound")
    return problems


def gate_status(name, entry, release, prereq):
    """Return (status, problems) for one gate: passed, failed or blocked."""
    where = f"gates.{name}"
    if not isinstance(entry, dict):
        return "blocked", [f"{where} (no evidence recorded)"]
    if entry.get("result") not in OUTCOMES:
        return "blocked", [f"{where}.result (one of passed, failed, blocked)"]
    problems = provenance_problems(name, entry, release)
    result = entry["result"]
    if result == "blocked":
        missing = entry.get("missing")
        if not isinstance(missing, list) or not missing or not all(_nonempty(m) for m in missing):
            return "blocked", problems + [f"{where}.missing (a blocked result lists its missing prerequisites)"]
        return "blocked", problems + [f"{where}: blocked — {m}" for m in missing]
    if problems:
        # Evidence that is not bound to this release is rejected, failed or passed alike.
        return "blocked", problems
    if result == "failed":
        failures = entry.get("failures")
        if not isinstance(failures, list) or not failures or not all(_nonempty(f) for f in failures):
            return "blocked", [f"{where}.failures (a failed result names its failures)"]
        return "failed", [f"{where}: failed — {f}" for f in failures]
    if entry.get("failures"):
        return "blocked", [f"{where} (a passed result carries failures)"]
    prefix = prereq.get("ownedLexiconPrefix") if isinstance(prereq, dict) else None
    prefix = prefix if isinstance(prefix, str) else entry.get("lexiconPrefix")
    if not _nonempty(entry.get("cleanup")):
        problems.append(f"{where}.cleanup (cleanup outcome)")
    if isinstance(prereq, dict) and prereq:
        if _origin(entry.get("origin")) != _origin(prereq.get("publicHttpsOrigin")):
            problems.append(f"{where}.origin (not the prerequisite origin)")
        if entry.get("lexiconPrefix") != prereq.get("ownedLexiconPrefix"):
            problems.append(f"{where}.lexiconPrefix (not the owned prefix)")
    else:
        prereq = {}
    if name in PDS_GATES:
        problems += _pds_problems(where, entry, prereq)
        problems += _subject_problems(where, entry, prereq, need_uri=name == "ingest", prefix=prefix)
    problems += _results_problems(name, entry, prefix)
    return ("blocked", problems) if problems else ("passed", [])


def evaluate(manifest, bundle_sha256=None, worker_version_id=None):
    """Classify a whole inventory: Verdict(status, problems, per-gate statuses)."""
    if not isinstance(manifest, dict):
        return Verdict("blocked", ["inventory (not a JSON object)"], {})
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        return Verdict("blocked", [
            f"schemaVersion (expected {SCHEMA_VERSION}; the schemaVersion 1 musl-artifact inventory "
            "cannot record Worker version evidence)"], {})
    problems = []
    if manifest.get("fixtureOnly") is not False:
        problems.append("fixtureOnly (fixture-only inventories cannot satisfy acceptance)")
    release = manifest.get("release")
    problems += release_problems(release)
    if isinstance(release, dict):
        if bundle_sha256 is not None and release.get("bundleSha256") != bundle_sha256:
            problems.append("release.bundleSha256 (does not match the bundle under review)")
        if worker_version_id is not None and release.get("workerVersionId") != worker_version_id:
            problems.append("release.workerVersionId (does not match the version under review)")
    prereq = manifest.get("prerequisites")
    problems += prerequisite_problems(prereq)
    gates = manifest.get("gates")
    if not isinstance(gates, dict):
        gates = {}
    statuses = {}
    for name in REQUIRED_GATES:
        status, gate_problems = gate_status(name, gates.get(name), release if isinstance(release, dict) else None,
                                            prereq if isinstance(prereq, dict) else {})
        statuses[name] = status
        problems += gate_problems
    for name in sorted(set(gates) - set(REQUIRED_GATES)):
        problems.append(f"gates.{name} (unknown gate)")
    if "failed" in statuses.values():
        status = "failed"
    elif problems:
        status = "blocked"
    else:
        status = "passed"
    return Verdict(status, problems, statuses)


def problems(manifest, artifact_sha256=None):
    """Everything that keeps the inventory from passing (compatibility helper)."""
    return evaluate(manifest, artifact_sha256).problems


def _report(status, lines, subject):
    head = {
        "passed": f"PASS: {subject} is complete for one Worker version and bundle",
        "failed": f"FAIL: {subject} records a failed live gate",
        "blocked": f"BLOCKED: {subject} is incomplete; no live tests ran",
    }[status]
    print(head)
    for line in lines:
        print(f"- {line}")
    if status == "passed":
        print("This validates recorded fields only; inspect the referenced independent verification evidence.")
    return EXIT_CODES[status]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("manifest", nargs="?", type=Path, default=ROOT / "docs/verification/live-evidence.json")
    parser.add_argument("--gate", type=Path, help="classify one gate result document printed by a scripts/live gate")
    parser.add_argument("--bundle-sha256", help="require the evidence to be for this bundle SHA-256")
    parser.add_argument("--worker-version-id", help="require the evidence to be for this Worker version id")
    parser.add_argument("--artifact", type=Path, help="require the evidence bundle hash to be this file's SHA-256")
    args = parser.parse_args(argv)
    try:
        if args.gate is not None:
            entry = json.loads(args.gate.read_text())
        else:
            manifest = json.loads(args.manifest.read_text())
        bundle = args.bundle_sha256
        if args.artifact is not None:
            bundle = hashlib.sha256(args.artifact.read_bytes()).hexdigest()
    except (OSError, ValueError):
        print("BLOCKED: live evidence inventory or artifact is unavailable/invalid; no live tests ran")
        return EXIT_CODES["blocked"]
    if args.gate is not None:
        name = entry.get("gate") if isinstance(entry, dict) else None
        if name not in REQUIRED_GATES:
            return _report("blocked", ["gate (not a known live gate)"], "gate result")
        release = {"workerVersionId": args.worker_version_id or entry.get("workerVersionId"),
                   "bundleSha256": bundle or entry.get("bundleSha256"), "commit": entry.get("commit")}
        status, lines = gate_status(name, entry, release, {})
        return _report(status, lines, f"{name} gate result")
    verdict = evaluate(manifest, bundle, args.worker_version_id)
    gates = ", ".join(f"{name}={status}" for name, status in verdict.gates.items())
    return _report(verdict.status, verdict.problems + ([f"gates: {gates}"] if gates else []), "live evidence inventory")


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Validate the Workers live evidence inventory (ADR 0004 §10.4, A19; W6-05).

This command never executes a live test. It classifies recorded evidence as
PASS (exit 0), FAIL (exit 1) or BLOCKED (exit 2):

- PASS: every required gate (oauth, ingest, pdsCompat, ssrfProbe, socketSoak)
  has a `passed` result for one Worker version id and one bundle SHA-256, with
  complete provenance and the gate's required results.
- FAIL: the inventory is bound to the release under review (valid release,
  matching --bundle-sha256/--worker-version-id, fixtureOnly false, complete
  prerequisites) and at least one gate recorded a `failed` result with valid
  provenance for that release, origin and prefix. Such a failure is
  definitive for that version, whatever else is missing.
- BLOCKED: anything else. A gate whose script reported `blocked` (missing
  prerequisites), a gate with no evidence, and evidence that is malformed,
  fixture-only, or not bound to the release under review (a missing or
  different version id or bundle hash, or missing prerequisites) all leave the
  gate open. A failure recorded in an unbound inventory is reported but stays
  BLOCKED: it says nothing about the bundle under review.

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

Every passed or failed gate document must name an owned prefix (never the
fixture prefix) and a public HTTPS origin of its own, with or without
prerequisites. PDS implementation and version must be reported (no
placeholder such as 'unreported'). Each oauth sign-in records the token `sub`
(equal to its DID), a grantedScope with create, update and delete on every
collection, and signedOut true. The socketSoak decision and failedThresholds
must follow from its recorded thresholds and measurements (reconnectsPerDay,
projectedMonthlyDoRequests and cpuMsPerAlarmUpperBound are recomputed from
reconnectsLowerBound, analytics and durationHours). Each ingest deleteReconcile entry names its
absence method (exclusionProof or snapshot, F4); in an inventory the method
must match pdsCompat's getRecordExclusion result for that identity's PDS.

`--gate FILE` classifies one gate document on its own. The verifier checks
recorded fields and their consistency only; it cannot establish that cited
external evidence is authentic.
"""
import argparse
from datetime import datetime
import hashlib
import ipaddress
import json
import math
from pathlib import Path
import re
import sys
from typing import NamedTuple
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_VERSION = 2
REQUIRED_GATES = ("oauth", "ingest", "pdsCompat", "ssrfProbe", "socketSoak")
OUTCOMES = ("passed", "failed", "blocked")
PDS_GATES = ("oauth", "ingest", "pdsCompat")
EXIT_CODES = {"passed": 0, "failed": 1, "blocked": 2}
MIN_SOAK_HOURS = 24
# scripts/live/workers_socket_soak.ts decide(): the four thresholds and the
# order in which a failed one is listed in failedThresholds.
SOAK_THRESHOLDS = ("maxReconnectsPerDay", "maxLagP95Ms", "maxMonthlyDoRequests", "maxCpuMsPerAlarm")
SOAK_CHECKS = ("reconnectsPerDay", "lagP95Ms", "projectedMonthlyDoRequests", "cpuMsPerAlarm")
REPO_ACTIONS = ("create", "update", "delete")
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
# Values that say "not known" instead of naming a PDS implementation or version.
PLACEHOLDERS = {"unreported", "unknown", "none", "null", "undefined", "n/a", "na", "tbd", "todo", "?", "-"}
ABSENCE_METHODS = ("exclusionProof", "snapshot")


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


def _reported(value):
    """A non-empty string that is not a placeholder such as 'unreported'."""
    return _nonempty(value) and value.strip().lower() not in PLACEHOLDERS


def _int(value, minimum=0):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _repo_grant(token):
    """(collections, actions) one `repo` scope token grants, or None (scripts/live/workers_oauth_check.ts repoGrant)."""
    if not (token.startswith("repo:") or token.startswith("repo?")):
        return None
    head, _, query = token.partition("?")
    params = parse_qs(query, keep_blank_values=True)
    positional = unquote(head[len("repo:"):]) if head.startswith("repo:") else ""
    collections = ([positional] if positional else []) + params.get("collection", [])
    actions = set(params.get("action", [])) or set(REPO_ACTIONS)
    return collections, actions


def full_repo_grant(prefix, scope):
    """`atproto` plus create, update and delete on each of the prefix's three collections."""
    tokens = scope.split() if isinstance(scope, str) else []
    grants = [g for g in map(_repo_grant, tokens) if g is not None]
    if "atproto" not in tokens or not isinstance(prefix, str):
        return False
    for collection in (f"{prefix}.scrobble", f"{prefix}.follow", f"{prefix}.settings"):
        actions = set()
        for collections, granted in grants:
            if collection in collections:
                actions |= granted
        if not set(REPO_ACTIONS) <= actions:
            return False
    return True


def node_full_repo_grant(prefix, scope):
    """Node OAuth grant: `atproto` plus full repo actions on all four Node collections."""
    tokens = scope.split() if isinstance(scope, str) else []
    grants = [g for g in map(_repo_grant, tokens) if g is not None]
    if "atproto" not in tokens or any(token.startswith("transition:") for token in tokens):
        return False
    if not isinstance(prefix, str):
        return False
    for collection in (f"{prefix}.scrobble", f"{prefix}.follow", f"{prefix}.settings", f"{prefix}.love"):
        actions = set()
        for collections, granted in grants:
            if collection in collections:
                actions |= granted
        if not set(REPO_ACTIONS) <= actions:
            return False
    return True


def _close(a, b):
    return _number(a) and _number(b) and abs(a - b) <= 1e-6 * max(1.0, abs(a), abs(b))


def _js_round(value):
    """Math.round: halves round up."""
    return int(math.floor(value + 0.5))


def soak_decision_problems(where, results):
    """The soak decision must follow from its recorded thresholds and measurements (decide())."""
    problems = []
    thresholds = results.get("thresholds")
    if not isinstance(thresholds, dict) or not all(
            _number(thresholds.get(k)) and thresholds[k] > 0 for k in SOAK_THRESHOLDS):
        return [f"{where}.thresholds (the four positive decision thresholds: {', '.join(SOAK_THRESHOLDS)})"]
    hours = results.get("durationHours")
    analytics = results.get("analytics") if isinstance(results.get("analytics"), dict) else {}
    if not _number(hours) or hours <= 0:
        return problems  # durationHours is reported on its own
    per_day = lambda n: n * 24 / hours  # noqa: E731
    reconnects = results.get("reconnectsLowerBound")
    if _int(reconnects) and not _close(results.get("reconnectsPerDay"), per_day(reconnects)):
        problems.append(f"{where}.reconnectsPerDay (is not reconnectsLowerBound × 24 / durationHours)")
    requests = analytics.get("doRequests")
    expected_monthly = _js_round(per_day(requests) * 30) if _int(requests, 1) else None
    if expected_monthly is not None and results.get("projectedMonthlyDoRequests") != expected_monthly:
        problems.append(f"{where}.projectedMonthlyDoRequests (is not analytics.doRequests projected to 30 days)")
    cpu, alarms = analytics.get("cpuTimeUs"), analytics.get("alarmInvocations")
    expected_cpu = cpu / 1000 / alarms if _number(cpu) and _int(alarms, 1) else None
    if expected_cpu is not None and not _close(results.get("cpuMsPerAlarmUpperBound"), expected_cpu):
        problems.append(f"{where}.cpuMsPerAlarmUpperBound (is not analytics.cpuTimeUs / 1000 / alarmInvocations)")
    if problems or expected_monthly is None or expected_cpu is None or not _int(reconnects):
        return problems
    p95 = (results.get("lagMs") or {}).get("p95") if isinstance(results.get("lagMs"), dict) else None
    measured = {
        "reconnectsPerDay": per_day(reconnects),
        "lagP95Ms": p95 if _number(p95) else None,
        "projectedMonthlyDoRequests": expected_monthly,
        "cpuMsPerAlarm": expected_cpu,
    }
    failed = [check for check, limit in zip(SOAK_CHECKS, SOAK_THRESHOLDS)
              if measured[check] is None or measured[check] > thresholds[limit]]
    if results.get("failedThresholds") != failed:
        problems.append(f"{where}.failedThresholds (recorded {results.get('failedThresholds')!r}, but the measurements "
                        f"and thresholds give {failed!r})")
    expected_decision = "pulse" if failed else "socket"
    if results.get("decision") in ("socket", "pulse") and results["decision"] != expected_decision:
        problems.append(f"{where}.decision (recorded {results['decision']!r}, but the thresholds give "
                        f"{expected_decision!r})")
    return problems


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


def prerequisite_problems(prereq, *, node=False):
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
    flags = ("independentPdsOperatorsVerified", "jetstreamCoverageVerified")
    if not node:
        flags += ("adminTokenConfigured",)
    for flag in flags:
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
            and _reported(p.get("implementation")) and _reported(p.get("version")) for p in pds):
        return [f"{where}.pds (endpoint, implementation and version for both PDSs; 'unreported' is not a value)"]
    if len({_host(p["endpoint"]) for p in pds}) < 2:
        return [f"{where}.pds (both PDSs on one host)"]
    expected = {_host(i.get("pds")) for i in prereq.get("identities", []) if isinstance(i, dict)}
    if expected and not expected <= {_host(p["endpoint"]) for p in pds}:
        return [f"{where}.pds (does not cover the prerequisite PDSs)"]
    return []


def _identity_dids(prereq):
    return {i.get("did") for i in prereq.get("identities", []) if isinstance(i, dict)}


def _identities(prereq):
    """The two prerequisite identities (A, B) as (did, pds host) pairs, or None when not recorded."""
    identities = prereq.get("identities") if isinstance(prereq, dict) else None
    if not isinstance(identities, list) or len(identities) != 2 or not all(isinstance(i, dict) for i in identities):
        return None
    return [(i.get("did"), _host(i.get("pds"))) for i in identities]


def _record_did(uri):
    match = re.fullmatch(r"at://(did:[a-z]+:[A-Za-z0-9._:%-]+)/([a-zA-Z0-9.-]+)/([A-Za-z0-9._~:-]+)",
                         uri if isinstance(uri, str) else "")
    return match.group(1) if match else None


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


def _results_problems(name, entry, prefix, prereq):
    where = f"gates.{name}.results"
    results = entry.get("results")
    if not isinstance(results, dict) or not results:
        return [where]
    identities = _identities(prereq)
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
            elif not full_repo_grant(prefix, item["grantedScope"]):
                problems.append(f"{where}.signIns ({item['did']}: grantedScope is not create, update and delete on "
                                "every collection)")
            elif item.get("tokenSub") != item["did"]:
                problems.append(f"{where}.signIns ({item['did']}: token sub {item.get('tokenSub')!r} is not the DID)")
            elif item.get("signedOut") is not True:
                problems.append(f"{where}.signIns ({item['did']}: sign-out through /settings not completed)")
        dids = sorted(str(item.get("did")) for item in sign_ins if isinstance(item, dict))
        if identities is not None:
            if dids != sorted(str(did) for did, _ in identities):
                problems.append(f"{where}.signIns (must be exactly one sign-in per prerequisite identity)")
        elif len(set(dids)) != len(dids):
            problems.append(f"{where}.signIns (one identity signed in twice)")
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
        local = results.get("localPublish") if isinstance(results.get("localPublish"), dict) else {}
        external = results.get("externalPublish") if isinstance(results.get("externalPublish"), dict) else {}
        local_did, external_did = _record_did(local.get("uri")), _record_did(external.get("uri"))
        if identities is not None:
            if local_did != identities[0][0]:
                problems.append(f"{where}.localPublish.uri (not a record of identity A {identities[0][0]})")
            if external_did != identities[1][0]:
                problems.append(f"{where}.externalPublish.uri (not a record of identity B {identities[1][0]})")
        elif local_did is None or external_did is None or local_did == external_did:
            problems.append(f"{where}.localPublish/externalPublish (records of two different identities)")
        if local.get("uri") is not None and local.get("uri") == external.get("uri"):
            problems.append(f"{where}.externalPublish.uri (the same record as localPublish)")
        for key, item in (("localPublish", local), ("externalPublish", external)):
            match = re.fullmatch(r"at://[^/]+/([a-zA-Z0-9.-]+)/[^/]+", str(item.get("uri")))
            if item and prefix and (not match or not match.group(1).startswith(prefix + ".")):
                problems.append(f"{where}.{key}.uri (outside the owned namespace)")
        deletes = results.get("deleteReconcile")
        present_revs = {item.get("uri"): item.get("verifiedRev") for item in (local, external)}
        if not isinstance(deletes, list) or len(deletes) < 2:
            problems.append(f"{where}.deleteReconcile (both records deleted and reconciled)")
        else:
            for item in deletes:
                if not isinstance(item, dict) or item.get("absentVerified") is not True:
                    problems.append(f"{where}.deleteReconcile (absence not independently verified)")
                elif item.get("method") not in ABSENCE_METHODS:
                    problems.append(f"{where}.deleteReconcile ({item.get('uri')}: method, exclusionProof or snapshot)")
                elif not isinstance(item.get("verifiedRev"), str) or not TID_RE.fullmatch(item["verifiedRev"]) \
                        or not _int(item.get("lagMs")):
                    problems.append(f"{where}.deleteReconcile ({item.get('uri')}: verifiedRev and lagMs)")
                elif isinstance(present_revs.get(item.get("uri")), str) \
                        and item["verifiedRev"] <= present_revs[item["uri"]]:
                    problems.append(f"{where}.deleteReconcile ({item['uri']}: absence verified at a head no newer "
                                    "than the one that proved it present)")
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
            elif item["getRecordExclusion"] is not True and item.get("snapshotAbsence") is not True:
                problems.append(f"{where}.perPds ({item.get('endpoint')}: neither an exclusion proof nor a verified "
                                "snapshot absence)")
        hosts = sorted(_host(item.get("endpoint")) for item in per_pds if isinstance(item, dict))
        if identities is not None:
            if hosts != sorted(host for _, host in identities):
                problems.append(f"{where}.perPds (must be exactly one result per prerequisite PDS host)")
        elif "" in hosts or len(set(hosts)) != len(hosts):
            problems.append(f"{where}.perPds (one result per distinct PDS host)")
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
        analytics = results.get("analytics") if isinstance(results.get("analytics"), dict) else {}
        if not _int(analytics.get("doRequests"), 1):
            problems.append(f"{where}.analytics.doRequests (billed DO requests, at least 1)")
        if not _int(analytics.get("alarmInvocations"), 1):
            problems.append(f"{where}.analytics.alarmInvocations (measured alarm invocations, at least 1)")
        if not _number(analytics.get("cpuTimeUs")):
            problems.append(f"{where}.analytics.cpuTimeUs (measured DO CPU time)")
        if analytics.get("missingFields") != []:
            problems.append(f"{where}.analytics.missingFields (every analytics measurement obtained)")
        if not _number(results.get("cpuMsPerAlarmUpperBound")):
            problems.append(f"{where}.cpuMsPerAlarmUpperBound")
        if not _number(results.get("reconnectsPerDay")):
            problems.append(f"{where}.reconnectsPerDay")
        if not _int(results.get("projectedMonthlyDoRequests")):
            problems.append(f"{where}.projectedMonthlyDoRequests")
        if not isinstance(results.get("failedThresholds"), list):
            problems.append(f"{where}.failedThresholds")
        problems += soak_decision_problems(where, results)
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
    # The document's own deployment, whatever the prerequisites say: never the fixture prefix or a
    # local/reserved origin (a single document classified with --gate has no prerequisites).
    if not owned_prefix(entry.get("lexiconPrefix")):
        problems.append(f"{where}.lexiconPrefix (owned production namespace, never the fixture prefix)")
    if not secure_url(entry.get("origin"), {"https"}, origin=True):
        problems.append(f"{where}.origin (deployed public HTTPS origin)")
    if isinstance(prereq, dict) and prereq:
        if _origin(entry.get("origin")) != _origin(prereq.get("publicHttpsOrigin")):
            problems.append(f"{where}.origin (not the prerequisite origin)")
        if entry.get("lexiconPrefix") != prereq.get("ownedLexiconPrefix"):
            problems.append(f"{where}.lexiconPrefix (not the owned prefix)")
    else:
        prereq = {}
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
    if name in PDS_GATES:
        problems += _pds_problems(where, entry, prereq)
        problems += _subject_problems(where, entry, prereq, need_uri=name == "ingest", prefix=prefix)
    problems += _results_problems(name, entry, prefix, prereq)
    return ("blocked", problems) if problems else ("passed", [])


def absence_method_problems(ingest, pds_compat, prereq):
    """Each delete's absence method must match its PDS's measured exclusion-proof support.

    A PDS whose pdsCompat result has getRecordExclusion true reconciles with an exclusion proof;
    one without it, with a verified snapshot (F4, ADR 0004 §13.8).
    """
    identities = _identities(prereq)
    if identities is None:
        return []
    host_of = dict(identities)
    per_pds = (pds_compat.get("results") or {}).get("perPds") or []
    exclusion = {_host(item.get("endpoint")): item.get("getRecordExclusion") is True
                 for item in per_pds if isinstance(item, dict)}
    problems = []
    for item in (ingest.get("results") or {}).get("deleteReconcile") or []:
        if not isinstance(item, dict):
            continue
        host = host_of.get(_record_did(item.get("uri")))
        if host not in exclusion:
            problems.append(f"gates.ingest.results.deleteReconcile ({item.get('uri')}: no pdsCompat result for its PDS)")
            continue
        expected = "exclusionProof" if exclusion[host] else "snapshot"
        if item.get("method") != expected:
            problems.append(f"gates.ingest.results.deleteReconcile ({item.get('uri')}: method "
                            f"{item.get('method')!r}, but pdsCompat for {host} requires {expected!r})")
    return problems


def evaluate(manifest, bundle_sha256=None, worker_version_id=None, *, commit=None):
    """Classify a whole inventory: Verdict(status, problems, per-gate statuses)."""
    if isinstance(manifest, dict) and manifest.get("runtime") == "node":
        return evaluate_node(manifest, commit, bundle_sha256)
    if not isinstance(manifest, dict):
        return Verdict("blocked", ["inventory (not a JSON object)"], {})
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        return Verdict("blocked", [
            f"schemaVersion (expected {SCHEMA_VERSION}; the schemaVersion 1 musl-artifact inventory "
            "cannot record Worker version evidence)"], {})
    # Binding: without a valid release that matches the one under review, a live
    # (non-fixture) inventory and complete prerequisites, no gate outcome -- not
    # even a recorded failure -- says anything about the bundle under review.
    binding = []
    if manifest.get("fixtureOnly") is not False:
        binding.append("fixtureOnly (fixture-only inventories cannot satisfy acceptance)")
    release = manifest.get("release")
    binding += release_problems(release)
    if isinstance(release, dict):
        if bundle_sha256 is not None and release.get("bundleSha256") != bundle_sha256:
            binding.append("release.bundleSha256 (does not match the bundle under review)")
        if worker_version_id is not None and release.get("workerVersionId") != worker_version_id:
            binding.append("release.workerVersionId (does not match the version under review)")
    prereq = manifest.get("prerequisites")
    binding += prerequisite_problems(prereq)
    problems = list(binding)
    gates = manifest.get("gates")
    if not isinstance(gates, dict):
        gates = {}
    statuses = {}
    for name in REQUIRED_GATES:
        status, gate_problems = gate_status(name, gates.get(name), release if isinstance(release, dict) else None,
                                            prereq if isinstance(prereq, dict) else {})
        statuses[name] = status
        problems += gate_problems
    if statuses.get("ingest") == "passed" and statuses.get("pdsCompat") == "passed":
        mismatch = absence_method_problems(gates["ingest"], gates["pdsCompat"],
                                           prereq if isinstance(prereq, dict) else {})
        if mismatch:
            statuses["ingest"] = "blocked"
            problems += mismatch
    for name in sorted(set(gates) - set(REQUIRED_GATES)):
        problems.append(f"gates.{name} (unknown gate)")
    if binding:
        status = "blocked"
    elif "failed" in statuses.values():
        status = "failed"
    elif problems:
        status = "blocked"
    else:
        status = "passed"
    return Verdict(status, problems, statuses)


# OAuth needs its own confidential-client interoperability evidence. The old
# Workers browser OAuth result shape is intentionally not accepted as Node proof.
NODE_SUPPORTED_GATES = ("oauth", "ingest", "pdsCompat")


def _node_oauth_results_problems(entry, prefix, prereq):
    """Validate the accepted Node confidential-OAuth contract before it can PASS."""
    where = "gates.oauth.results"
    results = entry.get("results")
    if not isinstance(results, dict) or set(results) != {"signIns", "cleanup"}:
        return [where]
    problems = []
    if not _nonempty(results.get("cleanup")):
        problems.append(f"{where}.cleanup (cleanup outcome)")
    sign_ins = results.get("signIns")
    if not isinstance(sign_ins, list) or len(sign_ins) != 2:
        return problems + [f"{where}.signIns (exactly one per PDS)"]
    collections = tuple(f"{prefix}.{name}" for name in ("scrobble", "follow", "settings", "love"))
    app_write_kinds = (
        "scrobble.create", "scrobble.delete", "follow.put", "follow.delete",
        "love.put", "love.delete", "settings.put",
    )
    for item in sign_ins:
        if not isinstance(item, dict) or set(item) != {
            "did", "issuerHost", "tokenSub", "grantedScope", "exchange", "crud", "appWrites", "signOut"
        } or not live_did(item.get("did")):
            problems.append(f"{where}.signIns (DID)")
            continue
        if not isinstance(item.get("issuerHost"), str) or not item["issuerHost"] \
                or item["issuerHost"] != item["issuerHost"].lower():
            problems.append(f"{where}.signIns ({item['did']}: observed OAuth issuer host is missing or non-canonical)")
        if item.get("tokenSub") != item["did"]:
            problems.append(f"{where}.signIns ({item['did']}: token sub does not match DID)")
        if not _nonempty(item.get("grantedScope")) or not node_full_repo_grant(prefix, item["grantedScope"]):
            problems.append(
                f"{where}.signIns ({item['did']}: grantedScope is not atproto plus create, update and delete on "
                "all four Node collections, and must not include transition:* scopes)"
            )
        exchange = item.get("exchange")
        if not isinstance(exchange, dict) or set(exchange) != {
            "sealedSessionObserved", "clientAuthMethod", "dpopBound", "refreshTokenPresent"
        } or exchange.get("sealedSessionObserved") is not True \
                or exchange.get("clientAuthMethod") != "private_key_jwt" \
                or exchange.get("dpopBound") is not True \
                or exchange.get("refreshTokenPresent") is not True:
            problems.append(f"{where}.signIns ({item['did']}: confidential exchange not observed from sealed session)")
        crud = item.get("crud")
        if not isinstance(crud, list) or len(crud) != len(collections):
            problems.append(f"{where}.signIns ({item['did']}: CRUD coverage for all four collections)")
        else:
            observed = []
            for check in crud:
                if not isinstance(check, dict) or set(check) != {"collection", "create", "update", "delete", "verified"}:
                    problems.append(f"{where}.signIns ({item['did']}: malformed CRUD observation)")
                    continue
                collection = check.get("collection")
                if collection not in collections or collection in observed:
                    problems.append(f"{where}.signIns ({item['did']}: unexpected or duplicate CRUD collection)")
                    continue
                observed.append(collection)
                for action in ("create", "update"):
                    action_result = check.get(action)
                    if not isinstance(action_result, dict) or set(action_result) != {"status", "cid"} \
                            or action_result.get("status") != 200 \
                            or not isinstance(action_result.get("cid"), str) \
                            or CID_RE.fullmatch(action_result["cid"]) is None:
                        problems.append(f"{where}.signIns ({item['did']}: {action} not verified for {collection})")
                delete_result = check.get("delete")
                if not isinstance(delete_result, dict) or set(delete_result) != {"status"} \
                        or delete_result.get("status") != 200:
                    problems.append(f"{where}.signIns ({item['did']}: delete not verified for {collection})")
                if check.get("verified") is not True:
                    problems.append(f"{where}.signIns ({item['did']}: CRUD record verification failed for {collection})")
            if sorted(observed) != sorted(collections):
                problems.append(f"{where}.signIns ({item['did']}: CRUD does not cover all four collections)")
        app_writes = item.get("appWrites")
        if not isinstance(app_writes, list) or len(app_writes) != len(app_write_kinds):
            problems.append(f"{where}.signIns ({item['did']}: all app-supported write routes were not exercised)")
        else:
            observed_writes = []
            for write in app_writes:
                if not isinstance(write, dict) or set(write) != {
                    "kind", "operationState", "recordVerified", "absenceVerified"
                }:
                    problems.append(f"{where}.signIns ({item['did']}: malformed app write observation)")
                    continue
                kind = write.get("kind")
                if kind not in app_write_kinds or kind in observed_writes:
                    problems.append(f"{where}.signIns ({item['did']}: unexpected or duplicate app write kind)")
                    continue
                observed_writes.append(kind)
                expected_record = kind in ("scrobble.create", "follow.put", "love.put", "settings.put")
                if write.get("operationState") != "succeeded" \
                        or write.get("recordVerified") is not expected_record \
                        or write.get("absenceVerified") is not (not expected_record):
                    problems.append(f"{where}.signIns ({item['did']}: app write not reconciled for {kind})")
            if sorted(observed_writes) != sorted(app_write_kinds):
                problems.append(f"{where}.signIns ({item['did']}: missing app-supported write kind)")
        sign_out = item.get("signOut")
        if not isinstance(sign_out, dict) or set(sign_out) != {
            "appSignOutCompleted", "sessionVersionStableUntilSignOut", "localSessionAbsent", "refreshRejected", "refreshError"
        } or sign_out.get("appSignOutCompleted") is not True \
                or sign_out.get("sessionVersionStableUntilSignOut") is not True \
                or sign_out.get("localSessionAbsent") is not True \
                or sign_out.get("refreshRejected") is not True \
                or sign_out.get("refreshError") != "invalid_grant":
            problems.append(f"{where}.signIns ({item['did']}: upstream refresh-token revocation not verified)")
    identities = _identities(prereq) if isinstance(prereq, dict) else None
    dids = sorted(str(item.get("did")) for item in sign_ins if isinstance(item, dict))
    if identities is not None:
        if dids != sorted(str(did) for did, _ in identities):
            problems.append(f"{where}.signIns (must be exactly one sign-in per prerequisite identity)")
        expected_pairs = {(did, host) for did, host in identities}
        observed_pairs = {
            (item.get("did"), item.get("issuerHost"))
            for item in sign_ins
            if isinstance(item, dict)
            and isinstance(item.get("did"), str)
            and isinstance(item.get("issuerHost"), str)
        }
        if observed_pairs != expected_pairs:
            problems.append(f"{where}.signIns (each DID must be bound to its prerequisite OAuth issuer host)")
    else:
        if len(set(dids)) != len(dids):
            problems.append(f"{where}.signIns (one identity signed in twice)")
        declared_pds = entry.get("pds")
        declared_hosts = set()
        if isinstance(declared_pds, list):
            for pds in declared_pds:
                if isinstance(pds, dict):
                    host = _host(pds.get("endpoint"))
                    if host:
                        declared_hosts.add(host)
        observed_hosts = {
            item.get("issuerHost")
            for item in sign_ins
            if isinstance(item, dict) and isinstance(item.get("issuerHost"), str)
        }
        if len(declared_hosts) != 2 or observed_hosts != declared_hosts:
            problems.append(f"{where}.signIns (issuer hosts must match the two declared PDS hosts)")
    return problems


def _node_identity_problems(data, expected_commit, expected_bundle, where, *, identity_fields=True):
    issues = []
    if not isinstance(expected_commit, str) or not COMMIT_RE.fullmatch(expected_commit) or int(expected_commit, 16) == 0:
        issues.append("independent expected commit must be a nonzero full 40-hex SHA")
    if not isinstance(expected_bundle, str) or not SHA256_RE.fullmatch(expected_bundle) or int(expected_bundle, 16) == 0:
        issues.append("independent expected bundle hash must be a nonzero 64-hex SHA-256")
    if not isinstance(data, dict):
        return issues + [f"{where} (not a JSON object)"]
    if data.get("runtime") != "node" or data.get("schemaVersion") != 3:
        issues.append(f"{where} (expected schemaVersion 3 and runtime=node)")
    if data.get("fixtureOnly") is not False:
        issues.append(f"{where}.fixtureOnly (must be false)")
    if not identity_fields:
        return issues
    for field, expected, pattern in (("commit", expected_commit, COMMIT_RE), ("bundleSha256", expected_bundle, SHA256_RE)):
        actual = data.get(field)
        if not isinstance(actual, str) or not pattern.fullmatch(actual) or int(actual, 16) == 0:
            issues.append(f"{where}.{field} (missing, malformed, or zero)")
        elif isinstance(expected, str) and pattern.fullmatch(expected) and actual != expected:
            issues.append(f"{where}.{field} (does not match independently expected identity)")
    return issues


def node_gate_status(name, entry, expected_commit, expected_bundle, prereq=None):
    """Validate a Node gate against an independently supplied release identity."""
    where = f"gates.{name}"
    if name not in REQUIRED_GATES:
        return "blocked", [f"{where} (unknown gate)"]
    issues = _node_identity_problems(entry, expected_commit, expected_bundle, where)
    if not isinstance(entry, dict):
        return "blocked", issues
    if entry.get("gate") != name:
        issues.append(f"{where}.gate (expected {name})")
    if not _timestamp(entry.get("recordedAt")):
        issues.append(f"{where}.recordedAt (timezone-qualified date)")
    if not _nonempty(entry.get("testCommand")):
        issues.append(f"{where}.testCommand")
    if not owned_prefix(entry.get("lexiconPrefix")):
        issues.append(f"{where}.lexiconPrefix (owned production namespace)")
    if not secure_url(entry.get("origin"), {"https"}, origin=True):
        issues.append(f"{where}.origin (deployed public HTTPS origin)")
    if isinstance(prereq, dict) and prereq:
        if _origin(entry.get("origin")) != _origin(prereq.get("publicHttpsOrigin")):
            issues.append(f"{where}.origin (not the prerequisite origin)")
        if entry.get("lexiconPrefix") != prereq.get("ownedLexiconPrefix"):
            issues.append(f"{where}.lexiconPrefix (not the owned prefix)")
    if entry.get("result") not in OUTCOMES:
        issues.append(f"{where}.result (one of passed, failed, blocked)")
    if entry.get("result") == "blocked":
        missing = entry.get("missing")
        if not isinstance(missing, list) or not missing or not all(_nonempty(v) for v in missing):
            issues.append(f"{where}.missing (blocked results list missing prerequisites)")
        return "blocked", issues
    if entry.get("result") == "failed":
        failures = entry.get("failures")
        if not isinstance(failures, list) or not failures or not all(_nonempty(v) for v in failures):
            issues.append(f"{where}.failures (failed results name their failures)")
        return ("blocked", issues) if issues else ("failed", [f"{where}: failed — {v}" for v in failures])
    if entry.get("failures"):
        issues.append(f"{where} (a passed result carries failures)")
    if not _nonempty(entry.get("cleanup")):
        issues.append(f"{where}.cleanup (cleanup outcome)")
    if name in PDS_GATES:
        issues += _pds_problems(where, entry, prereq if isinstance(prereq, dict) else {})
        issues += _subject_problems(where, entry, prereq if isinstance(prereq, dict) else {},
                                    need_uri=name == "ingest", prefix=entry.get("lexiconPrefix"))
    if name == "oauth":
        issues += _node_oauth_results_problems(entry, entry.get("lexiconPrefix"),
                                               prereq if isinstance(prereq, dict) else {})
        if name not in NODE_SUPPORTED_GATES:
            issues.append(f"{where} (Node gate semantics are not ported)")
    elif name in NODE_SUPPORTED_GATES:
        issues += _results_problems(name, entry, entry.get("lexiconPrefix"),
                                    prereq if isinstance(prereq, dict) else {})
    else:
        issues.append(f"{where} (Node gate semantics are not ported)")
    return ("blocked", issues) if issues else ("passed", [])


def evaluate_node(manifest, expected_commit, expected_bundle):
    """Classify Node inventory; expected release identity is never read from evidence."""
    binding = _node_identity_problems(manifest, expected_commit, expected_bundle, "inventory", identity_fields=False)
    if not isinstance(manifest, dict):
        return Verdict("blocked", binding, {})
    release = manifest.get("release")
    if not isinstance(release, dict):
        binding.append("inventory.release (commit and bundleSha256 required)")
        release = {}
    for field, pattern, expected in (("commit", COMMIT_RE, expected_commit),
                                     ("bundleSha256", SHA256_RE, expected_bundle)):
        value = release.get(field)
        if not isinstance(value, str) or not pattern.fullmatch(value) or int(value, 16) == 0:
            binding.append(f"inventory.release.{field} (missing, malformed, or zero)")
        elif value != expected:
            binding.append(f"inventory.release.{field} (does not match expected identity)")
    prereq = manifest.get("prerequisites")
    prereq_issues = prerequisite_problems(prereq, node=True)
    binding += prereq_issues
    gates = manifest.get("gates") if isinstance(manifest.get("gates"), dict) else {}
    statuses, all_issues = {}, list(binding)
    for name in REQUIRED_GATES:
        status, issues = node_gate_status(name, gates.get(name), expected_commit, expected_bundle,
                                          prereq if isinstance(prereq, dict) else {})
        if name not in NODE_SUPPORTED_GATES and status == "passed":
            status, issues = "blocked", [f"gates.{name} (Node gate semantics are not ported)"]
        statuses[name] = status
        all_issues += issues
    if statuses.get("ingest") == "passed" and statuses.get("pdsCompat") == "passed":
        mismatch = absence_method_problems(gates["ingest"], gates["pdsCompat"], prereq)
        if mismatch:
            statuses["ingest"] = "blocked"
            all_issues += mismatch
    for name in sorted(set(gates) - set(REQUIRED_GATES)):
        statuses[name] = "blocked"
        all_issues.append(f"gates.{name} (unknown gate)")
    # A gate failure is attributable only when both inventory binding/prerequisites
    # and that gate's own identity/provenance validate.
    if binding:
        status = "blocked"
    elif "failed" in statuses.values():
        status = "failed"
    elif all(status == "passed" for status in statuses.values()) and len(statuses) == len(REQUIRED_GATES):
        status = "passed"
    else:
        status = "blocked"
    return Verdict(status, all_issues, statuses)


def problems(manifest, artifact_sha256=None):
    """Everything that keeps the inventory from passing (compatibility helper)."""
    return evaluate(manifest, artifact_sha256).problems


def _report(status, lines, subject):
    head = {
        "passed": (f"PASS: {subject} is complete for its independently expected release"
                   if subject.startswith("Node ") else
                   f"PASS: {subject} is complete for one Worker version and bundle"),
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
    parser.add_argument("--commit", help="independently trusted full source commit under review")
    parser.add_argument("--node", action="store_true", help="explicitly require the Node schema, including for --gate")
    args = parser.parse_args(argv)
    try:
        if args.gate is not None:
            entry = json.loads(args.gate.read_text())
        else:
            manifest = json.loads(args.manifest.read_text())
        bundle = args.bundle_sha256
        if args.artifact is not None:
            artifact_bundle = hashlib.sha256(args.artifact.read_bytes()).hexdigest()
            if bundle is not None and bundle.lower() != artifact_bundle:
                return _report("blocked", ["--bundle-sha256 disagrees with --artifact SHA-256"], "live evidence")
            bundle = artifact_bundle
    except (OSError, ValueError):
        print("BLOCKED: live evidence inventory or artifact is unavailable/invalid; no live tests ran")
        return EXIT_CODES["blocked"]
    # Node schema v3 is deliberately separate from the historical Workers v2
    # verifier below. No identity is inferred from the evidence document.
    expected_commit = args.commit
    is_node = args.node or (args.gate is not None and isinstance(entry, dict)
                            and entry.get("runtime") == "node") or (
                                args.gate is None and isinstance(manifest, dict) and manifest.get("runtime") == "node")
    if is_node:
        if (not isinstance(expected_commit, str) or not COMMIT_RE.fullmatch(expected_commit)
                or int(expected_commit, 16) == 0 or not isinstance(bundle, str)
                or not SHA256_RE.fullmatch(bundle) or int(bundle, 16) == 0):
            return _report("blocked", ["independent --commit and --bundle-sha256/--artifact are required"], "Node evidence")
        if args.gate is not None:
            name = entry.get("gate") if isinstance(entry, dict) else None
            status, lines = node_gate_status(name, entry, expected_commit, bundle)
            return _report(status, lines, f"Node {name or 'unknown'} gate result")
        verdict = evaluate_node(manifest, expected_commit, bundle)
        statuses = ", ".join(f"{name}={status}" for name, status in verdict.gates.items())
        return _report(verdict.status, verdict.problems + ([f"gates: {statuses}"] if statuses else []),
                       "Node live evidence")
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

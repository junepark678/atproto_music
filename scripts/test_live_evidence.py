#!/usr/bin/env python3
"""Regression checks for the Workers live evidence verifier and the live gate scripts (W6-05).

Named tests (docs/verification/ts-case-map.json, AMENDMENTS-workers.md M6.4.1, M6.4.3):
- evidence missing version id or bundle hash is rejected
- blocked result is distinguished from pass and fail
- npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names
  (test_live_gate_scripts_without_env_exit_blocked_and_list_missing_names below runs that exact command)

No test makes a network request: the gate scripts run with an environment that holds no live
prerequisite and a preloaded fetch trap, and every manifest here is built in memory. Inventories
built here are never written to docs/verification.
"""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_live_evidence import REQUIRED_GATES, evaluate, gate_status, main, problems, secure_url  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
VERSION = "0f1e2d3c-4b5a-4968-8776-655443322110"
BUNDLE = "4" * 64
COMMIT = "5" * 40
ORIGIN = "https://music.214510.xyz"
PREFIX = "dev.pythonplayer123.music"
DID_A = "did:plc:q6gjnaw2blty4crticxkmujt"
DID_B = "did:plc:ewvi7nxzyoun6zhxrhs64oiz"
PDS_A = "https://pds-alpha.operator-one.net"
PDS_B = "https://pds-beta.operator-two.org"
IMPLEMENTATIONS = {"ATMUSIC_LIVE_PDS_A_IMPLEMENTATION": "@atproto/pds",
                   "ATMUSIC_LIVE_PDS_B_IMPLEMENTATION": "independent-pds"}
CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5djpkzwuevr6cqe"
CID2 = "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm"
REV = "3lbqzf4u2zs2k"
DELETE_REV = "3lbqzf4u2zt2k"  # a later head than REV, where both records were verified present
URI_A = f"at://{DID_A}/{PREFIX}.scrobble/3lbqzf4u2zs2a"
URI_B = f"at://{DID_B}/{PREFIX}.scrobble/3lbqzf4u2zs2b"
LIVE_SCRIPTS = {
    "pds_compat_check": ("pdsCompat", ["ATMUSIC_LIVE_ORIGIN", "ATMUSIC_LIVE_LEXICON_PREFIX",
                                       "ATMUSIC_LIVE_WORKER_VERSION_ID", "ATMUSIC_LIVE_BUNDLE_SHA256",
                                       "ATMUSIC_LIVE_DID_A", "ATMUSIC_LIVE_PDS_A", "ATMUSIC_LIVE_DID_B",
                                       "ATMUSIC_LIVE_PDS_B", "ATMUSIC_LIVE_PDS_INDEPENDENCE_REF",
                                       "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF", *IMPLEMENTATIONS]),
    "workers_oauth_check": ("oauth", ["ATMUSIC_LIVE_ORIGIN", "ATMUSIC_LIVE_DID_A", "ATMUSIC_LIVE_PDS_B",
                                      "ATMUSIC_LIVE_HANDLE_A", "ATMUSIC_LIVE_PASSWORD_B", *IMPLEMENTATIONS]),
    "workers_ingest_check": ("ingest", ["ATMUSIC_LIVE_ORIGIN", "ATMUSIC_LIVE_DID_B", "ATMUSIC_LIVE_ADMIN_TOKEN",
                                        "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF", "ATMUSIC_LIVE_APP_PASSWORD_B",
                                        *IMPLEMENTATIONS]),
    "ssrf_probe": ("ssrfProbe", ["ATMUSIC_LIVE_ORIGIN", "ATMUSIC_LIVE_ADMIN_TOKEN", "ATMUSIC_LIVE_SSRF_PROBE_URL",
                                 "ATMUSIC_LIVE_SSRF_HOSTS"]),
    "workers_socket_soak": ("socketSoak", ["ATMUSIC_LIVE_ORIGIN", "ATMUSIC_LIVE_ADMIN_TOKEN",
                                           "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF", "ATMUSIC_LIVE_CF_API_TOKEN",
                                           "ATMUSIC_LIVE_CF_ACCOUNT_ID", "ATMUSIC_LIVE_CF_DO_NAMESPACE_ID"]),
}
# Preloaded into every gate script: any fetch is recorded on stderr and refused.
FETCH_TRAP = """globalThis.fetch = async (url) => {
  process.stderr.write(`NETWORK-ATTEMPT ${String(url)}\\n`);
  throw new Error('network disabled in tests');
};
"""
# Preloaded into the soak gate for the analytics tests: a frozen clock that sleep() advances
# instantly, and a fake deployment plus Cloudflare GraphQL API. Every request is logged on stderr
# as `FAKE-FETCH <method> <url>`; anything else is refused. FAKE_ANALYTICS selects the data
# query's answer: "empty" (no account row) or "full".
FAKE_SOAK_RUNTIME = """// Only the gate process itself (argv[1] is the script), never npx or the tsx launcher.
if (/workers_socket_soak\\.ts$/.test(process.argv[1] ?? '')) {
const RealDate = Date;
let now = RealDate.parse('2026-01-15T12:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(now); else super(...args); }
  static now() { return now; }
};
const handle = { ref() { return handle; }, unref() { return handle; }, hasRef() { return false; } };
globalThis.setTimeout = (fn, ms = 0, ...args) => { now += Number(ms) || 0; queueMicrotask(() => fn(...args)); return handle; };
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const TYPES = {
  AccountDurableObjectsPeriodicGroupsSum: ['cpuTime', 'activeTime', 'inboundWebsocketMsgCount', 'outboundWebsocketMsgCount'],
  AccountDurableObjectsInvocationsAdaptiveGroupsDimensions: ['datetime', 'eventType', 'namespaceId'],
};
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  process.stderr.write(`FAKE-FETCH ${init.method ?? 'GET'} ${href}\\n`);
  const path = new URL(href).pathname;
  if (path === '/api/v1/meta')
    return json({ lexiconPrefix: process.env.ATMUSIC_LIVE_LEXICON_PREFIX, capabilities: ['publication'], version: 'v', stage: 'production' });
  if (path === '/internal/admin/status')
    return json({ ingest: { mode: 'socket', connected: true, hostIndex: 0, lastEventTimeUs: (now - 2000) * 1000, pendingGap: false } });
  if (href === 'https://api.cloudflare.com/client/v4/graphql') {
    const body = JSON.parse(init.body);
    if (body.query.includes('__type'))
      return json({ data: { __type: { fields: (TYPES[body.variables.n] ?? []).map((name) => ({ name })) } } });
    if (process.env.FAKE_ANALYTICS === 'empty') return json({ data: { viewer: { accounts: [] } } });
    return json({ data: { viewer: { accounts: [{
      invocations: [{ sum: { requests: 200000 }, dimensions: { eventType: 'fetch' } },
                    { sum: { requests: 1440 }, dimensions: { eventType: 'alarm' } }],
      periodic: [{ sum: { cpuTime: 72000000, activeTime: 90000000, inboundWebsocketMsgCount: 500000, outboundWebsocketMsgCount: 20 } }],
    }] } } });
  }
  throw new Error(`unexpected request ${href}`);
};
}
"""
# Preloaded into pds_compat_check for the PDS version test: a fake deployment whose PDS answers
# /xrpc/_health without a version. Every request is logged as `FAKE-FETCH <method> <url>`.
FAKE_HEALTH_RUNTIME = """if (/pds_compat_check\\.ts$/.test(process.argv[1] ?? '')) {
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  process.stderr.write(`FAKE-FETCH ${init.method ?? 'GET'} ${href}\\n`);
  const path = new URL(href).pathname;
  if (path === '/api/v1/meta')
    return json({ lexiconPrefix: process.env.ATMUSIC_LIVE_LEXICON_PREFIX, capabilities: ['publication'], version: 'v', stage: 'production' });
  if (path === '/xrpc/_health') return json({});
  throw new Error(`unexpected request ${href}`);
};
}
"""
# Runs the production absence verifier (live-gate.ts verifyAbsent) against the fixture network
# (@atmusic/atproto test-support: fake PDS, PLC and DoH, injected as the verifier's Transport).
# ABSENCE_CASE: exclusion | snapshot | snapshotStillHolds | stale | serverError.
ABSENCE_HARNESS = """(async () => {
  const { createFixtureKit } = await import('@atmusic/atproto/test-support/read-models');
  const gate = await import('./scripts/live/live-gate.ts');
  const kit = await createFixtureKit();
  const mode = process.env.ABSENCE_CASE;
  const did = kit.users.Alice.did;
  const pds = kit.pds.Alice;
  const collection = kit.collections.scrobble;
  const rkey = '3lbqzf4u2zs2a';
  const before = kit.repos.Alice.head.cid;
  await kit.createRecord('Alice', collection, rkey, { $type: collection, artist: 'a', track: 't',
    listenedAt: '2026-01-15T11:59:00Z', createdAt: '2026-01-15T12:00:00Z' });
  const present = await gate.verifyRecordAt(did, collection, rkey, { transport: kit.transport });
  const deleted = mode === 'snapshotStillHolds' ? null : await kit.deleteRecord('Alice', collection, rkey);
  pds.noExclusionProof = mode === 'snapshot' || mode === 'stale';
  if (mode === 'stale') pds.serveStaleHead(did, before);
  if (mode === 'snapshotStillHolds')
    pds.faults.add({ nsid: 'com.atproto.sync.getRecord' }, { kind: 'status', status: 400, error: 'RecordNotFound' });
  if (mode === 'serverError')
    pds.faults.add({ nsid: 'com.atproto.sync.getRecord' }, { kind: 'status', status: 500, error: 'InternalServerError' }, Infinity);
  pds.calls.reset();
  const out = { presentRev: present.rev, presentState: present.state, deleteRev: deleted?.commit?.rev ?? null };
  try {
    out.absence = await gate.verifyAbsent(did, collection, rkey, { after: present.rev, transport: kit.transport });
  } catch (e) {
    out.error = { name: e.name, code: e.code ?? null, message: e.message };
  }
  out.calls = pds.calls.entries.map((c) => `${c.nsid} ${c.status}`);
  console.log(JSON.stringify(out));
})();
"""
_TRAP_DIR = tempfile.TemporaryDirectory(prefix="atmusic-fetch-trap-")
TRAP_PATH = Path(_TRAP_DIR.name) / "fetch-trap.mjs"
TRAP_PATH.write_text(FETCH_TRAP)
SOAK_RUNTIME_PATH = Path(_TRAP_DIR.name) / "fake-soak-runtime.mjs"
SOAK_RUNTIME_PATH.write_text(FAKE_SOAK_RUNTIME)
HEALTH_RUNTIME_PATH = Path(_TRAP_DIR.name) / "fake-health-runtime.mjs"
HEALTH_RUNTIME_PATH.write_text(FAKE_HEALTH_RUNTIME)


def gate(name, results, **extra):
    entry = {
        "schemaVersion": 2, "gate": name, "result": "passed", "fixtureOnly": False,
        "recordedAt": "2026-01-15T12:00:00Z", "testCommand": f"npx tsx scripts/live/{name}.ts",
        "workerVersionId": VERSION, "bundleSha256": BUNDLE, "commit": COMMIT,
        "origin": ORIGIN, "lexiconPrefix": PREFIX, "pds": [], "subjects": [], "results": results,
        "cleanup": "every created record deleted and verified absent",
    }
    entry.update(extra)
    return copy.deepcopy(entry)  # each gate gets its own pds/subjects lists


PDS = [{"endpoint": PDS_A, "implementation": "@atproto/pds", "version": "0.4.200"},
       {"endpoint": PDS_B, "implementation": "independent", "version": "1.2.3"}]


def passing_inventory():
    published = {"cid": CID, "verifiedCid": CID, "indexedCid": CID, "verifiedRev": REV, "lagMs": 2400}
    return {
        "schemaVersion": 2, "fixtureOnly": False,
        "release": {"workerVersionId": VERSION, "bundleSha256": BUNDLE, "commit": COMMIT},
        "prerequisites": {
            "ownedLexiconPrefix": PREFIX, "publicHttpsOrigin": ORIGIN,
            "identities": [{"did": DID_A, "pds": PDS_A}, {"did": DID_B, "pds": PDS_B}],
            "independentPdsOperatorsVerified": True, "jetstreamCoverageVerified": True, "adminTokenConfigured": True,
        },
        "gates": {
            "oauth": gate("oauth", {"signIns": [
                {"did": d, "grantedScope": f"atproto repo:{PREFIX}.scrobble repo:{PREFIX}.follow repo:{PREFIX}.settings",
                 "repoScopesGranted": True, "transitionGeneric": False, "tokenSub": d, "signedOut": True}
                for d in (DID_A, DID_B)]},
                pds=PDS, subjects=[{"did": DID_A, "uri": None}, {"did": DID_B, "uri": None}]),
            "ingest": gate("ingest", {
                "localPublish": dict(published, uri=URI_A),
                "externalPublish": dict(published, uri=URI_B, cid=CID2, verifiedCid=CID2, indexedCid=CID2),
                # PDS A offers exclusion proofs, PDS B does not (pdsCompat below): B's absence is a snapshot.
                "deleteReconcile": [{"uri": u, "absentVerified": True, "method": method, "verifiedRev": DELETE_REV,
                                     "lagMs": 900}
                                    for u, method in ((URI_A, "exclusionProof"), (URI_B, "snapshot"))],
            }, pds=PDS, subjects=[{"did": DID_A, "uri": URI_A}, {"did": DID_B, "uri": URI_B}]),
            "pdsCompat": gate("pdsCompat", {"perPds": [
                {"endpoint": p["endpoint"], "getRecordInclusion": True, "getRecordExclusion": i == 0,
                 "snapshotAbsence": None if i == 0 else True, "getBlocks": True, "getRepoStatus": True}
                for i, p in enumerate(PDS)]},
                pds=PDS, subjects=[{"did": DID_A, "uri": URI_A}, {"did": DID_B, "uri": URI_B}]),
            "ssrfProbe": gate("ssrfProbe", {"targets": [
                {"target": {"label": label, "host": f"{label}.probe.operator-one.net", "kind": "controlledName"},
                 "raw": [{"outcome": "error"}], "safeFetch": {"outcome": "refused", "code": "blocked_destination"}}
                for label in ("rfc1918", "loopback", "metadata")]}),
            "socketSoak": gate("socketSoak", {
                "durationHours": 24, "decision": "socket", "reconnectsLowerBound": 7,
                "lagMs": {"p50": 900, "p95": 4000, "max": 61000},
                "analytics": {"doRequests": 201440, "alarmInvocations": 1440, "cpuTimeUs": 59760000,
                              "activeTimeUs": 90000000, "inboundWebsocketMsgCount": 500000,
                              "outboundWebsocketMsgCount": 20, "missingFields": []},
                # decide(): 7 reconnects/day, 201440 × 30 projected requests, 59760000 µs / 1440 alarms.
                "reconnectsPerDay": 7, "projectedMonthlyDoRequests": 6043200, "cpuMsPerAlarmUpperBound": 41.5,
                "thresholds": dict(SOAK_THRESHOLDS), "failedThresholds": []}),
        },
    }


SOAK_THRESHOLDS = {"maxReconnectsPerDay": 96, "maxLagP95Ms": 60000, "maxMonthlyDoRequests": 10000000,
                   "maxCpuMsPerAlarm": 15000}
# Runs the oauth gate's pure checks (scripts/live/workers_oauth_check.ts grantedScopes and
# signInFailures) and the ingest gate's monotonic lag (workers_ingest_check.ts lagSince) on the
# cases in OAUTH_CASES; fetch is trapped, and importing the modules starts no gate.
OAUTH_HARNESS = """(async () => {
  const oauth = await import('./scripts/live/workers_oauth_check.ts');
  const ingest = await import('./scripts/live/workers_ingest_check.ts');
  const prefix = process.env.CASE_PREFIX;
  const did = process.env.CASE_DID;
  const out = { scopes: {}, failures: {} };
  for (const [name, scope] of Object.entries(JSON.parse(process.env.SCOPE_CASES)))
    out.scopes[name] = oauth.grantedScopes(prefix, scope).repoScopesGranted;
  const full = `atproto repo:${prefix}.scrobble repo:${prefix}.follow repo:${prefix}.settings`;
  const ok = { signedOut: true, error: null };
  const cases = {
    control: [{ did, grantedScope: full, tokenSub: did }, ok],
    nullSub: [{ did, grantedScope: full, tokenSub: null }, ok],
    otherSub: [{ did, grantedScope: full, tokenSub: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz' }, ok],
    signOutFailed: [{ did, grantedScope: full, tokenSub: did }, { signedOut: false, error: 'Timeout 15000ms exceeded' }],
  };
  for (const [name, [result, signOut]] of Object.entries(cases))
    out.failures[name] = oauth.signInFailures('https://pds.test', did, result,
      oauth.grantedScopes(prefix, result.grantedScope), signOut);
  // Lag across a wall-clock step backwards: the monotonic lag still counts the real 50 ms.
  const start = ingest.monotonicMs();
  const realNow = Date.now;
  Date.now = () => realNow() - 3_600_000;
  await new Promise((done) => setTimeout(done, 50));
  out.lagAcrossClockStep = ingest.lagSince(start);
  Date.now = realNow;
  out.lagNeverNegative = ingest.lagSince(start + 10_000);
  console.log(JSON.stringify(out));
})();
"""


def run_oauth_harness(scope_cases):
    env = script_env(CASE_PREFIX=PREFIX, CASE_DID=DID_A, SCOPE_CASES=json.dumps(scope_cases))
    return subprocess.run(["npx", "tsx", "--eval", OAUTH_HARNESS], cwd=ROOT, text=True, capture_output=True,
                          env=env, timeout=120)


def run_cli(manifest, *flags):
    with tempfile.TemporaryDirectory(prefix="atmusic-live-evidence-") as directory:
        path = Path(directory) / "inventory.json"
        path.write_text(json.dumps(manifest))
        return subprocess.run([sys.executable, str(ROOT / "scripts/verify_live_evidence.py"), str(path), *flags],
                              text=True, capture_output=True)


def script_env(**extra):
    """Only what npx needs; no ATMUSIC_LIVE_* prerequisite is inherited from the caller."""
    env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR", "LANG") if name in os.environ}
    env["NODE_OPTIONS"] = f"--import={TRAP_PATH.as_uri()}"
    env.update(extra)
    return env


def run_script(name, **extra):
    return subprocess.run(["npx", "tsx", f"scripts/live/{name}.ts"], cwd=ROOT, text=True, capture_output=True,
                          env=script_env(**extra), timeout=120)


SOAK_ENV = {"ATMUSIC_LIVE_ORIGIN": ORIGIN, "ATMUSIC_LIVE_LEXICON_PREFIX": PREFIX,
            "ATMUSIC_LIVE_WORKER_VERSION_ID": VERSION, "ATMUSIC_LIVE_BUNDLE_SHA256": BUNDLE,
            "ATMUSIC_LIVE_COMMIT": COMMIT, "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF": "jetstream coverage log OPS-2",
            "ATMUSIC_LIVE_ADMIN_TOKEN": "a" * 40, "ATMUSIC_LIVE_CF_API_TOKEN": "cf-analytics-read-token",
            "ATMUSIC_LIVE_CF_ACCOUNT_ID": "1" * 32, "ATMUSIC_LIVE_CF_DO_NAMESPACE_ID": "2" * 32,
            "ATMUSIC_LIVE_SOAK_POLL_S": "3600"}


def run_fake_soak(analytics):
    """The whole soak gate against the fake deployment and analytics API (frozen, instantly advancing clock)."""
    env = script_env(**SOAK_ENV, FAKE_ANALYTICS=analytics)
    env["NODE_OPTIONS"] = f"--import={SOAK_RUNTIME_PATH.as_uri()}"
    return subprocess.run(["npx", "tsx", "scripts/live/workers_socket_soak.ts"], cwd=ROOT, text=True,
                          capture_output=True, env=env, timeout=120)


def run_gate_file(entry):
    """`verify_live_evidence.py --gate FILE` for one gate document."""
    with tempfile.TemporaryDirectory(prefix="atmusic-live-gate-") as directory:
        path = Path(directory) / "gate.json"
        path.write_text(json.dumps(entry))
        return subprocess.run([sys.executable, str(ROOT / "scripts/verify_live_evidence.py"), "--gate", str(path)],
                              text=True, capture_output=True)


def run_absence_case(case):
    """The production absence verifier against the fixture network; fetch is trapped, so nothing leaves."""
    return subprocess.run(["npx", "tsx", "--eval", ABSENCE_HARNESS], cwd=ROOT, text=True, capture_output=True,
                          env=script_env(ABSENCE_CASE=case), timeout=120)


PDS_COMPAT_ENV = {"ATMUSIC_LIVE_ORIGIN": ORIGIN, "ATMUSIC_LIVE_LEXICON_PREFIX": PREFIX,
                  "ATMUSIC_LIVE_WORKER_VERSION_ID": VERSION, "ATMUSIC_LIVE_BUNDLE_SHA256": BUNDLE,
                  "ATMUSIC_LIVE_COMMIT": COMMIT, "ATMUSIC_LIVE_DID_A": DID_A, "ATMUSIC_LIVE_PDS_A": PDS_A,
                  "ATMUSIC_LIVE_DID_B": DID_B, "ATMUSIC_LIVE_PDS_B": PDS_B,
                  "ATMUSIC_LIVE_PDS_INDEPENDENCE_REF": "operator attestation ticket OPS-1",
                  "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF": "jetstream coverage log OPS-2"}


def fake_fetches(result):
    return [line.split(" ", 2)[1:] for line in result.stderr.splitlines() if line.startswith("FAKE-FETCH ")]


class LiveEvidenceTests(unittest.TestCase):
    def test_complete_inventory_passes(self):
        """A complete, bound inventory is the only PASS (control for the rejection tests)."""
        verdict = evaluate(passing_inventory(), BUNDLE, VERSION)
        self.assertEqual(verdict.problems, [])
        self.assertEqual(verdict.status, "passed")
        self.assertEqual(set(verdict.gates.values()), {"passed"})
        result = run_cli(passing_inventory(), "--bundle-sha256", BUNDLE, "--worker-version-id", VERSION)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(result.stdout.startswith("PASS:"))

    def test_evidence_missing_version_id_or_bundle_hash_is_rejected(self):
        """evidence missing version id or bundle hash is rejected"""
        for name in REQUIRED_GATES:
            for key, label in (("workerVersionId", "Worker version id"), ("bundleSha256", "SHA-256")):
                manifest = passing_inventory()
                del manifest["gates"][name][key]
                verdict = evaluate(manifest)
                self.assertEqual(verdict.status, "blocked", (name, key))
                self.assertEqual(verdict.gates[name], "blocked", (name, key))
                self.assertIn(f"gates.{name}.{key} (missing or not a {label})", verdict.problems)
                for other in set(REQUIRED_GATES) - {name}:
                    self.assertEqual(verdict.gates[other], "passed")
        # Evidence recorded for another version or bundle is rejected as well, even a failure.
        manifest = passing_inventory()
        manifest["gates"]["ingest"]["bundleSha256"] = "6" * 64
        manifest["gates"]["oauth"]["workerVersionId"] = "11111111-2222-4333-8444-555555555555"
        manifest["gates"]["socketSoak"].update(result="failed", failures=["socket dropped"],
                                               workerVersionId="11111111-2222-4333-8444-555555555555")
        verdict = evaluate(manifest)
        self.assertEqual(verdict.status, "blocked")
        self.assertIn("gates.ingest.bundleSha256 (recorded for another bundle)", verdict.problems)
        self.assertIn("gates.oauth.workerVersionId (recorded for another Worker version)", verdict.problems)
        self.assertEqual(verdict.gates["socketSoak"], "blocked")
        # The release itself must name both.
        for key in ("workerVersionId", "bundleSha256"):
            manifest = passing_inventory()
            del manifest["release"][key]
            verdict = evaluate(manifest)
            self.assertEqual(verdict.status, "blocked")
            self.assertTrue(any(p.startswith(f"release.{key} (") for p in verdict.problems), verdict.problems)
        # Binding to the release under review: a different bundle or version is rejected by the CLI.
        result = run_cli(passing_inventory(), "--bundle-sha256", "7" * 64)
        self.assertEqual(result.returncode, 2)
        self.assertTrue(result.stdout.startswith("BLOCKED:"))
        self.assertIn("release.bundleSha256 (does not match the bundle under review)", result.stdout)
        result = run_cli(passing_inventory(), "--worker-version-id", "11111111-2222-4333-8444-555555555555")
        self.assertEqual(result.returncode, 2)
        self.assertIn("release.workerVersionId (does not match the version under review)", result.stdout)
        with tempfile.TemporaryDirectory(prefix="atmusic-live-gate-") as directory:
            entry = passing_inventory()["gates"]["pdsCompat"]
            del entry["bundleSha256"]
            path = Path(directory) / "gate.json"
            path.write_text(json.dumps(entry))
            result = subprocess.run([sys.executable, str(ROOT / "scripts/verify_live_evidence.py"), "--gate", str(path)],
                                    text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("gates.pdsCompat.bundleSha256 (missing or not a SHA-256)", result.stdout)

    def test_blocked_result_is_distinguished_from_pass_and_fail(self):
        """blocked result is distinguished from pass and fail"""
        passed = passing_inventory()
        failed = passing_inventory()
        failed["gates"]["ingest"].update(result="failed", failures=["record was not indexed within 300 s"])
        blocked = passing_inventory()
        blocked["gates"]["socketSoak"] = gate("socketSoak", {}, result="blocked", origin=None, lexiconPrefix=None,
                                              missing=["ATMUSIC_LIVE_CF_API_TOKEN: missing — analytics token"],
                                              cleanup="nothing to clean up: no live request was made")
        both = copy.deepcopy(blocked)
        both["gates"]["ingest"] = failed["gates"]["ingest"]
        cases = [(passed, "passed", 0, "PASS:"), (failed, "failed", 1, "FAIL:"),
                 (blocked, "blocked", 2, "BLOCKED:"), (both, "failed", 1, "FAIL:")]
        for manifest, status, code, head in cases:
            verdict = evaluate(manifest)
            self.assertEqual(verdict.status, status)
            result = run_cli(manifest)
            self.assertEqual(result.returncode, code, result.stdout)
            self.assertTrue(result.stdout.startswith(head), result.stdout)
        self.assertEqual(evaluate(failed).gates["ingest"], "failed")
        self.assertIn("gates.ingest: failed — record was not indexed within 300 s", evaluate(failed).problems)
        verdict = evaluate(blocked)
        self.assertEqual(verdict.gates, {**{name: "passed" for name in REQUIRED_GATES}, "socketSoak": "blocked"})
        self.assertIn("gates.socketSoak: blocked — ATMUSIC_LIVE_CF_API_TOKEN: missing — analytics token",
                      verdict.problems)
        # A gate with no evidence at all is blocked, never passed or failed.
        absent = passing_inventory()
        del absent["gates"]["ssrfProbe"]
        self.assertEqual(evaluate(absent).gates["ssrfProbe"], "blocked")
        self.assertIn("gates.ssrfProbe (no evidence recorded)", evaluate(absent).problems)
        # Each outcome must carry its own explanation; an unexplained one is rejected (blocked).
        for result, key in (("blocked", "missing"), ("failed", "failures")):
            manifest = passing_inventory()
            manifest["gates"]["oauth"]["result"] = result
            status, issues = gate_status("oauth", manifest["gates"]["oauth"], manifest["release"],
                                         manifest["prerequisites"])
            self.assertEqual(status, "blocked")
            self.assertTrue(any(f"gates.oauth.{key} (" in issue for issue in issues), issues)
        # A "passed" label whose required results are absent is not a pass.
        hollow = passing_inventory()
        hollow["gates"]["ssrfProbe"]["results"]["targets"][0]["safeFetch"]["outcome"] = "fetched"
        hollow["gates"]["socketSoak"]["results"]["durationHours"] = 6
        verdict = evaluate(hollow)
        self.assertEqual(verdict.status, "blocked")
        self.assertEqual(verdict.gates["ssrfProbe"], "blocked")
        self.assertIn("gates.socketSoak.results.durationHours (at least 24 h)", verdict.problems)
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(main([str(ROOT / "docs/verification/live-evidence.json")]), 2)
        self.assertTrue(printed.getvalue().startswith("BLOCKED:"))

    def test_gate_with_prerequisites_but_failing_network_is_failed_not_blocked(self):
        """With every prerequisite set, the first live request happens and its failure is a FAIL (exit 1)."""
        env = {"ATMUSIC_LIVE_ORIGIN": ORIGIN, "ATMUSIC_LIVE_LEXICON_PREFIX": PREFIX,
               "ATMUSIC_LIVE_WORKER_VERSION_ID": VERSION, "ATMUSIC_LIVE_BUNDLE_SHA256": BUNDLE,
               "ATMUSIC_LIVE_COMMIT": COMMIT, "ATMUSIC_LIVE_DID_A": DID_A, "ATMUSIC_LIVE_PDS_A": PDS_A,
               "ATMUSIC_LIVE_DID_B": DID_B, "ATMUSIC_LIVE_PDS_B": PDS_B,
               "ATMUSIC_LIVE_PDS_INDEPENDENCE_REF": "operator attestation ticket OPS-1",
               "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF": "jetstream coverage log OPS-2", **IMPLEMENTATIONS}
        result = run_script("pds_compat_check", **env)
        self.assertEqual(result.returncode, 1, result.stderr)
        attempts = [line for line in result.stderr.splitlines() if line.startswith("NETWORK-ATTEMPT")]
        self.assertEqual(attempts, [f"NETWORK-ATTEMPT {ORIGIN}/api/v1/meta"])
        document = json.loads(result.stdout)
        self.assertEqual((document["result"], document["workerVersionId"], document["bundleSha256"], document["commit"]),
                         ("failed", VERSION, BUNDLE, COMMIT))
        self.assertNotIn("missing", document)
        self.assertIn("\nFAIL: pdsCompat live gate failed\n", result.stderr)
        status, issues = gate_status("pdsCompat", document, {"workerVersionId": VERSION, "bundleSha256": BUNDLE,
                                                             "commit": COMMIT}, {})
        self.assertEqual(status, "failed")
        self.assertTrue(any("network disabled in tests" in issue for issue in issues), issues)

    def test_results_must_cover_both_prerequisite_identities_and_pds_hosts(self):
        """Per-identity results that name one identity or one PDS twice never pass."""
        cases = []
        manifest = passing_inventory()
        manifest["gates"]["oauth"]["results"]["signIns"][1]["did"] = DID_A
        cases.append((manifest, "oauth", "gates.oauth.results.signIns (must be exactly one sign-in per "
                                         "prerequisite identity)"))
        manifest = passing_inventory()
        manifest["gates"]["pdsCompat"]["results"]["perPds"][1]["endpoint"] = PDS_A
        cases.append((manifest, "pdsCompat", "gates.pdsCompat.results.perPds (must be exactly one result per "
                                             "prerequisite PDS host)"))
        manifest = passing_inventory()
        manifest["gates"]["ingest"]["results"]["externalPublish"]["uri"] = URI_A
        manifest["gates"]["ingest"]["results"]["deleteReconcile"][1]["uri"] = URI_A
        cases.append((manifest, "ingest", f"gates.ingest.results.externalPublish.uri (not a record of identity B "
                                          f"{DID_B})"))
        manifest = passing_inventory()
        results = manifest["gates"]["ingest"]["results"]
        results["localPublish"]["uri"], results["externalPublish"]["uri"] = URI_B, URI_A
        cases.append((manifest, "ingest", f"gates.ingest.results.localPublish.uri (not a record of identity A "
                                          f"{DID_A})"))
        for manifest, name, expected in cases:
            with self.subTest(gate=name, expected=expected):
                verdict = evaluate(manifest, BUNDLE, VERSION)
                self.assertEqual(verdict.status, "blocked")
                self.assertEqual(verdict.gates[name], "blocked")
                self.assertIn(expected, verdict.problems)
                self.assertEqual({g for g, s in verdict.gates.items() if s != "passed"}, {name})
                result = run_cli(manifest, "--bundle-sha256", BUNDLE)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn(expected, result.stdout)
        # A single gate document classified on its own (no prerequisites) still needs two distinct ones.
        with tempfile.TemporaryDirectory(prefix="atmusic-live-gate-") as directory:
            for name, mutate, expected in (
                    ("oauth", lambda r: r["signIns"][1].update(did=DID_A),
                     "gates.oauth.results.signIns (one identity signed in twice)"),
                    ("pdsCompat", lambda r: r["perPds"][1].update(endpoint=PDS_A),
                     "gates.pdsCompat.results.perPds (one result per distinct PDS host)"),
                    ("ingest", lambda r: (r["externalPublish"].update(uri=URI_A),
                                          r["deleteReconcile"][1].update(uri=URI_A)),
                     "gates.ingest.results.localPublish/externalPublish (records of two different identities)")):
                entry = passing_inventory()["gates"][name]
                path = Path(directory) / f"{name}.json"
                path.write_text(json.dumps(entry))
                ok = subprocess.run([sys.executable, str(ROOT / "scripts/verify_live_evidence.py"), "--gate", str(path)],
                                    text=True, capture_output=True)
                self.assertEqual(ok.returncode, 0, ok.stdout)
                mutate(entry["results"])
                path.write_text(json.dumps(entry))
                bad = subprocess.run([sys.executable, str(ROOT / "scripts/verify_live_evidence.py"), "--gate", str(path)],
                                     text=True, capture_output=True)
                self.assertEqual(bad.returncode, 2, bad.stdout)
                self.assertIn(expected, bad.stdout)

    def test_failure_in_an_unbound_inventory_is_blocked_not_failed(self):
        """A recorded failure is a FAIL only for the release under review; unbound inventories stay BLOCKED."""
        def failed_inventory():
            manifest = passing_inventory()
            manifest["gates"]["ingest"].update(result="failed", failures=["record was not indexed within 300 s"])
            return manifest
        bound = run_cli(failed_inventory(), "--bundle-sha256", BUNDLE, "--worker-version-id", VERSION)
        self.assertEqual(bound.returncode, 1, bound.stdout)
        self.assertTrue(bound.stdout.startswith("FAIL:"), bound.stdout)
        result = run_cli(failed_inventory(), "--bundle-sha256", "7" * 64)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertTrue(result.stdout.startswith("BLOCKED:"), result.stdout)
        self.assertIn("release.bundleSha256 (does not match the bundle under review)", result.stdout)
        self.assertIn("gates.ingest: failed — record was not indexed within 300 s", result.stdout)
        verdict = evaluate(failed_inventory(), worker_version_id="11111111-2222-4333-8444-555555555555")
        self.assertEqual(verdict.status, "blocked")
        self.assertEqual(verdict.gates["ingest"], "failed")
        fixture = failed_inventory()
        fixture["fixtureOnly"] = True
        no_prereq = failed_inventory()
        no_prereq["prerequisites"] = {}
        no_release = failed_inventory()
        del no_release["release"]["bundleSha256"]
        for manifest, expected in (
                (fixture, "fixtureOnly (fixture-only inventories cannot satisfy acceptance)"),
                (no_prereq, "prerequisites.identities (two dedicated live DIDs, each with its public HTTPS PDS)"),
                (no_release, "release.bundleSha256 (bundle SHA-256 from check-bundle.ts --release)")):
            verdict = evaluate(manifest)
            self.assertEqual(verdict.status, "blocked", expected)
            self.assertIn(expected, verdict.problems)
            self.assertEqual(run_cli(manifest).returncode, 2, expected)
        # A failed gate document recorded against another origin is not bound either.
        other_origin = failed_inventory()
        other_origin["gates"]["ingest"]["origin"] = "https://staging.music.214510.xyz"
        verdict = evaluate(other_origin)
        self.assertEqual((verdict.status, verdict.gates["ingest"]), ("blocked", "blocked"))
        self.assertIn("gates.ingest.origin (not the prerequisite origin)", verdict.problems)

    def test_oauth_full_grant_token_sub_and_sign_out_are_required(self):
        """A create-only repo grant, a missing or other token sub and an incomplete sign-out never pass."""
        p = PREFIX
        full = f"atproto repo:{p}.scrobble repo:{p}.follow repo:{p}.settings"
        scopes = {
            "full": full,
            "allActionsListed": f"atproto repo:{p}.scrobble?action=create&action=update&action=delete "
                                f"repo:{p}.follow repo:{p}.settings",
            "actionsAcrossTokens": f"atproto repo:{p}.scrobble?action=create repo:{p}.scrobble?action=update "
                                   f"repo:{p}.scrobble?action=delete repo:{p}.follow repo:{p}.settings",
            "collectionParam": f"atproto repo?collection={p}.scrobble&collection={p}.follow&collection={p}.settings",
            "createOnly": f"atproto repo:{p}.scrobble?action=create repo:{p}.follow repo:{p}.settings",
            "createOnlyEverywhere": f"atproto repo:{p}.scrobble?action=create repo:{p}.follow?action=create "
                                    f"repo:{p}.settings?action=create",
            "noDelete": f"atproto repo:{p}.scrobble?action=create&action=update repo:{p}.follow repo:{p}.settings",
            "noAtproto": f"repo:{p}.scrobble repo:{p}.follow repo:{p}.settings",
            "missingSettings": f"atproto repo:{p}.scrobble repo:{p}.follow",
        }
        result = run_oauth_harness(scopes)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("NETWORK-ATTEMPT", result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["scopes"], {"full": True, "allActionsListed": True, "actionsAcrossTokens": True,
                                         "collectionParam": True, "createOnly": False, "createOnlyEverywhere": False,
                                         "noDelete": False, "noAtproto": False, "missingSettings": False})
        # The gate's own checks: the control has no failure; each defect is exactly one named failure.
        self.assertEqual(out["failures"]["control"], [])
        self.assertEqual(out["failures"]["nullSub"], ["https://pds.test: the token response has no sub"])
        self.assertEqual(out["failures"]["otherSub"],
                         [f"https://pds.test: token sub did:plc:zzzzzzzzzzzzzzzzzzzzzzzz is not {DID_A}"])
        self.assertEqual(out["failures"]["signOutFailed"],
                         ["https://pds.test: sign-out through /settings did not complete (Timeout 15000ms exceeded)"])
        # The ingest gate's lag uses the monotonic clock: a one-hour wall-clock step backwards
        # during the wait changes nothing, and a lag is never negative.
        self.assertGreaterEqual(out["lagAcrossClockStep"], 45)
        self.assertLess(out["lagAcrossClockStep"], 60_000)
        self.assertEqual(out["lagNeverNegative"], 0)
        source = (ROOT / "scripts/live/workers_ingest_check.ts").read_text()
        self.assertEqual(source.count("const lagMs = lagSince("), 2)
        self.assertNotIn("committedAtMs", source)

        # The verifier: each sign-in needs a full grant, its token sub and a completed sign-out.
        control = passing_inventory()
        self.assertEqual(evaluate(control, BUNDLE, VERSION).gates["oauth"], "passed")
        for change, expected in (
                ({"grantedScope": scopes["createOnly"]},
                 f"gates.oauth.results.signIns ({DID_A}: grantedScope is not create, update and delete on every "
                 "collection)"),
                ({"grantedScope": scopes["noDelete"]},
                 f"gates.oauth.results.signIns ({DID_A}: grantedScope is not create, update and delete on every "
                 "collection)"),
                ({"tokenSub": None}, f"gates.oauth.results.signIns ({DID_A}: token sub None is not the DID)"),
                ({"tokenSub": DID_B}, f"gates.oauth.results.signIns ({DID_A}: token sub '{DID_B}' is not the DID)"),
                ({"signedOut": False},
                 f"gates.oauth.results.signIns ({DID_A}: sign-out through /settings not completed)"),
                ({"signedOut": None},
                 f"gates.oauth.results.signIns ({DID_A}: sign-out through /settings not completed)")):
            manifest = passing_inventory()
            manifest["gates"]["oauth"]["results"]["signIns"][0].update(change)
            verdict = evaluate(manifest, BUNDLE, VERSION)
            self.assertEqual((verdict.status, verdict.gates["oauth"]), ("blocked", "blocked"), change)
            self.assertIn(expected, verdict.problems)
        for key in ("tokenSub", "signedOut"):
            manifest = passing_inventory()
            del manifest["gates"]["oauth"]["results"]["signIns"][1][key]
            self.assertEqual(evaluate(manifest, BUNDLE, VERSION).gates["oauth"], "blocked", key)
        # Allowed spellings of the full grant pass the verifier too.
        for name in ("allActionsListed", "actionsAcrossTokens"):
            manifest = passing_inventory()
            manifest["gates"]["oauth"]["results"]["signIns"][0]["grantedScope"] = scopes[name]
            self.assertEqual(evaluate(manifest, BUNDLE, VERSION).gates["oauth"], "passed", name)

    def test_soak_decision_must_follow_its_thresholds_and_measurements(self):
        """A soak decision, failedThresholds or derived value that does not follow from the record is rejected."""
        where = "gates.socketSoak.results"
        # Control, and a consistent pulse decision, pass: the decision is a result, not a criterion.
        self.assertEqual(evaluate(passing_inventory(), BUNDLE, VERSION).gates["socketSoak"], "passed")
        pulse = passing_inventory()
        pulse["gates"]["socketSoak"]["results"].update(
            thresholds=dict(SOAK_THRESHOLDS, maxMonthlyDoRequests=5000000),
            decision="pulse", failedThresholds=["projectedMonthlyDoRequests"])
        self.assertEqual(evaluate(pulse, BUNDLE, VERSION).problems, [])

        def soak(**changes):
            manifest = passing_inventory()
            manifest["gates"]["socketSoak"]["results"].update(changes)
            return manifest

        cases = (
            # "socket" although the projected requests exceed the recorded threshold.
            (soak(thresholds=dict(SOAK_THRESHOLDS, maxMonthlyDoRequests=5000000)),
             [f"{where}.failedThresholds (recorded [], but the measurements and thresholds give "
              "['projectedMonthlyDoRequests'])",
              f"{where}.decision (recorded 'socket', but the thresholds give 'pulse')"]),
            # The original fixture's 812345 requests (24.4M a month) cannot be a socket decision.
            (soak(analytics=dict(passing_inventory()["gates"]["socketSoak"]["results"]["analytics"],
                                 doRequests=812345), projectedMonthlyDoRequests=24370350),
             [f"{where}.decision (recorded 'socket', but the thresholds give 'pulse')"]),
            # "pulse" with nothing over a threshold.
            (soak(decision="pulse", failedThresholds=[]),
             [f"{where}.decision (recorded 'pulse', but the thresholds give 'socket')"]),
            # p95 lag over the limit, reconnects over the limit, CPU per alarm over the limit.
            (soak(lagMs={"p50": 900, "p95": 60001, "max": 90000}),
             [f"{where}.failedThresholds (recorded [], but the measurements and thresholds give ['lagP95Ms'])"]),
            (soak(reconnectsLowerBound=97, reconnectsPerDay=97),
             [f"{where}.failedThresholds (recorded [], but the measurements and thresholds give "
              "['reconnectsPerDay'])"]),
            (soak(thresholds=dict(SOAK_THRESHOLDS, maxCpuMsPerAlarm=40)),
             [f"{where}.failedThresholds (recorded [], but the measurements and thresholds give ['cpuMsPerAlarm'])"]),
            # Derived values that do not follow from the measurements.
            (soak(reconnectsPerDay=2), [f"{where}.reconnectsPerDay (is not reconnectsLowerBound × 24 / durationHours)"]),
            (soak(projectedMonthlyDoRequests=1000),
             [f"{where}.projectedMonthlyDoRequests (is not analytics.doRequests projected to 30 days)"]),
            (soak(cpuMsPerAlarmUpperBound=1.5),
             [f"{where}.cpuMsPerAlarmUpperBound (is not analytics.cpuTimeUs / 1000 / alarmInvocations)"]),
            # Missing or invalid decision fields.
            (soak(thresholds=None), [f"{where}.thresholds (the four positive decision thresholds: "
                                     "maxReconnectsPerDay, maxLagP95Ms, maxMonthlyDoRequests, maxCpuMsPerAlarm)"]),
            (soak(thresholds=dict(SOAK_THRESHOLDS, maxLagP95Ms=0)), [f"{where}.thresholds (the four positive"]),
            (soak(failedThresholds=None), [f"{where}.failedThresholds"]),
            (soak(reconnectsPerDay=None), [f"{where}.reconnectsPerDay"]),
            (soak(projectedMonthlyDoRequests=None), [f"{where}.projectedMonthlyDoRequests"]),
        )
        for manifest, expected in cases:
            verdict = evaluate(manifest, BUNDLE, VERSION)
            self.assertEqual((verdict.status, verdict.gates["socketSoak"]), ("blocked", "blocked"), expected)
            text = "\n".join(verdict.problems)
            for line in expected:
                self.assertIn(line, text)
            # The other gates are unaffected.
            self.assertEqual({k: v for k, v in verdict.gates.items() if k != "socketSoak"},
                             {name: "passed" for name in REQUIRED_GATES if name != "socketSoak"})
        # A single --gate document is checked the same way.
        entry = soak(decision="pulse", failedThresholds=[])["gates"]["socketSoak"]
        result = run_gate_file(entry)
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn(f"{where}.decision (recorded 'pulse', but the thresholds give 'socket')", result.stdout)

    def test_soak_without_analytics_measurements_fails_and_never_passes(self):
        """An empty analytics answer fails the soak gate; evidence without DO requests, alarms or CPU never passes."""
        empty = run_fake_soak("empty")
        self.assertEqual(empty.returncode, 1, empty.stderr)
        self.assertIn("\nFAIL: socketSoak live gate failed\n", empty.stderr)
        document = json.loads(empty.stdout)
        self.assertEqual(document["result"], "failed")
        analytics = document["results"]["analytics"]
        self.assertIsNone(analytics["doRequests"])
        self.assertIsNone(analytics["alarmInvocations"])
        self.assertIsNone(analytics["cpuTimeUs"])
        self.assertIn("viewer.accounts (no analytics row for the account in the soak window)", analytics["missingFields"])
        self.assertIn("durableObjectsPeriodicGroups.sum.cpuTime (no rows in the soak window)", analytics["missingFields"])
        for missing in analytics["missingFields"]:
            self.assertIn(f"analytics field unavailable: {missing}", document["failures"])
        self.assertEqual(document["results"]["decision"], "pulse")
        self.assertIn("projectedMonthlyDoRequests", document["results"]["failedThresholds"])
        self.assertIsNone(document["results"]["projectedMonthlyDoRequests"])
        calls = fake_fetches(empty)
        self.assertEqual(sum(1 for _, url in calls if url.endswith("/internal/admin/status")), 24)
        self.assertEqual(sum(1 for _, url in calls if url == "https://api.cloudflare.com/client/v4/graphql"), 3)
        self.assertEqual(gate_status("socketSoak", document, passing_inventory()["release"],
                                     passing_inventory()["prerequisites"])[0], "failed")
        # Control: the same run with analytics rows passes, and its document passes the verifier.
        full = run_fake_soak("full")
        self.assertEqual(full.returncode, 0, full.stderr)
        document = json.loads(full.stdout)
        self.assertEqual(document["result"], "passed")
        self.assertEqual(document["results"]["analytics"], {
            "doRequests": 201440, "alarmInvocations": 1440, "cpuTimeUs": 72000000, "activeTimeUs": 90000000,
            "inboundWebsocketMsgCount": 500000, "outboundWebsocketMsgCount": 20, "missingFields": []})
        self.assertEqual((document["results"]["durationHours"], document["results"]["samples"]), (24, 24))
        self.assertEqual((document["results"]["decision"], document["results"]["failedThresholds"]), ("socket", []))
        self.assertEqual(document["results"]["projectedMonthlyDoRequests"], 201440 * 30)
        self.assertEqual(document["results"]["cpuMsPerAlarmUpperBound"], 50)
        self.assertEqual(gate_status("socketSoak", document, passing_inventory()["release"],
                                     passing_inventory()["prerequisites"]), ("passed", []))
        # The verifier rejects a "passed" soak whose analytics are absent or zero.
        for key, value, expected in (
                ("doRequests", 0, "gates.socketSoak.results.analytics.doRequests (billed DO requests, at least 1)"),
                ("doRequests", None, "gates.socketSoak.results.analytics.doRequests (billed DO requests, at least 1)"),
                ("alarmInvocations", 0, "gates.socketSoak.results.analytics.alarmInvocations (measured alarm "
                                        "invocations, at least 1)"),
                ("cpuTimeUs", None, "gates.socketSoak.results.analytics.cpuTimeUs (measured DO CPU time)"),
                ("missingFields", ["durableObjectsPeriodicGroups.sum.cpuTime"],
                 "gates.socketSoak.results.analytics.missingFields (every analytics measurement obtained)")):
            manifest = passing_inventory()
            manifest["gates"]["socketSoak"]["results"]["analytics"][key] = value
            verdict = evaluate(manifest, BUNDLE, VERSION)
            self.assertEqual((verdict.status, verdict.gates["socketSoak"]), ("blocked", "blocked"), (key, value))
            self.assertIn(expected, verdict.problems)

    def test_gate_document_with_fixture_prefix_or_local_origin_never_passes(self):
        """--gate checks a document's own prefix and origin: the fixture prefix or a local origin is BLOCKED."""
        for name in ("pdsCompat", "socketSoak", "ssrfProbe", "ingest", "oauth"):
            with self.subTest(gate=name):
                control = run_gate_file(passing_inventory()["gates"][name])
                self.assertEqual(control.returncode, 0, control.stdout)
                self.assertTrue(control.stdout.startswith("PASS:"), control.stdout)
                entry = passing_inventory()["gates"][name]
                entry.update(lexiconPrefix="com.example.atmusic", origin="http://127.0.0.1:8787")
                result = run_gate_file(entry)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertTrue(result.stdout.startswith("BLOCKED:"), result.stdout)
                self.assertIn(f"gates.{name}.lexiconPrefix (owned production namespace, never the fixture prefix)",
                              result.stdout)
                self.assertIn(f"gates.{name}.origin (deployed public HTTPS origin)", result.stdout)
                status, issues = gate_status(name, entry, passing_inventory()["release"], {})
                self.assertEqual(status, "blocked")
        # Each field on its own blocks, and so do other local or reserved origins.
        for key, value, expected in (
                ("lexiconPrefix", "com.example.atmusic", "lexiconPrefix (owned production namespace"),
                ("lexiconPrefix", "org.example.music", "lexiconPrefix (owned production namespace"),
                ("lexiconPrefix", None, "lexiconPrefix (owned production namespace"),
                ("origin", "http://127.0.0.1:8787", "origin (deployed public HTTPS origin)"),
                ("origin", "https://localhost:8787", "origin (deployed public HTTPS origin)"),
                ("origin", "http://music.214510.xyz", "origin (deployed public HTTPS origin)"),
                ("origin", "https://music.example.com", "origin (deployed public HTTPS origin)")):
            entry = passing_inventory()["gates"]["socketSoak"]
            entry[key] = value
            status, issues = gate_status("socketSoak", entry, passing_inventory()["release"], {})
            self.assertEqual(status, "blocked", (key, value))
            self.assertIn(f"gates.socketSoak.{expected}", "\n".join(issues), (key, value))
        # A failure recorded against the fixture deployment is not a FAIL of the release either.
        entry = passing_inventory()["gates"]["socketSoak"]
        entry.update(result="failed", failures=["socket dropped"], lexiconPrefix="com.example.atmusic",
                     origin="http://127.0.0.1:8787")
        self.assertEqual(gate_status("socketSoak", entry, passing_inventory()["release"], {})[0], "blocked")
        self.assertEqual(run_gate_file(entry).returncode, 2)

    def test_pds_implementation_and_version_must_be_reported(self):
        """'unreported' (or any placeholder) PDS implementation or version never passes; the gates require both."""
        for name in ("oauth", "ingest", "pdsCompat"):
            for key in ("implementation", "version"):
                for value in ("unreported", "Unknown", " ", None):
                    manifest = passing_inventory()
                    manifest["gates"][name]["pds"][1][key] = value
                    verdict = evaluate(manifest, BUNDLE, VERSION)
                    self.assertEqual((verdict.status, verdict.gates[name]), ("blocked", "blocked"), (name, key, value))
                    self.assertIn(f"gates.{name}.pds (endpoint, implementation and version for both PDSs; "
                                  "'unreported' is not a value)", verdict.problems)
                    self.assertEqual({g for g, s in verdict.gates.items() if s != "passed"}, {name})
        # The PDS gates require the implementation names: without them, blocked and offline.
        result = run_script("pds_compat_check", **PDS_COMPAT_ENV)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertNotIn("NETWORK-ATTEMPT", result.stderr)
        document = json.loads(result.stdout)
        self.assertEqual(document["result"], "blocked")
        self.assertEqual([m.split(":")[0] for m in document["missing"]], list(IMPLEMENTATIONS))
        result = run_script("pds_compat_check", **PDS_COMPAT_ENV, ATMUSIC_LIVE_PDS_A_IMPLEMENTATION="unreported",
                            ATMUSIC_LIVE_PDS_B_IMPLEMENTATION="independent-pds")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertNotIn("NETWORK-ATTEMPT", result.stderr)
        self.assertEqual(json.loads(result.stdout)["missing"], [
            "ATMUSIC_LIVE_PDS_A_IMPLEMENTATION: invalid — a placeholder, not an implementation name"])
        # A PDS whose /xrpc/_health reports no version fails the gate rather than recording 'unreported'.
        env = script_env(**PDS_COMPAT_ENV, **IMPLEMENTATIONS)
        env["NODE_OPTIONS"] = f"--import={HEALTH_RUNTIME_PATH.as_uri()}"
        result = subprocess.run(["npx", "tsx", "scripts/live/pds_compat_check.ts"], cwd=ROOT, text=True,
                                capture_output=True, env=env, timeout=120)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(fake_fetches(result), [["GET", f"{ORIGIN}/api/v1/meta"], ["GET", f"{PDS_A}/xrpc/_health"]])
        document = json.loads(result.stdout)
        self.assertEqual(document["result"], "failed")
        self.assertEqual(document["failures"],
                         [f"{PDS_A}: /xrpc/_health (HTTP 200) reports no version, PDS version unknown"])
        self.assertNotIn("unreported", result.stdout)
        self.assertEqual(gate_status("pdsCompat", document, passing_inventory()["release"],
                                     passing_inventory()["prerequisites"])[0], "failed")

    def test_delete_reconcile_absence_method_matches_pds_compat(self):
        """Absence is an exclusion proof or a verified snapshot, matching the PDS's measured support."""
        verdict = evaluate(passing_inventory(), BUNDLE, VERSION)
        self.assertEqual(verdict.status, "passed", verdict.problems)
        cases = []
        manifest = passing_inventory()
        del manifest["gates"]["ingest"]["results"]["deleteReconcile"][1]["method"]
        cases.append((manifest, "ingest", f"gates.ingest.results.deleteReconcile ({URI_B}: method, exclusionProof "
                                          "or snapshot)"))
        manifest = passing_inventory()
        for item, method in zip(manifest["gates"]["ingest"]["results"]["deleteReconcile"],
                                ("snapshot", "exclusionProof")):
            item["method"] = method
        cases.append((manifest, "ingest", f"gates.ingest.results.deleteReconcile ({URI_B}: method 'exclusionProof', "
                                          "but pdsCompat for pds-beta.operator-two.org requires 'snapshot')"))
        cases.append((manifest, "ingest", f"gates.ingest.results.deleteReconcile ({URI_A}: method 'snapshot', "
                                          "but pdsCompat for pds-alpha.operator-one.net requires 'exclusionProof')"))
        manifest = passing_inventory()
        manifest["gates"]["ingest"]["results"]["deleteReconcile"][0]["verifiedRev"] = REV
        cases.append((manifest, "ingest", f"gates.ingest.results.deleteReconcile ({URI_A}: absence verified at a "
                                          "head no newer than the one that proved it present)"))
        manifest = passing_inventory()
        manifest["gates"]["pdsCompat"]["results"]["perPds"][1]["snapshotAbsence"] = False
        cases.append((manifest, "pdsCompat", f"gates.pdsCompat.results.perPds ({PDS_B}: neither an exclusion proof "
                                             "nor a verified snapshot absence)"))
        for manifest, name, expected in cases:
            with self.subTest(expected=expected):
                verdict = evaluate(manifest, BUNDLE, VERSION)
                self.assertEqual(verdict.status, "blocked")
                self.assertIn(expected, verdict.problems)
                self.assertEqual({g for g, s in verdict.gates.items() if s != "passed"}, {name})
                result = run_cli(manifest, "--bundle-sha256", BUNDLE)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn(expected, result.stdout)
        entry = passing_inventory()["gates"]["ingest"]
        del entry["results"]["deleteReconcile"][0]["method"]
        self.assertEqual(run_gate_file(entry).returncode, 2)

        # The production verifier behind the ingest gate, over the fixture network.
        exclusion = run_absence_case("exclusion")
        self.assertEqual(exclusion.returncode, 0, exclusion.stderr)
        out = json.loads(exclusion.stdout)
        self.assertEqual(out["presentState"], "present")
        self.assertEqual(out["absence"]["method"], "exclusionProof")
        self.assertEqual(out["absence"]["rev"], out["deleteRev"])
        self.assertGreater(out["absence"]["rev"], out["presentRev"])
        self.assertEqual(out["calls"], ["com.atproto.sync.getRecord 200"])
        # A PDS that answers RecordNotFound instead of an exclusion proof: a verified getRepo snapshot.
        snapshot = run_absence_case("snapshot")
        self.assertEqual(snapshot.returncode, 0, snapshot.stderr)
        out = json.loads(snapshot.stdout)
        self.assertEqual((out["absence"]["method"], out["absence"]["exclusionProofUnavailable"]),
                         ("snapshot", "RecordNotFound"))
        self.assertEqual(out["absence"]["rev"], out["deleteRev"])
        self.assertEqual(out["absence"]["keysEnumerated"], 0)
        self.assertEqual(out["calls"], ["com.atproto.sync.getRecord 400", "com.atproto.sync.getRepo 200"])
        # The snapshot still holding the key is never absence.
        holds = json.loads(run_absence_case("snapshotStillHolds").stdout)
        self.assertNotIn("absence", holds)
        self.assertEqual(holds["error"]["name"], "GateFailure")
        self.assertIn(f"the verified snapshot at rev {holds['presentRev']} still holds it", holds["error"]["message"])
        self.assertEqual(holds["calls"], ["com.atproto.sync.getRecord 400", "com.atproto.sync.getRepo 200"])
        # A stale head from before the write lacks the key too; it is refused.
        stale = json.loads(run_absence_case("stale").stdout)
        self.assertNotIn("absence", stale)
        self.assertIn(f"not after rev {stale['presentRev']} where it was present", stale["error"]["message"])
        # A server error is a failure, not a reason to fall back to a snapshot.
        error = json.loads(run_absence_case("serverError").stdout)
        self.assertNotIn("absence", error)
        self.assertEqual((error["error"]["name"], error["error"]["code"]), ("SafeFetchError", "http_status"))
        self.assertNotIn("com.atproto.sync.getRepo 200", error["calls"])
        self.assertTrue(error["calls"] and all(c == "com.atproto.sync.getRecord 500" for c in error["calls"]))

    def test_live_gate_scripts_without_env_exit_blocked_and_list_missing_names(self):
        """npx tsx scripts/live/pds_compat_check.ts (no env) › exits nonzero with blocked and lists missing names"""
        for script, (gate_name, names) in LIVE_SCRIPTS.items():
            with self.subTest(script=script):
                result = run_script(script)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn("NETWORK-ATTEMPT", result.stderr)
                document = json.loads(result.stdout)
                self.assertEqual(document["gate"], gate_name)
                self.assertEqual(document["result"], "blocked")
                self.assertIsNone(document["workerVersionId"])
                missing = "\n".join(document["missing"])
                for name in names:
                    self.assertIn(f"{name}: missing", missing)
                    self.assertIn(name, result.stderr)
                self.assertTrue(result.stderr.startswith(f"BLOCKED: {gate_name} live gate"), result.stderr)
                status, issues = gate_status(gate_name, document, None, {})
                self.assertEqual(status, "blocked")
                self.assertTrue(any(issue.startswith(f"gates.{gate_name}: blocked — ATMUSIC_LIVE_ORIGIN") for issue in issues))

    def test_fixture_values_never_satisfy_gate_prerequisites(self):
        """Fixture prefix, example origins and reserved DIDs are reported invalid, still blocked, still offline."""
        result = run_script("pds_compat_check", ATMUSIC_LIVE_ORIGIN="https://music.example.com",
                            ATMUSIC_LIVE_LEXICON_PREFIX="com.example.atmusic",
                            ATMUSIC_LIVE_DID_A="did:plc:" + "a" * 24, ATMUSIC_LIVE_PDS_A="https://pds.test",
                            ATMUSIC_LIVE_DID_B=DID_B, ATMUSIC_LIVE_PDS_B="https://pds.test",
                            ATMUSIC_LIVE_WORKER_VERSION_ID="not-a-version", ATMUSIC_LIVE_BUNDLE_SHA256="abc")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertNotIn("NETWORK-ATTEMPT", result.stderr)
        missing = json.loads(result.stdout)["missing"]
        for expected in ("ATMUSIC_LIVE_ORIGIN: invalid — reserved example domain",
                         "ATMUSIC_LIVE_LEXICON_PREFIX: invalid — fixture/example prefix is never live",
                         "ATMUSIC_LIVE_DID_A: invalid — reserved fixture DID, not a live identity",
                         "ATMUSIC_LIVE_PDS_A: invalid — reserved or non-public name",
                         "ATMUSIC_LIVE_WORKER_VERSION_ID: invalid — must be a lowercase UUID",
                         "ATMUSIC_LIVE_BUNDLE_SHA256: invalid — must be 64 lowercase hex digits"):
            self.assertIn(expected, missing)
        # Secrets passed to a blocked gate are never echoed.
        token = "s3cret-admin-token-value-" + "z" * 16
        result = run_script("workers_socket_soak", ATMUSIC_LIVE_ADMIN_TOKEN=token, ATMUSIC_LIVE_CF_API_TOKEN="short")
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(token, result.stdout + result.stderr)
        manifest = passing_inventory()
        manifest["prerequisites"]["ownedLexiconPrefix"] = "com.example.atmusic"
        manifest["prerequisites"]["identities"][0]["did"] = "did:plc:" + "b" * 24
        self.assertIn("prerequisites.ownedLexiconPrefix (owned production namespace)", problems(manifest))
        self.assertTrue(any(p.startswith("prerequisites.identities") for p in problems(manifest)))

    def test_fixture_only_and_legacy_inventories_remain_blocked(self):
        manifest = passing_inventory()
        manifest["fixtureOnly"] = True
        for entry in manifest["gates"].values():
            entry["fixtureOnly"] = True
        verdict = evaluate(manifest)
        self.assertEqual(verdict.status, "blocked")
        self.assertIn("fixtureOnly (fixture-only inventories cannot satisfy acceptance)", verdict.problems)
        for name in REQUIRED_GATES:
            self.assertIn(f"gates.{name}.fixtureOnly (fixture evidence never closes a live gate)", verdict.problems)
        legacy = {"schemaVersion": 1, "fixtureOnly": False, "artifactSha256": "8" * 64, "prerequisites": {}, "evidence": {}}
        self.assertEqual(evaluate(legacy).status, "blocked")
        self.assertTrue(evaluate(legacy).problems[0].startswith("schemaVersion (expected 2"))
        saved = json.loads((ROOT / "docs/verification/live-evidence.json").read_text())
        self.assertIs(saved["fixtureOnly"], False, "fixture container entered the real inventory")
        self.assertEqual(evaluate(saved).status, "blocked")

    def test_reserved_example_origins_never_count_as_live_prerequisites(self):
        for host in ("example.com", "example.net", "example.org", "pds.example.com", "relay.example.net",
                     "pds.example.org", "music.example", "first.test", "probe.internal"):
            self.assertFalse(secure_url(f"https://{host}", {"https"}), host)
        self.assertFalse(secure_url("https://[broken", {"https"}))
        self.assertFalse(secure_url("https://real-domain.com:invalid", {"https"}))
        self.assertTrue(secure_url(ORIGIN, {"https"}, origin=True))


if __name__ == "__main__":
    unittest.main(verbosity=2)

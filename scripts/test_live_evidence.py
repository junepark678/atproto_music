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
CID = "bafyreib2rxk3rybk3aobmv5cjuql3bm2twh4jo5uxgf5djpkzwuevr6cqe"
CID2 = "bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm"
REV = "3lbqzf4u2zs2k"
URI_A = f"at://{DID_A}/{PREFIX}.scrobble/3lbqzf4u2zs2a"
URI_B = f"at://{DID_B}/{PREFIX}.scrobble/3lbqzf4u2zs2b"
LIVE_SCRIPTS = {
    "pds_compat_check": ("pdsCompat", ["ATMUSIC_LIVE_ORIGIN", "ATMUSIC_LIVE_LEXICON_PREFIX",
                                       "ATMUSIC_LIVE_WORKER_VERSION_ID", "ATMUSIC_LIVE_BUNDLE_SHA256",
                                       "ATMUSIC_LIVE_DID_A", "ATMUSIC_LIVE_PDS_A", "ATMUSIC_LIVE_DID_B",
                                       "ATMUSIC_LIVE_PDS_B", "ATMUSIC_LIVE_PDS_INDEPENDENCE_REF",
                                       "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF"]),
    "workers_oauth_check": ("oauth", ["ATMUSIC_LIVE_ORIGIN", "ATMUSIC_LIVE_DID_A", "ATMUSIC_LIVE_PDS_B",
                                      "ATMUSIC_LIVE_HANDLE_A", "ATMUSIC_LIVE_PASSWORD_B"]),
    "workers_ingest_check": ("ingest", ["ATMUSIC_LIVE_ORIGIN", "ATMUSIC_LIVE_DID_B", "ATMUSIC_LIVE_ADMIN_TOKEN",
                                        "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF", "ATMUSIC_LIVE_APP_PASSWORD_B"]),
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
_TRAP_DIR = tempfile.TemporaryDirectory(prefix="atmusic-fetch-trap-")
TRAP_PATH = Path(_TRAP_DIR.name) / "fetch-trap.mjs"
TRAP_PATH.write_text(FETCH_TRAP)


def gate(name, results, **extra):
    entry = {
        "schemaVersion": 2, "gate": name, "result": "passed", "fixtureOnly": False,
        "recordedAt": "2026-01-15T12:00:00Z", "testCommand": f"npx tsx scripts/live/{name}.ts",
        "workerVersionId": VERSION, "bundleSha256": BUNDLE, "commit": COMMIT,
        "origin": ORIGIN, "lexiconPrefix": PREFIX, "pds": [], "subjects": [], "results": results,
        "cleanup": "every created record deleted and verified absent",
    }
    entry.update(extra)
    return entry


PDS = [{"endpoint": PDS_A, "implementation": "reference", "version": "0.4.200"},
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
                 "repoScopesGranted": True, "transitionGeneric": False} for d in (DID_A, DID_B)]},
                pds=PDS, subjects=[{"did": DID_A, "uri": None}, {"did": DID_B, "uri": None}]),
            "ingest": gate("ingest", {
                "localPublish": dict(published, uri=URI_A),
                "externalPublish": dict(published, uri=URI_B, cid=CID2, verifiedCid=CID2, indexedCid=CID2),
                "deleteReconcile": [{"uri": u, "absentVerified": True, "verifiedRev": REV, "lagMs": 900}
                                    for u in (URI_A, URI_B)],
            }, pds=PDS, subjects=[{"did": DID_A, "uri": URI_A}, {"did": DID_B, "uri": URI_B}]),
            "pdsCompat": gate("pdsCompat", {"perPds": [
                {"endpoint": p["endpoint"], "getRecordInclusion": True, "getRecordExclusion": i == 0,
                 "getBlocks": True, "getRepoStatus": True} for i, p in enumerate(PDS)]},
                pds=PDS, subjects=[{"did": DID_A, "uri": URI_A}, {"did": DID_B, "uri": URI_B}]),
            "ssrfProbe": gate("ssrfProbe", {"targets": [
                {"target": {"label": label, "host": f"{label}.probe.operator-one.net", "kind": "controlledName"},
                 "raw": [{"outcome": "error"}], "safeFetch": {"outcome": "refused", "code": "blocked_destination"}}
                for label in ("rfc1918", "loopback", "metadata")]}),
            "socketSoak": gate("socketSoak", {
                "durationHours": 24, "decision": "socket", "reconnectsLowerBound": 7,
                "lagMs": {"p50": 900, "p95": 4000, "max": 61000}, "analytics": {"doRequests": 812345},
                "cpuMsPerAlarmUpperBound": 41.5}),
        },
    }


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
               "ATMUSIC_LIVE_JETSTREAM_COVERAGE_REF": "jetstream coverage log OPS-2"}
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

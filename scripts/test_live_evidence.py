#!/usr/bin/env python3
"""Regression checks for blocked live inventories; fixtures never close a gate."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from verify_live_evidence import REQUIRED_EVIDENCE, problems, secure_url

ROOT = Path(__file__).resolve().parents[1]


def fixture_inventory():
    checksum = "a" * 64
    return {
        "schemaVersion": 1, "fixtureOnly": True, "artifactSha256": checksum,
        "prerequisites": {
            "dedicatedIdentities": ["did:plc:aaaaaaaaaaaaaaaaaaaaaaaa", "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"],
            "ownedLexiconPrefix": "fm.controlled.music", "publicHttpsOrigin": "https://music.test",
            "pdsEndpoints": ["https://first.test", "https://second.test"],
            "independentPdsOperatorsVerified": True, "relayUrl": "wss://relay.test", "relayCoverageVerified": True,
        },
        "evidence": {name: {
            "result": "passed", "artifactSha256": checksum, "commit": "b" * 40,
            "recordedAt": "2026-01-15T12:00:00Z", "testCommand": "fixture-only unit test",
            "independentEvidence": "controlled fixture; no public record", "cleanup": "fixture removed",
            "fixtureOnly": True,
        } for name in REQUIRED_EVIDENCE},
    }


class LiveInventoryTests(unittest.TestCase):
    def test_live_credentials_missing(self):
        with tempfile.TemporaryDirectory(prefix="atmusic-blocked-evidence-") as directory:
            manifest = Path(directory) / "blocked.json"
            manifest.write_text(json.dumps({"schemaVersion": 1, "fixtureOnly": False, "prerequisites": {}, "evidence": {}}))
            result = subprocess.run(["python3", str(ROOT / "scripts/verify_live_evidence.py"), str(manifest)], text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("BLOCKED:", result.stdout)
        self.assertNotIn("PASS:", result.stdout)
        self.assertIn("prerequisites.dedicatedIdentities", result.stdout)
        self.assertIn("evidence.oauth", result.stdout)

    def test_blocked_gate(self):
        manifest = fixture_inventory()
        manifest["prerequisites"]["relayCoverageVerified"] = False
        del manifest["evidence"]["oauth"]
        issues = problems(manifest)
        self.assertTrue(any(value.startswith("prerequisites.relayCoverageVerified") for value in issues))
        self.assertIn("evidence.oauth", issues)

    def test_fixture_and_artifact_mismatch_remain_blocked(self):
        manifest = copy.deepcopy(fixture_inventory())
        issues = problems(manifest, "c" * 64)
        self.assertTrue(any("fixture-only" in value for value in issues))
        self.assertTrue(any(value.startswith("artifactSha256 (") for value in issues))
        for name in REQUIRED_EVIDENCE:
            self.assertIn(f"evidence.{name}.liveEvidence", issues)
        self.assertEqual(manifest, fixture_inventory(), "inventory validation changed the fixture")
        saved = json.loads((ROOT / "docs/verification/live-evidence.json").read_text())
        self.assertIs(saved["fixtureOnly"], False, "fixture container entered the real inventory")
        for entry in saved["evidence"].values():
            self.assertIs(entry.get("fixtureOnly"), False, "fixture entry entered the real inventory")

    def test_reserved_example_origins_never_count_as_live_prerequisites(self):
        for host in ("example.com", "example.net", "example.org", "pds.example.com", "relay.example.net", "pds.example.org", "music.example", "first.test"):
            self.assertFalse(secure_url(f"https://{host}", {"https"}), host)
        self.assertFalse(secure_url("https://[broken", {"https"}))
        self.assertFalse(secure_url("https://real-domain.com:invalid", {"https"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)

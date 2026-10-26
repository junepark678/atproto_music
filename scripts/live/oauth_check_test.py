#!/usr/bin/env python3
"""Deterministic helper regressions; these tests never establish live OAuth acceptance."""
from contextlib import redirect_stdout
from io import StringIO
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import oauth_check as helper

DID = "did:plc:zyxwvutsrqponmlkjihgfedc"
PREFIX = "net.controlled.music"
URI = "at://" + DID + "/" + PREFIX + ".scrobble/3m4zm2ufr2222"
CID = "bafyreiexactcontrolledcid000000000000000000000000000000000000"
SECRET = "credential-that-must-never-appear-in-evidence"


def environment(directory):
    artifact = Path(directory) / "atmusic-fixture-artifact"
    artifact.write_bytes(b"fixture only; not a release artifact")
    return {
        "ATMUSIC_PUBLIC_ORIGIN": "https://music.controlled-at.net",
        "ATMUSIC_OAUTH_TEST_HANDLE": "account.controlled-at.net",
        "ATMUSIC_OAUTH_EXPECTED_DID": DID,
        "ATMUSIC_OAUTH_PDS_ORIGIN": "https://pds.controlled-at.net",
        "ATMUSIC_LEXICON_PREFIX": PREFIX,
        "ATMUSIC_NAMESPACE_OWNER_DOMAIN": "controlled-at.net",
        "ATMUSIC_NAMESPACE_OWNERSHIP_REFERENCE": "reviewed ownership",
        "ATMUSIC_RELAY_URL": "wss://relay.controlled-at.net",
        "ATMUSIC_OAUTH_RELAY_COVERAGE_REFERENCE": "reviewed coverage",
        "ATMUSIC_OAUTH_ARTIFACT": str(artifact),
        "ATMUSIC_OAUTH_SOURCE_COMMIT": "d" * 40,
        "ATMUSIC_OAUTH_EVIDENCE_DIR": str(Path(directory) / "evidence"),
    }


class FakeLifecycle(helper.LiveClient):
    def __init__(self, wrong_cid=False):
        self.environment = {"ATMUSIC_OAUTH_EXPECTED_DID": DID, "ATMUSIC_LEXICON_PREFIX": PREFIX}
        self.calls = []
        self.wrong_cid = wrong_cid
        self.payload = None

    def operation(self, operation_id):
        self.calls.append(("OPERATION", operation_id))
        return {"recordUri": URI, "state": "succeeded"}

    def request(self, path, method="GET", payload=None, authenticated=False, external=False):
        self.calls.append((method, path, authenticated, external))
        if method == "POST":
            self.payload = payload
            return 202, {"operationId": "create-one"}, {}
        if method == "DELETE":
            return 202, {"operationId": "delete-one"}, {}
        deleted = any(call[0] == "DELETE" for call in self.calls)
        if external:
            if deleted:
                return 400, {"error": "RecordNotFound"}, {}
            return 200, {"uri": URI, "cid": "mismatchedcidvalue123" if self.wrong_cid else CID,
                         "value": self.payload}, {}
        if deleted:
            return 404, {"error": {"code": "not_found"}}, {}
        return 200, {"scrobble": {"uri": URI, "cid": CID}}, {}


class OAuthHelperTests(unittest.TestCase):
    def test_live_credentials_missing(self):
        clean = {name: value for name, value in os.environ.items() if not name.startswith("ATMUSIC_")}
        result = subprocess.run(["python3", str(Path(helper.__file__)), "--phase", "session"],
                                env=clean, text=True, capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("BLOCKED:", result.stdout)
        self.assertIn("ATMUSIC_PUBLIC_ORIGIN", result.stdout)
        self.assertIn("ATMUSIC_OAUTH_COOKIE_FILE", result.stdout)
        self.assertNotIn("OBSERVED:", result.stdout)
        with patch.object(helper, "LiveClient", side_effect=AssertionError("network must not execute")):
            with redirect_stdout(StringIO()):
                self.assertEqual(helper.run({}, "preflight"), 2)

    def test_reserved_origins_remain_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            values = environment(directory)
            for origin in ("http://real-domain.net", "https://music.example", "https://pds.test",
                           "https://127.0.0.1", "https://music.controlled-at.net:8443",
                           "https://cookie:secret@music.controlled-at.net"):
                values["ATMUSIC_PUBLIC_ORIGIN"] = origin
                self.assertTrue(any(name.startswith("ATMUSIC_PUBLIC_ORIGIN")
                                    for name in helper.prerequisites(values, "preflight")))

    def test_private_cookie_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "cookie.private"
            source.write_text("atmusic_session=" + "a" * 64)
            source.chmod(0o644)
            with self.assertRaises(helper.CheckFailure):
                helper.private_read(source)
            source.chmod(0o600)
            self.assertEqual(helper.private_read(source), source.read_text())
            link = Path(directory) / "cookie-link.private"
            link.symlink_to(source)
            with self.assertRaises(OSError):
                helper.private_read(link)

    def test_live_disposable_record_helper_sequence(self):
        client = FakeLifecycle()
        observation = {}
        client.disposable_record(observation)
        self.assertEqual(observation["atUri"], URI)
        self.assertEqual(observation["cid"], CID)
        self.assertTrue(observation["uriCidContentMatch"])
        self.assertEqual(observation["cleanup"], "confirmed absent")
        self.assertEqual(observation["pdsAfterDeleteStatus"], 400)
        self.assertEqual([call[0] for call in client.calls],
                         ["POST", "OPERATION", "GET", "GET", "DELETE", "OPERATION", "GET", "GET"])
        self.assertFalse(any(call[-1] is True and call[-2] is True
                             for call in client.calls if len(call) == 4), "cookie sent to external PDS")

    def test_cleanup_runs_on_independent_cid_mismatch(self):
        client = FakeLifecycle(wrong_cid=True)
        observation = {}
        with self.assertRaises(helper.CheckFailure):
            client.disposable_record(observation)
        self.assertEqual(observation["cleanup"], "confirmed absent")
        self.assertEqual(sum(call[0] == "POST" for call in client.calls), 1)
        self.assertEqual(sum(call[0] == "DELETE" for call in client.calls), 1)
        self.assertNotIn("uriCidContentMatch", observation)

    def test_sensitive_failures_are_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            values = environment(directory)
            output = StringIO()
            with patch.object(helper.LiveClient, "request", side_effect=helper.CheckFailure(SECRET)):
                with redirect_stdout(output):
                    self.assertEqual(helper.run(values, "preflight"), 1)
            self.assertNotIn(SECRET, output.getvalue())
            files = list(Path(values["ATMUSIC_OAUTH_EVIDENCE_DIR"]).glob("oauth-*.json"))
            self.assertEqual(len(files), 1)
            self.assertNotIn(SECRET, files[0].read_text())
            self.assertEqual(json.loads(files[0].read_text())["result"], "failed")
            self.assertEqual(files[0].stat().st_mode & 0o777, 0o600)

    def test_authorization_url_is_only_saved_privately(self):
        with tempfile.TemporaryDirectory() as directory:
            values = environment(directory)
            origin = values["ATMUSIC_PUBLIC_ORIGIN"]
            responses = [
                (200, {"client_id": origin + "/oauth/client-metadata.json",
                       "redirect_uris": [origin + "/api/v1/auth/callback"],
                       "scope": "atproto repo:" + PREFIX + ".scrobble repo:" + PREFIX + ".follow",
                       "token_endpoint_auth_method": "none", "dpop_bound_access_tokens": True,
                       "require_pushed_authorization_requests": True}, {}),
                (200, {"did": DID, "verified": True}, {}),
                (200, {"authorizationUrl": "https://as.controlled-at.net/authorize?state=" + SECRET}, {}),
            ]
            output = StringIO()
            with patch.object(helper.LiveClient, "request", side_effect=responses):
                with redirect_stdout(output):
                    self.assertEqual(helper.run(values, "start"), 0)
            evidence = Path(values["ATMUSIC_OAUTH_EVIDENCE_DIR"])
            private = list(evidence.glob("authorization-*.private"))
            self.assertEqual(len(private), 1)
            self.assertIn(SECRET, private[0].read_text())
            self.assertEqual(private[0].stat().st_mode & 0o777, 0o600)
            for result in evidence.glob("*.json"):
                self.assertNotIn(SECRET, result.read_text())
            self.assertNotIn(SECRET, output.getvalue())
            self.assertIn("live gate requires independent review", output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)

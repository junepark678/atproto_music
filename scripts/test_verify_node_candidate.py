"""Regression tests for static, no-extract Node candidate verification."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any
from unittest.mock import patch

from verify_node_candidate import CandidateError, main, verify_candidate

COMMIT = "a" * 40
TAG = "v0.0.0"
PAYLOAD = {
    "worker/dist/node/main.mjs": b"throw new Error('must not execute');\n",
    "worker/dist/node/main.mjs.map": b"{}\n",
    "worker/dist/node/main.meta.json": b"{}\n",
    "worker/dist/node/main.inputs.json": b"{}\n",
    "web/dist/index.html": b"<!doctype html><title>fixture</title>\n",
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def tar_info(name: str, kind: bytes = tarfile.REGTYPE, size: int = 0) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.size = size
    info.mode = 0o644
    return info


def make_archive(
    path: Path,
    *,
    payload: dict[str, bytes] | None = None,
    manifest_override: dict[str, Any] | None = None,
    raw_manifest: bytes | None = None,
    extra_members: list[tuple[str, bytes | None, bytes]] | None = None,
    pax_headers: dict[str, str] | None = None,
) -> str:
    files = dict(PAYLOAD if payload is None else payload)
    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "kind": "node-candidate-not-accepted",
        "version": "0.0.0",
        "tag": TAG,
        "commit": COMMIT,
        "bundleSha256": digest(files["worker/dist/node/main.mjs"]),
        "packageLockSha256": "b" * 64,
        "runtime": {"node": "v26.12.1", "sqlite": "3.54.1", "required": "26.12.1"},
        "files": {name: digest(data) for name, data in files.items()},
        "notAccepted": ["live acceptance", "installer activation"],
    }
    if manifest_override:
        manifest.update(manifest_override)
    encoded_manifest = raw_manifest if raw_manifest is not None else (json.dumps(manifest) + "\n").encode()
    entries: list[tuple[str, bytes | None, bytes]] = [("candidate.json", encoded_manifest, tarfile.REGTYPE)]
    entries.extend((name, data, tarfile.REGTYPE) for name, data in files.items())
    if extra_members:
        entries.extend(extra_members)
    directories: set[str] = set()
    for name, _, _ in entries:
        if name in (".", "./"):
            continue
        parts = name.removeprefix("./").split("/")[:-1]
        for index in range(1, len(parts) + 1):
            directories.add("/".join(parts[:index]))
    with tarfile.open(path, "w:gz") as archive:
        root = tar_info(".", tarfile.DIRTYPE)
        archive.addfile(root)
        for directory in sorted(directories):
            archive.addfile(tar_info(f"./{directory}/", tarfile.DIRTYPE))
        for name, data, kind in entries:
            if kind == tarfile.SYMTYPE:
                info = tar_info(name, kind)
                info.linkname = (data or b"").decode()
                archive.addfile(info)
            elif data is None:
                archive.addfile(tar_info(name, kind))
            else:
                info = tar_info(f"./{name.removeprefix('./')}", kind, len(data))
                if name == "web/dist/index.html" and pax_headers:
                    info.pax_headers = pax_headers
                archive.addfile(info, io.BytesIO(data))
    return digest(path.read_bytes())


class VerifyNodeCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="test-verify-candidate-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "candidate.tar.gz"
        self.trusted_sha = make_archive(self.archive)

    def verify(
        self,
        *,
        sha: str | None = None,
        commit: str = COMMIT,
        tag: str = TAG,
        archive_path: Path | None = None,
    ):
        return verify_candidate(str(archive_path or self.archive), sha or self.trusted_sha, commit, tag)

    def test_valid_candidate_reports_static_not_accepted_and_does_not_execute_payload(self) -> None:
        sentinel = self.root / "must-not-exist"
        # The bundle is deliberately executable JavaScript if someone were to run it.
        payload = dict(PAYLOAD)
        payload["worker/dist/node/main.mjs"] = f"import fs from 'node:fs'; fs.writeFileSync({json.dumps(str(sentinel))}, 'ran');".encode()
        self.trusted_sha = make_archive(self.archive, payload=payload)

        report = self.verify()

        self.assertEqual(report["result"], "verified-static-candidate-not-accepted")
        self.assertEqual(report["commit"], COMMIT)
        self.assertEqual(report["archiveSha256"], self.trusted_sha)
        self.assertEqual(report["fileCount"], len(PAYLOAD))
        self.assertIn("not trusted workflow provenance", " ".join(report["limitations"]))
        self.assertFalse(sentinel.exists())

    def test_requires_independent_digest_and_exact_source_identity(self) -> None:
        with self.assertRaisesRegex(CandidateError, "independently trusted digest"):
            self.verify(sha="0" * 64)
        with self.assertRaisesRegex(CandidateError, "expected tag/commit"):
            self.verify(commit="c" * 40)
        with self.assertRaisesRegex(CandidateError, "expected tag/commit"):
            self.verify(tag="v1.0.0")

    def test_rejects_symlink_archive_and_unexpected_manifest_roots(self) -> None:
        archive_link = self.root / "candidate-link.tar.gz"
        archive_link.symlink_to(self.archive)
        with self.assertRaisesRegex(CandidateError, "cannot open candidate archive safely"):
            self.verify(archive_path=archive_link)

        payload = dict(PAYLOAD)
        payload["config/systemd/atmusic.service"] = b"unexpected unit\n"
        self.trusted_sha = make_archive(self.archive, payload=payload)
        with self.assertRaisesRegex(CandidateError, "unexpected path"):
            self.verify()

        payload = dict(PAYLOAD)
        payload["worker/dist/node/unreviewed.mjs"] = b"unexpected bundle member\n"
        self.trusted_sha = make_archive(self.archive, payload=payload)
        with self.assertRaisesRegex(CandidateError, "missing or unexpected file"):
            self.verify()

    def test_rejects_corrupt_gzip_with_a_matching_trusted_digest(self) -> None:
        corrupt = bytearray(gzip.compress(b"not a tar archive"))
        corrupt[10] ^= 0xFF
        self.archive.write_bytes(corrupt)
        self.trusted_sha = digest(bytes(corrupt))
        with self.assertRaisesRegex(CandidateError, "cannot decompress candidate tar.gz"):
            self.verify()

    def test_rejects_fifo_archive_without_blocking(self) -> None:
        fifo = self.root / "candidate.fifo"
        os.mkfifo(fifo)
        script = Path(__file__).with_name("verify_node_candidate.py")
        result = subprocess.run(
            [
                sys.executable,
                str(script),
                "--archive",
                str(fifo),
                "--trusted-sha256",
                self.trusted_sha,
                "--commit",
                COMMIT,
                "--tag",
                TAG,
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=3,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("regular non-symlink file", result.stderr)

    def test_rejects_stream_resource_limits_before_payload_acceptance(self) -> None:
        with patch("verify_node_candidate.MAX_MEMBERS", 3), self.assertRaisesRegex(
            CandidateError, "member count"
        ):
            self.verify()

        with patch("verify_node_candidate.MAX_DECOMPRESSED_TAR_BYTES", 1024), self.assertRaisesRegex(
            CandidateError, "decompressed tar exceeds the configured size limit"
        ):
            self.verify()

    def test_rejects_oversized_pax_extension_before_tarfile_parses_it(self) -> None:
        self.trusted_sha = make_archive(
            self.archive,
            pax_headers={"comment": "x" * 1_000_001},
        )
        with self.assertRaisesRegex(CandidateError, "extension metadata exceeds"):
            self.verify()

    def test_rejects_payload_hash_mismatch_and_uninventoried_file(self) -> None:
        tampered = dict(PAYLOAD)
        tampered["worker/dist/node/main.mjs"] += b"tampered"
        original_inventory = {name: digest(data) for name, data in PAYLOAD.items()}
        self.trusted_sha = make_archive(
            self.archive,
            payload=tampered,
            manifest_override={
                "files": original_inventory,
                "bundleSha256": digest(PAYLOAD["worker/dist/node/main.mjs"]),
            },
        )
        with self.assertRaisesRegex(CandidateError, "payload hash mismatch"):
            self.verify()

        self.trusted_sha = make_archive(
            self.archive,
            extra_members=[("web/dist/extra.js", b"extra", tarfile.REGTYPE)],
        )
        with self.assertRaisesRegex(CandidateError, "absent from manifest inventory"):
            self.verify()

    def test_rejects_manifest_path_escape_duplicate_json_key_and_bundle_disagreement(self) -> None:
        manifest = b'{"schemaVersion":1,' + b'"schemaVersion":1}'
        self.trusted_sha = make_archive(self.archive, raw_manifest=manifest)
        with self.assertRaisesRegex(CandidateError, "duplicate JSON key"):
            self.verify()

        payload = dict(PAYLOAD)
        override = {
            "files": {"../outside": "a" * 64, **{name: digest(data) for name, data in payload.items()}},
        }
        self.trusted_sha = make_archive(self.archive, payload=payload, manifest_override=override)
        with self.assertRaisesRegex(CandidateError, "unsafe candidate manifest path"):
            self.verify()

        self.trusted_sha = make_archive(self.archive, manifest_override={"bundleSha256": "f" * 64})
        with self.assertRaisesRegex(CandidateError, "bundleSha256 differs"):
            self.verify()

    def test_rejects_archive_traversal_links_duplicates_and_special_entries(self) -> None:
        for name, kind, message in [
            ("../outside", tarfile.REGTYPE, "unsafe archive path"),
            ("././web/dist/alias.js", tarfile.REGTYPE, "unsafe archive path"),
            ("web/dist/link", tarfile.SYMTYPE, "only bounded regular files"),
            ("web/dist/index.html", tarfile.REGTYPE, "duplicate normalized archive member"),
            ("web/dist/fifo", tarfile.FIFOTYPE, "only bounded regular files"),
        ]:
            with self.subTest(name=name, kind=kind):
                self.trusted_sha = make_archive(
                    self.archive,
                    extra_members=[(name, b"../outside" if kind == tarfile.SYMTYPE else b"extra", kind)],
                )
                with self.assertRaisesRegex(CandidateError, message):
                    self.verify()

    def test_cli_emits_machine_readable_report_without_writing_artifact_paths(self) -> None:
        args = [
            "--archive", str(self.archive),
            "--trusted-sha256", self.trusted_sha,
            "--commit", COMMIT,
            "--tag", TAG,
        ]
        output = io.StringIO()
        with redirect_stdout(output):
            status = main(args)
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(output.getvalue())["result"], "verified-static-candidate-not-accepted")


if __name__ == "__main__":
    unittest.main()

"""Offline candidate staging and release-link rollback regressions."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

import stage_node_candidate as stager
import verify_node_candidate as verifier

CandidateError = verifier.CandidateError
REQUIRED_FILES = verifier.REQUIRED_FILES


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def make_candidate(
    path: Path,
    commit: str,
    label: str,
    execution_sentinel: Path | None = None,
) -> tuple[str, dict[str, bytes], str]:
    files = {
        name: (f"candidate={label};file={name}\n".encode())
        for name in sorted(REQUIRED_FILES)
    }
    if execution_sentinel is None:
        bundle = f"// bundle {label}\n"
    else:
        bundle = (
            'import { writeFileSync } from "node:fs"; '
            f"writeFileSync({json.dumps(str(execution_sentinel))}, \"executed\");\n"
        )
    files["worker/dist/node/main.mjs"] = bundle.encode()
    files["web/dist/.node-candidate-release.json"] = b"an inventoried asset, not the root release marker\n"
    file_hashes = {name: digest(content) for name, content in files.items()}
    manifest = {
        "schemaVersion": 1,
        "kind": "node-candidate-not-accepted",
        "version": "0.0.0",
        "tag": "v0.0.0",
        "commit": commit,
        "bundleSha256": file_hashes["worker/dist/node/main.mjs"],
        "packageLockSha256": "a" * 64,
        "runtime": {"node": "v26.12.1", "sqlite": "3.54.1", "required": "26.12.1"},
        "files": file_hashes,
        "notAccepted": ["test fixture only"],
    }
    raw_manifest = json.dumps(manifest, sort_keys=True, indent=2).encode() + b"\n"
    directories = sorted(
        {
            "/".join(name.split("/")[:index])
            for name in files
            for index in range(1, len(name.split("/")))
        }
    )
    tar_bytes = io.BytesIO()
    with tarfile.open(fileobj=tar_bytes, mode="w", format=tarfile.PAX_FORMAT) as archive:
        root = tarfile.TarInfo("./")
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        archive.addfile(root)
        manifest_info = tarfile.TarInfo("./candidate.json")
        manifest_info.size = len(raw_manifest)
        manifest_info.mode = 0o644
        archive.addfile(manifest_info, io.BytesIO(raw_manifest))
        for name in directories:
            info = tarfile.TarInfo(f"./{name}/")
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            archive.addfile(info)
        for name, content in sorted(files.items()):
            info = tarfile.TarInfo(f"./{name}")
            info.size = len(content)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(content))
    compressed = gzip.compress(tar_bytes.getvalue(), mtime=0)
    path.write_bytes(compressed)
    release_id = f"{commit}-{digest(compressed)[:16]}"
    return digest(compressed), files, release_id


class StageCandidateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="atmusic-stage-candidate-test-")
        self.root = Path(self.temp.name)
        self.prefix = self.root / "prefix"
        self.archive_a = self.root / "candidate-a.tar.gz"
        self.archive_b = self.root / "candidate-b.tar.gz"
        self.execution_sentinel = self.root / "candidate-executed"
        self.sha_a, self.files_a, self.release_a = make_candidate(
            self.archive_a, "a" * 40, "A", self.execution_sentinel
        )
        self.sha_b, self.files_b, self.release_b = make_candidate(
            self.archive_b, "b" * 40, "B", self.execution_sentinel
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def stage_a(self, *, switch: bool = False) -> dict[str, object]:
        return stager.stage_candidate(
            str(self.archive_a), self.sha_a, "a" * 40, "v0.0.0", str(self.prefix), switch=switch
        )

    def stage_b(self, *, switch: bool = False) -> dict[str, object]:
        current = (
            {"current_trusted_sha256": self.sha_a, "current_commit": "a" * 40, "current_tag": "v0.0.0"}
            if switch
            else {}
        )
        return stager.stage_candidate(
            str(self.archive_b), self.sha_b, "b" * 40, "v0.0.0", str(self.prefix), switch=switch, **current
        )

    def seed_current(self, release_id: str) -> None:
        os.symlink(f"releases/{release_id}", self.prefix / "current")

    @contextmanager
    def fail_switch_lock_close(self) -> Iterator[None]:
        actual_open = os.open
        actual_close = os.close
        lock_fd: int | None = None

        def capture_open(path: str | os.PathLike[str], *args: Any, **kwargs: Any) -> int:
            nonlocal lock_fd
            fd = actual_open(path, *args, **kwargs)
            if Path(path).name == ".candidate-switch.lock":
                lock_fd = fd
            return fd

        def fail_lock_close(fd: int) -> None:
            if fd == lock_fd:
                actual_close(fd)
                raise OSError("injected switch-lock close failure")
            actual_close(fd)

        with (
            patch.object(stager.os, "open", side_effect=capture_open),
            patch.object(stager.os, "close", side_effect=fail_lock_close),
        ):
            yield

    def test_stage_consumes_verified_bytes_without_switch_or_execution(self) -> None:
        result = self.stage_a()
        self.assertEqual(result["result"], "candidate-staged-not-activated")
        self.assertFalse(result["switched"])
        self.assertFalse((self.prefix / "current").exists())
        self.assertFalse(self.execution_sentinel.exists())
        release = self.prefix / "releases" / self.release_a
        self.assertTrue((release / stager.MARKER).is_file())
        for relative, expected in self.files_a.items():
            self.assertEqual((release / relative).read_bytes(), expected, relative)
            self.assertEqual((release / relative).stat().st_mode & 0o777, 0o644)
        self.assertEqual((release / "candidate.json").stat().st_mode & 0o777, 0o644)
        self.assertEqual((release / "candidate.tar.gz").read_bytes(), self.archive_a.read_bytes())
        self.assertEqual(
            result["limitations"],
            [
                "service was not activated or restarted",
                "systemd units were not installed",
                "database migration, backup, health, hosted provenance and live acceptance were not verified",
            ],
        )

    def test_snapshot_cleanup_error_reports_published_identity_without_switching(self) -> None:
        self.stage_a()
        self.seed_current(self.release_a)
        real_snapshot = stager.verified_candidate_snapshot
        releases = self.prefix / "releases"
        actual_fsync = stager._fsync_directory

        @contextmanager
        def fail_after_snapshot_cleanup(
            archive_path: str,
            trusted_sha256: str,
            expected_commit: str,
            expected_tag: str,
        ) -> Iterator[tuple[str, dict[str, Any]]]:
            with real_snapshot(archive_path, trusted_sha256, expected_commit, expected_tag) as verified:
                yield verified
            raise OSError("injected verified snapshot cleanup failure")

        def fail_publication_fsync(path: Path) -> None:
            if path == releases:
                raise OSError("injected publication directory fsync failure")
            actual_fsync(path)

        with (
            patch.object(stager, "verified_candidate_snapshot", fail_after_snapshot_cleanup),
            patch.object(stager, "_fsync_directory", side_effect=fail_publication_fsync),
            self.assertRaises(CandidateError) as caught,
        ):
            stager.stage_candidate(
                str(self.archive_b),
                self.sha_b,
                "b" * 40,
                "v0.0.0",
                str(self.prefix),
                switch=True,
                current_trusted_sha256=self.sha_a,
                current_commit="a" * 40,
                current_tag="v0.0.0",
            )

        message = str(caught.exception)
        self.assertIn(f"candidate release {self.release_b} remains staged", message)
        self.assertIn(f"archiveSha256={self.sha_b}", message)
        self.assertIn("commit=" + "b" * 40, message)
        self.assertIn("current was not switched by this invocation", message)
        self.assertIn("release was published, but releases directory fsync failed", message)
        self.assertTrue((self.prefix / "releases" / self.release_b).is_dir())
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_same_candidate_reuses_only_a_hash_verified_release(self) -> None:
        self.stage_a()
        second = self.stage_a()
        self.assertTrue(second["reused"])
        self.assertEqual(
            [path.name for path in (self.prefix / "releases").iterdir() if path.name.startswith(".candidate-staging-")],
            [],
        )

    def test_switch_and_rollback_keep_both_exact_release_trees(self) -> None:
        self.stage_a()
        self.stage_b()
        self.seed_current(self.release_a)
        switched = self.stage_b(switch=True)
        self.assertTrue(switched["switched"])
        self.assertEqual(switched["previousTarget"], f"releases/{self.release_a}")
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")
        actual_fsync = stager._fsync_directory
        prefix_fsyncs = 0

        def fail_rollback_fsync(path: Path) -> None:
            nonlocal prefix_fsyncs
            if path == self.prefix:
                prefix_fsyncs += 1
                if prefix_fsyncs == 2:
                    raise OSError("injected rollback fsync failure")
            actual_fsync(path)

        with patch.object(stager, "_fsync_directory", side_effect=fail_rollback_fsync):
            rollback = stager.rollback_release(
                str(self.prefix),
                self.release_a,
                self.sha_a,
                "a" * 40,
                "v0.0.0",
                self.sha_b,
                "b" * 40,
                "v0.0.0",
            )
        rollback_warning = cast(str, rollback["durabilityWarning"])
        self.assertIn("current was switched", rollback_warning)
        self.assertEqual(rollback["result"], "release-link-rolled-back-not-activated")
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")
        for relative, expected in self.files_a.items():
            self.assertEqual((self.prefix / "releases" / self.release_a / relative).read_bytes(), expected)
        for relative, expected in self.files_b.items():
            self.assertEqual((self.prefix / "releases" / self.release_b / relative).read_bytes(), expected)

    def test_first_install_switch_is_refused_without_a_rollback_target(self) -> None:
        with self.assertRaisesRegex(CandidateError, "existing verified current release"):
            self.stage_a(switch=True)
        self.assertFalse((self.prefix / "current").exists())
        self.assertEqual(list((self.prefix / "releases").iterdir()), [])

    def test_wrong_digest_keeps_current_and_publishes_no_partial_release(self) -> None:
        self.stage_a()
        self.seed_current(self.release_a)
        with self.assertRaisesRegex(CandidateError, "trusted digest"):
            stager.stage_candidate(
                str(self.archive_b),
                "f" * 64,
                "b" * 40,
                "v0.0.0",
                str(self.prefix),
                switch=True,
                current_trusted_sha256=self.sha_a,
                current_commit="a" * 40,
                current_tag="v0.0.0",
            )
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")
        self.assertFalse((self.prefix / "releases" / self.release_b).exists())

    def test_staging_failure_leaves_current_unchanged_and_removes_partial_tree(self) -> None:
        self.stage_a()
        self.seed_current(self.release_a)
        def fail_after_partial_write(_snapshot: str, destination: Path, _receipt: dict[str, Any]) -> dict[str, Any]:
            (destination / "partial-payload").write_bytes(b"partial")
            raise RuntimeError("injected write failure")

        with (
            patch.object(stager, "_extract_verified_snapshot", side_effect=fail_after_partial_write),
            self.assertRaisesRegex(RuntimeError, "injected write failure"),
        ):
            self.stage_b(switch=True)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")
        self.assertFalse((self.prefix / "releases" / self.release_b).exists())
        self.assertEqual(
            [path for path in (self.prefix / "releases").iterdir() if path.name.startswith(".candidate-staging-")],
            [],
        )

    def test_tampered_prior_release_is_refused_for_rollback(self) -> None:
        self.stage_a()
        self.stage_b()
        self.seed_current(self.release_b)
        target = self.prefix / "releases" / self.release_a / "web/dist/index.html"
        target.write_bytes(b"tampered")
        with self.assertRaisesRegex(CandidateError, "release files or hashes differ"):
            stager.rollback_release(
                str(self.prefix),
                self.release_a,
                self.sha_a,
                "a" * 40,
                "v0.0.0",
                self.sha_b,
                "b" * 40,
                "v0.0.0",
            )
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

    def test_coordinated_forgery_of_release_files_and_marker_cannot_pass_reuse(self) -> None:
        self.stage_a()
        release = self.prefix / "releases" / self.release_a
        altered = b"attacker-coordinated payload alteration\n"
        (release / "worker/dist/node/main.mjs").write_bytes(altered)
        marker_path = release / stager.MARKER
        marker = json.loads(marker_path.read_text())
        marker["files"]["worker/dist/node/main.mjs"] = digest(altered)
        marker_path.write_text(json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n")
        with self.assertRaisesRegex(CandidateError, "verified candidate archive"):
            self.stage_a()

    def test_self_consistent_forged_current_marker_cannot_authorize_switch(self) -> None:
        self.stage_a()
        self.stage_b()
        self.seed_current(self.release_a)
        release = self.prefix / "releases" / self.release_a
        altered = b"forged rollback payload\n"
        (release / "worker/dist/node/main.mjs").write_bytes(altered)
        marker_path = release / stager.MARKER
        marker = json.loads(marker_path.read_text())
        marker["files"]["worker/dist/node/main.mjs"] = digest(altered)
        marker_path.write_text(json.dumps(marker, sort_keys=True, separators=(",", ":")) + "\n")
        with self.assertRaisesRegex(CandidateError, "verified candidate archive"):
            self.stage_b(switch=True)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_release_destination_race_is_not_overwritten(self) -> None:
        original_rename = stager._rename_noreplace
        destination = self.prefix / "releases" / self.release_a

        def create_destination_then_rename(source: Path, target: Path) -> None:
            target.mkdir()
            (target / "sentinel").write_text("pre-existing")
            original_rename(source, target)

        with (
            patch.object(stager, "_rename_noreplace", side_effect=create_destination_then_rename),
            self.assertRaises(FileExistsError),
        ):
            self.stage_a()
        self.assertEqual((destination / "sentinel").read_text(), "pre-existing")
        self.assertEqual(
            [path for path in (self.prefix / "releases").iterdir() if path.name.startswith(".candidate-staging-")],
            [],
        )

    def test_descriptor_relative_staging_refuses_symlink_and_traversal_paths(self) -> None:
        root = self.root / "descriptor-root"
        root.mkdir(mode=0o700)
        outside = self.root / "outside"
        outside.mkdir(mode=0o700)
        sentinel = outside / "sentinel"
        sentinel.write_text("unchanged")
        (root / "middle").symlink_to(outside, target_is_directory=True)
        (root / "leaf").symlink_to(sentinel)

        for relative in ("middle/created", "leaf", "../outside/sentinel"):
            with self.subTest(relative=relative), self.assertRaises(CandidateError):
                stager._write_regular(root, relative, b"must not escape")
        self.assertEqual(sentinel.read_text(), "unchanged")
        self.assertFalse((outside / "created").exists())

    def test_prefix_and_releases_parent_entries_are_fsynced_after_creation(self) -> None:
        prefix = self.root / "new-parent" / "new-prefix"
        calls: list[Path] = []
        real_fsync = stager._fsync_directory

        def record_fsync(path: Path) -> None:
            calls.append(path)
            real_fsync(path)

        with patch.object(stager, "_fsync_directory", side_effect=record_fsync):
            stager.stage_candidate(str(self.archive_a), self.sha_a, "a" * 40, "v0.0.0", str(prefix))
        self.assertTrue({self.root, prefix.parent, prefix}.issubset(set(calls)))
        stage_root = next(path for path in calls if path.name.startswith(".candidate-staging-"))
        staged_directories = [path for path in calls if path == stage_root or stage_root in path.parents]
        positions = {path: index for index, path in enumerate(calls)}
        for child in staged_directories:
            for parent in child.parents:
                if parent in staged_directories:
                    self.assertLess(positions[child], positions[parent], f"{child} must fsync before {parent}")

    def test_file_and_directory_fsyncs_precede_publication_rename(self) -> None:
        proc_fds = Path("/proc/self/fd")
        if not proc_fds.is_dir():
            self.skipTest("requires /proc/self/fd to map fsync descriptors")
        events: list[tuple[str, Path]] = []
        actual_fsync = os.fsync
        actual_rename = stager._rename_noreplace

        def record_fsync(fd: int) -> None:
            descriptor_path = Path(os.readlink(proc_fds / str(fd)))
            if any(part.startswith(".candidate-staging-") for part in descriptor_path.parts):
                kind = "directory" if os.path.isdir(proc_fds / str(fd)) else "file"
                events.append((kind, descriptor_path))
            actual_fsync(fd)

        def record_publish(source: Path, destination: Path) -> None:
            events.append(("publish", source))
            actual_rename(source, destination)

        with (
            patch.object(stager.os, "fsync", side_effect=record_fsync),
            patch.object(stager, "_rename_noreplace", side_effect=record_publish),
        ):
            self.stage_a()

        stage_root = next(
            path for kind, path in events if kind == "directory" and path.name.startswith(".candidate-staging-")
        )
        staged_files = [
            index
            for index, (kind, path) in enumerate(events)
            if kind == "file" and stage_root in path.parents
        ]
        staged_directories = [
            index
            for index, (kind, path) in enumerate(events)
            if kind == "directory" and (path == stage_root or stage_root in path.parents)
        ]
        publish_index = next(index for index, (kind, _path) in enumerate(events) if kind == "publish")
        self.assertTrue(staged_files)
        self.assertTrue(staged_directories)
        self.assertLess(max(staged_files), min(staged_directories))
        self.assertLess(max(staged_directories), publish_index)

    def test_scan_directory_fails_closed_on_iterator_and_close_errors(self) -> None:
        class BrokenScandir:
            def __init__(self, failure: str) -> None:
                self.failure = failure

            def __enter__(self) -> BrokenScandir:
                return self

            def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> bool:
                if self.failure == "close":
                    raise OSError("injected scandir close failure")
                return False

            def __iter__(self) -> Any:
                return self if self.failure == "iteration" else iter(())

            def __next__(self) -> Any:
                raise OSError("injected scandir iteration failure")

        for failure in ("iteration", "close"):
            with (
                self.subTest(failure=failure),
                patch.object(stager.os, "scandir", return_value=BrokenScandir(failure)),
                self.assertRaisesRegex(OSError, "injected scandir"),
            ):
                stager._scan_directory(self.root)

    def test_existing_release_reuse_retries_failed_publication_fsync(self) -> None:
        self.stage_a()
        releases = self.prefix / "releases"
        actual_fsync = stager._fsync_directory

        def fail_releases(path: Path) -> None:
            if path == releases:
                raise OSError("injected releases fsync failure")
            actual_fsync(path)

        with patch.object(stager, "_fsync_directory", side_effect=fail_releases):
            first_retry = self.stage_a()
        self.assertTrue(first_retry["reused"])
        self.assertIn("releases directory fsync failed", cast(str, first_retry["durabilityWarning"]))

        calls: list[Path] = []

        def record_fsync(path: Path) -> None:
            calls.append(path)
            actual_fsync(path)

        with patch.object(stager, "_fsync_directory", side_effect=record_fsync):
            second_retry = self.stage_a()
        self.assertTrue(second_retry["reused"])
        self.assertIsNone(second_retry["durabilityWarning"])
        self.assertIn(releases, calls)

    def test_failed_prefix_parent_fsync_is_retried_for_existing_directory(self) -> None:
        prefix = self.root / "new-parent" / "new-prefix"
        actual_fsync = stager._fsync_directory
        failed = False

        def fail_once(path: Path) -> None:
            nonlocal failed
            if path == self.root and not failed:
                failed = True
                raise OSError("injected prefix parent fsync failure")
            actual_fsync(path)

        with (
            patch.object(stager, "_fsync_directory", side_effect=fail_once),
            self.assertRaisesRegex(OSError, "prefix parent fsync failure"),
        ):
            stager.stage_candidate(str(self.archive_a), self.sha_a, "a" * 40, "v0.0.0", str(prefix))
        self.assertTrue((self.root / "new-parent").is_dir())

        calls: list[Path] = []

        def record_fsync(path: Path) -> None:
            calls.append(path)
            actual_fsync(path)

        with patch.object(stager, "_fsync_directory", side_effect=record_fsync):
            stager.stage_candidate(str(self.archive_a), self.sha_a, "a" * 40, "v0.0.0", str(prefix))
        self.assertIn(self.root, calls)

    def test_failed_releases_entry_fsync_is_retried_for_existing_directory(self) -> None:
        prefix = self.root / "releases-parent-prefix"
        actual_fsync = stager._fsync_directory

        def fail_releases_entry(path: Path) -> None:
            if path == prefix:
                raise OSError("injected releases-entry fsync failure")
            actual_fsync(path)

        with (
            patch.object(stager, "_fsync_directory", side_effect=fail_releases_entry),
            self.assertRaisesRegex(OSError, "releases-entry fsync failure"),
        ):
            stager.stage_candidate(str(self.archive_a), self.sha_a, "a" * 40, "v0.0.0", str(prefix))
        self.assertTrue((prefix / "releases").is_dir())

        calls: list[Path] = []

        def record_fsync(path: Path) -> None:
            calls.append(path)
            actual_fsync(path)

        with patch.object(stager, "_fsync_directory", side_effect=record_fsync):
            stager.stage_candidate(str(self.archive_a), self.sha_a, "a" * 40, "v0.0.0", str(prefix))
        self.assertIn(prefix, calls)

    def test_switch_refuses_unconfirmed_release_directory_durability_and_can_retry(self) -> None:
        self.stage_a()
        self.stage_b()
        self.seed_current(self.release_b)
        releases = self.prefix / "releases"
        actual_fsync = stager._fsync_directory

        def fail_releases(path: Path) -> None:
            if path == releases:
                raise OSError("injected target releases fsync failure")
            actual_fsync(path)

        with (
            patch.object(stager, "_fsync_directory", side_effect=fail_releases),
            self.assertRaisesRegex(CandidateError, "refusing current switch"),
        ):
            stager.rollback_release(
                str(self.prefix),
                self.release_a,
                self.sha_a,
                "a" * 40,
                "v0.0.0",
                self.sha_b,
                "b" * 40,
                "v0.0.0",
            )
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

        retry = stager.rollback_release(
            str(self.prefix),
            self.release_a,
            self.sha_a,
            "a" * 40,
            "v0.0.0",
            self.sha_b,
            "b" * 40,
            "v0.0.0",
        )
        self.assertEqual(retry["result"], "release-link-rolled-back-not-activated")
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_publication_warning_survives_later_switch_failure(self) -> None:
        self.stage_a()
        self.stage_b()
        archive_c = self.root / "candidate-c.tar.gz"
        sha_c, _files_c, release_c = make_candidate(archive_c, "c" * 40, "C", self.execution_sentinel)
        self.seed_current(self.release_a)
        actual_rename = stager._rename_noreplace
        releases = self.prefix / "releases"
        actual_fsync = stager._fsync_directory

        def publish_then_change_current(source: Path, destination: Path) -> None:
            actual_rename(source, destination)
            replacement = self.prefix / ".racing-current"
            os.symlink(f"releases/{self.release_b}", replacement)
            os.replace(replacement, self.prefix / "current")

        def fail_releases(path: Path) -> None:
            if path == releases:
                raise OSError("injected publication fsync failure")
            actual_fsync(path)

        with (
            patch.object(stager, "_rename_noreplace", side_effect=publish_then_change_current),
            patch.object(stager, "_fsync_directory", side_effect=fail_releases),
            self.assertRaises(CandidateError) as caught,
        ):
            stager.stage_candidate(
                str(archive_c),
                sha_c,
                "c" * 40,
                "v0.0.0",
                str(self.prefix),
                switch=True,
                current_trusted_sha256=self.sha_a,
                current_commit="a" * 40,
                current_tag="v0.0.0",
            )

        message = str(caught.exception)
        self.assertIn("remains staged", message)
        self.assertIn("current was not switched by this invocation", message)
        self.assertIn("release was published, but releases directory fsync failed", message)
        self.assertTrue((self.prefix / "releases" / release_c).is_dir())
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

    def test_stage_directory_walk_error_aborts_before_publication(self) -> None:
        actual_scandir = os.scandir
        failed = False

        def fail_staged_web_scan(path: str | os.PathLike[str] | int) -> Any:
            nonlocal failed
            if isinstance(path, (str, os.PathLike)):
                candidate_path = Path(path)
                if (
                    not failed
                    and candidate_path.name == "web"
                    and candidate_path.parent.name.startswith(".candidate-staging-")
                ):
                    failed = True
                    raise OSError("injected staged directory scan failure")
            return actual_scandir(path)

        with (
            patch.object(stager.os, "scandir", side_effect=fail_staged_web_scan),
            self.assertRaisesRegex(OSError, "staged directory scan failure"),
        ):
            self.stage_a()
        self.assertTrue(failed)
        self.assertFalse((self.prefix / "releases" / self.release_a).exists())
        self.assertEqual(
            [path for path in (self.prefix / "releases").iterdir() if path.name.startswith(".candidate-staging-")],
            [],
        )

    def test_entry_stat_error_during_staging_scan_aborts_before_publication(self) -> None:
        actual_scandir = os.scandir
        removed = False

        class RemoveWebBeforeStat:
            def __init__(self, path: str | os.PathLike[str], iterator: Any) -> None:
                self.path = Path(path)
                self.iterator = iterator

            def __enter__(self) -> RemoveWebBeforeStat:
                self.iterator.__enter__()
                return self

            def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> Any:
                return self.iterator.__exit__(exc_type, exc_value, traceback)

            def __iter__(self) -> Any:
                nonlocal removed
                for entry in self.iterator:
                    if (
                        not removed
                        and self.path.name.startswith(".candidate-staging-")
                        and entry.name == "web"
                    ):
                        removed = True
                        shutil.rmtree(entry.path)
                    yield entry

        def remove_web_before_stat(path: str | os.PathLike[str] | int) -> Any:
            if isinstance(path, (str, os.PathLike)) and Path(path).name.startswith(".candidate-staging-"):
                return RemoveWebBeforeStat(path, actual_scandir(path))
            return actual_scandir(path)

        with (
            patch.object(stager.os, "scandir", side_effect=remove_web_before_stat),
            self.assertRaisesRegex(OSError, "cannot inspect candidate entry 'web'"),
        ):
            self.stage_a()
        self.assertTrue(removed)
        self.assertFalse((self.prefix / "releases" / self.release_a).exists())
        self.assertEqual(
            [path for path in (self.prefix / "releases").iterdir() if path.name.startswith(".candidate-staging-")],
            [],
        )

    def test_release_verification_walk_fails_closed_when_entry_stat_fails(self) -> None:
        self.stage_a()
        release = self.prefix / "releases" / self.release_a
        actual_scandir = os.scandir
        removed = False

        class RemoveWebBeforeStat:
            def __init__(self, path: str | os.PathLike[str], iterator: Any) -> None:
                self.path = Path(path)
                self.iterator = iterator

            def __enter__(self) -> RemoveWebBeforeStat:
                self.iterator.__enter__()
                return self

            def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> Any:
                return self.iterator.__exit__(exc_type, exc_value, traceback)

            def __iter__(self) -> Any:
                nonlocal removed
                for entry in self.iterator:
                    if not removed and self.path == release and entry.name == "web":
                        removed = True
                        shutil.rmtree(entry.path)
                    yield entry

        def remove_web_before_stat(path: str | os.PathLike[str] | int) -> Any:
            if isinstance(path, (str, os.PathLike)) and Path(path) == release:
                return RemoveWebBeforeStat(path, actual_scandir(path))
            return actual_scandir(path)

        with (
            patch.object(stager.os, "scandir", side_effect=remove_web_before_stat),
            self.assertRaisesRegex(OSError, "cannot inspect candidate entry 'web'"),
        ):
            self.stage_a()
        self.assertTrue(removed)
        self.assertFalse((self.prefix / "current").exists())

    def test_release_verification_walk_fails_closed_on_reuse(self) -> None:
        self.stage_a()
        release_web = self.prefix / "releases" / self.release_a / "web"
        actual_scandir = os.scandir
        failed = False

        def fail_release_web_scan(path: str | os.PathLike[str] | int) -> Any:
            nonlocal failed
            if isinstance(path, (str, os.PathLike)) and not failed and Path(path) == release_web:
                failed = True
                raise OSError("injected release verification scan failure")
            return actual_scandir(path)

        with (
            patch.object(stager.os, "scandir", side_effect=fail_release_web_scan),
            self.assertRaisesRegex(OSError, "release verification scan failure"),
        ):
            self.stage_a()
        self.assertTrue(failed)
        self.assertTrue((self.prefix / "releases" / self.release_a).is_dir())
        self.assertFalse((self.prefix / "current").exists())

    def test_precommit_lock_close_error_keeps_current_unchanged(self) -> None:
        self.stage_a()
        self.seed_current(self.release_a)
        actual_current_target = stager._current_target
        current_checks = 0

        def fail_atomic_current_check(prefix: Path, identity: tuple[str, str, str]) -> str:
            nonlocal current_checks
            current_checks += 1
            if current_checks == 2:
                raise CandidateError("injected precommit current check failure")
            return actual_current_target(prefix, identity)

        caught = self.assertRaisesRegex(CandidateError, "current was not switched by this invocation")
        with (
            patch.object(stager, "_current_target", side_effect=fail_atomic_current_check),
            self.fail_switch_lock_close(),
            caught,
        ):
            self.stage_b(switch=True)
        self.assertIn("switch-lock close also failed", str(caught.exception))
        self.assertEqual(current_checks, 2)
        self.assertTrue((self.prefix / "releases" / self.release_b).is_dir())
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_switch_lock_close_error_after_commit_is_reported_as_warning(self) -> None:
        self.stage_a()
        self.seed_current(self.release_a)
        with self.fail_switch_lock_close():
            result = self.stage_b(switch=True)
        warning = cast(str, result["durabilityWarning"])
        self.assertTrue(result["switched"])
        self.assertIn("current was switched", warning)
        self.assertIn("switch-lock close failed", warning)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

    def test_rollback_lock_close_error_after_commit_is_reported_as_warning(self) -> None:
        self.stage_a()
        self.stage_b()
        self.seed_current(self.release_b)
        with self.fail_switch_lock_close():
            result = stager.rollback_release(
                str(self.prefix),
                self.release_a,
                self.sha_a,
                "a" * 40,
                "v0.0.0",
                self.sha_b,
                "b" * 40,
                "v0.0.0",
            )
        warning = cast(str, result["durabilityWarning"])
        self.assertIn("current was switched", warning)
        self.assertIn("switch-lock close failed", warning)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_cli_receipt_output_failure_reports_committed_switch_and_rollback(self) -> None:
        class BrokenStdout:
            def write(self, _text: str) -> int:
                raise OSError("injected stdout failure")

            def flush(self) -> None:
                return None

        self.stage_a()
        self.seed_current(self.release_a)
        stage_stderr = io.StringIO()
        with (
            patch.object(stager.sys, "stdout", BrokenStdout()),
            patch.object(stager.sys, "stderr", stage_stderr),
        ):
            stage_status = stager.main(
                [
                    "stage",
                    "--archive",
                    str(self.archive_b),
                    "--trusted-sha256",
                    self.sha_b,
                    "--commit",
                    "b" * 40,
                    "--tag",
                    "v0.0.0",
                    "--prefix",
                    str(self.prefix),
                    "--switch",
                    "--current-trusted-sha256",
                    self.sha_a,
                    "--current-commit",
                    "a" * 40,
                    "--current-tag",
                    "v0.0.0",
                ]
            )
        self.assertEqual(stage_status, 3)
        self.assertIn("RECEIPT_FAILED", stage_stderr.getvalue())
        self.assertIn("current was switched", stage_stderr.getvalue())
        self.assertIn(self.release_b, stage_stderr.getvalue())
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

        rollback_stderr = io.StringIO()
        with (
            patch.object(stager.sys, "stdout", BrokenStdout()),
            patch.object(stager.sys, "stderr", rollback_stderr),
        ):
            rollback_status = stager.main(
                [
                    "rollback",
                    "--prefix",
                    str(self.prefix),
                    "--release",
                    self.release_a,
                    "--trusted-sha256",
                    self.sha_a,
                    "--commit",
                    "a" * 40,
                    "--tag",
                    "v0.0.0",
                    "--current-trusted-sha256",
                    self.sha_b,
                    "--current-commit",
                    "b" * 40,
                    "--current-tag",
                    "v0.0.0",
                ]
            )
        self.assertEqual(rollback_status, 3)
        self.assertIn("RECEIPT_FAILED", rollback_stderr.getvalue())
        self.assertIn("rollback switched current", rollback_stderr.getvalue())
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_cli_stage_only_flush_failure_reports_staged_state(self) -> None:
        class FlushFailingStdout:
            def write(self, text: str) -> int:
                return len(text)

            def flush(self) -> None:
                raise OSError("injected stdout flush failure")

        self.stage_a()
        self.seed_current(self.release_a)
        stderr = io.StringIO()
        with (
            patch.object(stager.sys, "stdout", FlushFailingStdout()),
            patch.object(stager.sys, "stderr", stderr),
        ):
            status = stager.main(
                [
                    "stage",
                    "--archive",
                    str(self.archive_b),
                    "--trusted-sha256",
                    self.sha_b,
                    "--commit",
                    "b" * 40,
                    "--tag",
                    "v0.0.0",
                    "--prefix",
                    str(self.prefix),
                ]
            )
        self.assertEqual(status, 3)
        self.assertIn("RECEIPT_FAILED", stderr.getvalue())
        self.assertIn("candidate remains staged; current was not switched", stderr.getvalue())
        self.assertTrue((self.prefix / "releases" / self.release_b).is_dir())
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_cli_receipt_and_stderr_failures_still_return_receipt_error_status(self) -> None:
        class BrokenStream:
            def write(self, _text: str) -> int:
                raise OSError("injected stream write failure")

            def flush(self) -> None:
                raise OSError("injected stream flush failure")

        with (
            patch.object(stager.sys, "stdout", BrokenStream()),
            patch.object(stager.sys, "stderr", BrokenStream()),
        ):
            status = stager.main(
                [
                    "stage",
                    "--archive",
                    str(self.archive_a),
                    "--trusted-sha256",
                    self.sha_a,
                    "--commit",
                    "a" * 40,
                    "--tag",
                    "v0.0.0",
                    "--prefix",
                    str(self.prefix),
                ]
            )
        self.assertEqual(status, 3)
        self.assertTrue((self.prefix / "releases" / self.release_a).is_dir())
        self.assertFalse((self.prefix / "current").exists())

    def test_real_cli_argparse_output_failures_preserve_exit_two(self) -> None:
        dev_full = Path("/dev/full")
        if not dev_full.exists():
            self.skipTest("requires Linux /dev/full for broken argparse streams")
        script = str(Path(stager.__file__))
        with dev_full.open("wb") as error_output:
            missing_command = subprocess.run(
                [stager.sys.executable, script],
                stdout=subprocess.DEVNULL,
                stderr=error_output,
                check=False,
            )
        self.assertEqual(missing_command.returncode, 2)

        with dev_full.open("wb") as error_output:
            missing_arguments = subprocess.run(
                [stager.sys.executable, script, "stage"],
                stdout=subprocess.DEVNULL,
                stderr=error_output,
                check=False,
            )
        self.assertEqual(missing_arguments.returncode, 2)

        with dev_full.open("wb") as help_output:
            failed_help = subprocess.run(
                [stager.sys.executable, script, "--help"],
                stdout=help_output,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
        self.assertEqual(failed_help.returncode, 2)

    def test_real_cli_broken_stdout_exits_three_after_switch_and_rollback(self) -> None:
        dev_full = Path("/dev/full")
        if not dev_full.exists():
            self.skipTest("requires Linux /dev/full for real broken-pipe-equivalent stdout")

        self.stage_a()
        self.seed_current(self.release_a)

        def invoke(arguments: list[str]) -> subprocess.CompletedProcess[str]:
            with dev_full.open("wb") as output:
                return subprocess.run(
                    [stager.sys.executable, str(Path(stager.__file__)), *arguments],
                    stdout=output,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )

        staged = invoke(
            [
                "stage",
                "--archive",
                str(self.archive_b),
                "--trusted-sha256",
                self.sha_b,
                "--commit",
                "b" * 40,
                "--tag",
                "v0.0.0",
                "--prefix",
                str(self.prefix),
                "--switch",
                "--current-trusted-sha256",
                self.sha_a,
                "--current-commit",
                "a" * 40,
                "--current-tag",
                "v0.0.0",
            ]
        )
        self.assertEqual(staged.returncode, 3, staged.stderr)
        self.assertIn("RECEIPT_FAILED", staged.stderr)
        self.assertIn("current was switched", staged.stderr)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

        rolled_back = invoke(
            [
                "rollback",
                "--prefix",
                str(self.prefix),
                "--release",
                self.release_a,
                "--trusted-sha256",
                self.sha_a,
                "--commit",
                "a" * 40,
                "--tag",
                "v0.0.0",
                "--current-trusted-sha256",
                self.sha_b,
                "--current-commit",
                "b" * 40,
                "--current-tag",
                "v0.0.0",
            ]
        )
        self.assertEqual(rolled_back.returncode, 3, rolled_back.stderr)
        self.assertIn("RECEIPT_FAILED", rolled_back.stderr)
        self.assertIn("rollback switched current", rolled_back.stderr)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_real_cli_dual_broken_streams_keep_exit_three_after_switch_and_rollback(self) -> None:
        dev_full = Path("/dev/full")
        if not dev_full.exists():
            self.skipTest("requires Linux /dev/full for broken stdout/stderr")
        self.stage_a()
        self.seed_current(self.release_a)

        def invoke(arguments: list[str]) -> int:
            with dev_full.open("wb") as output:
                result = subprocess.run(
                    [stager.sys.executable, str(Path(stager.__file__)), *arguments],
                    stdout=output,
                    stderr=output,
                    check=False,
                )
            return result.returncode

        stage_status = invoke(
            [
                "stage",
                "--archive",
                str(self.archive_b),
                "--trusted-sha256",
                self.sha_b,
                "--commit",
                "b" * 40,
                "--tag",
                "v0.0.0",
                "--prefix",
                str(self.prefix),
                "--switch",
                "--current-trusted-sha256",
                self.sha_a,
                "--current-commit",
                "a" * 40,
                "--current-tag",
                "v0.0.0",
            ]
        )
        self.assertEqual(stage_status, 3)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

        rollback_status = invoke(
            [
                "rollback",
                "--prefix",
                str(self.prefix),
                "--release",
                self.release_a,
                "--trusted-sha256",
                self.sha_a,
                "--commit",
                "a" * 40,
                "--tag",
                "v0.0.0",
                "--current-trusted-sha256",
                self.sha_b,
                "--current-commit",
                "b" * 40,
                "--current-tag",
                "v0.0.0",
            ]
        )
        self.assertEqual(rollback_status, 3)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_a}")

    def test_real_cli_broken_stderr_preserves_blocked_exit_two(self) -> None:
        dev_full = Path("/dev/full")
        if not dev_full.exists():
            self.skipTest("requires Linux /dev/full for broken stderr")
        with dev_full.open("wb") as error_output:
            result = subprocess.run(
                [
                    stager.sys.executable,
                    str(Path(stager.__file__)),
                    "stage",
                    "--archive",
                    str(self.archive_a),
                    "--trusted-sha256",
                    self.sha_a,
                    "--commit",
                    "a" * 40,
                    "--tag",
                    "v0.0.0",
                    "--prefix",
                    "relative-prefix",
                ],
                stdout=subprocess.DEVNULL,
                stderr=error_output,
                check=False,
            )
        self.assertEqual(result.returncode, 2)
        self.assertFalse((self.prefix / "releases" / self.release_a).exists())
        self.assertFalse((self.prefix / "current").exists())

    def test_actual_payload_copy_failure_removes_partial_file(self) -> None:
        class BrokenReader(io.BytesIO):
            def __init__(self) -> None:
                super().__init__(b"partial bytes then failure")
                self.first_read = True

            def read(self, size: int | None = -1) -> bytes:
                if not self.first_read:
                    raise OSError("injected tar stream failure")
                self.first_read = False
                return super().read(7)

        class BrokenArchive:
            def extractfile(self, _member: tarfile.TarInfo) -> BrokenReader:
                return BrokenReader()

        root = self.root / "partial-copy-root"
        root.mkdir(mode=0o700)
        member = tarfile.TarInfo("worker/dist/node/main.mjs")
        member.size = 24
        with self.assertRaisesRegex(OSError, "injected tar stream failure"):
            stager._copy_member(root, cast(Any, BrokenArchive()), member, "0" * 64)
        self.assertFalse((root / "worker/dist/node/main.mjs").exists())

    def test_switch_rejects_a_stale_current_changed_during_staging(self) -> None:
        self.stage_a()
        self.stage_b()
        archive_c = self.root / "candidate-c.tar.gz"
        sha_c, _files_c, release_c = make_candidate(archive_c, "c" * 40, "C", self.execution_sentinel)
        self.seed_current(self.release_a)
        real_rename = stager._rename_noreplace

        def publish_then_switch_cooperatively(source: Path, destination: Path) -> None:
            real_rename(source, destination)
            replacement = self.prefix / ".racing-current"
            os.symlink(f"releases/{self.release_b}", replacement)
            os.replace(replacement, self.prefix / "current")

        with (
            patch.object(stager, "_rename_noreplace", side_effect=publish_then_switch_cooperatively),
            self.assertRaises(CandidateError),
        ):
            stager.stage_candidate(
                str(archive_c),
                sha_c,
                "c" * 40,
                "v0.0.0",
                str(self.prefix),
                switch=True,
                current_trusted_sha256=self.sha_a,
                current_commit="a" * 40,
                current_tag="v0.0.0",
            )
        self.assertTrue((self.prefix / "releases" / release_c).is_dir())
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

    def test_prefix_symlink_component_is_rejected(self) -> None:
        link = self.root / "prefix-link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(CandidateError, "symlink"):
            stager.stage_candidate(
                str(self.archive_a), self.sha_a, "a" * 40, "v0.0.0", str(link / "prefix")
            )
        self.assertFalse((self.root / "prefix").exists())

    def test_fsync_failure_after_atomic_switch_reports_committed_state(self) -> None:
        self.stage_a()
        self.seed_current(self.release_a)
        actual_fsync = stager._fsync_directory
        prefix_fsyncs = 0

        def fail_post_switch_prefix_fsync(path: Path) -> None:
            nonlocal prefix_fsyncs
            if path == self.prefix:
                prefix_fsyncs += 1
                if prefix_fsyncs == 2:
                    raise OSError("injected directory fsync failure")
            actual_fsync(path)

        with patch.object(stager, "_fsync_directory", side_effect=fail_post_switch_prefix_fsync):
            result = self.stage_b(switch=True)
        self.assertTrue(result["switched"])
        self.assertIsInstance(result["durabilityWarning"], str)
        durability_warning = cast(str, result["durabilityWarning"])
        self.assertIn("current was switched", durability_warning)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

    def test_switch_retries_publication_fsync_before_committing_link(self) -> None:
        self.stage_a()
        self.seed_current(self.release_a)
        real_fsync = stager._fsync_directory
        releases_fsyncs = 0
        prefix_fsyncs = 0
        releases = self.prefix / "releases"

        def fail_first_publication_and_post_switch_prefix(path: Path) -> None:
            nonlocal releases_fsyncs, prefix_fsyncs
            if path == releases:
                releases_fsyncs += 1
                if releases_fsyncs == 1:
                    raise OSError("injected publication fsync failure")
            if path == self.prefix:
                prefix_fsyncs += 1
                if prefix_fsyncs == 2:
                    raise OSError("injected post-switch prefix fsync failure")
            real_fsync(path)

        with patch.object(stager, "_fsync_directory", side_effect=fail_first_publication_and_post_switch_prefix):
            result = self.stage_b(switch=True)
        warning = cast(str, result["durabilityWarning"])
        self.assertTrue(result["switched"])
        self.assertGreaterEqual(releases_fsyncs, 2)
        self.assertIn("current was switched", warning)
        self.assertNotIn("release was published", warning)
        self.assertEqual(os.readlink(self.prefix / "current"), f"releases/{self.release_b}")

    def test_staging_uses_the_verified_snapshot_if_original_path_changes(self) -> None:
        original_snapshot = stager.verified_candidate_snapshot

        @contextmanager
        def replace_after_verify(
            archive_path: str,
            trusted_sha256: str,
            expected_commit: str,
            expected_tag: str,
        ) -> Iterator[tuple[str, dict[str, Any]]]:
            with original_snapshot(archive_path, trusted_sha256, expected_commit, expected_tag) as (snapshot, receipt):
                self.archive_a.write_bytes(self.archive_b.read_bytes())
                yield snapshot, receipt

        with patch.object(stager, "verified_candidate_snapshot", side_effect=replace_after_verify):
            result = self.stage_a()
        self.assertEqual(result["archiveSha256"], self.sha_a)
        release = self.prefix / "releases" / self.release_a
        for relative, expected in self.files_a.items():
            self.assertEqual((release / relative).read_bytes(), expected, relative)
        self.assertEqual(digest(self.archive_a.read_bytes()), self.sha_b)


if __name__ == "__main__":
    unittest.main()

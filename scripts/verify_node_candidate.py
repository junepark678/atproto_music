#!/usr/bin/env python3
"""Statically verify a Node candidate archive against a trusted SHA-256.

This verifier does not extract or execute the artifact, install units, read
credentials, access production state, or establish release authenticity. The
expected digest must come from an independently trusted source (for example,
reviewed workflow provenance), not only from the archive's sibling checksum.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import stat
import sys
import tarfile
import tempfile
import zlib
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import PurePosixPath
from typing import Any, cast

MAX_ARCHIVE_BYTES = 1_000_000_000
MAX_DECOMPRESSED_TAR_BYTES = 1_100_000_000
MAX_EXPANDED_BYTES = 1_000_000_000
MAX_MEMBER_BYTES = 512_000_000
MAX_MEMBERS = 20_000
MAX_TAR_HEADERS = MAX_MEMBERS * 2 + 100
MAX_PATH_LENGTH = 1024
MAX_MANIFEST_BYTES = 2_000_000
MAX_PAX_METADATA_BYTES = 1_000_000
MAX_TAR_READ_BYTES = 1_048_576
REQUIRED_NODE_FILES = {
    "worker/dist/node/main.mjs",
    "worker/dist/node/main.mjs.map",
    "worker/dist/node/main.meta.json",
    "worker/dist/node/main.inputs.json",
}
REQUIRED_FILES = {*REQUIRED_NODE_FILES, "web/dist/index.html"}
HEX256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


class CandidateError(ValueError):
    """The candidate does not satisfy the verifier's static safety contract."""


class BoundedReader:
    """Reject oversized tar-internal reads before tarfile allocates them."""

    def __init__(self, source: Any) -> None:
        self.source = source

    def read(self, size: int = -1) -> bytes:
        if size < 0 or size > MAX_TAR_READ_BYTES:
            raise CandidateError("tar metadata/read exceeds the configured single-read limit")
        return self.source.read(size)

    def readable(self) -> bool:
        return True

    def close(self) -> None:
        self.source.close()


@contextmanager
def _open_binary(path: str, mode: str) -> Iterator[Any]:
    try:
        with open(path, mode) as stream:
            yield stream
    except OSError as error:
        raise CandidateError(f"cannot open candidate data: {error}") from error


def _preflight_tar_headers(path: str) -> None:
    """Bound decompressed tar size, header count and extension records pre-parse."""
    with _open_binary(path, "rb") as archive:
        total_size = os.fstat(archive.fileno()).st_size
        if total_size <= 0 or total_size > MAX_DECOMPRESSED_TAR_BYTES or total_size % 512 != 0:
            raise CandidateError("decompressed tar size is invalid or exceeds the configured limit")
        offset = 0
        header_count = 0
        while offset + 512 <= total_size:
            header = archive.read(512)
            if len(header) != 512:
                raise CandidateError("truncated tar header")
            offset += 512
            if header == bytes(512):
                while chunk := archive.read(1024 * 1024):
                    if any(chunk):
                        raise CandidateError("nonzero data follows the tar end marker")
                return
            header_count += 1
            if header_count > MAX_TAR_HEADERS:
                raise CandidateError("tar header count exceeds the configured limit")
            size_field = header[124:136]
            if not size_field or size_field[0] & 0x80:
                raise CandidateError("base-256 tar sizes are unsupported")
            size_text = size_field.strip(b"\0 ")
            if size_text and any(byte not in b"01234567" for byte in size_text):
                raise CandidateError("invalid tar size field")
            member_size = int(size_text or b"0", 8)
            typeflag = header[156:157]
            if typeflag in (b"x", b"g", b"L", b"K") and member_size > MAX_PAX_METADATA_BYTES:
                raise CandidateError("tar extension metadata exceeds the configured limit")
            if member_size > MAX_MEMBER_BYTES:
                raise CandidateError("tar member exceeds the configured size limit")
            padded = ((member_size + 511) // 512) * 512
            archive.seek(padded, os.SEEK_CUR)
            offset += padded
            if offset > total_size:
                raise CandidateError("tar member extends beyond the decompressed archive")
        raise CandidateError("tar end marker is missing")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise CandidateError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _safe_relative_path(name: str) -> str:
    if not name or len(name) > MAX_PATH_LENGTH or "\\" in name or name.startswith("/"):
        raise CandidateError(f"unsafe archive path: {name!r}")
    if name in (".", "./"):
        return "."
    # The packager emits one optional leading ./ and a trailing slash for
    # directories. Reject aliases instead of relying on path normalization.
    if name.startswith("./"):
        name = name[2:]
    if name.startswith(("./", "/")):
        raise CandidateError(f"unsafe archive path: {name!r}")
    if name.endswith("/"):
        name = name[:-1]
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise CandidateError(f"unsafe archive path: {name!r}")
    return "/".join(parts)


def _digest_member(archive: tarfile.TarFile, member: tarfile.TarInfo) -> str:
    stream = archive.extractfile(member)
    if stream is None:
        raise CandidateError(f"cannot read regular file: {member.name}")
    digest = hashlib.sha256()
    size = 0
    with stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > member.size:
                raise CandidateError(f"member exceeds declared size: {member.name}")
            digest.update(chunk)
    if size != member.size:
        raise CandidateError(f"member size differs from tar header: {member.name}")
    return digest.hexdigest()


def _validate_manifest(raw: bytes, expected_commit: str, expected_tag: str) -> tuple[dict[str, Any], str]:
    if len(raw) > MAX_MANIFEST_BYTES:
        raise CandidateError("candidate.json exceeds the size limit")
    try:
        manifest = json.loads(raw, object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CandidateError(f"invalid candidate.json: {error}") from error
    if not isinstance(manifest, dict):
        raise CandidateError("candidate.json must be an object")
    if (
        type(manifest.get("schemaVersion")) is not int
        or manifest.get("schemaVersion") != 1
        or manifest.get("kind") != "node-candidate-not-accepted"
    ):
        raise CandidateError("unsupported candidate manifest schema or kind")
    version = manifest.get("version")
    tag = manifest.get("tag")
    commit = manifest.get("commit")
    if not isinstance(version, str) or VERSION.fullmatch(version) is None or tag != f"v{version}":
        raise CandidateError("candidate tag/version mismatch or invalid version")
    if not isinstance(commit, str) or COMMIT.fullmatch(commit) is None:
        raise CandidateError("candidate commit must be a full lowercase Git SHA")
    if tag != expected_tag or commit != expected_commit:
        raise CandidateError("candidate identity differs from the expected tag/commit")
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        raise CandidateError("candidate runtime metadata is missing")
    for key in ("node", "sqlite", "required"):
        if not isinstance(runtime.get(key), str) or not runtime[key]:
            raise CandidateError(f"candidate runtime.{key} is missing")
    if not re.fullmatch(r"v?\d+\.\d+\.\d+", runtime["node"]):
        raise CandidateError("candidate runtime.node is malformed")
    if not re.fullmatch(r"\d+\.\d+\.\d+", runtime["sqlite"]):
        raise CandidateError("candidate runtime.sqlite is malformed")
    if not re.fullmatch(r"\d+\.\d+\.\d+", runtime["required"]):
        raise CandidateError("candidate runtime.required is malformed")
    if runtime["node"].removeprefix("v") != runtime["required"]:
        raise CandidateError("candidate build Node does not match its pinned requirement")
    package_lock = manifest.get("packageLockSha256")
    if not isinstance(package_lock, str) or HEX256.fullmatch(package_lock) is None:
        raise CandidateError("candidate packageLockSha256 is malformed")
    bundle = manifest.get("bundleSha256")
    files = manifest.get("files")
    if not isinstance(bundle, str) or HEX256.fullmatch(bundle) is None:
        raise CandidateError("candidate bundleSha256 is malformed")
    if not isinstance(files, dict) or not files:
        raise CandidateError("candidate files inventory is missing")
    for path, digest in files.items():
        try:
            normalized_path = _safe_relative_path(path) if isinstance(path, str) else None
        except CandidateError as error:
            raise CandidateError(f"unsafe candidate manifest path: {path!r}") from error
        if not isinstance(path, str) or normalized_path != path:
            raise CandidateError(f"unsafe candidate manifest path: {path!r}")
        if not isinstance(digest, str) or HEX256.fullmatch(digest) is None:
            raise CandidateError(f"invalid SHA-256 for candidate file: {path}")
    if not REQUIRED_FILES.issubset(files):
        raise CandidateError("candidate is missing required bundle or asset files")
    if files.get("worker/dist/node/main.mjs") != bundle:
        raise CandidateError("bundleSha256 differs from the main.mjs inventory entry")
    not_accepted = manifest.get("notAccepted")
    if not isinstance(not_accepted, list) or not not_accepted or not all(isinstance(item, str) for item in not_accepted):
        raise CandidateError("candidate notAccepted limitations are missing")
    return manifest, hashlib.sha256(raw).hexdigest()


def _consume_member(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    *,
    capture: bool = False,
) -> tuple[str, bytes | None]:
    stream = archive.extractfile(member)
    if stream is None:
        raise CandidateError(f"cannot read regular file: {member.name}")
    digest = hashlib.sha256()
    content = bytearray() if capture else None
    size = 0
    with stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > member.size:
                raise CandidateError(f"member exceeds declared size: {member.name}")
            if content is not None:
                if size > MAX_MANIFEST_BYTES:
                    raise CandidateError("candidate.json exceeds the size limit")
                content.extend(chunk)
            digest.update(chunk)
    if size != member.size:
        raise CandidateError(f"member size differs from tar header: {member.name}")
    return digest.hexdigest(), bytes(content) if content is not None else None


def _verify_snapshot(
    snapshot: str,
    archive_sha: str,
    expected_commit: str,
    expected_tag: str,
) -> dict[str, Any]:
    if sys.version_info < (3, 13):
        raise CandidateError("streaming archive verification requires Python 3.13 or newer")
    with tempfile.TemporaryDirectory(prefix="atmusic-candidate-tar-") as scratch:
        tar_path = os.path.join(scratch, "candidate.tar")
        decompressed_size = 0
        try:
            with gzip.open(snapshot, "rb") as compressed, open(tar_path, "xb") as expanded:
                while chunk := compressed.read(1024 * 1024):
                    decompressed_size += len(chunk)
                    if decompressed_size > MAX_DECOMPRESSED_TAR_BYTES:
                        raise CandidateError("decompressed tar exceeds the configured size limit")
                    expanded.write(chunk)
        except (OSError, EOFError, zlib.error) as error:
            raise CandidateError(f"cannot decompress candidate tar.gz: {error}") from error
        _preflight_tar_headers(tar_path)

        with _open_binary(tar_path, "rb") as raw_tar:
            bounded_tar = BoundedReader(raw_tar)
            tar_open = cast(Any, tarfile.open)
            try:
                archive_handle = tar_open(fileobj=bounded_tar, mode="r|", stream=True)
            except (tarfile.TarError, OSError) as error:
                raise CandidateError(f"invalid tar stream: {error}") from error
            with closing(archive_handle) as archive:
                seen_paths: set[str] = set()
                file_hashes: dict[str, str] = {}
                directories: set[str] = set()
                root_entries = 0
                member_count = 0
                expanded_size = 0
                manifest: dict[str, Any] | None = None
                manifest_sha: str | None = None
                while (member := archive.next()) is not None:
                    member_count += 1
                    if member_count > MAX_MEMBERS:
                        raise CandidateError("archive member count exceeds the configured limit")
                    path = _safe_relative_path(member.name)
                    if path == ".":
                        root_entries += 1
                        if root_entries > 1 or not member.isdir() or member.size != 0:
                            raise CandidateError("archive must contain exactly one empty root directory")
                        continue
                    if path in seen_paths:
                        raise CandidateError(f"duplicate normalized archive member: {path}")
                    seen_paths.add(path)
                    if member.pax_headers.get("linkpath") or any(
                        key.startswith("GNU.sparse") for key in member.pax_headers
                    ) or getattr(member, "sparse", None) is not None:
                        raise CandidateError(f"unsupported PAX link/sparse metadata: {path}")
                    if member.isdir():
                        if member.size != 0:
                            raise CandidateError(f"directory has unexpected data: {path}")
                        directories.add(path)
                        continue
                    if not member.isreg() or member.size < 0 or member.size > MAX_MEMBER_BYTES:
                        raise CandidateError(f"only bounded regular files are permitted: {path}")
                    expanded_size += member.size
                    if expanded_size > MAX_EXPANDED_BYTES:
                        raise CandidateError("expanded archive exceeds the configured size limit")
                    if path == "candidate.json":
                        if manifest is not None or member.size > MAX_MANIFEST_BYTES:
                            raise CandidateError("candidate.json is duplicated or exceeds the size limit")
                        _, raw_manifest = _consume_member(archive, member, capture=True)
                        if raw_manifest is None:
                            raise CandidateError("candidate.json cannot be read")
                        manifest, manifest_sha = _validate_manifest(raw_manifest, expected_commit, expected_tag)
                        continue
                    if manifest is None:
                        raise CandidateError("candidate.json must precede all payload files")
                    path_allowed = path.startswith(("worker/dist/node/", "web/dist/"))
                    if not path_allowed:
                        raise CandidateError(f"candidate payload contains an unexpected path: {path}")
                    inventory = manifest["files"]
                    if path not in inventory:
                        raise CandidateError(f"candidate payload is absent from manifest inventory: {path}")
                    digest, _ = _consume_member(archive, member)
                    if digest != inventory[path]:
                        raise CandidateError(f"candidate payload hash mismatch: {path}")
                    file_hashes[path] = digest

                if root_entries != 1:
                    raise CandidateError("archive root entry is missing")
                if manifest is None or manifest_sha is None:
                    raise CandidateError("candidate.json is missing")
                inventory = manifest["files"]
                payload_paths = set(file_hashes)
                if payload_paths != set(inventory):
                    raise CandidateError("archive payload does not exactly match candidate.json files inventory")
                if {path for path in payload_paths if path.startswith("worker/dist/node/")} != REQUIRED_NODE_FILES:
                    raise CandidateError("candidate Node bundle contains a missing or unexpected file")
                expected_directories: set[str] = set()
                for path in payload_paths:
                    parts = PurePosixPath(path).parts[:-1]
                    for index in range(1, len(parts) + 1):
                        expected_directories.add("/".join(parts[:index]))
                if directories != expected_directories:
                    raise CandidateError("archive directory entries do not match the payload layout")
                for path in payload_paths:
                    parent = PurePosixPath(path).parent
                    while parent.as_posix() != ".":
                        if parent.as_posix() in payload_paths:
                            raise CandidateError(f"archive file/directory conflict: {parent.as_posix()}")
                        parent = parent.parent
                return {
                    "schemaVersion": 1,
                    "result": "verified-static-candidate-not-accepted",
                    "archiveSha256": archive_sha,
                    "manifestSha256": manifest_sha,
                    "commit": manifest["commit"],
                    "tag": manifest["tag"],
                    "version": manifest["version"],
                    "bundleSha256": manifest["bundleSha256"],
                    "fileCount": len(payload_paths),
                    "notAccepted": manifest["notAccepted"],
                    "checks": [
                        "trusted archive digest",
                        "bounded streaming tar and PAX inspection",
                        "safe archive paths and regular-file-only payload",
                        "manifest identity and exact payload inventory",
                        "per-file SHA-256 and bundle identity",
                    ],
                    "limitations": [
                        "checksum integrity is not trusted workflow provenance",
                        "artifact was not extracted or executed",
                        "installation, migration, rollback, hosted CI and live acceptance are not verified",
                    ],
                }


@contextmanager
def verified_candidate_snapshot(
    archive_path: str,
    trusted_sha256: str,
    expected_commit: str,
    expected_tag: str,
) -> Iterator[tuple[str, dict[str, Any]]]:
    """Keep one fully verified private archive snapshot alive for a caller.

    The default verifier API below returns only its receipt. Staging code may
    consume this context manager's same private snapshot, never reopen the
    caller-controlled original archive after verification.
    """
    if HEX256.fullmatch(trusted_sha256) is None:
        raise CandidateError("trusted SHA-256 must be 64 lowercase hexadecimal characters")
    if COMMIT.fullmatch(expected_commit) is None:
        raise CandidateError("expected commit must be a full lowercase Git SHA")
    try:
        source_fd = os.open(
            archive_path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
        )
    except OSError as error:
        raise CandidateError(f"cannot open candidate archive safely: {error}") from error
    with os.fdopen(source_fd, "rb") as source:
        source_stat = os.fstat(source.fileno())
        if not stat.S_ISREG(source_stat.st_mode):
            raise CandidateError("archive must be a regular non-symlink file")
        if source_stat.st_size <= 0 or source_stat.st_size > MAX_ARCHIVE_BYTES:
            raise CandidateError("archive size is empty or exceeds the configured limit")

        with tempfile.TemporaryDirectory(prefix="atmusic-candidate-verify-") as scratch:
            snapshot = os.path.join(scratch, "candidate.tar.gz")
            digest = hashlib.sha256()
            copied = 0
            target_fd = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(target_fd, "wb") as target:
                while chunk := source.read(1024 * 1024):
                    copied += len(chunk)
                    if copied > MAX_ARCHIVE_BYTES:
                        raise CandidateError("archive grew beyond the configured size limit")
                    digest.update(chunk)
                    target.write(chunk)
            archive_sha = digest.hexdigest()
            if archive_sha != trusted_sha256:
                raise CandidateError("archive SHA-256 differs from the independently trusted digest")
            receipt = _verify_snapshot(snapshot, archive_sha, expected_commit, expected_tag)
            yield snapshot, receipt


def verify_candidate(
    archive_path: str,
    trusted_sha256: str,
    expected_commit: str,
    expected_tag: str,
) -> dict[str, Any]:
    """Verify one private snapshot of the archive without extracting/executing it."""
    with verified_candidate_snapshot(archive_path, trusted_sha256, expected_commit, expected_tag) as (_, receipt):
        return receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, help="candidate .tar.gz path")
    parser.add_argument("--trusted-sha256", required=True, help="independently trusted archive SHA-256")
    parser.add_argument("--commit", required=True, help="expected full source Git SHA")
    parser.add_argument("--tag", required=True, help="expected vX.Y.Z tag")
    args = parser.parse_args(argv)
    try:
        result = verify_candidate(args.archive, args.trusted_sha256, args.commit, args.tag)
        sys.stdout.write(json.dumps(result, indent=2, sort_keys=True) + "\n")
        return 0
    except (CandidateError, OSError, tarfile.TarError) as error:
        print(f"verify_node_candidate: BLOCKED: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

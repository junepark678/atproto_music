#!/usr/bin/env python3
"""Verify and stage exact Node candidate bytes without activating a service.

This offline helper requires an independently trusted archive digest and full
source identity. It never executes the candidate, installs units, initializes a
database, reads credentials, invokes systemd, or accesses production state. It
retains each verified archive with its release. The optional --switch changes
only the local current symlink and requires caller-supplied trusted identity for
both releases. Use only an owner-controlled mode-0700 prefix with no untrusted
concurrent writers; this does not install or activate a production service.
"""
from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
import zlib
from collections.abc import Iterable, Iterator
from contextlib import suppress
from pathlib import Path, PurePosixPath
from typing import Any, cast

import verify_node_candidate as verifier

BoundedReader = verifier.BoundedReader
CandidateError = verifier.CandidateError
COMMIT = verifier.COMMIT
HEX256 = verifier.HEX256
MAX_MANIFEST_BYTES = verifier.MAX_MANIFEST_BYTES
MAX_MEMBER_BYTES = verifier.MAX_MEMBER_BYTES
_safe_relative_path = verifier._safe_relative_path
_unique_object = verifier._unique_object
_validate_manifest = verifier._validate_manifest
verified_candidate_snapshot = verifier.verified_candidate_snapshot
verify_candidate = verifier.verify_candidate

RELEASE_ID = re.compile(r"^[0-9a-f]{40}-[0-9a-f]{16}$")
MARKER = ".node-candidate-release.json"


def _sha256(root: Path, relative_path: str) -> str:
    digest = hashlib.sha256()
    try:
        fd = _open_relative(
            root,
            relative_path,
            os.O_RDONLY | getattr(os, "O_NONBLOCK", 0),
        )
    except OSError as error:
        raise CandidateError(f"cannot safely open release file {relative_path}: {error}") from error
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise CandidateError(f"release file is not regular: {relative_path}")
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _read_regular(root: Path, relative_path: str, max_bytes: int) -> bytes:
    try:
        fd = _open_relative(
            root,
            relative_path,
            os.O_RDONLY | getattr(os, "O_NONBLOCK", 0),
        )
    except OSError as error:
        raise CandidateError(f"cannot safely open release metadata {relative_path}: {error}") from error
    with os.fdopen(fd, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise CandidateError(f"release metadata is not a regular file: {relative_path}")
        content = source.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise CandidateError(f"release metadata exceeds its size limit: {relative_path}")
    return content


def _copy_verified_archive(snapshot: str, root: Path, relative_path: str, expected_sha: str) -> None:
    digest = hashlib.sha256()
    source_fd: int | None = None
    destination_fd: int | None = None
    try:
        source_fd = os.open(
            snapshot,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
        )
        if not stat.S_ISREG(os.fstat(source_fd).st_mode):
            raise CandidateError("verified archive snapshot is not a regular file")
        destination_fd = _open_relative(
            root,
            relative_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            mode=0o600,
            create_parents=True,
        )
    except BaseException:
        if source_fd is not None:
            os.close(source_fd)
        if destination_fd is not None:
            os.close(destination_fd)
        raise
    try:
        with os.fdopen(source_fd, "rb") as source, os.fdopen(destination_fd, "wb") as target:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
    except BaseException:
        with suppress(OSError):
            _unlink_relative(root, relative_path)
        raise
    if digest.hexdigest() != expected_sha:
        _unlink_relative(root, relative_path)
        raise CandidateError("verified archive snapshot changed during retention")


def _expected_directories(paths: Iterable[str]) -> set[str]:
    result: set[str] = set()
    for path in paths:
        parts = PurePosixPath(path).parts[:-1]
        for index in range(1, len(parts) + 1):
            result.add("/".join(parts[:index]))
    return result


def _open_directory(root: Path, relative_path: str, *, create: bool) -> int:
    normalized = _safe_relative_path(relative_path)
    root_fd = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))
    current_fd = root_fd
    try:
        parts = () if normalized == "." else PurePosixPath(normalized).parts
        for component in parts:
            try:
                child_fd = os.open(
                    component,
                    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=current_fd,
                )
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, mode=0o755, dir_fd=current_fd)
                child_fd = os.open(
                    component,
                    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=current_fd,
                )
            if not stat.S_ISDIR(os.fstat(child_fd).st_mode):
                os.close(child_fd)
                raise CandidateError(f"staging parent is not a real directory: {component}")
            if current_fd != root_fd:
                os.close(current_fd)
            current_fd = child_fd
        return os.dup(current_fd)
    finally:
        if current_fd != root_fd:
            os.close(current_fd)
        os.close(root_fd)


def _open_relative(
    root: Path,
    relative_path: str,
    flags: int,
    *,
    mode: int = 0o644,
    create_parents: bool = False,
) -> int:
    normalized = _safe_relative_path(relative_path)
    if normalized == ".":
        raise CandidateError("a regular file path is required")
    pure_path = PurePosixPath(normalized)
    parts = pure_path.parts
    leaf = pure_path.name
    if leaf in {"", ".", ".."}:
        raise CandidateError("a regular file path is required")
    parent = "/".join(parts[:-1]) if len(parts) > 1 else "."
    parent_fd = _open_directory(root, parent, create=create_parents)
    try:
        return os.open(leaf, flags | getattr(os, "O_NOFOLLOW", 0), mode, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)


def _unlink_relative(root: Path, relative_path: str) -> None:
    normalized = _safe_relative_path(relative_path)
    if normalized == ".":
        raise CandidateError("a regular file path is required")
    pure_path = PurePosixPath(normalized)
    parts = pure_path.parts
    leaf = pure_path.name
    if leaf in {"", ".", ".."}:
        raise CandidateError("a regular file path is required")
    parent = "/".join(parts[:-1]) if len(parts) > 1 else "."
    parent_fd = _open_directory(root, parent, create=False)
    try:
        os.unlink(leaf, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)


def _mkdir_parents(root: Path, relative_path: str) -> None:
    normalized = _safe_relative_path(relative_path)
    parts = PurePosixPath(normalized).parts[:-1]
    parent = "/".join(parts) if parts else "."
    fd = _open_directory(root, parent, create=True)
    os.close(fd)


def _write_regular(root: Path, relative_path: str, content: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = _open_relative(root, relative_path, flags, create_parents=True)
    except OSError as error:
        raise CandidateError(f"cannot create staged file {relative_path}: {error}") from error
    with os.fdopen(fd, "wb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def _copy_member(root: Path, archive: tarfile.TarFile, member: tarfile.TarInfo, expected_sha: str) -> str:
    stream = archive.extractfile(member)
    if stream is None:
        raise CandidateError(f"cannot read candidate member: {member.name}")
    relative_path = _safe_relative_path(member.name)
    if relative_path == "." or not member.isreg() or member.size < 0 or member.size > MAX_MEMBER_BYTES:
        raise CandidateError(f"only bounded regular payload files may be staged: {relative_path}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        fd = _open_relative(root, relative_path, flags, create_parents=True)
    except OSError as error:
        raise CandidateError(f"cannot create staged file {relative_path}: {error}") from error

    digest = hashlib.sha256()
    size = 0
    try:
        with stream, os.fdopen(fd, "wb") as output:
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > member.size:
                    raise CandidateError(f"staged member exceeds its declared size: {relative_path}")
                digest.update(chunk)
                output.write(chunk)
            if size != member.size:
                raise CandidateError(f"staged member size differs from its tar header: {relative_path}")
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        with suppress(OSError):
            _unlink_relative(root, relative_path)
        raise
    actual_sha = digest.hexdigest()
    if actual_sha != expected_sha:
        _unlink_relative(root, relative_path)
        raise CandidateError(f"staged payload hash mismatch: {relative_path}")
    return actual_sha


def _extract_verified_snapshot(snapshot: str, destination: Path, receipt: dict[str, Any]) -> dict[str, Any]:
    if sys.version_info < (3, 13):
        raise CandidateError("streaming candidate staging requires Python 3.13 or newer")
    expected_commit = cast(str, receipt["commit"])
    expected_tag = cast(str, receipt["tag"])
    seen: set[str] = set()
    written: dict[str, str] = {}
    directories: set[str] = set()
    manifest: dict[str, Any] | None = None
    manifest_digest: str | None = None

    try:
        with gzip.open(snapshot, "rb") as compressed:
            tar_open = cast(Any, tarfile.open)
            with tar_open(fileobj=BoundedReader(compressed), mode="r|", stream=True) as archive:
                while (member := archive.next()) is not None:
                    relative_path = _safe_relative_path(member.name)
                    if relative_path == ".":
                        if not member.isdir() or member.size != 0:
                            raise CandidateError("candidate root entry is not an empty directory")
                        continue
                    if relative_path in seen:
                        raise CandidateError(f"duplicate staged member: {relative_path}")
                    seen.add(relative_path)
                    if member.pax_headers.get("linkpath") or any(
                        key.startswith("GNU.sparse") for key in member.pax_headers
                    ) or getattr(member, "sparse", None) is not None:
                        raise CandidateError(f"unsupported PAX link/sparse metadata: {relative_path}")
                    if member.isdir():
                        if member.size != 0:
                            raise CandidateError(f"directory contains unexpected data: {relative_path}")
                        directories.add(relative_path)
                        directory_fd = _open_directory(destination, relative_path, create=True)
                        os.close(directory_fd)
                        continue
                    if not member.isreg():
                        raise CandidateError(f"special archive member refused: {relative_path}")
                    if relative_path == "candidate.json":
                        if manifest is not None or member.size > MAX_MANIFEST_BYTES:
                            raise CandidateError("candidate.json is duplicated or exceeds the size limit")
                        stream = archive.extractfile(member)
                        if stream is None:
                            raise CandidateError("candidate.json cannot be read")
                        raw_buffer = bytearray()
                        with stream:
                            while chunk := stream.read(64 * 1024):
                                raw_buffer.extend(chunk)
                                if len(raw_buffer) > MAX_MANIFEST_BYTES:
                                    raise CandidateError("candidate.json exceeds the size limit")
                        raw = bytes(raw_buffer)
                        if len(raw) != member.size:
                            raise CandidateError("candidate.json size is invalid")
                        manifest, manifest_digest = _validate_manifest(raw, expected_commit, expected_tag)
                        if manifest_digest != receipt["manifestSha256"]:
                            raise CandidateError("candidate manifest changed after verification")
                        _write_regular(destination, relative_path, raw)
                        written[relative_path] = manifest_digest
                        continue
                    if manifest is None:
                        raise CandidateError("candidate.json must precede payload files")
                    expected_files = cast(dict[str, str], manifest["files"])
                    if relative_path not in expected_files:
                        raise CandidateError(f"unexpected candidate payload: {relative_path}")
                    written[relative_path] = _copy_member(destination, archive, member, expected_files[relative_path])

    except (OSError, EOFError, zlib.error, tarfile.TarError) as error:
        raise CandidateError(f"cannot extract verified candidate snapshot: {error}") from error

    if manifest is None or manifest_digest is None:
        raise CandidateError("candidate manifest is missing during staging")
    expected_files = cast(dict[str, str], manifest["files"])
    if set(written) != {"candidate.json", *expected_files}:
        raise CandidateError("staged files do not exactly match the verified manifest inventory")
    expected_dirs = _expected_directories(expected_files)
    if directories != expected_dirs:
        raise CandidateError("staged directories do not match the verified payload layout")
    for path in expected_dirs:
        directory_fd = _open_directory(destination, path, create=False)
        try:
            if not stat.S_ISDIR(os.fstat(directory_fd).st_mode):
                raise CandidateError(f"staged directory is missing: {path}")
        finally:
            os.close(directory_fd)
    return {
        "schemaVersion": 1,
        "releaseId": f"{expected_commit}-{receipt['archiveSha256'][:16]}",
        "archiveSha256": receipt["archiveSha256"],
        "manifestSha256": manifest_digest,
        "commit": expected_commit,
        "tag": expected_tag,
        "version": manifest["version"],
        "bundleSha256": manifest["bundleSha256"],
        "files": {"candidate.json": manifest_digest, "candidate.tar.gz": receipt["archiveSha256"], **expected_files},
    }


def _rename_noreplace(source: Path, destination: Path) -> None:
    """Atomically publish a same-filesystem directory without replacing a path."""
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise CandidateError("atomic no-replace rename is unavailable on this platform")
    renameat2.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    renameat2.restype = ctypes.c_int
    result = renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    if result != 0:
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(code, os.strerror(code), destination)
        raise OSError(code, os.strerror(code), destination)


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _scan_directory(path: Path) -> tuple[list[str], list[str]]:
    directories: list[str] = []
    files: list[str] = []
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                try:
                    is_directory = stat.S_ISDIR(entry.stat(follow_symlinks=False).st_mode)
                except OSError as error:
                    raise OSError(f"cannot inspect candidate entry {entry.name!r} in {path}: {error}") from error
                (directories if is_directory else files).append(entry.name)
    except OSError as error:
        raise OSError(f"cannot safely scan candidate directory {path}: {error}") from error
    return directories, files


def _walk_tree(root: Path) -> Iterator[tuple[Path, list[str], list[str]]]:
    pending = [root]
    while pending:
        directory = pending.pop()
        subdirectories, files = _scan_directory(directory)
        yield directory, subdirectories, files
        pending.extend(directory / name for name in subdirectories)


def _fsync_tree_bottom_up(root: Path) -> None:
    pending = [root]
    directories: list[Path] = []
    while pending:
        directory = pending.pop()
        subdirectories, _files = _scan_directory(directory)
        directories.append(directory)
        pending.extend(directory / name for name in subdirectories)
    for directory in reversed(directories):
        _fsync_directory(directory)


def _read_release(
    release_dir: Path,
    expected_release_id: str,
    trusted_sha256: str,
    expected_commit: str,
    expected_tag: str,
    *,
    allow_staging_name: bool = False,
) -> dict[str, Any]:
    try:
        info = release_dir.lstat()
    except OSError as error:
        raise CandidateError(f"release does not exist: {release_dir}") from error
    if not stat.S_ISDIR(info.st_mode):
        raise CandidateError(f"release is not a real directory: {release_dir}")
    try:
        marker = json.loads(_read_regular(release_dir, MARKER, 2_000_000), object_pairs_hook=_unique_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CandidateError(f"release marker is invalid: {release_dir}") from error
    if not isinstance(marker, dict) or type(marker.get("schemaVersion")) is not int or marker["schemaVersion"] != 1:
        raise CandidateError(f"release marker schema is invalid: {release_dir}")
    release_id = marker.get("releaseId")
    commit = marker.get("commit")
    archive_sha = marker.get("archiveSha256")
    tag = marker.get("tag")
    files = marker.get("files")
    if (
        not isinstance(release_id, str)
        or RELEASE_ID.fullmatch(release_id) is None
        or not isinstance(commit, str)
        or COMMIT.fullmatch(commit) is None
        or not isinstance(archive_sha, str)
        or HEX256.fullmatch(archive_sha) is None
        or not isinstance(tag, str)
        or not isinstance(files, dict)
        or release_id != expected_release_id
        or release_id != f"{commit}-{archive_sha[:16]}"
        or archive_sha != trusted_sha256
        or commit != expected_commit
        or tag != expected_tag
        or (not allow_staging_name and release_dir.name != release_id)
    ):
        raise CandidateError(f"release marker identity differs from independently supplied identity: {release_dir}")

    actual_files: dict[str, str] = {}
    actual_dirs: set[str] = set()
    for base_path, dirs, names in _walk_tree(release_dir):
        for name in dirs:
            path = base_path / name
            if not stat.S_ISDIR(path.lstat().st_mode):
                raise CandidateError(f"release contains a non-directory path: {path}")
            actual_dirs.add(path.relative_to(release_dir).as_posix())
        for name in names:
            path = base_path / name
            relative_path = path.relative_to(release_dir).as_posix()
            if relative_path == MARKER:
                if not stat.S_ISREG(path.lstat().st_mode):
                    raise CandidateError("release marker is not a regular file")
                continue
            if _safe_relative_path(relative_path) != relative_path:
                raise CandidateError(f"release contains an unsafe path: {relative_path!r}")
            if not stat.S_ISREG(path.lstat().st_mode):
                raise CandidateError(f"release contains a non-regular file: {path}")
            actual_files[relative_path] = _sha256(release_dir, relative_path)
    if actual_files != files:
        raise CandidateError(f"release files or hashes differ from its marker: {release_dir}")

    archive_path = release_dir / "candidate.tar.gz"
    archive_receipt = verify_candidate(str(archive_path), trusted_sha256, expected_commit, expected_tag)
    raw_manifest = _read_regular(release_dir, "candidate.json", MAX_MANIFEST_BYTES)
    manifest, manifest_sha = _validate_manifest(raw_manifest, expected_commit, expected_tag)
    expected_files = {
        "candidate.json": manifest_sha,
        "candidate.tar.gz": trusted_sha256,
        **manifest["files"],
    }
    if files != expected_files or marker.get("manifestSha256") != manifest_sha:
        raise CandidateError(f"release inventory differs from its verified candidate archive: {release_dir}")
    if (
        archive_receipt["manifestSha256"] != manifest_sha
        or archive_receipt["bundleSha256"] != manifest["bundleSha256"]
        or marker.get("bundleSha256") != manifest["bundleSha256"]
        or marker.get("version") != manifest["version"]
    ):
        raise CandidateError(f"release identity differs from its verified candidate archive: {release_dir}")
    if actual_dirs != _expected_directories(manifest["files"]):
        raise CandidateError(f"release directories differ from its manifest: {release_dir}")
    return marker


def _current_target(prefix: Path, identity: tuple[str, str, str]) -> str:
    current = prefix / "current"
    try:
        info = current.lstat()
    except FileNotFoundError as error:
        raise CandidateError("--switch requires an existing verified current release for rollback") from error
    if not stat.S_ISLNK(info.st_mode):
        raise CandidateError("current must be a managed symlink")
    target = os.readlink(current)
    if not target.startswith("releases/") or "/" in target[len("releases/"):] or not RELEASE_ID.fullmatch(target[9:]):
        raise CandidateError("current symlink target is outside the managed release layout")
    _read_release(prefix / target, target[9:], *identity)
    return target


def _atomic_switch(
    prefix: Path,
    release_id: str,
    release_identity: tuple[str, str, str],
    expected_current: str | None,
    current_identity: tuple[str, str, str],
) -> tuple[str, str | None]:
    if expected_current is None:
        raise CandidateError("refusing first-install switch without a verified rollback release")
    lock_path = prefix / ".candidate-switch.lock"
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    switched = False
    old_target: str | None = None
    durability_warnings: list[str] = []
    operation_error: BaseException | None = None
    try:
        lock_info = os.fstat(lock_fd)
        if (
            not stat.S_ISREG(lock_info.st_mode)
            or lock_info.st_uid != os.geteuid()
            or lock_info.st_mode & 0o077
            or lock_info.st_nlink != 1
        ):
            raise CandidateError("candidate switch lock must be an owner-only regular file")
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        old_target = _current_target(prefix, current_identity)
        if old_target != expected_current:
            raise CandidateError("current release changed before the atomic switch")
        _read_release(prefix / "releases" / release_id, release_id, *release_identity)
        try:
            _fsync_directory(prefix / "releases")
        except OSError as error:
            raise CandidateError(
                f"releases directory fsync failed; refusing current switch and leaving current unchanged: {error}"
            ) from error
        current = prefix / "current"
        temporary_link = prefix / f".current.{os.getpid()}.tmp"
        temporary_link.unlink(missing_ok=True)
        os.symlink(f"releases/{release_id}", temporary_link)
        try:
            os.replace(temporary_link, current)
        except OSError as error:
            try:
                temporary_link.unlink(missing_ok=True)
            except OSError as cleanup_error:
                error.add_note(f"temporary switch-link cleanup also failed: {cleanup_error}")
            raise
        switched = True
        try:
            _fsync_directory(prefix)
        except OSError as error:
            durability_warnings.append(f"current was switched, but prefix fsync failed: {error}")
    except BaseException as error:
        operation_error = error
        raise
    finally:
        try:
            os.close(lock_fd)
        except OSError as error:
            if switched:
                durability_warnings.append(f"current was switched, but switch-lock close failed: {error}")
            elif operation_error is not None:
                operation_error.add_note(f"switch-lock close also failed: {error}")
            else:
                raise

    if not switched or old_target is None:
        raise CandidateError("current switch did not commit")
    return old_target, "; ".join(durability_warnings) if durability_warnings else None


def _prepare_prefix(raw_prefix: str) -> tuple[Path, Path]:
    raw = Path(raw_prefix).expanduser()
    if not raw.is_absolute():
        raise CandidateError("--prefix must be an absolute path")
    prefix = Path(os.path.abspath(raw))
    if prefix == Path("/"):
        raise CandidateError("refusing filesystem root as candidate prefix")
    current = Path("/")
    for part in prefix.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            current.mkdir(mode=0o700)
            info = current.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise CandidateError(f"candidate prefix path contains a symlink or non-directory: {current}")
        if current == prefix:
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise CandidateError("candidate prefix must be owned by the current user and mode 0700 or stricter")
        elif info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
            raise CandidateError(f"writable non-sticky parent is unsafe for candidate staging: {current}")
        # Retry this barrier on every invocation: a prior mkdir may have
        # succeeded even if its parent fsync failed or the process crashed.
        _fsync_directory(current.parent)

    releases = prefix / "releases"
    try:
        release_info = releases.lstat()
    except FileNotFoundError:
        releases.mkdir(mode=0o700)
        release_info = releases.lstat()
    if (
        stat.S_ISLNK(release_info.st_mode)
        or not stat.S_ISDIR(release_info.st_mode)
        or release_info.st_uid != os.geteuid()
        or release_info.st_mode & 0o077
    ):
        raise CandidateError("releases directory must be owned by the current user and mode 0700 or stricter")
    # As above, retry even when releases/ already exists after an earlier
    # interrupted/failed parent-directory durability barrier.
    _fsync_directory(prefix)
    return prefix, releases


def stage_candidate(
    archive_path: str,
    trusted_sha256: str,
    expected_commit: str,
    expected_tag: str,
    prefix_path: str,
    *,
    switch: bool = False,
    current_trusted_sha256: str | None = None,
    current_commit: str | None = None,
    current_tag: str | None = None,
) -> dict[str, Any]:
    prefix, releases = _prepare_prefix(prefix_path)
    current_identity: tuple[str, str, str] | None = None
    if switch:
        if current_trusted_sha256 is None or current_commit is None or current_tag is None:
            raise CandidateError("--switch requires an existing verified current release and independently supplied archive digest, commit, and tag")
        current_identity = (current_trusted_sha256, current_commit, current_tag)
        previous_target = _current_target(prefix, current_identity)
    else:
        previous_target = None

    publication_warning: str | None = None
    release_identity = (trusted_sha256, expected_commit, expected_tag)
    snapshot_body_complete = False
    completed_stage: tuple[str, dict[str, Any]] | None = None
    try:
        with verified_candidate_snapshot(archive_path, trusted_sha256, expected_commit, expected_tag) as (
            snapshot,
            receipt,
        ):
            release_id = f"{expected_commit}-{receipt['archiveSha256'][:16]}"
            destination = releases / release_id
            try:
                destination_info = destination.lstat()
            except FileNotFoundError:
                destination_info = None

            if destination_info is not None:
                if not stat.S_ISDIR(destination_info.st_mode):
                    raise CandidateError("release destination exists but is not a real directory")
                existing = _read_release(destination, release_id, *release_identity)
                if (
                    existing.get("manifestSha256") != receipt["manifestSha256"]
                    or existing.get("bundleSha256") != receipt["bundleSha256"]
                ):
                    raise CandidateError("existing release does not match the independently verified archive")
                staged = existing
                reused = True
                if not switch:
                    try:
                        _fsync_directory(releases)
                    except OSError as error:
                        publication_warning = (
                            f"existing release was verified but releases directory fsync failed: {error}"
                        )
            else:
                temporary = Path(tempfile.mkdtemp(prefix=".candidate-staging-", dir=releases))
                os.chmod(temporary, 0o700)
                published = False
                try:
                    staged = _extract_verified_snapshot(snapshot, temporary, receipt)
                    _copy_verified_archive(snapshot, temporary, "candidate.tar.gz", receipt["archiveSha256"])
                    marker = json.dumps(staged, sort_keys=True, separators=(",", ":")).encode() + b"\n"
                    _write_regular(temporary, MARKER, marker)
                    _fsync_tree_bottom_up(temporary)
                    _read_release(
                        temporary,
                        release_id,
                        *release_identity,
                        allow_staging_name=True,
                    )
                    _rename_noreplace(temporary, destination)
                    published = True
                    try:
                        _fsync_directory(releases)
                    except OSError as error:
                        publication_warning = f"release was published, but releases directory fsync failed: {error}"
                finally:
                    if not published:
                        shutil.rmtree(temporary, ignore_errors=True)
                reused = False
            snapshot_body_complete = True
            completed_stage = (release_id, receipt)
    except Exception as error:
        if snapshot_body_complete and completed_stage is not None:
            completed_release_id, completed_receipt = completed_stage
            details = [
                f"candidate release {completed_release_id} remains staged",
                f"prefix={prefix}",
                f"archiveSha256={completed_receipt['archiveSha256']}",
                f"commit={expected_commit}",
                f"tag={expected_tag}",
                "current was not switched by this invocation",
                f"verified snapshot cleanup failed after staging: {error}",
            ]
            if publication_warning is not None:
                details.append(publication_warning)
            raise CandidateError("; ".join(details)) from error
        raise

    old_target: str | None = None
    switch_warning: str | None = None
    if switch:
        if current_identity is None or previous_target is None:
            raise CandidateError("switch requires an independently verified current release")
        try:
            old_target, switch_warning = _atomic_switch(
                prefix,
                release_id,
                release_identity,
                previous_target,
                current_identity,
            )
        except (CandidateError, OSError) as error:
            details = [f"candidate release {release_id} remains staged", "current was not switched by this invocation"]
            if publication_warning is not None:
                details.append(publication_warning)
            details.append(f"switch failed: {error}")
            details.extend(f"switch note: {note}" for note in getattr(error, "__notes__", []))
            raise CandidateError("; ".join(details)) from error
        # _atomic_switch re-syncs releases/ before it changes current, so an
        # earlier publication warning has now been resolved.
        publication_warning = None
    limitations = [
        "service was not activated or restarted",
        "systemd units were not installed",
        "database migration, backup, health, hosted provenance and live acceptance were not verified",
    ]
    if switch:
        limitations.append(
            "switch locking coordinates cooperating stager processes; the private prefix must not be concurrently modified by another same-user process"
        )
    durability_warnings = [warning for warning in (publication_warning, switch_warning) if warning]
    return {
        "schemaVersion": 1,
        "result": "candidate-staged-not-activated",
        "prefix": str(prefix),
        "releaseId": release_id,
        "archiveSha256": receipt["archiveSha256"],
        "manifestSha256": receipt["manifestSha256"],
        "commit": expected_commit,
        "tag": expected_tag,
        "bundleSha256": receipt["bundleSha256"],
        "reused": reused,
        "switched": switch,
        "previousTarget": old_target,
        "durabilityWarning": "; ".join(durability_warnings) if durability_warnings else None,
        "limitations": limitations,
    }


def rollback_release(
    prefix_path: str,
    release_id: str,
    trusted_sha256: str,
    expected_commit: str,
    expected_tag: str,
    current_trusted_sha256: str,
    current_commit: str,
    current_tag: str,
) -> dict[str, Any]:
    if RELEASE_ID.fullmatch(release_id) is None:
        raise CandidateError("--release must be <full-commit>-<archive-sha256-prefix>")
    prefix, releases = _prepare_prefix(prefix_path)
    target_identity = (trusted_sha256, expected_commit, expected_tag)
    current_identity = (current_trusted_sha256, current_commit, current_tag)
    target = releases / release_id
    marker = _read_release(target, release_id, *target_identity)
    previous = _current_target(prefix, current_identity)
    if previous == f"releases/{release_id}":
        raise CandidateError("requested rollback target is already current")
    old_target, durability_warning = _atomic_switch(
        prefix,
        release_id,
        target_identity,
        previous,
        current_identity,
    )
    return {
        "schemaVersion": 1,
        "result": "release-link-rolled-back-not-activated",
        "prefix": str(prefix),
        "releaseId": release_id,
        "archiveSha256": marker["archiveSha256"],
        "commit": marker["commit"],
        "previousTarget": old_target,
        "durabilityWarning": durability_warning,
        "limitations": ["service was not restarted", "database was not restored", "runtime health was not verified"],
    }


def _write_stderr(message: str) -> None:
    try:
        sys.stderr.write(message + "\n")
        sys.stderr.flush()
    except Exception:
        # Avoid a second finalization flush changing the intended status code.
        sys.stderr = None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("stage", help="verify and stage candidate bytes; never activate a service")
    stage.add_argument("--archive", required=True)
    stage.add_argument("--trusted-sha256", required=True)
    stage.add_argument("--commit", required=True)
    stage.add_argument("--tag", required=True)
    stage.add_argument("--prefix", required=True, help="explicit absolute candidate prefix")
    stage.add_argument("--current-trusted-sha256", help="independently trusted digest of the current release archive")
    stage.add_argument("--current-commit", help="full expected commit of the current release")
    stage.add_argument("--current-tag", help="expected tag of the current release")
    stage.add_argument("--switch", action="store_true", help="atomically update current; requires an independently verified current release")
    rollback = commands.add_parser("rollback", help="verify an existing release and atomically switch current back")
    rollback.add_argument("--prefix", required=True, help="explicit absolute candidate prefix")
    rollback.add_argument("--release", required=True, help="verified release id to switch to")
    rollback.add_argument("--trusted-sha256", required=True, help="independently trusted digest of rollback archive")
    rollback.add_argument("--commit", required=True, help="full expected commit of rollback release")
    rollback.add_argument("--tag", required=True, help="expected tag of rollback release")
    rollback.add_argument("--current-trusted-sha256", required=True, help="independently trusted digest of current archive")
    rollback.add_argument("--current-commit", required=True, help="full expected commit of current release")
    rollback.add_argument("--current-tag", required=True, help="expected tag of current release")
    try:
        args = parser.parse_args(argv)
    except SystemExit as error:
        output_failed = False
        for stream_name in ("stdout", "stderr"):
            stream = getattr(sys, stream_name)
            if stream is None:
                continue
            try:
                stream.flush()
            except Exception:
                setattr(sys, stream_name, None)
                output_failed = True
        status = error.code if isinstance(error.code, int) else 2
        return 2 if output_failed and status == 0 else status
    except (OSError, ValueError, AttributeError):
        sys.stdout = None
        sys.stderr = None
        return 2

    try:
        if args.command == "stage":
            result = stage_candidate(
                args.archive,
                args.trusted_sha256,
                args.commit,
                args.tag,
                args.prefix,
                switch=args.switch,
                current_trusted_sha256=args.current_trusted_sha256,
                current_commit=args.current_commit,
                current_tag=args.current_tag,
            )
        else:
            result = rollback_release(
                args.prefix,
                args.release,
                args.trusted_sha256,
                args.commit,
                args.tag,
                args.current_trusted_sha256,
                args.current_commit,
                args.current_tag,
            )
    except (CandidateError, OSError, tarfile.TarError) as error:
        details = [f"stage_node_candidate: BLOCKED: {error}"]
        details.extend(getattr(error, "__notes__", []))
        _write_stderr("; ".join(details))
        return 2

    try:
        sys.stdout.write(json.dumps(result, sort_keys=True, indent=2) + "\n")
        sys.stdout.flush()
    except Exception as error:
        # Stop CPython finalization from retrying the failed buffered stream
        # and replacing the deliberate receipt-failure status with exit 120.
        sys.stdout = None
        if args.command == "stage":
            state = (
                "current was switched"
                if result.get("switched") is True
                else "candidate remains staged; current was not switched"
            )
        else:
            state = "rollback switched current"
        details = [
            f"operation completed ({state})",
            f"prefix={result.get('prefix')}",
            f"release={result.get('releaseId')}",
            f"archiveSha256={result.get('archiveSha256')}",
            f"commit={result.get('commit')}",
        ]
        if result.get("durabilityWarning"):
            details.append(f"durabilityWarning={result['durabilityWarning']}")
        details.append(f"JSON receipt output failed: {error}")
        _write_stderr("stage_node_candidate: RECEIPT_FAILED: " + "; ".join(details))
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Verify tag rejection and the actual produced executable/archive checksums."""
import argparse
import hashlib
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

from check_release import ROOT, validate_tag
from package_release import package


def run(binary: Path) -> None:
    validate_tag("v0.1.0")
    mismatch = subprocess.run([sys.executable, str(ROOT / "scripts/check_release.py"), "v0.2.0"], capture_output=True, text=True)
    if mismatch.returncode == 0 or "must match workspace version" not in mismatch.stderr:
        raise RuntimeError("mismatched tag did not fail before publication")
    print("PASS tag_version: matching accepted and mismatching CLI rejected")
    with tempfile.TemporaryDirectory(prefix="atmusic-release-") as temporary:
        directory = Path(temporary)
        archive = package(binary, directory / "produced", "v0.1.0")
        second = package(binary, directory / "repeat", "v0.1.0")
        if archive.read_bytes() != second.read_bytes():
            raise RuntimeError("packaging is not reproducible")
        subprocess.run(["sha256sum", "-c", "SHA256SUMS"], cwd=archive.parent, check=True)
        extracted = directory / "downloaded"
        extracted.mkdir()
        with tarfile.open(archive, "r:gz") as tar:
            names = tar.getnames()
            if names != ["atmusic", "atmusic.sha256"]:
                raise RuntimeError("archive contains unexpected files")
            tar.extractall(extracted, filter="data")
        subprocess.run(["sha256sum", "-c", "atmusic.sha256"], cwd=extracted, check=True)
        payload = (extracted / "atmusic").read_bytes()
        if not (extracted / "atmusic").stat().st_mode & 0o111 or hashlib.sha256(payload).digest() != hashlib.sha256(binary.read_bytes()).digest():
            raise RuntimeError("archive lost executable permissions or changed binary bytes")
        tampered = bytearray(payload)
        tampered[-1] ^= 1
        (extracted / "atmusic").write_bytes(tampered)
        failed = subprocess.run(["sha256sum", "-c", "atmusic.sha256"], cwd=extracted, capture_output=True, text=True)
        if failed.returncode == 0 or "FAILED" not in failed.stdout:
            raise RuntimeError("one-byte tamper was accepted")
    print("PASS checksum: produced archive/executable verified, repeat identical, one-byte tamper rejected")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    run(args.binary.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

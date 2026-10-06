#!/usr/bin/env python3
"""Create a deterministic executable archive and SHA256 checksums."""
import argparse
import gzip
import hashlib
import io
from pathlib import Path
import tarfile

from check_release import validate_tag


def package(binary: Path, output: Path, tag: str) -> Path:
    version = validate_tag(tag)
    payload = binary.read_bytes()
    if not payload.startswith(b"\x7fELF"):
        raise ValueError("release input must be an ELF executable; run the static smoke first")
    output.mkdir(parents=True, exist_ok=False)
    (output / "atmusic").write_bytes(payload)
    (output / "atmusic").chmod(0o755)
    digest = hashlib.sha256(payload).hexdigest()
    checksum = f"{digest}  atmusic\n".encode()
    (output / "atmusic.sha256").write_bytes(checksum)
    archive = output / f"atmusic-{version}-linux-x86_64-musl.tar.gz"
    with archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, filename="", mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as tar:
            for name, data, mode in [("atmusic", payload, 0o755), ("atmusic.sha256", checksum, 0o644)]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = mode
                info.mtime = 0
                tar.addfile(info, io.BytesIO(data))
    archive_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / "SHA256SUMS").write_text(f"{archive_digest}  {archive.name}\n{digest}  atmusic\n")
    return archive


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    try:
        print(package(args.binary, args.output, args.tag))
    except (ValueError, OSError) as error:
        parser.exit(1, f"FAIL release packaging: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

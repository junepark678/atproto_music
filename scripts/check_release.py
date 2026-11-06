#!/usr/bin/env python3
"""Reject a tag/package mismatch before any release publication."""
import argparse
from pathlib import Path
import re
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def validate_tag(tag: str, root: Path = ROOT) -> str:
    workspace = tomllib.loads((root / "Cargo.toml").read_text())
    version = workspace["workspace"]["package"]["version"]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or tag != f"v{version}":
        raise ValueError(f"release tag {tag!r} must match workspace version v{version}")
    for member in workspace["workspace"]["members"]:
        package = tomllib.loads((root / member / "Cargo.toml").read_text())["package"]
        member_version = package["version"]
        if member_version != {"workspace": True} and member_version != version:
            raise ValueError(f"{member} does not use release version {version}")
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    args = parser.parse_args()
    try:
        print(f"PASS tag_version: {validate_tag(args.tag)}")
    except (ValueError, KeyError, OSError) as error:
        parser.exit(1, f"FAIL tag_version: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

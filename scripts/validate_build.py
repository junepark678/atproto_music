#!/usr/bin/env python3
"""Exercise the locked build and inspect the actual dependency graph/features."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def cargo(*args):
    return subprocess.run(
        ["cargo", *args], cwd=ROOT, check=True, text=True, capture_output=True
    ).stdout


def require(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


def main():
    lockfile = ROOT / "Cargo.lock"
    original = hashlib.sha256(lockfile.read_bytes()).digest()
    metadata = json.loads(cargo("metadata", "--locked", "--no-deps", "--format-version", "1"))
    packages = {p["name"]: p for p in metadata["packages"]}
    expected = {"atmusic-core", "atmusic-storage", "atmusic-atproto", "atmusic-server"}
    require(set(packages) == expected, "workspace must contain exactly the four documented crates")
    edges = {
        name: {d["name"] for d in p["dependencies"] if d["name"] in expected}
        for name, p in packages.items()
    }
    require(not edges["atmusic-core"], "core depends on a higher layer")
    for name in expected - {"atmusic-server"}:
        require("atmusic-server" not in edges[name], f"{name} depends on server composition")

    def visit(name, ancestors):
        require(name not in ancestors, "workspace dependency cycle")
        for dependency in edges[name]:
            visit(dependency, ancestors | {name})

    for name in expected:
        visit(name, set())
    print("PASS dependency_direction: four members, acyclic dependencies, independent core")

    # The resolved feature set is authoritative; merely declaring rustls in Cargo.toml
    # cannot detect native TLS enabled transitively by another dependency.
    resolved = json.loads(cargo("metadata", "--locked", "--format-version", "1"))
    features = {n["id"]: set(n["features"]) for n in resolved["resolve"]["nodes"]}
    names = {p["name"] for p in resolved["packages"]}
    require(not names & {"openssl", "openssl-sys", "native-tls", "tokio-native-tls"},
            "OpenSSL/native-tls is present in the resolved graph")
    for name, required in [("libsqlite3-sys", "bundled"), ("reqwest", "rustls-tls")]:
        selected = [p for p in resolved["packages"] if p["name"] == name]
        require(bool(selected), f"missing {name} dependency")
        require(all(required in features[p["id"]] for p in selected),
                f"{name} does not enable {required}")
    print("PASS sqlite_tls_features: bundled SQLite and rustls, no native TLS")

    subprocess.run(["cargo", "build", "--locked", "--workspace"], cwd=ROOT, check=True)
    require(hashlib.sha256(lockfile.read_bytes()).digest() == original,
            "locked build modified Cargo.lock")
    print("PASS locked_build: workspace build succeeded without changing Cargo.lock")


if __name__ == "__main__":
    main()

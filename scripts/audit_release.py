#!/usr/bin/env python3
"""Audit the selected Linux musl release graph, retaining the full RustSec report."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TARGET = "x86_64-unknown-linux-musl"
HOST_TARGET = "x86_64-unknown-linux-gnu"


def selected_packages(metadata: dict) -> set[tuple[str, str]]:
    packages = {package["id"]: package for package in metadata["packages"]}
    servers = [package["id"] for package in packages.values() if package["name"] == "atmusic-server"]
    if len(servers) != 1 or not metadata.get("resolve"):
        raise ValueError("one resolved server package is required")
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    visited = set()
    pending = servers[:]
    while pending:
        package_id = pending.pop()
        if package_id in visited:
            continue
        if package_id not in nodes or package_id not in packages:
            raise ValueError("incomplete resolved dependency graph")
        visited.add(package_id)
        for dependency in nodes[package_id]["deps"]:
            kinds = dependency["dep_kinds"]
            if not kinds or any(kind["kind"] not in (None, "build", "dev") for kind in kinds):
                raise ValueError("invalid dependency kind")
            if any(kind["kind"] in (None, "build") for kind in kinds):
                pending.append(dependency["pkg"])
    return {(packages[package_id]["name"], packages[package_id]["version"]) for package_id in visited}


def findings(report: dict) -> list[dict]:
    vulnerabilities = report["vulnerabilities"]
    result = vulnerabilities["list"][:]
    if vulnerabilities["count"] != len(result) or vulnerabilities["found"] != bool(result):
        raise ValueError("inconsistent audit vulnerability count")
    warnings = report["warnings"]
    if not isinstance(warnings, dict):
        raise ValueError("invalid audit warnings")
    for entries in warnings.values():
        if not isinstance(entries, list):
            raise ValueError("invalid audit warning entries")
        result.extend(entries)
    for finding in result:
        package = finding["package"]
        if not all(isinstance(package.get(field), str) and package[field] for field in ("name", "version")):
            raise ValueError("invalid finding package")
        advisory = finding.get("advisory")
        # Yanked packages are represented without an advisory and still fail if selected.
        if advisory is not None and not isinstance(advisory.get("id"), str):
            raise ValueError("invalid advisory identifier")
    return result


def tree_packages(output: str) -> set[tuple[str,str]]:
    packages = set()
    for line in output.splitlines():
        if not line.strip(): continue
        matched = re.fullmatch(r"([A-Za-z0-9_-]+) v([0-9][0-9A-Za-z.+-]*)(?: \(.+\))*",line)
        if not matched: raise ValueError("unrecognized Cargo dependency tree output")
        packages.add((matched[1],matched[2]))
    if not packages: raise ValueError("empty feature-resolved dependency tree")
    return packages


def evaluate(report: dict, metadata: dict, host_metadata: dict | None = None, compiled_packages: set[tuple[str,str]] | None = None) -> tuple[list[dict], list[dict]]:
    selected = selected_packages(metadata)
    if host_metadata is not None:
        # Build scripts and proc macros run on the GNU Linux build host. Include
        # its entire server graph conservatively, so host-conditional build
        # dependencies cannot disappear under the musl metadata filter.
        selected |= selected_packages(host_metadata)
    if compiled_packages is not None:
        # Metadata may list disabled optional drivers (for example sqlx-mysql).
        # Cargo tree applies the actual selected features. Verify its identities
        # against the metadata graph rather than treating optional edges as built.
        if not compiled_packages <= selected or not any(name=="atmusic-server" for name,_ in compiled_packages):
            raise ValueError("feature-resolved tree does not match metadata identities")
        selected = compiled_packages
    active, excluded = [], []
    for finding in findings(report):
        package = finding["package"]
        (active if (package["name"], package["version"]) in selected else excluded).append(finding)
    return active, excluded


def label(finding: dict) -> str:
    package = finding["package"]
    advisory = finding.get("advisory") or {}
    return f"{advisory.get('id', finding.get('kind', 'yanked'))}: {package['name']} {package['version']}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit-bin", required=True, type=Path)
    parser.add_argument("--report-directory", type=Path, default=ROOT / "work/security")
    args = parser.parse_args()
    args.report_directory.mkdir(parents=True, exist_ok=True)
    lockfile = ROOT / "Cargo.lock"
    before = hashlib.sha256(lockfile.read_bytes()).hexdigest()
    audit = subprocess.run([str(args.audit_bin.resolve()), "audit", "--file", str(lockfile), "--db", str(ROOT / "work/advisory-db"), "--deny", "warnings", "--json"], cwd=ROOT, capture_output=True, text=True)
    (args.report_directory / "full-audit.json").write_text(audit.stdout)
    (args.report_directory / "audit.stderr.log").write_text(audit.stderr)
    if audit.returncode not in (0, 1):
        parser.exit(1, "FAIL release audit: audit tool failed; inspect the retained stderr report\n")
    try:
        report = json.loads(audit.stdout)
        entries = findings(report)
        if audit.returncode != 0 and not entries:
            raise ValueError("audit failed without a valid finding report")
        metadata_process = subprocess.run(["cargo", "metadata", "--locked", "--filter-platform", TARGET, "--format-version", "1"], cwd=ROOT, capture_output=True, text=True, check=True)
        metadata = json.loads(metadata_process.stdout)
        (args.report_directory / "musl-dependencies.json").write_text(metadata_process.stdout)
        host_process = subprocess.run(["cargo", "metadata", "--locked", "--filter-platform", HOST_TARGET, "--format-version", "1"], cwd=ROOT, capture_output=True, text=True, check=True)
        host_metadata = json.loads(host_process.stdout)
        (args.report_directory / "linux-host-dependencies.json").write_text(host_process.stdout)
        compiled_packages = set()
        for target,filename in [(TARGET,"musl-tree.txt"),(HOST_TARGET,"linux-host-tree.txt")]:
            tree = subprocess.run(["cargo","tree","--locked","--package","atmusic-server","--target",target,"--edges","normal,build","--prefix","none","--format","{p}"],cwd=ROOT,capture_output=True,text=True,check=True)
            (args.report_directory / filename).write_text(tree.stdout)
            compiled_packages |= tree_packages(tree.stdout)
        if hashlib.sha256(lockfile.read_bytes()).hexdigest() != before:
            raise ValueError("lockfile changed during the audit")
        active, excluded = evaluate(report, metadata, host_metadata, compiled_packages)
    except (ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"FAIL release audit: invalid tool/report/graph result: {error}\n")
    scope = {"target": TARGET, "buildHost": HOST_TARGET, "hostScope": "conservative complete server normal+build graph", "rootPackage": "atmusic-server", "dependencyKinds": ["normal", "build"], "selection": "Cargo feature-resolved tree identities verified against metadata", "selectedPackages": sorted(compiled_packages), "lockfileSha256": before, "rawAuditExitCode":audit.returncode,"active": active, "outsideReleaseGraph": excluded}
    (args.report_directory / "release-scope.json").write_text(json.dumps(scope, sort_keys=True, indent=2) + "\n")
    for finding in excluded:
        print(f"OUTSIDE RELEASE/HOST GRAPHS ({TARGET}, {HOST_TARGET}, normal+build): {label(finding)}")
    for finding in active:
        print(f"FAIL release audit: {label(finding)}")
    if active:
        return 1
    print(f"PASS release audit: no RustSec findings in {TARGET} release/{HOST_TARGET} host normal+build graphs; full report retained")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

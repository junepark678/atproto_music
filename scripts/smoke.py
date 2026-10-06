#!/usr/bin/env python3
"""Validate packaged HTTP, initialized SQLite, config failures and owned SIGTERM."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener
from uuid import UUID


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def inspect_static(binary):
    program = subprocess.run(["readelf", "-l", str(binary)], check=True, capture_output=True, text=True)
    dynamic = subprocess.run(["readelf", "-d", str(binary)], check=True, capture_output=True, text=True)
    require("INTERP" not in program.stdout, "static_elf: executable has an ELF interpreter")
    require("(NEEDED)" not in dynamic.stdout, "static_elf: executable requires shared libraries")
    print("PASS static_elf: no INTERP segment or NEEDED dependencies")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--static", action="store_true", help="also require a self-contained ELF")
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    if args.static:
        inspect_static(binary)
    opener = build_opener(ProxyHandler({}))
    clean_env = {k: v for k, v in os.environ.items() if not k.startswith("ATMUSIC_")}
    clean_env["RUST_LOG"] = "info"
    with tempfile.TemporaryDirectory(prefix="atmusic-smoke-") as directory:
        missing = subprocess.run(
            [str(binary), "serve", "--bind", "127.0.0.1:0"], cwd=directory,
            env=clean_env, timeout=5, capture_output=True, text=True,
        )
        require(missing.returncode != 0, "missing_config: server started without required settings")
        require("--public-origin" in missing.stderr and "--encryption-key" in missing.stderr,
                "missing_config: required field diagnostics missing")
        require(not list(Path(directory).rglob("*.sqlite")), "missing_config: startup created a database")
        invalid = subprocess.run(
            [str(binary), "serve", "--bind", "127.0.0.1:0"], cwd=directory,
            env={**clean_env, "ATMUSIC_PUBLIC_ORIGIN": "https://music.example",
                 "ATMUSIC_ENCRYPTION_KEY": "do-not-print-this-invalid-key"},
            timeout=5, capture_output=True, text=True,
        )
        require(invalid.returncode != 0 and "encryption_key:" in invalid.stderr,
                "invalid_config: missing typed encryption_key failure")
        require("do-not-print-this-invalid-key" not in invalid.stdout + invalid.stderr,
                "invalid_config: secret value leaked")
        print("PASS required_config: missing/invalid settings fail without exposing secrets")

        database = Path(directory) / "music.sqlite"
        with (Path(directory) / "server.log").open("w+") as log:
            process = subprocess.Popen(
                [str(binary), "serve", "--bind", "127.0.0.1:0", "--database-path", str(database)],
                cwd=directory,
                env={**clean_env, "ATMUSIC_PUBLIC_ORIGIN": "https://music.example",
                     "ATMUSIC_ENCRYPTION_KEY": secrets.token_hex(32)},
                stdout=log, stderr=log,
            )

            port = None

            def request(path):
                try:
                    response = opener.open(f"http://127.0.0.1:{port}{path}", timeout=2)
                except HTTPError as error:
                    response = error
                with response:
                    return response.status, response.headers, response.read()

            try:
                deadline = time.monotonic() + 15
                while True:
                    require(process.poll() is None, f"server exited during startup: {process.returncode}")
                    if port is None:
                        startup = (Path(directory) / "server.log").read_text()
                        startup = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", startup)
                        address = re.search(r"address=127\.0\.0\.1:(\d+)", startup)
                        if address:
                            port = int(address.group(1))
                        else:
                            require(time.monotonic() < deadline, "server did not report its bound port")
                            time.sleep(0.05)
                            continue
                    try:
                        status, _, body = request("/health/live")
                        require(status == 200 and json.loads(body) == {"status": "live"}, "invalid liveness")
                        break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise
                        time.sleep(0.05)
                status, _, body = request("/health/ready")
                require(status == 200 and json.loads(body) == {"status": "ready"}, "storage is not ready")
                require(database.is_file(), "ready200 without an initialized database")
                with sqlite3.connect(database) as connection:
                    require(connection.execute("PRAGMA user_version").fetchone()[0] == 4,
                            "ready200 without current database migrations")
                status, _, body = request("/api/v1/meta")
                meta = json.loads(body)
                require(status == 200 and set(meta) == {
                    "name", "version", "stage", "capabilities", "lexiconPrefix", "indexing"
                }, "metadata shape differs from API v1")
                require(meta["name"] == "atproto_music" and meta["stage"] == "backend"
                        and isinstance(meta["version"], str) and bool(meta["version"]), "invalid backend metadata")
                require(meta["capabilities"] == ["storage"] and meta["lexiconPrefix"] is None,
                        "metadata advertises unavailable music/publication capabilities")
                require(meta["indexing"] == {"state": "recovering", "caughtUp": False,
                                            "lastIndexedAt": None, "lagSeconds": None},
                        "new database falsely advertises a current index")
                status, _, body = request("/api/v1/users/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/scrobbles")
                history = json.loads(body)
                require(status == 200 and set(history) == {"items", "nextCursor", "asOf", "indexing"}
                        and history["items"] == [] and history["nextCursor"] is None,
                        "packaged history route does not read the initialized database")
                status, _, body = request("/")
                require(status == 200 and b"The music interface is not available yet." in body,
                        "embedded placeholder asset missing from packaged executable")
                status, headers, body = request("/feed")
                require(status == 200 and headers.get("Cache-Control") == "no-cache"
                        and b"The music interface is not available yet." in body,
                        "embedded deep link fallback is not available outside the source directory")
                status, headers, body = request("/assets/placeholder.77f5eec3.js")
                require(status == 200 and body == b'"use strict";\n'
                        and headers.get("Cache-Control") == "public, max-age=31536000, immutable",
                        "hashed embedded asset or immutable cache header missing")
                status, headers, body = request("/api/v1/unimplemented")
                error = json.loads(body)["error"]
                require(status == 404 and error["code"] == "not_found", "unknown API route is not JSON404")
                UUID(error["requestId"])
                require(headers.get("X-Request-Id") == error["requestId"], "error request ID/header mismatch")
                print("PASS packaged_http: initialized ready200, history read, embedded assets and JSON404")
                require(process.poll() is None, "server died before shutdown")
                process.terminate()
                require(process.wait(timeout=5) == 0, "packaged_shutdown: SIGTERM did not exit cleanly")
                print("PASS packaged_shutdown: owned server exits zero within five seconds")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()

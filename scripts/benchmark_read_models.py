#!/usr/bin/env python3
"""Benchmark the packaged backend in an owned 2-vCPU/2-GiB Docker container."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import sqlite3
import statistics
import subprocess
import tempfile
import time

DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]
DOCKER_ENV = {key: value for key, value in os.environ.items() if key not in {
    "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}}

def docker(*arguments, **kwargs):
    return subprocess.run([*DOCKER, *arguments], env=DOCKER_ENV, check=True, text=True, capture_output=True, **kwargs)

def plans(database):
    with sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True) as connection:
        count = connection.execute("SELECT count(*) FROM scrobbles WHERE confirmed=1").fetchone()[0]
        distribution = connection.execute("SELECT count(*),min(n),max(n) FROM (SELECT count(*) n FROM scrobbles GROUP BY did)").fetchone()
        if count != 100000 or distribution != (100, 1000, 1000):
            raise ValueError("expected exactly 100000 valid rows distributed 100 x 1000")
        statements = {
            "history": ("SELECT * FROM scrobbles WHERE did=? AND listened_at<=? ORDER BY listened_at DESC,uri DESC LIMIT 20", ("did:web:benchmark-000.test", "2026-01-15T12:00:00.000000000Z")),
            "feed": ("SELECT * FROM scrobbles ORDER BY listened_at DESC,uri DESC LIMIT 20", ()),
            "statistics": ("SELECT * FROM scrobbles WHERE did=? AND listened_at BETWEEN ? AND ? ORDER BY listened_at DESC,uri DESC", ("did:web:benchmark-000.test", "2026-01-08T12:00:00.000000000Z", "2026-01-15T12:00:00.000000000Z")),
        }
        output = {name: [row[3] for row in connection.execute("EXPLAIN QUERY PLAN " + sql, bindings)] for name, (sql, bindings) in statements.items()}
    required = {"history": "scrobbles_owner_time", "feed": "scrobbles_global_time", "statistics": "scrobbles_owner_time"}
    for name, index in required.items():
        if not any(index in row for row in output[name]):
            raise ValueError(f"required index missing from {name} plan: {output[name]}")
    return output

def measure(port, cookie, duration, keep):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    requests = int(duration * 10)
    latencies, errors = [], 0
    start = time.monotonic()
    routes = ["/api/v1/users/did:web:benchmark-000.test/scrobbles?limit=20", "/api/v1/feed?scope=global&limit=20"]
    try:
        for number in range(requests):
            remaining = start + number / 10 - time.monotonic()
            if remaining > 0:
                time.sleep(remaining)
            before = time.monotonic()
            try:
                connection.request("GET", routes[number % 2], headers={"Cookie": cookie})
                response = connection.getresponse()
                body = json.loads(response.read())
                if response.status != 200 or len(body.get("items", [])) != 20:
                    errors += 1
            except (OSError, ValueError, http.client.HTTPException):
                errors += 1
                connection.close()
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            if keep:
                latencies.append((time.monotonic() - before) * 1000)
        remaining = start + duration - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)
    finally:
        connection.close()
    return latencies, errors

def benchmark(binary, dataset, output):
    query_plans = plans(dataset / "music.sqlite")
    credentials = json.loads((dataset / "fixture-access.json").read_text())
    with tempfile.TemporaryDirectory(prefix="atmusic-benchmark-") as temporary:
        context = Path(temporary)
        image = "atmusic-benchmark:" + hashlib.sha256(binary.read_bytes()).hexdigest()[:16]
        # Build a scratch image without any networked build step.
        (context / "atmusic").write_bytes(binary.read_bytes())
        (context / "atmusic").chmod(0o755)
        (context / "Dockerfile").write_text("FROM scratch\nCOPY atmusic /atmusic\nENTRYPOINT [\"/atmusic\"]\n")
        docker("build", "-t", image, str(context))
        env_file = context / "runtime.env"
        env_file.write_text("ATMUSIC_ENCRYPTION_KEY=" + credentials["key"] + "\nATMUSIC_PUBLIC_ORIGIN=https://benchmark.test\n")
        env_file.chmod(0o600)
        container = None
        try:
            container = docker("run", "-d", "--cpus=2", "--memory=2g", "--memory-swap=2g", "--env-file", str(env_file),
                "--mount", f"type=bind,src={dataset.resolve()},dst=/data", "-p", "127.0.0.1::3000", image,
                "serve", "--bind", "0.0.0.0:3000", "--database-path", "/data/music.sqlite").stdout.strip()
            binding = docker("port", container, "3000/tcp").stdout.strip()
            port = int(binding.rsplit(":", 1)[1])
            deadline = time.monotonic() + 10
            while True:
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                    connection.request("GET", "/health/ready")
                    response = connection.getresponse()
                    response.read()
                    connection.close()
                    if response.status == 200:
                        break
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("owned backend container did not become ready")
                time.sleep(0.05)
            print("warmup: 30 seconds at 10 requests/second", flush=True)
            _, warmup_errors = measure(port, credentials["cookie"], 30, False)
            print("measurement: 600 requests over 60 seconds", flush=True)
            latencies, errors = measure(port, credentials["cookie"], 60, True)
            assert len(latencies) == 600
            p95 = sorted(latencies)[569]
            report = {"artifactSha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "datasetSeed":7,
                "rows":100000,"users":100,"rowsPerUser":1000,"cpuLimit":2,"memoryLimitBytes":2147483648,
                "warmupSeconds":30,"measurementSeconds":60,"requestsPerSecond":10,"measuredRequests":600,
                "warmupErrors":warmup_errors,"errors":errors,"p95Milliseconds":p95,"medianMilliseconds":statistics.median(latencies),
                "targetMilliseconds":300,"queryPlans":query_plans,"passed":errors==0 and warmup_errors==0 and p95<300}
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(report,indent=2)+"\n")
            print(json.dumps({key:report[key] for key in ["measuredRequests","errors","p95Milliseconds","passed"]}),flush=True)
            if not report["passed"]:
                raise RuntimeError("benchmark target failed")
        finally:
            try:
                if container:
                    try:
                        docker("stop", "-t", "35", container)
                    finally:
                        docker("rm", "-f", container)
            finally:
                docker("image", "rm", image)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary",type=Path)
    parser.add_argument("dataset",type=Path)
    parser.add_argument("--output",type=Path,default=Path("work/benchmark-results.json"))
    parser.add_argument("--plan-only",action="store_true")
    args = parser.parse_args()
    if args.plan_only:
        print(json.dumps(plans(args.dataset/"music.sqlite"),indent=2))
    else:
        benchmark(args.binary.resolve(),args.dataset.resolve(),args.output)

if __name__ == "__main__":
    main()

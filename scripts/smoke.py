#!/usr/bin/env python3
"""Run real HTTP and SIGTERM checks against a supplied packaged executable."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

binary = Path(sys.argv[1]).resolve(strict=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
opener = build_opener(ProxyHandler({}))
with tempfile.TemporaryDirectory(prefix='atmusic-smoke-') as directory:
    process = subprocess.Popen([str(binary), 'serve', '--bind', f'127.0.0.1:{port}'],
                               cwd=directory, env={**os.environ, 'RUST_LOG': 'warn'})
    def request(path):
        try:
            response = opener.open(f'http://127.0.0.1:{port}{path}', timeout=2)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.read()
    try:
        deadline = time.monotonic() + 15
        while True:
            if process.poll() is not None:
                raise RuntimeError(f'server exited during startup: {process.returncode}')
            try:
                status, body = request('/health/live')
                assert status == 200 and json.loads(body) == {'status': 'live'}
                break
            except OSError:
                if time.monotonic() >= deadline: raise
                time.sleep(0.05)
        status, body = request('/health/ready')
        assert status == 503 and json.loads(body)['error']['code'] == 'not_initialized'
        status, body = request('/api/v1/meta')
        assert status == 200 and json.loads(body)['stage'] == 'scaffold'
        status, body = request('/')
        assert status == 200 and b'Music features are not implemented yet.' in body
        status, body = request('/api/v1/scrobbles')
        assert status == 404 and json.loads(body)['error']['code'] == 'not_found'
        process.terminate()
        assert process.wait(timeout=5) == 0
        print('PASS: live HTTP, readiness 503, metadata, embedded asset, API 404, clean SIGTERM')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()

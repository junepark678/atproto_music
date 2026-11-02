#!/usr/bin/env python3
"""Tests for the pidfd-based one-time database initializer supervisor."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "run_init.py"
SPEC = importlib.util.spec_from_file_location("atmusic_run_init", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
run_init = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_init)


def cleanup_fixture_root(root: Path, child: subprocess.Popen[bytes] | None) -> bool:
    reaped = child is None
    if child is not None:
        try:
            child.wait(timeout=3)
            reaped = True
        except subprocess.TimeoutExpired:
            with contextlib.suppress(OSError):
                child.kill()
            try:
                child.wait(timeout=3)
                reaped = True
            except Exception:
                reaped = False
        except Exception:
            reaped = False
    if reaped:
        shutil.rmtree(root, ignore_errors=True)
    else:
        print(f"test child was not reaped; fixture preserved at {root}", file=sys.stderr)
    return reaped


def capture_spawned_children():
    children: list[subprocess.Popen[bytes]] = []
    real_popen = run_init.subprocess.Popen

    def capture(*args, **kwargs):
        child = real_popen(*args, **kwargs)
        children.append(child)
        return child

    return children, mock.patch.object(run_init.subprocess, "Popen", side_effect=capture)


@contextlib.contextmanager
def supervisor_watchdog(seconds: float):
    def alarm_handler(_signum, _frame):
        raise TimeoutError("supervisor watchdog expired")

    previous = run_init.signal.signal(run_init.signal.SIGALRM, alarm_handler)
    run_init.signal.setitimer(run_init.signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        run_init.signal.setitimer(run_init.signal.ITIMER_REAL, 0)
        run_init.signal.signal(run_init.signal.SIGALRM, previous)


@unittest.skipUnless(run_init.pidfd_supported(), "Linux pidfd support is required")
class RunInitSupervisorTest(unittest.TestCase):
    def test_failed_signals_are_bounded_and_return_live_child_for_cleanup(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="atmusic-run-init-test-"))
        marker = root / "stop-child"
        log_path = root / "init.log"
        child_code = (
            "import pathlib, sys, time; "
            "print('{\"event\":\"run.ready\"}', flush=True); "
            "marker = pathlib.Path(sys.argv[1]); "
            "exec(\"while not marker.exists(): time.sleep(0.01)\")"
        )
        child = None
        spawned, capture_popen = capture_spawned_children()
        stderr = io.StringIO()
        started = time.monotonic()
        try:
            with supervisor_watchdog(3), capture_popen, mock.patch.object(
                run_init.signal,
                "pidfd_send_signal",
                side_effect=PermissionError("fixture blocks signals"),
            ) as send_signal, contextlib.redirect_stderr(stderr):
                status, child = run_init.supervise(
                    [sys.executable, "-c", child_code, str(marker)],
                    cwd=root,
                    log_path=log_path,
                    child_env=os.environb.copy(),
                    timeout_seconds=2,
                    grace_seconds=0.1,
                )
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 1.5)
            self.assertEqual(status, run_init.RETAIN_WORKDIR_STATUS)
            self.assertIsNotNone(child)
            self.assertIsNone(child.poll())
            self.assertEqual(send_signal.call_count, 2)
            self.assertIn("could not send SIGTERM", stderr.getvalue())
            self.assertIn("could not send SIGKILL", stderr.getvalue())
            self.assertIn("not waiting indefinitely", stderr.getvalue())
            self.assertIn(b'"event":"run.ready"', log_path.read_bytes())
        finally:
            child = child or (spawned[-1] if spawned else None)
            marker.write_text("stop\n", encoding="utf-8")
            self.assertTrue(cleanup_fixture_root(root, child), f"fixture preserved at {root}")

    def test_broken_stderr_does_not_interrupt_signal_escalation(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="atmusic-run-init-stderr-"))
        marker = root / "stop-child"
        log_path = root / "init.log"
        child_code = (
            "import pathlib, signal, sys, time; "
            "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
            "print('{\"event\":\"run.ready\"}', flush=True); "
            "marker = pathlib.Path(sys.argv[1]); "
            "exec(\"while not marker.exists(): time.sleep(0.01)\")"
        )

        class BrokenStderr:
            def write(self, _text: str) -> int:
                raise ValueError("fixture stderr is closed")

            def flush(self) -> None:
                raise ValueError("fixture stderr is closed")

        child = None
        spawned, capture_popen = capture_spawned_children()
        started = time.monotonic()
        try:
            with supervisor_watchdog(3), capture_popen, mock.patch.object(
                run_init.signal,
                "pidfd_send_signal",
                side_effect=PermissionError("fixture blocks signals"),
            ), contextlib.redirect_stderr(BrokenStderr()):
                status, child = run_init.supervise(
                    [sys.executable, "-c", child_code, str(marker)],
                    cwd=root,
                    log_path=log_path,
                    child_env=os.environb.copy(),
                    timeout_seconds=2,
                    grace_seconds=0.1,
                )
            self.assertLess(time.monotonic() - started, 1.5)
            self.assertEqual(status, run_init.RETAIN_WORKDIR_STATUS)
            self.assertIsNotNone(child)
            self.assertIsNone(child.poll())
        finally:
            child = child or (spawned[-1] if spawned else None)
            marker.write_text("stop\n", encoding="utf-8")
            self.assertTrue(cleanup_fixture_root(root, child), f"fixture preserved at {root}")

    def test_parent_log_close_error_does_not_bypass_child_supervision(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="atmusic-run-init-log-close-"))
        log_path = root / "init.log"
        child_code = (
            "import signal, sys, time; "
            "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0)); "
            "print('{\"event\":\"run.ready\"}', flush=True); "
            "time.sleep(30)"
        )

        class CloseFailingFile:
            def __init__(self, stream):
                self.stream = stream

            def fileno(self) -> int:
                return self.stream.fileno()

            def close(self) -> None:
                self.stream.close()
                raise OSError("injected parent log close failure")

        class CloseFailingPath:
            def open(self, mode: str = "r", buffering: int = -1):
                stream = log_path.open(mode, buffering=buffering)
                if mode == "wb":
                    return CloseFailingFile(stream)
                return stream

        child = None
        spawned, capture_popen = capture_spawned_children()

        class InterruptingStderr:
            def write(self, _text: str) -> int:
                raise KeyboardInterrupt("fixture interrupted diagnostic output")

            def flush(self) -> None:
                raise KeyboardInterrupt("fixture interrupted diagnostic output")

        try:
            with supervisor_watchdog(3), capture_popen, contextlib.redirect_stderr(InterruptingStderr()):
                status, child = run_init.supervise(
                    [sys.executable, "-c", child_code],
                    cwd=root,
                    log_path=CloseFailingPath(),
                    child_env=os.environb.copy(),
                    timeout_seconds=2,
                    grace_seconds=1,
                )
            self.assertEqual(status, 0)
            if child is None:
                self.fail("supervisor lost the child handle after starting it")
            self.assertEqual(child.returncode, 0)
            self.assertIn(run_init.READY_MARKER, log_path.read_bytes())
        finally:
            child = child or (spawned[-1] if spawned else None)
            self.assertTrue(cleanup_fixture_root(root, child), f"fixture preserved at {root}")

    def test_non_finite_grace_is_rejected_before_starting_child(self) -> None:
        with tempfile.TemporaryDirectory(prefix="atmusic-run-init-invalid-") as temp:
            root = Path(temp)
            log_path = root / "init.log"
            status, child = run_init.supervise(
                [sys.executable, "-c", "raise SystemExit('must not run')"],
                cwd=root,
                log_path=log_path,
                child_env=os.environb.copy(),
                timeout_seconds=1,
                grace_seconds=float("inf"),
            )
            self.assertEqual(status, run_init.CLEAN_FAILURE_STATUS)
            self.assertIsNone(child)
            self.assertFalse(log_path.exists())

    def test_init_time_bounds_are_enforced_before_starting_child(self) -> None:
        with self.assertRaises(run_init.argparse.ArgumentTypeError):
            run_init._timeout_seconds(str(run_init.MAX_TIMEOUT_SECONDS + 0.5))
        with self.assertRaises(run_init.argparse.ArgumentTypeError):
            run_init._grace_seconds(str(run_init.MAX_GRACE_SECONDS + 0.5))
        for timeout, grace in (
            (run_init.MAX_TIMEOUT_SECONDS + 0.5, 1),
            (1, run_init.MAX_GRACE_SECONDS + 0.5),
        ):
            with tempfile.TemporaryDirectory(prefix="atmusic-run-init-bound-") as temp:
                root = Path(temp)
                log_path = root / "init.log"
                status, child = run_init.supervise(
                    [sys.executable, "-c", "raise SystemExit('must not run')"],
                    cwd=root,
                    log_path=log_path,
                    child_env=os.environb.copy(),
                    timeout_seconds=timeout,
                    grace_seconds=grace,
                )
                self.assertEqual(status, run_init.CLEAN_FAILURE_STATUS)
                self.assertIsNone(child)
                self.assertFalse(log_path.exists())

    def test_child_receives_exact_nul_delimited_environment(self) -> None:
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node is required to verify the exact child environment")
        root = Path(tempfile.mkdtemp(prefix="atmusic-run-init-env-"))
        log_path = root / "init.log"
        child_env = {
            b"PATH": os.fsencode(Path(node).parent),
            b"HOME": b"/fixture-home",
            b"ONLY_ALLOWED": b"yes",
            b"VALUE_WITH_EQUALS": b"one=two",
            b"UNICODE_VALUE": "Música".encode(),
        }
        payload = b"\0".join(key + b"=" + value for key, value in child_env.items()) + b"\0"
        child_code = (
            "import process from 'node:process'; "
            "const keys = Object.keys(process.env).sort(); "
            "const names = ['HOME', 'ONLY_ALLOWED', 'PATH', 'UNICODE_VALUE', 'VALUE_WITH_EQUALS']; "
            "const values = Object.fromEntries(names.map((key) => [key, process.env[key]])); "
            "process.on('SIGTERM', () => process.exit(0)); "
            "setInterval(() => {}, 1000); "
            "console.log(JSON.stringify({ keys, values })); "
            "console.log('{\"event\":\"run.ready\"}');"
        )
        child = None
        spawned, capture_popen = capture_spawned_children()
        captured: dict[str, subprocess.Popen[bytes] | None] = {}
        real_supervise = run_init.supervise

        def capture_supervise(*args, **kwargs):
            status, process = real_supervise(*args, **kwargs)
            captured["child"] = process
            return status, process

        stdin = io.TextIOWrapper(io.BytesIO(payload), encoding="utf-8")
        try:
            with capture_popen, mock.patch.object(run_init.sys, "stdin", stdin), mock.patch.object(
                run_init, "supervise", side_effect=capture_supervise
            ):
                status = run_init.main(
                    [
                        "--timeout",
                        "2",
                        "--grace",
                        "1",
                        "--log",
                        str(log_path),
                        "--cwd",
                        str(root),
                        "--env-stdin",
                        "--",
                        node,
                        "--input-type=module",
                        "-e",
                        child_code,
                    ]
                )
            child = captured.get("child")
            self.assertEqual(status, 0)
            if child is None:
                self.fail("successful initialization did not return its reaped process handle")
            self.assertEqual(child.returncode, 0)
            lines = log_path.read_text(encoding="utf-8").splitlines()
            observed = json.loads(lines[0])
            self.assertEqual(observed["keys"], sorted(os.fsdecode(key) for key in child_env))
            self.assertEqual(
                observed["values"],
                {os.fsdecode(key): os.fsdecode(value) for key, value in child_env.items()},
            )
            self.assertNotIn("LC_CTYPE", observed["keys"])
        finally:
            stdin.close()
            child = child or captured.get("child") or (spawned[-1] if spawned else None)
            self.assertTrue(cleanup_fixture_root(root, child), f"fixture preserved at {root}")

    def test_pidfd_preflight_succeeds(self) -> None:
        self.assertTrue(run_init.pidfd_supported())


if __name__ == "__main__":
    unittest.main()

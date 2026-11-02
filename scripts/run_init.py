#!/usr/bin/env python3
"""Run one-time database initialization with bounded, PID-reuse-safe shutdown."""

from __future__ import annotations

import argparse
import contextlib
import math
import os
import select
import signal
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path

READY_MARKER = b'"event":"run.ready"'
CLEAN_FAILURE_STATUS = 70
RETAIN_WORKDIR_STATUS = 75
MAX_TIMEOUT_SECONDS = 900.0
MAX_GRACE_SECONDS = 60.0


def _diagnostic(message: str) -> None:
    # Diagnostic I/O must never interrupt signal escalation or child reaping.
    with contextlib.suppress(BaseException):
        print(message, file=sys.stderr)


def _positive_finite_float(raw: str, *, maximum: float) -> float:
    try:
        value = float(raw)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be finite, positive, and within the configured maximum") from error
    if not math.isfinite(value) or value <= 0 or value > maximum:
        raise argparse.ArgumentTypeError("must be finite, positive, and within the configured maximum")
    return value


def _timeout_seconds(raw: str) -> float:
    return _positive_finite_float(raw, maximum=MAX_TIMEOUT_SECONDS)


def _grace_seconds(raw: str) -> float:
    return _positive_finite_float(raw, maximum=MAX_GRACE_SECONDS)


def pidfd_supported() -> bool:
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        return False
    try:
        pidfd = os.pidfd_open(os.getpid(), 0)
    except OSError:
        return False
    try:
        signal.pidfd_send_signal(pidfd, 0)
    except OSError:
        return False
    finally:
        os.close(pidfd)
    return True


def _has_exited(pidfd: int) -> bool:
    poller = select.poll()
    poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
    return bool(poller.poll(0))


def _log_has_ready(log_path: Path) -> bool:
    try:
        with log_path.open("rb") as log_file:
            return READY_MARKER in log_file.read()
    except OSError:
        return False


def _send_signal(pidfd: int, signum: int, label: str) -> None:
    try:
        signal.pidfd_send_signal(pidfd, signum)
    except ProcessLookupError:
        # The pidfd still identifies the original process; it has already exited.
        return
    except OSError as error:
        _diagnostic(f"run-init: warning: could not send SIG{label}: {error}")


def _stop_child(
    process: subprocess.Popen[bytes], pidfd: int, grace_seconds: float
) -> int | None:
    _send_signal(pidfd, signal.SIGTERM, "TERM")
    try:
        return process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        _diagnostic(
            f"run-init: warning: --init process {process.pid} did not stop within "
            f"{grace_seconds:g} seconds; sending SIGKILL"
        )

    _send_signal(pidfd, signal.SIGKILL, "KILL")
    try:
        return process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        _diagnostic(
            f"run-init: error: --init process {process.pid} is still running after "
            "SIGKILL; not waiting indefinitely"
        )
        return None


def parse_environment(data: bytes) -> dict[bytes, bytes]:
    if not data.endswith(b"\0"):
        raise ValueError("environment input is not NUL-terminated")
    environment: dict[bytes, bytes] = {}
    for item in data[:-1].split(b"\0"):
        key, separator, value = item.partition(b"=")
        if not separator or not key:
            raise ValueError("environment input contains an invalid assignment")
        environment[key] = value
    return environment


def supervise(
    command: Sequence[str],
    *,
    cwd: Path,
    log_path: Path,
    child_env: Mapping[bytes, bytes],
    timeout_seconds: float,
    grace_seconds: float,
) -> tuple[int, subprocess.Popen[bytes] | None]:
    """Run init and return its Popen handle whenever a child was started."""
    if (
        not command
        or not math.isfinite(timeout_seconds)
        or timeout_seconds <= 0
        or timeout_seconds > MAX_TIMEOUT_SECONDS
        or not math.isfinite(grace_seconds)
        or grace_seconds <= 0
        or grace_seconds > MAX_GRACE_SECONDS
    ):
        _diagnostic("run-init: timeout and grace must be finite, positive, and within configured maxima")
        return CLEAN_FAILURE_STATUS, None

    try:
        log_file = log_path.open("wb", buffering=0)
    except OSError as error:
        _diagnostic(f"run-init: could not open init log: {error}")
        return CLEAN_FAILURE_STATUS, None
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=dict(child_env),
            stdout=log_file,
            stderr=subprocess.STDOUT,
            close_fds=True,
        )
    except OSError as error:
        _diagnostic(f"run-init: could not start --init: {error}")
        with contextlib.suppress(Exception):
            log_file.close()
        return CLEAN_FAILURE_STATUS, None
    try:
        log_file.close()
    except BaseException as error:
        # The child already owns its stdout fd; a parent-side close failure must
        # not skip pidfd acquisition or classify a possibly live child as safe.
        _diagnostic(f"run-init: warning: could not close parent init-log fd: {error}")

    # Open the pidfd before polling/waiting. Popen remains the direct parent, so
    # an exited child cannot have its PID reused before this handle is acquired.
    pidfd: int | None = None
    try:
        pidfd = os.pidfd_open(process.pid, 0)
        deadline = time.monotonic() + timeout_seconds
        ready = False
        while True:
            if _log_has_ready(log_path):
                ready = True
                break
            if _has_exited(pidfd):
                status = process.wait()
                _diagnostic(
                    "run-init: main.mjs --init exited before reporting readiness "
                    f"(status {status})"
                )
                return CLEAN_FAILURE_STATUS, process
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            poller = select.poll()
            poller.register(pidfd, select.POLLIN | select.POLLHUP | select.POLLERR)
            poller.poll(max(1, min(200, int(remaining * 1000))))

        if not ready:
            status = _stop_child(process, pidfd, grace_seconds)
            if status is None:
                return RETAIN_WORKDIR_STATUS, process
            _diagnostic(
                "run-init: main.mjs --init did not report ready (see the output above)"
            )
            return CLEAN_FAILURE_STATUS, process

        status = _stop_child(process, pidfd, grace_seconds)
        if status is None:
            return RETAIN_WORKDIR_STATUS, process
        if status != 0:
            _diagnostic(f"run-init: main.mjs --init exited with {status} after SIGTERM")
            return CLEAN_FAILURE_STATUS, process
        return 0, process
    except BaseException as error:
        _diagnostic(f"run-init: supervision interrupted or failed: {error}")
        try:
            if process.poll() is None:
                return RETAIN_WORKDIR_STATUS, process
            process.wait()
            return CLEAN_FAILURE_STATUS, process
        except BaseException as cleanup_error:
            _diagnostic(f"run-init: could not verify child exit: {cleanup_error}")
            return RETAIN_WORKDIR_STATUS, process
    finally:
        if pidfd is not None:
            try:
                os.close(pidfd)
            except OSError as error:
                _diagnostic(f"run-init: could not close pidfd: {error}")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check Linux pidfd support")
    parser.add_argument("--timeout", type=_timeout_seconds)
    parser.add_argument("--grace", type=_grace_seconds)
    parser.add_argument("--log", type=Path)
    parser.add_argument("--cwd", type=Path)
    parser.add_argument(
        "--env-stdin",
        action="store_true",
        help="read exact NUL-delimited child environment from stdin",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)

    if args.check:
        if pidfd_supported():
            return 0
        _diagnostic("run-init: Python/Linux pidfd support is required for safe --init shutdown")
        return 1

    command = list(args.command)
    if command and command[0] == "--":
        command.pop(0)
    if (
        not command
        or args.timeout is None
        or args.grace is None
        or args.log is None
        or args.cwd is None
        or not args.env_stdin
    ):
        parser.error("--timeout, --grace, --log, --cwd, --env-stdin, and a command are required")
    if not pidfd_supported():
        _diagnostic("run-init: Python/Linux pidfd support is required for safe --init shutdown")
        return CLEAN_FAILURE_STATUS

    try:
        child_env = parse_environment(sys.stdin.buffer.read())
    except (OSError, ValueError) as error:
        _diagnostic(f"run-init: invalid child environment input: {error}")
        return CLEAN_FAILURE_STATUS

    status, _live_child = supervise(
        command,
        cwd=args.cwd,
        log_path=args.log,
        child_env=child_env,
        timeout_seconds=args.timeout,
        grace_seconds=args.grace,
    )
    return status


if __name__ == "__main__":
    raise SystemExit(main())

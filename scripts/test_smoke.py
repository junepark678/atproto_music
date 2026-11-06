#!/usr/bin/env python3
"""Exercise smoke's failure cases with a disposable early-exit executable."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="atmusic-smoke-negative-") as directory:
        early = Path(directory) / "early-exit"
        early.write_text('''#!/usr/bin/env python3
import os
import sys
if not os.environ.get("ATMUSIC_PUBLIC_ORIGIN"):
    print("required arguments: --public-origin --encryption-key", file=sys.stderr)
    sys.exit(2)
if os.environ.get("ATMUSIC_ENCRYPTION_KEY") == "do-not-print-this-invalid-key":
    print("encryption_key: invalid", file=sys.stderr)
    sys.exit(1)
sys.exit(0)
''')
        early.chmod(0o755)
        result = subprocess.run(
            ["python3", str(ROOT / "scripts/smoke.py"), str(early)],
            text=True, capture_output=True, timeout=10,
        )
        if result.returncode == 0 or "server exited during startup: 0" not in result.stderr:
            raise SystemExit("FAIL: smoke did not reject early server exit")
        print("PASS packaged_shutdown_negative: startup exit cannot pass the HTTP/shutdown smoke")
        result = subprocess.run(
            ["python3", str(ROOT / "scripts/smoke.py"), "--static", str(early)],
            text=True, capture_output=True, timeout=10,
        )
        if result.returncode == 0 or "readelf" not in result.stderr:
            raise SystemExit("FAIL: smoke accepted a non-ELF artifact")
        print("PASS static_elf_negative: failed ELF inspection cannot pass packaging")


if __name__ == "__main__":
    main()

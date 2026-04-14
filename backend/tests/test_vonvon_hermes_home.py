"""vonvon-specific Hermes home defaults."""

import os
import subprocess
import sys
from pathlib import Path


def test_backend_defaults_hermes_home_to_vonvon_dir():
    backend_dir = Path(__file__).resolve().parents[1]
    env = {k: v for k, v in os.environ.items() if k != "HERMES_HOME"}
    env["PYTHONPATH"] = str(backend_dir)

    proc = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "from app.config import HERMES_HOME; "
                "import os; "
                "print(HERMES_HOME); "
                "print(os.environ['HERMES_HOME'])"
            ),
        ],
        cwd=backend_dir,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )

    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    expected = str(Path.home() / ".vonvon" / ".hermes")
    assert lines == [expected, expected]

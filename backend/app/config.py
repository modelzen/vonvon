"""Configuration for vonvon backend service."""
import os
from pathlib import Path


# vonvon keeps its Hermes state under ~/.vonvon/.hermes by default so it does
# not collide with a separately installed native Hermes CLI. An explicit
# HERMES_HOME env var still takes precedence for local debugging and tests.
DEFAULT_HERMES_HOME = Path.home() / ".vonvon" / ".hermes"
os.environ.setdefault("HERMES_HOME", str(DEFAULT_HERMES_HOME))
os.environ.setdefault("HERMES_PLATFORM", "vonvon")
HERMES_HOME = Path(os.environ["HERMES_HOME"]).expanduser()

# Default model
DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514"

# Server port
PORT = int(os.environ.get("VONVON_BACKEND_PORT", "8000"))

# Allowed CORS origins (Electron renderer + Vite dev server)
CORS_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:3000",
    # Electron uses file:// or custom protocol; allow all for dev
]

"""Configuration for vonvon backend service."""
import os
from pathlib import Path


# Default hermes home directory
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))

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

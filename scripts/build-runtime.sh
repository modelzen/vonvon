#!/usr/bin/env bash
#
# build-runtime.sh — produce a self-contained Python runtime for the
# vonvon backend, to be shipped inside Vonvon.app/Contents/Resources/.
#
# Strategy:
#   1. Download python-build-standalone (arm64 macOS) — a fully static
#      Python install that runs without any system Python.
#   2. Extract it to .dist/backend-runtime/.
#   3. pip install hermes-agent + backend into that runtime's site-packages.
#
# Requires: curl, tar. No system Python needed.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$REPO_ROOT/.dist"
RUNTIME_DIR="$DIST_DIR/backend-runtime"
RUNTIME_STAMP="$DIST_DIR/backend-runtime.stamp"
BACKEND_SRC="$REPO_ROOT/backend"

# python-build-standalone release — pin to a known-good build.
# arm64 darwin install_only variant is minimal and relocatable.
PBS_VERSION="3.11.11"
PBS_DATE="20250317"
PBS_FILENAME="cpython-${PBS_VERSION}+${PBS_DATE}-aarch64-apple-darwin-install_only.tar.gz"
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_DATE}/${PBS_FILENAME}"

mkdir -p "$DIST_DIR"
PBS_CACHE="$DIST_DIR/$PBS_FILENAME"

if [ ! -f "$PBS_CACHE" ]; then
  echo "[build-runtime] downloading python-build-standalone $PBS_VERSION ($PBS_DATE)"
  echo "[build-runtime] $PBS_URL"
  curl -fL "$PBS_URL" -o "$PBS_CACHE.tmp"
  mv "$PBS_CACHE.tmp" "$PBS_CACHE"
else
  echo "[build-runtime] reusing cached $PBS_CACHE"
fi

echo "[build-runtime] cleaning $RUNTIME_DIR"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"

echo "[build-runtime] extracting"
# The tarball contains a top-level 'python/' dir. Strip it so our runtime
# layout is .dist/backend-runtime/{bin,lib,include,share}.
tar -xzf "$PBS_CACHE" -C "$RUNTIME_DIR" --strip-components=1

PY="$RUNTIME_DIR/bin/python3"
if [ ! -x "$PY" ]; then
  echo "[build-runtime] FATAL: extracted runtime has no bin/python3 at $PY" >&2
  exit 1
fi

echo "[build-runtime] python version: $("$PY" -V)"

# PBS builds ship pip but it's ancient — upgrade first.
"$PY" -m pip install --upgrade --disable-pip-version-check pip setuptools wheel

# Install hermes-agent FIRST so backend's `hermes-agent` dependency is
# already satisfied when we install backend itself. Without this, pip
# would try to resolve hermes-agent from PyPI (which does not exist).
echo "[build-runtime] installing hermes-agent from source"
"$PY" -m pip install --no-cache-dir --disable-pip-version-check \
  "$BACKEND_SRC/hermes-agent"

echo "[build-runtime] installing vonvon-backend from source"
"$PY" -m pip install --no-cache-dir --disable-pip-version-check \
  "$BACKEND_SRC"

# Trim obvious fat — test suites, __pycache__, docs — to keep the .dmg
# under ~400MB. The PBS tarball itself is ~50MB; most weight is deps.
echo "[build-runtime] stripping caches"
find "$RUNTIME_DIR" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME_DIR" -type f -name "*.pyc" -delete 2>/dev/null || true

echo
echo "[build-runtime] done. size:"
du -sh "$RUNTIME_DIR"

# Record a local build completion time for stale checks. The extracted runtime's
# files keep upstream mtimes, so they cannot be used as a reliable freshness marker.
touch "$RUNTIME_STAMP"

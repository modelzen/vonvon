#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_SCRIPT="$REPO_ROOT/scripts/build-runtime.sh"
RUNTIME_BIN="$REPO_ROOT/.dist/backend-runtime/bin/python3"
RUNTIME_STAMP="$REPO_ROOT/.dist/backend-runtime.stamp"
NATIVE_ADDON="$REPO_ROOT/native/build/Release/kirby_native.node"
APP_PATH="$REPO_ROOT/release/mac-arm64/Vonvon.app"
APP_BIN="$APP_PATH/Contents/MacOS/Vonvon"

build_target="dir"
build_only=0
refresh_runtime=0
refresh_native=0

log() {
  printf '[test-packaged] %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage: npm run test:packaged -- [options]

Builds Vonvon in packaged mode, then launches the packaged app from the
terminal so you can reproduce DMG-installed behavior with real stdout/stderr.

Options:
  --build-only       Build the packaged app, but do not launch it.
  --dmg              Build the full DMG instead of the unpacked .app bundle.
  --refresh-runtime  Rebuild the bundled backend runtime even if it looks fresh.
  --refresh-native   Rebuild the native addon even if it looks fresh.
  --help             Show this help.
EOF
}

runtime_is_stale() {
  # The extracted python-build-standalone binaries preserve upstream mtimes,
  # so use our own success stamp instead of bin/python3 as the freshness marker.
  if [ ! -x "$RUNTIME_BIN" ] || [ ! -f "$RUNTIME_STAMP" ]; then
    return 0
  fi

  find "$REPO_ROOT/backend" \
    -type f \
    ! -path '*/.venv/*' \
    ! -path '*/.omc/*' \
    ! -path '*/.pytest_cache/*' \
    ! -path '*/__pycache__/*' \
    ! -path '*/build/*' \
    ! -path '*/dist/*' \
    ! -path '*/tests/*' \
    ! -path '*/docs/*' \
    ! -path '*/website/*' \
    ! -path '*/landingpage/*' \
    ! -path '*/docker/*' \
    ! -path '*/node_modules/*' \
    ! -path '*/.egg-info/*' \
    ! -path '*/tinker-atropos/*' \
    ! -path '*/datagen-config-examples/*' \
    -newer "$RUNTIME_STAMP" \
    -print -quit 2>/dev/null | grep -q .
}

native_is_stale() {
  if [ ! -f "$NATIVE_ADDON" ]; then
    return 0
  fi

  find "$REPO_ROOT/native" \
    -type f \
    ! -path '*/build/*' \
    -newer "$NATIVE_ADDON" \
    -print -quit 2>/dev/null | grep -q .
}

for arg in "$@"; do
  case "$arg" in
    --build-only)
      build_only=1
      ;;
    --dmg)
      build_target="dmg"
      ;;
    --refresh-runtime)
      refresh_runtime=1
      ;;
    --refresh-native)
      refresh_native=1
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'test-packaged only supports macOS because the packaged target is a macOS app bundle.\n' >&2
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  log "warning: this repo currently packages the macOS arm64 target; you are on $(uname -m)"
fi

cd "$REPO_ROOT"

if [ "$refresh_runtime" -eq 1 ] || runtime_is_stale; then
  log "Refreshing bundled backend runtime"
  "$RUNTIME_SCRIPT"
else
  log "Bundled backend runtime is up to date"
fi

if [ "$refresh_native" -eq 1 ] || native_is_stale; then
  log "Rebuilding native addon"
  npm run rebuild
else
  log "Native addon is up to date"
fi

log "Building Electron app bundle"
npm run build:app

if [ "$build_target" = "dmg" ]; then
  log "Building DMG"
  npm run dist
else
  log "Building unpacked packaged app"
  npm run pack
fi

if [ ! -x "$APP_BIN" ]; then
  printf 'Packaged app binary not found at %s\n' "$APP_BIN" >&2
  exit 1
fi

if [ "$build_only" -eq 1 ]; then
  log "Packaged app is ready at $APP_PATH"
  if [ "$build_target" = "dmg" ]; then
    log "DMG artifacts are in $REPO_ROOT/release"
  fi
  exit 0
fi

log "Launching packaged app from terminal so packaged-mode logs stay visible"
exec "$APP_BIN"

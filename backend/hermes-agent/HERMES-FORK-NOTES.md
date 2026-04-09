# Hermes Fork Notes

This directory is a git-subtree fork of the upstream hermes-agent.
All modifications from vonvon v1.1 are documented here to ease future upstream merges.

## WP1-C-fork (vonvon v1.1 — 2026-04-09)

### New files

- **`hermes_cli/config_lock.py`** — Cross-process advisory file lock for
  `~/.hermes/config.yaml` read/modify/write cycles. Mirrors the existing
  `auth.py:_auth_store_lock` pattern. Uses `fcntl` on POSIX and `msvcrt`
  on Windows. Re-entrancy implemented with `contextvars.ContextVar` (not
  `threading.local`) because the vonvon backend runs config writes inside
  `asyncio.to_thread` workers — each worker is a distinct OS thread, so
  `threading.local` would not recognize the re-entrant call context.
  Candidate for upstream PR since it benefits the CLI too.

### Modified files

- **`hermes_cli/mcp_config.py`** — Wrapped `_save_mcp_server`,
  `_remove_mcp_server`, and `cmd_mcp_configure` RMW paths with
  `config_store_lock()`. Each site now does load → mutate → save inside
  the advisory lock.

- **`hermes_cli/skills_config.py`** — Wrapped `save_disabled_skills` with
  `config_store_lock()` and changed it to re-read config inside the lock
  (RMW pattern) so concurrent `hermes skills` toggle calls don't overwrite
  each other.

- **`hermes_cli/auth_commands.py`** — Wrapped the
  `_interactive_strategy` RMW (`load_config` → mutate
  `credential_pool_strategies` → `save_config`) with `config_store_lock()`.

### Not patched (out of v1.1 scope)

- `hermes_cli/commands.py` and other rarely-touched config writers.
  The vonvon backend never triggers them directly, so the inconsistency
  is acceptable for v1.1. Future upstream PR to cover all writers.

### Upstream PR intent

`hermes_cli/config_lock.py` and the three call-site wraps in
`mcp_config.py` are good candidates to upstream since they protect the
CLI itself from corruption when multiple CLI instances run concurrently.
The `skills_config.py` and `auth_commands.py` wraps are equally valid
upstream contributions.

---

## WP1-B-fork (vonvon v1.1 — 2026-04-09)

### New files

- **`agent/codex_device_flow.py`** — Pure-function Codex OAuth device flow
  split into `start_device_flow()` / `poll_device_flow()` / `_try_token_exchange()`.
  All three are side-effect-free HTTP callers with no print/sleep — safe to call
  from async backend via `asyncio.to_thread`. Handles transient 5xx on token
  exchange by returning `{status: "pending", pending_exchange: {...}}` so
  `auth_service.poll_codex_oauth_flow` can retry on the next poll without
  restarting the device-code flow (AC-A12).

### Modified files

- **`hermes_cli/auth.py:_codex_device_code_login`** (lines 2714-2856) —
  Refactored from monolithic implementation to thin CLI shim. Delegates
  HTTP calls to `agent.codex_device_flow.{start_device_flow, poll_device_flow}`.
  Preserves all original CLI print/sleep/Ctrl-C behaviour byte-for-byte.
  No other hermes functions touched.

---

## Pending fork work (other workers)

- **WP1-D-fork** (worker-3): `hermes_cli/skills_config.py` + vonvon platform
  entry + `config_store_lock` in `save_disabled_skills`.
- **WP1-D-fork-2** (worker-3): `tools/skills_hub.py` headless install helper.

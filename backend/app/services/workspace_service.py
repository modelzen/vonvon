"""Project workspace management — single process-wide cwd for hermes tools.

Hermes agent file/terminal tools resolve paths through os.getenv('TERMINAL_CWD')
with an os.getcwd() fallback. vonvon-backend must own this value so user
conversations affect the user's project, not the backend install dir.

Fallback: ~/.vonvon/workdir/ (auto-created sandbox). Never use $HOME as
the default — too broad, agent could scribble on dotfiles."""

import asyncio
import logging
import os
from pathlib import Path
from typing import Dict

from hermes_cli.config import load_config, save_config
from hermes_cli.config_lock import config_store_lock   # WP1-C-fork

logger = logging.getLogger(__name__)

SANDBOX_PATH = Path.home() / ".vonvon" / "workdir"
SANDBOX_README = """# vonvon default workdir

This is the sandbox directory vonvon uses when no project workspace
is configured in Settings. The agent's file / terminal / git tools
operate inside this folder.

You can switch to a real project directory via Settings → 工作区 → 选择目录...
"""

_current_path: Path = SANDBOX_PATH   # assumption: sandbox is primed by init


def _ensure_sandbox() -> Path:
    """Create ~/.vonvon/workdir/ if missing and seed a README."""
    try:
        SANDBOX_PATH.mkdir(parents=True, exist_ok=True)
        readme = SANDBOX_PATH / "README.md"
        if not readme.exists():
            readme.write_text(SANDBOX_README, encoding="utf-8")
    except OSError as exc:
        logger.warning("Failed to ensure sandbox %s: %s", SANDBOX_PATH, exc)
    return SANDBOX_PATH


def _state(path: Path) -> Dict[str, object]:
    return {
        "path": str(path),
        "exists": path.exists(),
        "is_dir": path.is_dir(),
        "is_sandbox": path == SANDBOX_PATH.resolve(),
    }


def current_state() -> Dict[str, object]:
    return _state(_current_path)


def _apply(path: Path) -> None:
    """Apply cwd as an atomic transaction: either both TERMINAL_CWD AND
    os.chdir succeed, or neither changes. Critic MF-2 requires no partial
    state — if chdir fails, env is rolled back and ValueError is raised
    so callers (e.g. set_workspace) skip the config.yaml persistence.
    """
    global _current_path
    resolved = path.expanduser().resolve()
    if not resolved.exists() or not resolved.is_dir():
        raise ValueError(f"workspace path does not exist or is not a directory: {resolved}")

    prev_env = os.environ.get("TERMINAL_CWD")
    # chdir FIRST — if this fails we haven't touched env yet
    try:
        os.chdir(resolved)
    except OSError as exc:
        raise ValueError(f"chdir to {resolved} failed: {exc}") from exc

    # Now env — if this somehow fails, roll chdir back
    try:
        os.environ["TERMINAL_CWD"] = str(resolved)
    except Exception as exc:
        try:
            if prev_env is not None:
                os.environ["TERMINAL_CWD"] = prev_env
            else:
                os.environ.pop("TERMINAL_CWD", None)
        finally:
            try:
                if _current_path.exists() and _current_path.is_dir():
                    os.chdir(_current_path)
            except OSError:
                pass
        raise ValueError(f"env update failed: {exc}") from exc

    _current_path = resolved
    logger.info("workspace_applied path=%s sandbox=%s",
                resolved, resolved == SANDBOX_PATH.resolve())


def _set_workspace_sync(path: str) -> Dict[str, object]:
    resolved = Path(path).expanduser().resolve()
    _apply(resolved)
    with config_store_lock():
        cfg = load_config()
        cfg.setdefault("vonvon", {})
        cfg["vonvon"]["workspace"] = str(resolved)
        save_config(cfg)
    return _state(resolved)


def _reset_to_sandbox_sync() -> Dict[str, object]:
    sandbox = _ensure_sandbox().resolve()
    _apply(sandbox)
    with config_store_lock():
        cfg = load_config()
        vcfg = cfg.get("vonvon")
        if isinstance(vcfg, dict) and "workspace" in vcfg:
            vcfg.pop("workspace", None)
            if not vcfg:
                cfg.pop("vonvon", None)
            save_config(cfg)
    return _state(sandbox)


async def set_workspace(path: str) -> Dict[str, object]:
    """Async wrapper — disk I/O + fcntl wait off the event loop (DELTA-7)."""
    return await asyncio.to_thread(_set_workspace_sync, path)


async def reset_to_sandbox() -> Dict[str, object]:
    """Async wrapper — disk I/O + fcntl wait off the event loop (DELTA-7)."""
    return await asyncio.to_thread(_reset_to_sandbox_sync)


def init_from_hermes_config() -> None:
    """Load workspace from ~/.hermes/config.yaml:vonvon.workspace at backend startup.

    Order:
      1. Persisted vonvon.workspace (if valid)
      2. ~/.vonvon/workdir/ (auto-create + seed README)
    """
    try:
        cfg = load_config()
        persisted = cfg.get("vonvon", {}).get("workspace")
        if persisted:
            try:
                _apply(Path(persisted))
                return
            except ValueError as exc:
                logger.warning("Persisted workspace invalid: %s — falling back to sandbox",
                               exc)
    except Exception as exc:
        logger.warning("Failed to load workspace config: %s", exc)

    sandbox = _ensure_sandbox().resolve()
    _apply(sandbox)
    logger.info("workspace_default_sandbox path=%s", sandbox)

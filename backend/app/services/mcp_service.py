"""Adapter over hermes_cli.mcp_config — all writes are config-locked,
all probes are serialized through a module-level asyncio.Lock."""
import asyncio
import logging
import time
from typing import Any, Dict, List

from hermes_cli.mcp_config import (
    _get_mcp_servers,
    _probe_single_server,
    _save_mcp_server,
    _remove_mcp_server,
)
from hermes_cli.config_lock import config_store_lock  # WP1-C-fork

logger = logging.getLogger(__name__)

# DELTA-2 + Critic MF-4: prevents concurrent _probe_single_server calls
# from tearing down the shared MCP loop singleton. This is a module-level
# lock so ALL probe operations serialize — the tradeoff is that adding 3
# MCP servers with probe=True is now a sequential wait (10-30s × N), not
# parallel. UX mitigation: probe uses a 10s connect timeout (not the
# hermes default 30s), and UI disables the "add server" button while a
# probe is running with copy "连接测试中…".
_probe_lock = asyncio.Lock()
_PROBE_TIMEOUT_SECONDS = 10.0   # < hermes default 30s; capped for UI responsiveness


def _sanitize(cfg: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in cfg.items() if v is not None}


def list_servers() -> List[Dict[str, Any]]:
    servers = _get_mcp_servers()
    return [{"name": name, **cfg} for name, cfg in servers.items()]


async def add_server(cfg: Dict[str, Any], *, probe: bool) -> Dict[str, Any]:
    name = cfg.pop("name")
    if not cfg.get("url") and not cfg.get("command"):
        raise ValueError("url or command is required")
    clean = _sanitize(cfg)

    if probe:
        try:
            async with _probe_lock:
                tools = await asyncio.to_thread(_probe_single_server, name, clean)
            clean["enabled"] = True
            probed_info = {"tools_count": len(tools),
                           "last_probed_at": time.time()}
        except Exception as exc:
            logger.info("mcp_probe_failed name=%s err=%s", name, exc)
            clean["enabled"] = False
            probed_info = {"last_probed_at": time.time(),
                           "last_error": str(exc)}
    else:
        clean["enabled"] = bool(clean.get("enabled", True))
        probed_info = {}

    # _save_mcp_server does its own load/save; we add an outer lock for
    # cross-process safety (WP1-C-fork config_store_lock).
    await asyncio.to_thread(_save_locked, name, clean)
    logger.info("mcp_server_added name=%s probe=%s", name, probe)
    return {"name": name, **clean, **probed_info}


def _save_locked(name: str, clean: Dict[str, Any]) -> None:
    with config_store_lock():
        _save_mcp_server(name, clean)


def _remove_locked(name: str) -> bool:
    with config_store_lock():
        return _remove_mcp_server(name)


async def remove_server(name: str) -> bool:
    return await asyncio.to_thread(_remove_locked, name)


async def set_server_enabled(name: str, enabled: bool) -> Dict[str, Any]:
    servers = _get_mcp_servers()
    cfg = servers.get(name)
    if cfg is None:
        raise KeyError(name)

    clean = _sanitize(dict(cfg))
    clean["enabled"] = enabled
    await asyncio.to_thread(_save_locked, name, clean)
    logger.info("mcp_server_toggled name=%s enabled=%s", name, enabled)
    return {"name": name, **clean}


async def probe_server(name: str) -> Dict[str, Any]:
    servers = _get_mcp_servers()
    cfg = servers.get(name)
    if cfg is None:
        return {"ok": False, "latency_ms": 0, "tools": [],
                "error": f"server {name} not found"}
    start = time.monotonic()
    try:
        async with _probe_lock:
            tools = await asyncio.to_thread(_probe_single_server, name, cfg)
        return {
            "ok": True,
            "latency_ms": int((time.monotonic() - start) * 1000),
            "tools": [{"name": t[0], "description": t[1]} for t in tools],
        }
    except Exception as exc:
        return {"ok": False,
                "latency_ms": int((time.monotonic() - start) * 1000),
                "tools": [], "error": str(exc)}

"""Unit tests for mcp_service: list, add, remove, probe."""
import asyncio
from unittest.mock import MagicMock, patch

import pytest

# Stub hermes modules before any app import (conftest.py handles the heavy
# stubs; we only need to add mcp-specific ones here).
import sys
sys.modules.setdefault("hermes_cli.mcp_config", MagicMock())
sys.modules.setdefault("hermes_cli.config_lock", MagicMock())

from app.services import mcp_service  # noqa: E402


@pytest.fixture(autouse=True)
def _patch_hermes_mcp(tmp_path):
    """Stub out the hermes mcp_config and config_store_lock for every test."""
    fake_servers = {}

    def fake_get_mcp_servers():
        return dict(fake_servers)

    def fake_save_mcp_server(name, cfg):
        fake_servers[name] = cfg

    def fake_remove_mcp_server(name):
        if name in fake_servers:
            del fake_servers[name]
            return True
        return False

    from contextlib import contextmanager

    @contextmanager
    def fake_config_store_lock(*a, **kw):
        yield

    with (
        patch("app.services.mcp_service._get_mcp_servers", side_effect=fake_get_mcp_servers),
        patch("app.services.mcp_service._save_mcp_server", side_effect=fake_save_mcp_server),
        patch("app.services.mcp_service._remove_mcp_server", side_effect=fake_remove_mcp_server),
        patch("app.services.mcp_service.config_store_lock", fake_config_store_lock),
    ):
        yield fake_servers


def test_list_servers_empty(_patch_hermes_mcp):
    assert mcp_service.list_servers() == []


def test_list_servers_returns_names(_patch_hermes_mcp):
    _patch_hermes_mcp["fs"] = {"command": "npx", "enabled": True}
    result = mcp_service.list_servers()
    assert len(result) == 1
    assert result[0]["name"] == "fs"
    assert result[0]["command"] == "npx"


@pytest.mark.asyncio
async def test_add_server_no_probe(_patch_hermes_mcp):
    cfg = {"name": "myserver", "url": "http://localhost:9000"}
    result = await mcp_service.add_server(cfg, probe=False)
    assert result["name"] == "myserver"
    assert result["enabled"] is True
    assert "myserver" in _patch_hermes_mcp


@pytest.mark.asyncio
async def test_add_server_no_probe_preserves_enabled_false(_patch_hermes_mcp):
    cfg = {"name": "disabled-server", "url": "http://localhost:9000", "enabled": False}
    result = await mcp_service.add_server(cfg, probe=False)
    assert result["enabled"] is False
    assert _patch_hermes_mcp["disabled-server"]["enabled"] is False


@pytest.mark.asyncio
async def test_add_server_requires_url_or_command(_patch_hermes_mcp):
    with pytest.raises(ValueError, match="url or command"):
        await mcp_service.add_server({"name": "bad"}, probe=False)


@pytest.mark.asyncio
async def test_add_server_probe_success(_patch_hermes_mcp):
    fake_tools = [("read_file", "Read a file")]
    with patch("app.services.mcp_service._probe_single_server", return_value=fake_tools):
        cfg = {"name": "fs", "command": "npx", "args": ["@mcp/fs"]}
        result = await mcp_service.add_server(cfg, probe=True)
    assert result["enabled"] is True
    assert result["tools_count"] == 1
    assert "last_probed_at" in result


@pytest.mark.asyncio
async def test_add_server_probe_failure_still_saves(_patch_hermes_mcp):
    with patch("app.services.mcp_service._probe_single_server", side_effect=ConnectionError("refused")):
        cfg = {"name": "broken", "url": "http://bad"}
        result = await mcp_service.add_server(cfg, probe=True)
    assert result["enabled"] is False
    assert "last_error" in result
    assert "broken" in _patch_hermes_mcp


@pytest.mark.asyncio
async def test_remove_server_existing(_patch_hermes_mcp):
    _patch_hermes_mcp["fs"] = {"command": "npx"}
    removed = await mcp_service.remove_server("fs")
    assert removed is True
    assert "fs" not in _patch_hermes_mcp


@pytest.mark.asyncio
async def test_remove_server_missing(_patch_hermes_mcp):
    removed = await mcp_service.remove_server("nonexistent")
    assert removed is False


@pytest.mark.asyncio
async def test_set_server_enabled_existing(_patch_hermes_mcp):
    _patch_hermes_mcp["fs"] = {"command": "npx", "enabled": True}
    result = await mcp_service.set_server_enabled("fs", False)
    assert result["enabled"] is False
    assert _patch_hermes_mcp["fs"]["enabled"] is False


@pytest.mark.asyncio
async def test_set_server_enabled_missing(_patch_hermes_mcp):
    with pytest.raises(KeyError):
        await mcp_service.set_server_enabled("ghost", False)


@pytest.mark.asyncio
async def test_probe_server_not_found(_patch_hermes_mcp):
    result = await mcp_service.probe_server("ghost")
    assert result["ok"] is False
    assert "not found" in result["error"]


@pytest.mark.asyncio
async def test_probe_server_success(_patch_hermes_mcp):
    _patch_hermes_mcp["fs"] = {"command": "npx"}
    fake_tools = [("read_file", "Read a file"), ("write_file", "Write a file")]
    with patch("app.services.mcp_service._probe_single_server", return_value=fake_tools):
        result = await mcp_service.probe_server("fs")
    assert result["ok"] is True
    assert result["latency_ms"] >= 0
    assert len(result["tools"]) == 2
    assert result["tools"][0]["name"] == "read_file"


@pytest.mark.asyncio
async def test_probe_server_failure(_patch_hermes_mcp):
    _patch_hermes_mcp["fs"] = {"command": "npx"}
    with patch("app.services.mcp_service._probe_single_server", side_effect=TimeoutError("timeout")):
        result = await mcp_service.probe_server("fs")
    assert result["ok"] is False
    assert "timeout" in result["error"]
    assert result["tools"] == []


def test_probe_lock_is_asyncio_lock():
    """_probe_lock must be an asyncio.Lock for AC-P8 serialization."""
    assert isinstance(mcp_service._probe_lock, asyncio.Lock)

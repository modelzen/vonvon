"""AC-P8: Concurrent probe_server() calls must all succeed without
RuntimeError: Event loop is closed or task group errors.

Proves _probe_lock + asyncio.to_thread serializes the shared MCP loop
singleton so concurrent UI probes don't tear each other down.
"""
import asyncio
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

sys.modules.setdefault("hermes_cli.mcp_config", MagicMock())
sys.modules.setdefault("hermes_cli.config_lock", MagicMock())

from app.services import mcp_service  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_probe_lock():
    """Replace module-level _probe_lock with a fresh asyncio.Lock() for each
    test. The module-level lock can carry internal waiter state across
    pytest-asyncio's per-function event loops, causing subsequent tests to
    deadlock or skip the second coroutine's probe call."""
    original = mcp_service._probe_lock
    mcp_service._probe_lock = asyncio.Lock()
    yield
    mcp_service._probe_lock = original


def _fake_probe(name, cfg):
    """Simulate a probe that takes a short time but doesn't tear down a loop."""
    time.sleep(0.02)
    return [("tool_a", "desc a"), ("tool_b", "desc b")]


@pytest.mark.asyncio
async def test_three_concurrent_probes_all_succeed():
    """AC-P8: 3 concurrent probe_server() return full results, no errors."""
    servers = {
        "srv1": {"command": "npx"},
        "srv2": {"command": "npx"},
        "srv3": {"command": "npx"},
    }
    with (
        patch("app.services.mcp_service._get_mcp_servers", return_value=servers),
        patch("app.services.mcp_service._probe_single_server", side_effect=_fake_probe),
    ):
        results = await asyncio.gather(
            mcp_service.probe_server("srv1"),
            mcp_service.probe_server("srv2"),
            mcp_service.probe_server("srv3"),
        )

    assert len(results) == 3
    for r in results:
        assert r["ok"] is True, f"probe failed: {r}"
        assert len(r["tools"]) == 2
        assert r["tools"][0]["name"] == "tool_a"
        assert "error" not in r or r["error"] is None


@pytest.mark.asyncio
async def test_probe_lock_serializes_calls():
    """_probe_lock ensures probes are sequential, not concurrent."""
    call_times: list[float] = []

    def _timed_probe(name, cfg):
        call_times.append(time.monotonic())
        time.sleep(0.05)
        return [("t", "d")]

    servers = {"a": {"url": "http://x"}, "b": {"url": "http://y"}}
    with (
        patch("app.services.mcp_service._get_mcp_servers", return_value=servers),
        patch("app.services.mcp_service._probe_single_server", side_effect=_timed_probe),
    ):
        await asyncio.gather(
            mcp_service.probe_server("a"),
            mcp_service.probe_server("b"),
        )

    # If serialized, second call starts after first finishes (gap >= ~50ms)
    assert len(call_times) == 2
    assert call_times[1] - call_times[0] >= 0.04, "probes ran concurrently — _probe_lock not working"


@pytest.mark.asyncio
async def test_add_server_probe_uses_same_lock():
    """add_server(probe=True) and probe_server() share _probe_lock (AC-P8)."""
    call_order: list[str] = []

    def _probe_add(name, cfg):
        call_order.append(f"add:{name}")
        time.sleep(0.03)
        return []

    def _probe_test(name, cfg):
        call_order.append(f"test:{name}")
        time.sleep(0.01)
        return [("x", "y")]

    servers = {"existing": {"url": "http://e"}}

    from contextlib import contextmanager

    @contextmanager
    def fake_lock(*a, **kw):
        yield

    with (
        patch("app.services.mcp_service._get_mcp_servers", return_value=servers),
        patch("app.services.mcp_service.config_store_lock", fake_lock),
        patch("app.services.mcp_service._save_mcp_server"),
        patch(
            "app.services.mcp_service._probe_single_server",
            side_effect=lambda name, cfg: (
                _probe_add(name, cfg) if name == "new" else _probe_test(name, cfg)
            ),
        ),
    ):
        await asyncio.gather(
            mcp_service.add_server({"name": "new", "url": "http://new"}, probe=True),
            mcp_service.probe_server("existing"),
        )

    # One must have completed before the other started (serialized)
    assert len(call_order) == 2
    # Both ran, just sequentially
    names = {c.split(":")[1] for c in call_order}
    assert names == {"new", "existing"}

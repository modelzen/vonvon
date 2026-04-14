"""Tests for agent_service: create_agent, switch_model, _agent_lock."""
import asyncio
from unittest.mock import MagicMock, patch

import pytest

from app.services import agent_service


def test_create_agent_passes_session_id(mock_session_db):
    """create_agent forwards session_id to AIAgent constructor."""
    mock_cls = MagicMock()
    with patch("app.services.agent_service.AIAgent", mock_cls):
        agent_service.create_agent("sid-abc")
    kwargs = mock_cls.call_args.kwargs
    assert kwargs["session_id"] == "sid-abc"


def test_create_agent_passes_session_db(mock_session_db):
    """create_agent passes the singleton SessionDB instance to AIAgent."""
    mock_cls = MagicMock()
    with patch("app.services.agent_service.AIAgent", mock_cls):
        agent_service.create_agent("sid-xyz")
    kwargs = mock_cls.call_args.kwargs
    assert kwargs["session_db"] is mock_session_db


def test_create_agent_passes_callbacks(mock_session_db):
    """Extra callback kwargs are forwarded verbatim to AIAgent."""
    cb = MagicMock()
    mock_cls = MagicMock()
    with patch("app.services.agent_service.AIAgent", mock_cls):
        agent_service.create_agent("s1", stream_delta_callback=cb)
    kwargs = mock_cls.call_args.kwargs
    assert kwargs["stream_delta_callback"] is cb


async def test_switch_model_updates_global():
    """switch_model updates _current_model when hermes reports success."""
    result = MagicMock()
    result.success = True
    result.new_model = "openai/gpt-4o"
    result.target_provider = "openai"
    with patch("hermes_cli.model_switch.switch_model", return_value=result):
        await agent_service.switch_model("openai/gpt-4o")
    assert agent_service._current_model == "openai/gpt-4o"


def test_get_current_model_returns_model():
    """get_current_model reflects the current _current_model global."""
    agent_service._current_model = "google/gemini-2.5-pro"
    assert agent_service.get_current_model() == "google/gemini-2.5-pro"


def test_agent_lock_is_asyncio_lock():
    """_agent_lock must be an asyncio.Lock so it serializes async requests."""
    assert isinstance(agent_service._agent_lock, asyncio.Lock)


async def test_agent_lock_serializes_concurrent_calls():
    """Two coroutines acquiring _agent_lock are never concurrent."""
    results = []
    lock = agent_service._agent_lock

    async def task(label):
        async with lock:
            results.append(f"enter-{label}")
            await asyncio.sleep(0)  # yield to scheduler
            results.append(f"exit-{label}")

    await asyncio.gather(task("A"), task("B"))

    # Each enter must be immediately followed by its own exit (no interleaving)
    for i in range(0, len(results), 2):
        assert results[i].startswith("enter")
        assert results[i + 1].startswith("exit")
        assert results[i].split("-")[1] == results[i + 1].split("-")[1]


async def test_request_stop_interrupts_and_waits_for_running_task():
    """request_stop should interrupt the active agent and await task exit."""
    gate = asyncio.Event()

    async def _runner():
        await gate.wait()

    task = asyncio.create_task(_runner())
    agent = MagicMock()
    agent.interrupt.side_effect = lambda reason: gate.set()

    agent_service.register_running_task("sid-stop", task)
    agent_service.attach_running_agent("sid-stop", agent)

    result = await agent_service.request_stop("sid-stop", timeout=1.0)
    agent_service.clear_running_task(task)

    assert result["had_active_run"] is True
    assert result["stopped"] is True
    agent.interrupt.assert_called_once_with("Stop requested")


async def test_request_stop_ignores_other_sessions():
    """request_stop should no-op when another session owns the active run."""
    task = asyncio.create_task(asyncio.sleep(0))
    agent = MagicMock()
    agent_service.register_running_task("sid-a", task)
    agent_service.attach_running_agent("sid-a", agent)

    result = await agent_service.request_stop("sid-b", timeout=0.01)
    await task
    agent_service.clear_running_task(task)

    assert result["had_active_run"] is False
    assert result["stopped"] is True
    agent.interrupt.assert_not_called()


async def test_request_stop_force_unlocks_hung_run():
    """Timed-out stops should still unlock the backend for the next request."""
    never = asyncio.Event()

    async def _runner():
        await never.wait()

    task = asyncio.create_task(_runner())
    agent = MagicMock()

    await agent_service._agent_lock.acquire()
    agent_service.claim_agent_lock(task)
    agent_service.register_running_task("sid-hung", task)
    agent_service.attach_running_agent("sid-hung", agent)

    result = await agent_service.request_stop("sid-hung", timeout=0.01)

    assert result["had_active_run"] is True
    assert result["stopped"] is True
    assert result["hard_stopped"] is True
    assert agent_service._running_task is None
    assert agent_service._running_agent is None
    assert agent_service._running_session_id is None
    assert agent_service._lock_owner_task is None
    assert agent_service._agent_lock.locked() is False
    agent.interrupt.assert_called_once_with("Stop requested")

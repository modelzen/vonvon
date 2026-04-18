"""Tests for chat endpoints."""
import asyncio
import threading

import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "model" in data
    assert "hermes_home" in data


def test_list_models(client):
    resp = client.get("/api/models")
    assert resp.status_code == 200
    data = resp.json()
    # v1.1: response shape changed to {providers, current, current_provider}
    assert "providers" in data
    assert "current" in data
    assert "current_provider" in data
    assert isinstance(data["providers"], list)


def test_switch_model(client):
    resp = client.post("/api/models/current", json={"model": "openai/gpt-4o"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["model"] == "openai/gpt-4o"


def test_send_message_sse(client, mock_agent):
    """Test that /api/chat/send returns SSE events including run.completed."""
    resp = client.post(
        "/api/chat/send",
        json={"session_id": "test-session-123", "message": "Hello"},
        headers={"Accept": "text/event-stream"},
    )
    assert resp.status_code == 200
    body = resp.text
    assert "run.completed" in body
    assert "final_response" in body or "output" in body


def test_send_message_sse_strips_empty_output_placeholder(client, mock_agent):
    mock_agent.run_conversation.return_value = {
        "final_response": "(empty)",
        "last_prompt_tokens": 500,
        "total_tokens": 1000,
        "completed": True,
        "messages": [],
    }

    resp = client.post(
        "/api/chat/send",
        json={"session_id": "test-session-123", "message": "Hello"},
        headers={"Accept": "text/event-stream"},
    )

    assert resp.status_code == 200
    body = resp.text
    assert "run.completed" in body
    assert "(empty)" not in body


def test_send_message_expands_inline_skills_before_agent_run(client, mock_agent):
    with patch(
        "app.routes.chat.skills_service.extract_inline_skills",
        return_value=(["Checkpoint"], "save current state"),
    ), patch(
        "app.routes.chat.skills_service.build_skill_turn_message",
        return_value=("skill prompt + user instruction", ["Checkpoint"], []),
    ):
        resp = client.post(
            "/api/chat/send",
            json={
                "session_id": "test-session-123",
                "message": '@skill:checkpoint save current state',
            },
            headers={"Accept": "text/event-stream"},
        )

    assert resp.status_code == 200
    assert mock_agent.run_conversation.called
    kwargs = mock_agent.run_conversation.call_args.kwargs
    assert kwargs["user_message"] == "skill prompt + user instruction"
    assert kwargs["persist_user_message"] == '@skill:checkpoint save current state'


def test_send_message_can_persist_display_text_without_sending_it_to_agent(client, mock_agent):
    with patch(
        "app.routes.chat.skills_service.build_skill_turn_message",
        return_value=("skill prompt only", ["vonvon-inspect"], []),
    ):
        resp = client.post(
            "/api/chat/send",
            json={
                "session_id": "test-session-123",
                "message": "",
                "persist_message": "【vonvon-inspect】",
                "skills": ["vonvon-inspect"],
                "attachments": [
                    {
                        "type": "image",
                        "data_url": "data:image/png;base64,ZmFrZQ==",
                        "name": "vonvon-inspect-lark.png",
                    }
                ],
            },
            headers={"Accept": "text/event-stream"},
        )

    assert resp.status_code == 200
    kwargs = mock_agent.run_conversation.call_args.kwargs
    assert kwargs["persist_user_message"] == "【vonvon-inspect】 [图片:vonvon-inspect-lark.png]"
    assert "【vonvon-inspect】" not in str(kwargs["user_message"])


def test_send_message_interrupts_agent_when_sse_client_disconnects(mock_session_db, mock_agent):
    """Disconnecting the SSE client should interrupt the running agent."""
    from app.routes.chat import send_message
    from app.schemas import ChatRequest

    stop_event = threading.Event()

    def _run_conversation(*args, **kwargs):
        stop_event.wait(timeout=2.0)
        return {
            "final_response": "late response",
            "last_prompt_tokens": 500,
            "total_tokens": 1000,
            "completed": True,
            "messages": [],
        }

    def _interrupt(reason: str):
        stop_event.set()

    class _DisconnectingRequest:
        def __init__(self):
            self._checks = 0

        async def is_disconnected(self) -> bool:
            self._checks += 1
            return self._checks >= 2

    mock_agent.run_conversation.side_effect = _run_conversation
    mock_agent.interrupt.side_effect = _interrupt

    async def _collect_chunks():
        response = await send_message(
            ChatRequest(session_id="test-session-123", message="Hello"),
            _DisconnectingRequest(),
        )
        chunks = []
        async for chunk in response._gen:
            chunks.append(chunk)
        return chunks

    chunks = asyncio.run(_collect_chunks())

    mock_agent.interrupt.assert_called_once_with("SSE client disconnected")
    assert all("run.completed" not in str(chunk) for chunk in chunks)


def test_compress_context(client, mock_session_db):
    """Test /api/chat/compress returns usage after compression."""
    import sys
    mock_compressor = MagicMock()
    mock_compressor.compress.return_value = [
        {"role": "user", "content": "[compressed]"},
        {"role": "assistant", "content": "Summary"},
    ]
    # ContextCompressor is imported locally inside compress_context(), so patch
    # the module attribute directly (not the route-module namespace).
    sys.modules["agent.context_compressor"].ContextCompressor.return_value = mock_compressor

    resp = client.post(
        "/api/chat/compress",
        json={"session_id": "test-session-123"},
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["compressed"] is True
    assert "usage_percent" in data

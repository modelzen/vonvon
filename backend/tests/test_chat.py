"""Tests for chat endpoints."""
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
    assert "models" in data
    assert "current" in data
    assert isinstance(data["models"], list)
    assert len(data["models"]) > 0


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

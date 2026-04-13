"""Tests for session CRUD endpoints."""
import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient


def test_list_sessions(client):
    resp = client.get("/api/sessions")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["id"] == "session-1"


def test_list_sessions_with_include_archived(client, mock_session_db):
    resp = client.get("/api/sessions?include_archived=true")
    assert resp.status_code == 200
    mock_session_db.list_sessions_rich.assert_called_with(
        source="vonvon",
        include_archived=True,
        archived_only=False,
    )


def test_create_session(client, mock_session_db):
    resp = client.post("/api/sessions", json={"name": "My New Session"})
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "My New Session"
    assert "id" in data
    mock_session_db.create_session.assert_called_once()
    mock_session_db.set_session_title.assert_called_once()


def test_reset_session(client, mock_session_db):
    resp = client.post("/api/sessions/session-1/reset")
    assert resp.status_code == 200
    data = resp.json()
    assert data["reset"] is True
    mock_session_db.clear_messages.assert_called_once_with("session-1")


def test_delete_session(client, mock_session_db):
    resp = client.delete("/api/sessions/session-1")
    assert resp.status_code == 204
    mock_session_db.delete_session.assert_called_once_with("session-1")


def test_delete_session_not_found(client, mock_session_db):
    mock_session_db.delete_session.return_value = False
    resp = client.delete("/api/sessions/nonexistent")
    assert resp.status_code == 404


def test_archive_session(client, mock_session_db):
    resp = client.post("/api/sessions/session-1/archive")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == "session-1"
    assert data["archived"] is True
    assert data["archived_at"] == 1700000100.0
    mock_session_db.archive_session.assert_called_once_with("session-1")


def test_archive_session_not_found(client, mock_session_db):
    mock_session_db.archive_session.return_value = None
    resp = client.post("/api/sessions/nonexistent/archive")
    assert resp.status_code == 404


def test_restore_session(client, mock_session_db):
    resp = client.post("/api/sessions/session-1/restore")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == "session-1"
    assert data["archived"] is False
    mock_session_db.restore_session.assert_called_once_with("session-1")


def test_restore_session_not_found(client, mock_session_db):
    mock_session_db.restore_session.return_value = False
    resp = client.post("/api/sessions/nonexistent/restore")
    assert resp.status_code == 404


def test_get_usage(client):
    resp = client.get("/api/sessions/session-1/usage")
    assert resp.status_code == 200
    data = resp.json()
    assert "usage_percent" in data
    assert "total_tokens" in data
    assert "context_size" in data

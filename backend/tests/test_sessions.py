"""Tests for session CRUD endpoints."""

import asyncio
from unittest.mock import call

import pytest

from app.services import agent_service, session_service

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


def test_list_sessions_falls_back_for_legacy_session_db(monkeypatch):
    class LegacySessionDB:
        def __init__(self):
            self.calls = []

        def list_sessions_rich(self, source="vonvon", **kwargs):
            self.calls.append((source, kwargs))
            if kwargs:
                bad_key = next(iter(kwargs))
                raise TypeError(
                    f"SessionDB.list_sessions_rich() got an unexpected keyword argument '{bad_key}'"
                )
            return [
                {"id": "active-1", "title": "Active", "archived_at": None},
                {"id": "archived-1", "title": "Archived", "archived_at": 1700000000.0},
            ]

    legacy_db = LegacySessionDB()
    monkeypatch.setattr(agent_service, "_session_db", legacy_db)

    active_only = session_service.list_sessions()
    archived_only = session_service.list_sessions(archived_only=True)
    include_archived = session_service.list_sessions(include_archived=True)

    assert [session["id"] for session in active_only] == ["active-1"]
    assert [session["id"] for session in archived_only] == ["archived-1"]
    assert [session["id"] for session in include_archived] == ["active-1", "archived-1"]
    assert legacy_db.calls == [
        ("vonvon", {"include_archived": False, "archived_only": False}),
        ("vonvon", {}),
        ("vonvon", {"include_archived": True, "archived_only": True}),
        ("vonvon", {}),
        ("vonvon", {"include_archived": True, "archived_only": False}),
        ("vonvon", {}),
    ]


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


def test_rename_session_conflict_returns_409(client, mock_session_db):
    mock_session_db.set_session_title.side_effect = ValueError(
        "Title 'Taken Title' is already in use by session other-session"
    )

    resp = client.patch("/api/sessions/session-1", json={"name": "Taken Title"})

    assert resp.status_code == 409
    assert "already in use" in resp.json()["detail"]


def test_list_sessions_rewrites_empty_placeholder_title(client, mock_session_db):
    mock_session_db.list_sessions_rich.return_value = [
        {
            "id": "session-1",
            "title": "(empty) #2",
            "source": "vonvon",
            "last_active": 1700000000.0,
        }
    ]
    mock_session_db.get_messages_as_conversation.return_value = [
        {"role": "user", "content": "Hello there"},
        {"role": "assistant", "content": "(empty)"},
    ]

    resp = client.get("/api/sessions")

    assert resp.status_code == 200
    data = resp.json()
    assert data[0]["title"] == "Hello there #2"


def test_get_messages_strips_empty_assistant_placeholder(mock_session_db):
    mock_session_db.get_messages_as_conversation.return_value = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "(empty)"},
        {"role": "assistant", "content": "Actual reply"},
    ]

    messages = session_service.get_messages("session-1")

    assert messages[0]["content"] == "Hello"
    assert messages[1]["content"] == ""
    assert messages[2]["content"] == "Actual reply"


@pytest.mark.asyncio
async def test_summarize_title_conflict_gets_numbered(mock_session_db, mock_agent):
    agent_service._agent_lock = asyncio.Lock()
    mock_agent.run_conversation.return_value = {
        "final_response": "飞书上下文识别",
    }
    mock_session_db.get_next_title_in_lineage.return_value = "飞书上下文识别 #2"

    def set_title(session_id, title):
        if session_id == "session-1" and title == "飞书上下文识别":
            raise ValueError(
                "Title '飞书上下文识别' is already in use by session existing-session"
            )
        return True

    mock_session_db.set_session_title.side_effect = set_title

    title = await session_service.summarize_title("session-1")

    assert title == "飞书上下文识别 #2"
    mock_session_db.get_next_title_in_lineage.assert_called_once_with("飞书上下文识别")
    assert mock_session_db.set_session_title.call_args_list == [
        call("session-1", "飞书上下文识别"),
        call("session-1", "飞书上下文识别 #2"),
    ]


@pytest.mark.asyncio
async def test_summarize_title_empty_placeholder_falls_back_to_first_user_text(
    mock_session_db,
    mock_agent,
):
    agent_service._agent_lock = asyncio.Lock()
    mock_session_db.get_messages_as_conversation.return_value = [
        {"role": "user", "content": "Hello there"},
        {"role": "assistant", "content": "(empty)"},
    ]
    mock_agent.run_conversation.return_value = {
        "final_response": "(empty)",
    }

    title = await session_service.summarize_title("session-1")

    assert title == "Hello there"
    mock_session_db.set_session_title.assert_called_with("session-1", "Hello there")

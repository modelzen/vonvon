"""pytest fixtures for vonvon backend tests.

All hermes-agent and sse_starlette modules are stubbed in sys.modules BEFORE
any app import, so tests run without a real hermes installation or LLM.
"""
import sys
import asyncio
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from starlette.responses import Response

# ─── 1. Stub external modules BEFORE any app import ───────────────────────────
# IMPORTANT: these must run at module level so that when conftest is collected,
# the stubs are in place before any `from app.X import Y` in test files.

# Minimal EventSourceResponse: extends Response so FastAPI skips jsonable_encoder.
# Collects SSE chunks so TestClient can read the response body.
class _FakeEventSourceResponse(Response):
    def __init__(self, content):
        super().__init__(media_type="text/event-stream")
        self._gen = content  # async generator from event_generator()

    async def __call__(self, scope, receive, send):
        chunks = []
        async for chunk in self._gen:
            chunks.append(chunk.encode() if isinstance(chunk, str) else chunk)
        body = b"".join(chunks)
        await send({
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/event-stream; charset=utf-8")],
        })
        await send({"type": "http.response.body", "body": body, "more_body": False})


_sse_sse = MagicMock()
_sse_sse.EventSourceResponse = _FakeEventSourceResponse
sys.modules.setdefault("sse_starlette", MagicMock())
sys.modules.setdefault("sse_starlette.sse", _sse_sse)

sys.modules.setdefault("run_agent", MagicMock())
sys.modules.setdefault("hermes_state", MagicMock())
sys.modules.setdefault("hermes_cli", MagicMock())
# load_config must return a plain dict so init_from_hermes_config() doesn't
# accidentally set _current_model to a MagicMock (breaks Pydantic serialisation).
_hermes_cli_config = MagicMock()
_hermes_cli_config.load_config = MagicMock(return_value={})
sys.modules.setdefault("hermes_cli.config", _hermes_cli_config)

_model_meta = MagicMock()
_model_meta.get_model_context_length = MagicMock(return_value=200_000)
_model_meta.estimate_tokens_rough = MagicMock(side_effect=lambda t: max(1, len(t) // 4))
_ctx_compressor = MagicMock()
sys.modules.setdefault("agent", MagicMock())
sys.modules.setdefault("agent.model_metadata", _model_meta)
sys.modules.setdefault("agent.context_compressor", _ctx_compressor)

# ─── 2. App imports (safe after stubs) ────────────────────────────────────────
from app.main import app  # noqa: E402
from app.services import agent_service  # noqa: E402

# ─── 3. Fixtures ──────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _reset_agent_service():
    """Restore agent_service module-level globals between tests."""
    saved = (
        agent_service._session_db,
        agent_service._current_model,
        agent_service._base_url,
        agent_service._api_key,
    )
    yield
    (
        agent_service._session_db,
        agent_service._current_model,
        agent_service._base_url,
        agent_service._api_key,
    ) = saved


@pytest.fixture
def mock_session_db():
    """Mock SessionDB injected into agent_service."""
    db = MagicMock()
    db.list_sessions_rich.return_value = [
        {
            "id": "session-1",
            "title": "Test Session",
            "source": "vonvon",
            "model": "anthropic/claude-sonnet-4-20250514",
            "message_count": 2,
            "last_active": 1700000000.0,
        }
    ]
    db.get_messages_as_conversation.return_value = [
        {"role": "user", "content": "Hello"},
        {"role": "assistant", "content": "Hi there!"},
    ]
    db.create_session.return_value = "session-new"
    db.set_session_title.return_value = True
    db.clear_messages.return_value = None
    db.delete_session.return_value = True
    db.replace_messages.return_value = None
    agent_service._session_db = db
    return db


@pytest.fixture
def mock_agent(mock_session_db):
    """Patch agent_service.create_agent with a controllable mock AIAgent.

    Callbacks passed to create_agent are stored on inst._callbacks so tests
    can invoke them to simulate streaming / tool events.
    """
    inst = MagicMock()
    inst.session_id = "test-session-123"
    inst.run_conversation.return_value = {
        "final_response": "Hello from mock agent",
        "last_prompt_tokens": 500,
        "total_tokens": 1000,
        "completed": True,
        "messages": [],
    }

    def _create(session_id, **callbacks):
        inst._callbacks = callbacks
        inst.session_id = session_id
        return inst

    with patch("app.services.agent_service.create_agent", side_effect=_create):
        with patch.object(agent_service, "get_model_context_size", return_value=200_000):
            yield inst


@pytest.fixture
def app_with_mocks(mock_agent, mock_session_db):
    """App fixture that ensures both agent and session DB are mocked."""
    yield app


@pytest.fixture
def client(mock_session_db):
    """FastAPI TestClient with mocked SessionDB."""
    with patch.object(agent_service, "get_model_context_size", return_value=200_000):
        with TestClient(app, raise_server_exceptions=True) as c:
            yield c

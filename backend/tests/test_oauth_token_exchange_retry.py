"""AC-A12: 5xx token exchange retry tests for codex_device_flow pure functions.

Loads the real codex_device_flow module from file (bypassing sys.modules["agent"]
mock set by conftest) so we exercise the actual implementation.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys
from unittest.mock import MagicMock

import httpx
import pytest

# ── Load real codex_device_flow from file, bypassing agent mock ───────────────
_HERMES_ROOT = pathlib.Path(__file__).parents[1] / "hermes-agent"

# Provide hermes_cli.auth stubs needed by codex_device_flow
_auth_stub = MagicMock()
_auth_stub.CODEX_OAUTH_CLIENT_ID = "app_testclient"
_auth_stub.CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
_auth_stub.DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"

class _AuthError(RuntimeError):
    def __init__(self, msg, *, provider, code):
        super().__init__(msg)
        self.provider = provider
        self.code = code

_auth_stub.AuthError = _AuthError
# Override any existing hermes_cli.auth stub so our module loads correctly
sys.modules["hermes_cli.auth"] = _auth_stub

# Load module directly from path so we get the real implementation
_spec = importlib.util.spec_from_file_location(
    "_codex_device_flow_real",
    _HERMES_ROOT / "agent" / "codex_device_flow.py",
)
_real_flow = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_real_flow)

start_device_flow = _real_flow.start_device_flow
poll_device_flow = _real_flow.poll_device_flow
_try_token_exchange = _real_flow._try_token_exchange


# ── helpers ───────────────────────────────────────────────────────────────────

def _mock_transport(status_code: int, body: dict | None = None):
    """Returns an httpx.MockTransport that always responds with `status_code`."""
    import json as _json

    def handler(request):
        content = _json.dumps(body or {}).encode()
        return httpx.Response(
            status_code, content=content,
            headers={"content-type": "application/json"},
        )

    return httpx.MockTransport(handler)


def _patched_client(transport):
    """Return a context-manager-compatible httpx.Client using the given transport."""
    return httpx.Client(transport=transport)


# ── _try_token_exchange ───────────────────────────────────────────────────────

def test_try_token_exchange_5xx_returns_pending():
    """AC-A12: 5xx from token endpoint → status=pending with pending_exchange."""
    transport = _mock_transport(503)
    original_client = httpx.Client

    class _PatchedClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(transport=transport)

    _real_flow.httpx.Client = _PatchedClient
    try:
        result = _try_token_exchange("auth_code_abc", "verifier_xyz")
    finally:
        _real_flow.httpx.Client = original_client

    assert result["status"] == "pending"
    assert "pending_exchange" in result
    assert result["pending_exchange"]["authorization_code"] == "auth_code_abc"
    assert result["pending_exchange"]["code_verifier"] == "verifier_xyz"


def test_try_token_exchange_success():
    body = {"access_token": "tok_xyz", "refresh_token": "ref_abc"}
    transport = _mock_transport(200, body)
    original_client = httpx.Client

    class _PatchedClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(transport=transport)

    _real_flow.httpx.Client = _PatchedClient
    try:
        result = _try_token_exchange("auth_code_abc", "verifier_xyz")
    finally:
        _real_flow.httpx.Client = original_client

    assert result["status"] == "success"
    assert result["tokens"]["access_token"] == "tok_xyz"


def test_try_token_exchange_4xx_returns_error():
    transport = _mock_transport(400, {"error": "invalid_grant"})
    original_client = httpx.Client

    class _PatchedClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(transport=transport)

    _real_flow.httpx.Client = _PatchedClient
    try:
        result = _try_token_exchange("bad_code", "bad_verifier")
    finally:
        _real_flow.httpx.Client = original_client

    assert result["status"] == "error"
    assert "400" in result["error"]


def test_try_token_exchange_no_access_token_returns_error():
    transport = _mock_transport(200, {"refresh_token": "only_refresh"})
    original_client = httpx.Client

    class _PatchedClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(transport=transport)

    _real_flow.httpx.Client = _PatchedClient
    try:
        result = _try_token_exchange("code", "verifier")
    finally:
        _real_flow.httpx.Client = original_client

    assert result["status"] == "error"
    assert "no_access_token" in result["error"]


# ── poll_device_flow with pending_exchange fast path ─────────────────────────

def test_poll_fast_path_retries_exchange_on_5xx_then_pending():
    """If pending_exchange is supplied, poll goes straight to token exchange.
    If that exchange 5xxes, we get pending+pending_exchange back again."""
    transport = _mock_transport(503)
    original_client = httpx.Client

    class _PatchedClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(transport=transport)

    _real_flow.httpx.Client = _PatchedClient
    try:
        result = poll_device_flow(
            "dev_id", "user_code",
            pending_exchange={"authorization_code": "code1", "code_verifier": "v1"},
        )
    finally:
        _real_flow.httpx.Client = original_client

    assert result["status"] == "pending"
    assert result["pending_exchange"]["authorization_code"] == "code1"


def test_poll_device_flow_pending_on_403():
    """403 from poll endpoint → status=pending (user hasn't logged in yet)."""
    transport = _mock_transport(403)
    original_client = httpx.Client

    class _PatchedClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(transport=transport)

    _real_flow.httpx.Client = _PatchedClient
    try:
        result = poll_device_flow("dev_id", "user_code")
    finally:
        _real_flow.httpx.Client = original_client

    assert result["status"] == "pending"


def test_poll_device_flow_5xx_device_endpoint_returns_pending():
    """5xx from device poll endpoint → status=pending (transient error)."""
    transport = _mock_transport(500)
    original_client = httpx.Client

    class _PatchedClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(transport=transport)

    _real_flow.httpx.Client = _PatchedClient
    try:
        result = poll_device_flow("dev_id", "user_code")
    finally:
        _real_flow.httpx.Client = original_client

    assert result["status"] == "pending"


def test_poll_device_flow_non_200_non_5xx_returns_error():
    transport = _mock_transport(401)
    original_client = httpx.Client

    class _PatchedClient(httpx.Client):
        def __init__(self, **kwargs):
            super().__init__(transport=transport)

    _real_flow.httpx.Client = _PatchedClient
    try:
        result = poll_device_flow("dev_id", "user_code")
    finally:
        _real_flow.httpx.Client = original_client

    assert result["status"] == "error"
    assert "401" in result["error"]

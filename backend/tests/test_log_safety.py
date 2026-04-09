"""AC-C11: Log safety — no secret material in structured logs.

Grep captured log records for the following patterns (all must be 0 occurrences):
  sk-  sk_  refresh_token  access_token  eyJ[A-Za-z0-9_-]{20,}  Bearer   oauth_token
"""
import asyncio
import logging
import re
from unittest.mock import MagicMock, patch

import pytest

# ── Secret patterns to assert absent from all log records ────────────────────

SECRET_PATTERNS = [
    re.compile(r'sk-'),
    re.compile(r'sk_'),
    re.compile(r'refresh_token\s*[:=]\s*\S+'),
    re.compile(r'access_token\s*[:=]\s*\S+'),
    re.compile(r'eyJ[A-Za-z0-9_-]{20,}'),      # JWT prefix
    re.compile(r'Bearer\s+\S+'),
    re.compile(r'oauth_token\s*[:=]\s*\S+'),
]

FAKE_API_KEY = 'sk-test1234567890abcdef'
FAKE_JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIn0.fake_sig'
FAKE_REFRESH = 'refresh_token_value_secret_xyz'


def _assert_no_secrets(caplog_records: list) -> None:
    for record in caplog_records:
        msg = record.getMessage()
        for pat in SECRET_PATTERNS:
            assert not pat.search(msg), (
                f"Secret pattern '{pat.pattern}' found in log: {msg!r}"
            )


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_add_api_key_does_not_log_secret(caplog):
    """Adding an API key credential must not log the key value."""
    from app.services import auth_service

    mock_pool = MagicMock()
    mock_pool.entries.return_value = []
    mock_entry = MagicMock()
    mock_entry.id = 'cred-001'
    mock_entry.label = 'api-key-1'
    mock_entry.auth_type = 'api_key'
    mock_entry.access_token = FAKE_API_KEY
    mock_entry.source = 'manual'
    mock_entry.last_status = None
    mock_entry.base_url = ''

    with patch('app.services.auth_service.load_pool', return_value=mock_pool), \
         patch('app.services.auth_service.PooledCredential', return_value=mock_entry):
        with caplog.at_level(logging.DEBUG, logger='app.services.auth_service'):
            asyncio.run(auth_service.add_api_key_credential(
                provider='openai',
                api_key=FAKE_API_KEY,
                label='test',
                base_url=None,
            ))

    _assert_no_secrets(caplog.records)


def test_oauth_flow_start_does_not_log_token(caplog):
    """Starting an OAuth flow must not log any token/secret material."""
    from app.services import auth_service

    fake_start = {
        'device_auth_id': 'device-id-123',
        'user_code': 'ABCD-1234',
        'verification_url': 'https://auth.openai.com/codex/device',
        'interval': 5,
    }
    with patch('app.services.auth_service.start_device_flow', return_value=fake_start):
        with caplog.at_level(logging.DEBUG, logger='app.services.auth_service'):
            asyncio.run(auth_service.start_codex_oauth_flow())

    _assert_no_secrets(caplog.records)


def test_credential_persistence_does_not_log_token(caplog):
    """Persisting OAuth credential must not log access_token or refresh_token."""
    from app.services import auth_service
    from app.services.auth_service import OAuthFlowState
    import time

    fake_flow_id = 'flow-abc-123'
    state = OAuthFlowState(
        flow_id=fake_flow_id,
        provider='openai-codex',
        device_auth_id='dev-id',
        user_code='AAAA-1111',
        verification_url='https://auth.openai.com/codex/device',
        interval=5,
        started_at=time.time(),
    )
    auth_service._active_flows[fake_flow_id] = state

    mock_result = {
        'status': 'success',
        'tokens': {'access_token': FAKE_JWT, 'refresh_token': FAKE_REFRESH},
        'base_url': 'https://api.openai.com',
        'last_refresh': '2026-04-09T00:00:00Z',
    }
    mock_pool = MagicMock()
    mock_pool.entries.return_value = []
    mock_entry = MagicMock()
    mock_entry.id = 'cred-001'
    mock_entry.label = 'openai-codex-oauth-1'
    mock_entry.auth_type = 'oauth'
    mock_entry.access_token = FAKE_JWT
    mock_entry.source = 'manual:device_code'
    mock_entry.last_status = None
    mock_entry.base_url = ''

    with patch('app.services.auth_service.poll_device_flow', return_value=mock_result), \
         patch('app.services.auth_service.load_pool', return_value=mock_pool), \
         patch('app.services.auth_service.PooledCredential', return_value=mock_entry), \
         patch('app.services.auth_service.label_from_token', return_value='openai-codex-oauth-1'):
        with caplog.at_level(logging.DEBUG, logger='app.services.auth_service'):
            asyncio.run(auth_service.poll_codex_oauth_flow(fake_flow_id))

    auth_service._active_flows.pop(fake_flow_id, None)
    _assert_no_secrets(caplog.records)


def test_mcp_probe_failure_does_not_log_secret(caplog):
    """MCP probe failure log must not expose any config secrets."""
    from app.services import mcp_service

    with patch('app.services.mcp_service._probe_single_server',
               side_effect=Exception('connection refused')), \
         patch('app.services.mcp_service._get_mcp_servers',
               return_value={'fs': {'url': 'http://localhost:3000'}}):
        with caplog.at_level(logging.DEBUG, logger='app.services.mcp_service'):
            asyncio.run(mcp_service.probe_server('fs'))

    _assert_no_secrets(caplog.records)


def test_no_secrets_in_workspace_logs(caplog):
    """Workspace set/reset logs must not contain any secret-like content."""
    from app.services import workspace_service

    with patch('app.services.workspace_service._set_workspace_sync',
               return_value={'path': '/tmp/proj', 'exists': True, 'is_dir': True, 'is_sandbox': False}):
        with caplog.at_level(logging.DEBUG, logger='app.services.workspace_service'):
            asyncio.run(workspace_service.set_workspace('/tmp/proj'))

    _assert_no_secrets(caplog.records)

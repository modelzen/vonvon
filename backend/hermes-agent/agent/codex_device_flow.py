"""Pure-function Codex device flow — start/poll split for non-blocking UI use."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx
from hermes_cli.auth import (  # reuse existing constants
    CODEX_OAUTH_CLIENT_ID,
    CODEX_OAUTH_TOKEN_URL,
    DEFAULT_CODEX_BASE_URL,
    AuthError,
)

ISSUER = "https://auth.openai.com"
POLL_ENDPOINT = f"{ISSUER}/api/accounts/deviceauth/token"
USERCODE_ENDPOINT = f"{ISSUER}/api/accounts/deviceauth/usercode"
VERIFICATION_URL = f"{ISSUER}/codex/device"


def start_device_flow() -> Dict[str, Any]:
    """POST /usercode and return {device_auth_id, user_code, verification_url, interval}.
    Non-blocking: single HTTP call, <15s."""
    with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
        resp = client.post(
            USERCODE_ENDPOINT,
            json={"client_id": CODEX_OAUTH_CLIENT_ID},
            headers={"Content-Type": "application/json"},
        )
    if resp.status_code != 200:
        raise AuthError(
            f"Device code request status {resp.status_code}",
            provider="openai-codex",
            code="device_code_request_error",
        )
    data = resp.json()
    return {
        "device_auth_id": data["device_auth_id"],
        "user_code": data["user_code"],
        "verification_url": VERIFICATION_URL,
        "interval": max(3, int(data.get("interval", 5))),
    }


def poll_device_flow(
    device_auth_id: str,
    user_code: str,
    pending_exchange: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Single poll. Returns {status: 'pending'|'success'|'error', ...}.

    If token exchange returns a 5xx, returns
    `{status: "pending", pending_exchange: {authorization_code, code_verifier}}`
    so the next poll can retry the exchange without restarting the flow.
    Callers (auth_service) MUST carry `pending_exchange` back into the
    next poll call via OAuthFlowState.
    """
    # Fast path: retrying a prior token exchange
    if pending_exchange:
        return _try_token_exchange(
            pending_exchange["authorization_code"],
            pending_exchange["code_verifier"],
        )

    # Normal path: poll device endpoint first
    with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
        resp = client.post(
            POLL_ENDPOINT,
            json={"device_auth_id": device_auth_id, "user_code": user_code},
            headers={"Content-Type": "application/json"},
        )
    if resp.status_code in (403, 404):
        return {"status": "pending"}
    if resp.status_code >= 500:
        # Device endpoint 5xx — transient; keep polling
        return {"status": "pending"}
    if resp.status_code != 200:
        return {"status": "error", "error": f"poll_status_{resp.status_code}"}

    code_resp = resp.json()
    auth_code = code_resp.get("authorization_code", "")
    verifier = code_resp.get("code_verifier", "")
    if not auth_code or not verifier:
        return {"status": "error", "error": "device_code_incomplete_exchange"}

    return _try_token_exchange(auth_code, verifier)


def _try_token_exchange(authorization_code: str, code_verifier: str) -> Dict[str, Any]:
    """Exchange authorization_code for tokens. On 5xx return pending
    with the exchange params so the caller can retry next poll."""
    with httpx.Client(timeout=httpx.Timeout(15.0)) as client:
        tok_resp = client.post(
            CODEX_OAUTH_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": authorization_code,
                "redirect_uri": f"{ISSUER}/deviceauth/callback",
                "client_id": CODEX_OAUTH_CLIENT_ID,
                "code_verifier": code_verifier,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if tok_resp.status_code >= 500:
        return {
            "status": "pending",
            "pending_exchange": {
                "authorization_code": authorization_code,
                "code_verifier": code_verifier,
            },
        }
    if tok_resp.status_code != 200:
        return {"status": "error", "error": f"token_exchange_status_{tok_resp.status_code}"}
    tokens = tok_resp.json()
    if not tokens.get("access_token"):
        return {"status": "error", "error": "token_exchange_no_access_token"}
    base_url = (
        os.getenv("HERMES_CODEX_BASE_URL", "").strip().rstrip("/")
        or DEFAULT_CODEX_BASE_URL
    )
    return {
        "status": "success",
        "tokens": {
            "access_token": tokens["access_token"],
            "refresh_token": tokens.get("refresh_token", ""),
        },
        "base_url": base_url,
        "last_refresh": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "auth_mode": "chatgpt",
        "source": "device-code",
    }

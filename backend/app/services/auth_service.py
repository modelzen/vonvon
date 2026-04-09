"""Thin adapter over hermes credential_pool + codex_device_flow.

Stateless except for _active_flows which holds in-flight OAuth sessions
(expired after 15 minutes via TTL check on each access).
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from agent.credential_pool import (
    AUTH_TYPE_API_KEY,
    AUTH_TYPE_OAUTH,
    PooledCredential,
    SOURCE_MANUAL,
    load_pool,
    label_from_token,
)
from agent.codex_device_flow import start_device_flow, poll_device_flow
from hermes_cli.auth import PROVIDER_REGISTRY

logger = logging.getLogger(__name__)

FLOW_TTL_SECONDS = 15 * 60
MAX_CONCURRENT_FLOWS = 8


@dataclass
class OAuthFlowState:
    flow_id: str
    provider: str
    device_auth_id: str
    user_code: str
    verification_url: str
    interval: int
    started_at: float = field(default_factory=time.time)
    status: str = "pending"
    error: Optional[str] = None
    credential_view: Optional[dict] = None
    # Carry authorization_code + code_verifier across polls so that a
    # transient 5xx on /oauth/token can be retried on the next poll
    # without restarting the device-code flow (AC-A12).
    pending_exchange: Optional[Dict[str, str]] = None


_active_flows: Dict[str, OAuthFlowState] = {}
_flows_lock = asyncio.Lock()


def _mask(token: str) -> str:
    return f"...{token[-4:]}" if token and len(token) >= 4 else "..."


def _to_view(provider: str, entry: PooledCredential, *, is_current: bool) -> dict:
    return {
        "id": entry.id,
        "provider": provider,
        "label": entry.label,
        "auth_type": entry.auth_type,
        "last4": _mask(entry.access_token or ""),
        "source": entry.source,
        "status": entry.last_status,
        "is_current": is_current,
    }


async def list_all_credentials() -> List[dict]:
    def _load() -> List[dict]:
        providers = sorted({*PROVIDER_REGISTRY.keys(), "openrouter"})
        out: List[dict] = []
        for provider in providers:
            pool = load_pool(provider)
            entries = pool.entries()
            if not entries:
                continue
            current = pool.peek()
            for entry in entries:
                is_current = current is not None and entry.id == current.id
                out.append(_to_view(provider, entry, is_current=is_current))
        return out

    return await asyncio.to_thread(_load)


async def add_api_key_credential(
    *,
    provider: str,
    api_key: str,
    label: Optional[str] = None,
    base_url: Optional[str] = None,
) -> dict:
    def _add() -> dict:
        p = provider.strip().lower()
        pool = load_pool(p)
        lbl = (label or "").strip() or f"api-key-{len(pool.entries()) + 1}"
        entry = PooledCredential(
            provider=p,
            id=uuid.uuid4().hex[:6],
            label=lbl,
            auth_type=AUTH_TYPE_API_KEY,
            priority=0,
            source=SOURCE_MANUAL,
            access_token=api_key,
            base_url=base_url or "",
        )
        pool.add_entry(entry)
        logger.info("credential_added provider=%s label=%s last4=%s", p, lbl, _mask(api_key))
        return _to_view(p, entry, is_current=False)

    return await asyncio.to_thread(_add)


async def remove_credential(provider: str, cred_id: str) -> bool:
    def _remove() -> bool:
        pool = load_pool(provider)
        index, matched, _ = pool.resolve_target(cred_id)
        if matched is None or index is None:
            return False
        removed = pool.remove_index(index)
        logger.info("credential_removed provider=%s id=%s", provider, cred_id)
        return removed is not None

    return await asyncio.to_thread(_remove)


async def start_codex_oauth_flow() -> dict:
    async with _flows_lock:
        # Purge expired flows
        now = time.time()
        expired = [
            fid for fid, f in _active_flows.items()
            if now - f.started_at > FLOW_TTL_SECONDS
        ]
        for fid in expired:
            _active_flows.pop(fid, None)
        if len(_active_flows) >= MAX_CONCURRENT_FLOWS:
            raise ValueError("too many concurrent OAuth flows; try again later")
        flow = await asyncio.to_thread(start_device_flow)
        fid = uuid.uuid4().hex
        state = OAuthFlowState(
            flow_id=fid,
            provider="openai-codex",
            device_auth_id=flow["device_auth_id"],
            user_code=flow["user_code"],
            verification_url=flow["verification_url"],
            interval=flow["interval"],
        )
        _active_flows[fid] = state
        logger.info("oauth_flow_started flow_id=%s provider=openai-codex", fid)
        return {
            "flow_id": fid,
            "provider": "openai-codex",
            "user_code": flow["user_code"],
            "verification_url": flow["verification_url"],
            "interval": flow["interval"],
            "expires_in_seconds": FLOW_TTL_SECONDS,
        }


async def poll_codex_oauth_flow(flow_id: str) -> dict:
    # Architect iter-2: avoid concurrent double-poll race where two clients
    # simultaneously read the same pending_exchange and both POST to the
    # token endpoint (authorization_code is single-use). Gate each flow to
    # at most one in-flight poll via a transient "polling" status held under
    # _flows_lock (AC-A13).
    async with _flows_lock:
        state = _active_flows.get(flow_id)
        if state is None:
            return {"status": "error", "error": "unknown_or_expired_flow"}
        if time.time() - state.started_at > FLOW_TTL_SECONDS:
            _active_flows.pop(flow_id, None)
            return {"status": "timeout"}
        if state.status in ("success", "error", "timeout"):
            return {
                "status": state.status,
                "credential": state.credential_view,
                "error": state.error,
            }
        if state.status == "polling":
            # Another request is already polling this flow — return pending
            # without making a duplicate OpenAI request (AC-A13 dedup gate).
            return {"status": "pending"}
        state.status = "polling"
        # Snapshot fields under the lock; release before blocking I/O.
        device_auth_id = state.device_auth_id
        user_code = state.user_code
        pending_exchange = dict(state.pending_exchange) if state.pending_exchange else None

    try:
        result = await asyncio.to_thread(
            poll_device_flow, device_auth_id, user_code, pending_exchange
        )
    except Exception as exc:
        async with _flows_lock:
            state.status = "error"
            state.error = f"poll_exception: {exc}"
        return {"status": "error", "error": state.error}

    # Re-acquire lock to mutate state based on result
    async with _flows_lock:
        if result["status"] == "pending":
            pe = result.get("pending_exchange")
            if pe:
                state.pending_exchange = pe
            state.status = "pending"
            return {"status": "pending"}
        if result["status"] == "error":
            state.status = "error"
            state.error = result.get("error")
            logger.info("oauth_flow_error flow_id=%s error=%s", flow_id, state.error)
            return {"status": "error", "error": state.error}
        # Success path — persist credential outside _flows_lock to avoid
        # holding it during fcntl, but mark state transitionally.
        state.status = "finalizing"

    # pool.add_entry grabs its own _auth_store_lock via to_thread
    def _persist_codex_credential() -> Dict[str, Any]:
        pool = load_pool("openai-codex")
        lbl = label_from_token(
            result["tokens"]["access_token"],
            f"openai-codex-oauth-{len(pool.entries()) + 1}",
        )
        entry = PooledCredential(
            provider="openai-codex",
            id=uuid.uuid4().hex[:6],
            label=lbl,
            auth_type=AUTH_TYPE_OAUTH,
            priority=0,
            source=f"{SOURCE_MANUAL}:device_code",
            access_token=result["tokens"]["access_token"],
            refresh_token=result["tokens"].get("refresh_token"),
            base_url=result.get("base_url"),
            last_refresh=result.get("last_refresh"),
        )
        pool.add_entry(entry)
        return _to_view("openai-codex", entry, is_current=False)

    try:
        view = await asyncio.to_thread(_persist_codex_credential)
    except Exception as exc:
        async with _flows_lock:
            state.status = "error"
            state.error = f"credential_persist_failed: {exc}"
        return {"status": "error", "error": state.error}

    async with _flows_lock:
        state.status = "success"
        state.credential_view = view
    logger.info("oauth_flow_success flow_id=%s", flow_id)
    return {"status": "success", "credential": view}


async def cancel_codex_oauth_flow(flow_id: str) -> None:
    async with _flows_lock:
        _active_flows.pop(flow_id, None)

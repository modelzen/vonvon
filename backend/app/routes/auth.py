"""Auth routes — credential CRUD + Codex OAuth device flow."""
from fastapi import APIRouter, HTTPException
from app.services import auth_service
from app.schemas import (
    CredentialCreateRequest,
    CredentialView,
    OAuthStartResponse,
    OAuthPollResponse,
)

router = APIRouter()


@router.get("/api/auth/credentials")
async def list_credentials() -> list[CredentialView]:
    return await auth_service.list_all_credentials()


@router.post("/api/auth/credentials")
async def add_credential(req: CredentialCreateRequest) -> CredentialView:
    if req.auth_type != "api_key":
        raise HTTPException(400, "Use /api/auth/oauth/start for OAuth")
    if not req.api_key:
        raise HTTPException(400, "api_key is required for api_key auth")
    try:
        return await auth_service.add_api_key_credential(
            provider=req.provider,
            api_key=req.api_key,
            label=req.label,
            base_url=req.base_url,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.delete("/api/auth/credentials/{provider}/{cred_id}")
async def remove_credential(provider: str, cred_id: str) -> dict:
    removed = await auth_service.remove_credential(provider, cred_id)
    if not removed:
        raise HTTPException(404, f"no credential {cred_id} for provider {provider}")
    return {"removed": True}


@router.post("/api/auth/oauth/start")
async def oauth_start(provider: str) -> OAuthStartResponse:
    if provider != "openai-codex":
        raise HTTPException(400, "v1.1 only supports openai-codex OAuth")
    try:
        return await auth_service.start_codex_oauth_flow()
    except ValueError as exc:
        raise HTTPException(429, str(exc))


@router.get("/api/auth/oauth/poll")
async def oauth_poll(flow_id: str) -> OAuthPollResponse:
    return await auth_service.poll_codex_oauth_flow(flow_id)


@router.delete("/api/auth/oauth/flows/{flow_id}")
async def oauth_cancel(flow_id: str) -> dict:
    await auth_service.cancel_codex_oauth_flow(flow_id)
    return {"cancelled": True}

"""MCP server management routes."""
from fastapi import APIRouter, HTTPException

from app.schemas import McpServerConfig, McpServerEnabledRequest, McpServerView, McpProbeResult
from app.services import mcp_service

router = APIRouter()


@router.get("/api/mcp/servers")
async def list_servers() -> list[McpServerView]:
    return mcp_service.list_servers()


@router.post("/api/mcp/servers")
async def add_server(cfg: McpServerConfig, probe: bool = True) -> McpServerView:
    try:
        return await mcp_service.add_server(cfg.model_dump(), probe=probe)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.delete("/api/mcp/servers/{name}")
async def remove_server(name: str) -> dict:
    if not await mcp_service.remove_server(name):
        raise HTTPException(404, f"no mcp server named {name}")
    return {"removed": True}


@router.post("/api/mcp/servers/{name}/enabled")
async def set_server_enabled(name: str, req: McpServerEnabledRequest) -> McpServerView:
    try:
        return await mcp_service.set_server_enabled(name, req.enabled)
    except KeyError:
        raise HTTPException(404, f"no mcp server named {name}")


@router.post("/api/mcp/servers/{name}/test")
async def test_server(name: str) -> McpProbeResult:
    return await mcp_service.probe_server(name)

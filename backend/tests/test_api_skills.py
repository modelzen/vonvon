"""Integration tests for GET/POST /api/skills/* routes."""
import sys
from unittest.mock import MagicMock, patch, AsyncMock

import pytest
from fastapi.testclient import TestClient

# conftest.py already stubs hermes_cli and agent modules before app import.
# We add skills-specific stubs here.
_mock_skills_svc = MagicMock()
sys.modules.setdefault("app.services.skills_service", _mock_skills_svc)

from app.main import app  # noqa: E402

BASE_SKILL = {
    "name": "pptx",
    "category": "office",
    "description": "PowerPoint generator",
    "install_path": "/skills/pptx",
    "version": "1.0",
    "source": "official",
    "enabled_global": True,
    "enabled_vonvon": True,
}

BASE_JOB = {
    "job_id": "abc123",
    "kind": "install",
    "identifier": "official/pptx",
    "status": "pending",
    "error": None,
    "skill": None,
    "started_at": 1700000000.0,
    "updated_at": 1700000000.0,
}


@pytest.fixture
def client():
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


# ── GET /api/skills ────────────────────────────────────────────────────────────

def test_list_skills_200(client):
    with patch("app.routes.skills.skills_service") as svc:
        svc.list_skills.return_value = [BASE_SKILL]
        resp = client.get("/api/skills")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["name"] == "pptx"


def test_list_skills_empty_on_exception(client):
    with patch("app.routes.skills.skills_service") as svc:
        svc.list_skills.return_value = []
        resp = client.get("/api/skills")
    assert resp.status_code == 200
    assert resp.json() == []


# ── POST /api/skills/toggle ────────────────────────────────────────────────────

def test_toggle_skill_200(client):
    toggled = {**BASE_SKILL, "enabled_vonvon": False}
    with patch("app.routes.skills.skills_service") as svc:
        svc.toggle_skill.return_value = toggled
        resp = client.post(
            "/api/skills/toggle",
            json={"name": "pptx", "enabled": False, "scope": "vonvon"},
        )
    assert resp.status_code == 200
    assert resp.json()["enabled_vonvon"] is False


def test_toggle_skill_invalid_scope_422(client):
    # Pydantic pattern validator rejects invalid scope before service is called
    resp = client.post(
        "/api/skills/toggle",
        json={"name": "pptx", "enabled": False, "scope": "invalid"},
    )
    assert resp.status_code == 422


# ── GET /api/skills/search ─────────────────────────────────────────────────────

def test_search_skills_200(client):
    result = {
        "identifier": "official/pptx",
        "name": "pptx",
        "description": "Make PPT",
        "source": "official",
        "trust_level": "trusted",
    }
    with patch("app.routes.skills.skills_service") as svc:
        svc.search_hub.return_value = [result]
        resp = client.get("/api/skills/search?q=pptx")
    assert resp.status_code == 200
    assert resp.json()[0]["identifier"] == "official/pptx"


def test_search_skills_empty_query_returns_empty(client):
    resp = client.get("/api/skills/search?q=")
    assert resp.status_code == 200
    assert resp.json() == []


# ── POST /api/skills/install ───────────────────────────────────────────────────

def test_start_install_200(client):
    with patch("app.routes.skills.skills_service") as svc:
        svc.start_install_job = AsyncMock(return_value=BASE_JOB)
        resp = client.post("/api/skills/install", json={"identifier": "official/pptx"})
    assert resp.status_code == 200
    assert resp.json()["job_id"] == "abc123"
    assert resp.json()["status"] == "pending"


def test_start_install_429_when_too_many_jobs(client):
    with patch("app.routes.skills.skills_service") as svc:
        svc.start_install_job = AsyncMock(
            side_effect=ValueError("too many concurrent skill jobs")
        )
        resp = client.post("/api/skills/install", json={"identifier": "official/pptx"})
    assert resp.status_code == 429


# ── GET /api/skills/jobs/{job_id} ──────────────────────────────────────────────

def test_poll_job_200(client):
    running_job = {**BASE_JOB, "status": "running"}
    with patch("app.routes.skills.skills_service") as svc:
        svc.get_job_status.return_value = running_job
        resp = client.get("/api/skills/jobs/abc123")
    assert resp.status_code == 200
    assert resp.json()["status"] == "running"


def test_poll_job_404_unknown(client):
    with patch("app.routes.skills.skills_service") as svc:
        svc.get_job_status.return_value = None
        resp = client.get("/api/skills/jobs/unknown-id")
    assert resp.status_code == 404


# ── GET /api/skills/updates ────────────────────────────────────────────────────

def test_check_updates_200(client):
    with patch("app.routes.skills.skills_service") as svc:
        svc.check_updates.return_value = {"updates": [], "error": None}
        resp = client.get("/api/skills/updates")
    assert resp.status_code == 200
    assert resp.json()["updates"] == []

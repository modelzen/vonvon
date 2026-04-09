"""Adapter over hermes skills: list/toggle/search/install/uninstall.

Install/uninstall are long-running operations (git fetch, file copy, dependency
resolution). They run on a shared ThreadPoolExecutor and expose a start+poll
job API. Jobs are in-memory (same semantics as OAuth flows)."""

import asyncio
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from hermes_cli.config import load_config
from hermes_cli.config_lock import config_store_lock
from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

logger = logging.getLogger(__name__)

FLOW_TTL_SECONDS = 30 * 60
MAX_CONCURRENT_JOBS = 4
_executor = ThreadPoolExecutor(
    max_workers=MAX_CONCURRENT_JOBS, thread_name_prefix="skill-job"
)


@dataclass
class SkillJob:
    job_id: str
    kind: str                           # install | uninstall | update
    identifier: str
    status: str = "pending"
    error: Optional[str] = None
    skill: Optional[Dict[str, Any]] = None
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


_jobs: Dict[str, SkillJob] = {}
_jobs_lock = asyncio.Lock()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _find_installed_skills() -> List[Dict[str, Any]]:
    from tools.skills_tool import _find_all_skills
    try:
        return _find_all_skills(skip_disabled=False)
    except Exception as exc:
        logger.warning("find_all_skills failed: %s", exc)
        return []


def _to_view(
    skill: Dict[str, Any],
    *,
    disabled_global: set,
    disabled_vonvon: set,
) -> Dict[str, Any]:
    name = skill.get("name", "")
    return {
        "name": name,
        "category": skill.get("category"),
        "description": skill.get("description", "") or "",
        "install_path": skill.get("install_path", "") or "",
        "version": skill.get("version"),
        "source": skill.get("source"),
        "enabled_global": name not in disabled_global,
        "enabled_vonvon": name not in disabled_vonvon,
    }


def _job_to_dict(job: SkillJob) -> Dict[str, Any]:
    return {
        "job_id": job.job_id,
        "kind": job.kind,
        "identifier": job.identifier,
        "status": job.status,
        "error": job.error,
        "skill": job.skill,
        "started_at": job.started_at,
        "updated_at": job.updated_at,
    }


# ── Public service functions ────────────────────────────────────────────────────

def list_skills() -> List[Dict[str, Any]]:
    config = load_config()
    disabled_global = get_disabled_skills(config, platform=None)
    disabled_vonvon = get_disabled_skills(config, platform="vonvon")
    return [
        _to_view(s, disabled_global=disabled_global, disabled_vonvon=disabled_vonvon)
        for s in _find_installed_skills()
    ]


def toggle_skill(*, name: str, enabled: bool, scope: str) -> Dict[str, Any]:
    if scope not in ("global", "vonvon"):
        raise ValueError("scope must be global or vonvon")
    platform = None if scope == "global" else "vonvon"

    # Architect iter-2: cache clear INSIDE the lock so no concurrent
    # build_system_prompt reads stale cache between save and clear.
    with config_store_lock():
        config = load_config()
        disabled = set(get_disabled_skills(config, platform=platform))
        if enabled:
            disabled.discard(name)
        else:
            disabled.add(name)
        save_disabled_skills(config, disabled, platform=platform)  # re-entrant lock OK
        try:
            from agent.prompt_builder import clear_skills_system_prompt_cache
            clear_skills_system_prompt_cache(clear_snapshot=True)
        except Exception as exc:
            logger.warning("toggle_skill: clear_skills_system_prompt_cache failed: %s", exc)

    config_after = load_config()
    dg = get_disabled_skills(config_after, None)
    dv = get_disabled_skills(config_after, "vonvon")
    for s in _find_installed_skills():
        if s.get("name") == name:
            return _to_view(s, disabled_global=dg, disabled_vonvon=dv)
    return {
        "name": name,
        "enabled_global": name not in dg,
        "enabled_vonvon": name not in dv,
        "description": "",
        "install_path": "",
    }


def search_hub(query: str, *, limit: int) -> List[Dict[str, Any]]:
    from tools.skills_hub import GitHubAuth, create_source_router, unified_search
    try:
        auth = GitHubAuth()
        sources = create_source_router(auth)
        results = unified_search(query, sources, source_filter="all", limit=limit)
    except Exception as exc:
        logger.info("skill_search_failed query=%s err=%s", query, exc)
        return []
    return [
        {
            "identifier": r.identifier,
            "name": r.name,
            "description": r.description or "",
            "source": r.source,
            "trust_level": r.trust_level,
        }
        for r in results
    ]


def check_updates() -> Dict[str, Any]:
    from tools.skills_hub import check_for_skill_updates
    try:
        updates = check_for_skill_updates()
    except Exception as exc:
        logger.info("check_for_skill_updates failed: %s", exc)
        return {"updates": [], "error": str(exc)}
    return {"updates": updates, "error": None}


# ── Job executor ───────────────────────────────────────────────────────────────

def _do_install(identifier: str) -> Dict[str, Any]:
    from tools.skills_hub import install_bundle_silent
    installed = install_bundle_silent(identifier, force=False)
    if installed is None:
        raise RuntimeError(f"install_bundle_silent returned None for {identifier}")
    return {
        "name": installed.get("name", ""),
        "category": installed.get("category"),
        "description": installed.get("description", "") or "",
        "install_path": str(installed.get("install_path", "")),
        "version": installed.get("version"),
        "source": installed.get("source", ""),
    }


def _do_uninstall(name: str) -> Dict[str, Any]:
    from tools.skills_hub import uninstall_skill
    ok, msg = uninstall_skill(name)
    if not ok:
        raise RuntimeError(msg or f"uninstall failed for {name}")
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception as exc:
        logger.warning("_do_uninstall: clear_skills_system_prompt_cache failed: %s", exc)
    return {"name": name, "install_path": "", "description": ""}


async def _run_job(job: SkillJob, func, *args) -> None:
    job.status = "running"
    job.updated_at = time.time()
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(_executor, func, *args)
        job.status = "success"
        job.skill = result
        logger.info(
            "skill_job_success id=%s kind=%s ident=%s",
            job.job_id, job.kind, job.identifier,
        )
    except Exception as exc:
        job.status = "error"
        job.error = str(exc)
        logger.info(
            "skill_job_error id=%s kind=%s err=%s",
            job.job_id, job.kind, exc,
        )
    finally:
        job.updated_at = time.time()


async def _create_job(kind: str, identifier: str, func, *args) -> Dict[str, Any]:
    async with _jobs_lock:
        now = time.time()
        # AC-S11: lazy cleanup of expired completed jobs
        expired = [
            jid for jid, j in _jobs.items()
            if now - j.updated_at > FLOW_TTL_SECONDS
            and j.status in ("success", "error")
        ]
        for jid in expired:
            _jobs.pop(jid, None)
        active = sum(1 for j in _jobs.values() if j.status in ("pending", "running"))
        if active >= MAX_CONCURRENT_JOBS:
            raise ValueError("too many concurrent skill jobs; try again later")
        job = SkillJob(job_id=uuid.uuid4().hex, kind=kind, identifier=identifier)
        _jobs[job.job_id] = job
    asyncio.create_task(_run_job(job, func, *args))
    return _job_to_dict(job)


async def start_install_job(identifier: str) -> Dict[str, Any]:
    return await _create_job("install", identifier, _do_install, identifier)


async def start_uninstall_job(name: str) -> Dict[str, Any]:
    return await _create_job("uninstall", name, _do_uninstall, name)


def get_job_status(job_id: str) -> Optional[Dict[str, Any]]:
    # AC-S11: also trigger lazy expiry cleanup on poll
    now = time.time()
    expired = [
        jid for jid, j in _jobs.items()
        if now - j.updated_at > FLOW_TTL_SECONDS
        and j.status in ("success", "error")
        and jid != job_id
    ]
    for jid in expired:
        _jobs.pop(jid, None)
    job = _jobs.get(job_id)
    return _job_to_dict(job) if job else None

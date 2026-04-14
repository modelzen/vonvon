"""Adapter over hermes skills: list/toggle/search/install/uninstall.

Install/uninstall are long-running operations (git fetch, file copy, dependency
resolution). They run on a shared ThreadPoolExecutor and expose a start+poll
job API. Jobs are in-memory (same semantics as OAuth flows)."""

import asyncio
import ast
import json
import logging
import re
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from app.config import HERMES_HOME
from hermes_cli.config import load_config
from hermes_cli.config_lock import config_store_lock
from hermes_cli.skills_config import get_disabled_skills, save_disabled_skills

logger = logging.getLogger(__name__)

FLOW_TTL_SECONDS = 30 * 60
MAX_CONCURRENT_JOBS = 4
_executor = ThreadPoolExecutor(
    max_workers=MAX_CONCURRENT_JOBS, thread_name_prefix="skill-job"
)

_CATEGORY_LABELS = {
    "apple": "Apple",
    "autonomous-ai-agents": "AI Agents",
    "blockchain": "Blockchain",
    "communication": "Communication",
    "creative": "Creative",
    "copywriting": "Copywriting",
    "data-science": "Data Science",
    "devops": "DevOps",
    "dogfood": "Dogfood",
    "domain": "Domain",
    "email": "Email",
    "feeds": "Feeds",
    "gaming": "Gaming",
    "gifs": "GIFs",
    "github": "GitHub",
    "health": "Health",
    "inference-sh": "Inference",
    "leisure": "Leisure",
    "mcp": "MCP",
    "media": "Media",
    "migration": "Migration",
    "mlops": "MLOps",
    "note-taking": "Note-Taking",
    "other": "Other",
    "productivity": "Productivity",
    "research": "Research",
    "security": "Security",
    "smart-home": "Smart Home",
    "social-media": "Social Media",
    "software-development": "Software Dev",
    "translation": "Translation",
}
_TAG_TO_CATEGORY: Dict[str, str] = {}
for _cat, _tags in {
    "software-development": [
        "programming", "code", "coding", "software-development",
        "frontend-development", "backend-development", "web-development",
        "react", "python", "typescript", "java", "rust",
    ],
    "creative": ["writing", "design", "creative", "art", "image-generation"],
    "research": ["education", "academic", "research"],
    "social-media": ["marketing", "seo", "social-media"],
    "productivity": ["productivity", "business"],
    "data-science": ["data", "data-science"],
    "mlops": ["machine-learning", "deep-learning", "mlops"],
    "devops": ["devops"],
    "gaming": ["gaming", "game", "game-development", "games"],
    "media": ["music", "media", "video"],
    "health": ["health", "fitness"],
    "translation": ["translation", "language-learning"],
    "security": ["security", "cybersecurity"],
}.items():
    for _tag in _tags:
        _TAG_TO_CATEGORY[_tag] = _cat

_DISCOVER_SOURCE_ORDER = {
    "built-in": 0,
    "optional": 1,
    "anthropic": 2,
    "lobehub": 3,
}
_DISCOVER_SOURCE_LABELS = {
    "built-in": "Built-in",
    "optional": "Optional",
    "anthropic": "Anthropic",
    "lobehub": "LobeHub",
}
_DISCOVER_CACHE_FILE = (
    HERMES_HOME / "skills" / ".hub" / "index-cache" / "vonvon-discover-catalog-v1.json"
)
_REMOTE_DISCOVER_SOURCES = {"optional", "anthropic", "lobehub"}


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

_VENDORED_SKILLS_DIR = Path(__file__).resolve().parents[2] / "hermes-agent" / "skills"
_INLINE_SKILL_RE = re.compile(r'@skill:(?:"([^"]+)"|(\S+))')


def _find_installed_skills() -> List[Dict[str, Any]]:
    from tools.skills_tool import _find_all_skills
    try:
        return _find_all_skills(skip_disabled=False)
    except Exception as exc:
        logger.warning("find_all_skills failed: %s", exc)
        return []


def _parse_skill_md(skill_md: Path) -> tuple:
    """Return (name, description) from a SKILL.md file."""
    from tools.skills_tool import _parse_frontmatter, MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH
    content = skill_md.read_text(encoding="utf-8")[:4000]
    frontmatter, body = _parse_frontmatter(content)
    name = (frontmatter.get("name") or skill_md.parent.name)[:MAX_NAME_LENGTH]
    description = frontmatter.get("description", "")
    if not description:
        for line in body.strip().split("\n"):
            line = line.strip()
            if line and not line.startswith("#"):
                description = line
                break
    if len(description) > MAX_DESCRIPTION_LENGTH:
        description = description[:MAX_DESCRIPTION_LENGTH] + "..."
    return name, description


def _normalize_category(raw: str | None) -> str:
    category = (raw or "").strip().lower().replace("_", "-").replace(" ", "-")
    if not category or category == "uncategorized":
        return "other"
    return category


def _category_label(category: str) -> str:
    return _CATEGORY_LABELS.get(category, category.replace("-", " ").title())


def _guess_category(tags: List[str]) -> str:
    for raw_tag in tags:
        key = str(raw_tag).strip().lower()
        if not key:
            continue
        category = _TAG_TO_CATEGORY.get(key)
        if category:
            return category
    return "other"


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).encode("utf-8", "replace").decode("utf-8")


def _installed_skill_names() -> set[str]:
    return {
        str(skill.get("name", "")).strip().casefold()
        for skill in _find_installed_skills()
        if str(skill.get("name", "")).strip()
    }


def _build_discover_item(
    *,
    identifier: str,
    name: str,
    description: str,
    source: str,
    trust_level: str,
    install_kind: str,
    installed_names: set[str],
    category: str = "other",
    tags: Optional[List[str]] = None,
    installed: Optional[bool] = None,
) -> Dict[str, Any]:
    safe_identifier = _safe_text(identifier).strip()
    safe_name = _safe_text(name).strip()
    safe_description = _safe_text(description).strip()
    safe_source = _safe_text(source).strip()
    normalized_category = _normalize_category(_safe_text(category))
    safe_tags = [
        _safe_text(tag).strip()
        for tag in (tags or [])
        if _safe_text(tag).strip()
    ]
    return {
        "identifier": safe_identifier,
        "name": safe_name,
        "description": safe_description,
        "source": safe_source,
        "source_label": _DISCOVER_SOURCE_LABELS.get(safe_source, safe_source.title()),
        "trust_level": trust_level,
        "category": normalized_category,
        "category_label": _category_label(normalized_category),
        "tags": safe_tags,
        "install_kind": install_kind,
        "installed": (
            installed if installed is not None else safe_name.casefold() in installed_names
        ),
    }


def _discover_builtin_items(installed_names: set[str]) -> List[Dict[str, Any]]:
    return [
        _build_discover_item(
            identifier=template["identifier"],
            name=template["name"],
            description=template.get("description", "") or "",
            source="built-in",
            trust_level="builtin",
            install_kind="template",
            installed_names=installed_names,
            category=template.get("category", "other") or "other",
            installed=bool(template.get("installed")),
        )
        for template in list_templates()
    ]


def _normalize_remote_source(raw_source: str) -> str:
    source = (raw_source or "").strip().lower()
    aliases = {
        "built-in": "built-in",
        "optional": "optional",
        "anthropic": "anthropic",
        "lobehub": "lobehub",
        "claude marketplace": "claude-marketplace",
    }
    return aliases.get(source, source)


def _trust_level_for_remote_source(source: str) -> str:
    if source == "optional":
        return "builtin"
    if source == "anthropic":
        return "trusted"
    return "community"


def _sanitize_cached_remote_item(
    record: Dict[str, Any],
    installed_names: set[str],
) -> Optional[Dict[str, Any]]:
    source = _normalize_remote_source(str(record.get("source", "")))
    if source not in _REMOTE_DISCOVER_SOURCES:
        return None

    identifier = str(record.get("identifier", "")).strip()
    name = str(record.get("name", "")).strip()
    if not identifier or not name:
        return None

    raw_tags = record.get("tags", [])
    tags = [str(tag) for tag in raw_tags if str(tag).strip()] if isinstance(raw_tags, list) else []

    return _build_discover_item(
        identifier=identifier,
        name=name,
        description=str(record.get("description", "") or ""),
        source=source,
        trust_level=_trust_level_for_remote_source(source),
        install_kind="hub",
        installed_names=installed_names,
        category=str(record.get("category", "other") or "other"),
        tags=tags,
    )


def _read_discover_cache(installed_names: set[str]) -> List[Dict[str, Any]]:
    if not _DISCOVER_CACHE_FILE.exists():
        return []

    try:
        payload = json.loads(_DISCOVER_CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.info("discover_cache_read_failed err=%s", exc)
        return []

    if isinstance(payload, dict):
        records = payload.get("items", [])
    elif isinstance(payload, list):
        records = payload
    else:
        records = []

    if not isinstance(records, list):
        return []

    results: List[Dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        item = _sanitize_cached_remote_item(record, installed_names)
        if item is not None:
            results.append(item)
    return results


def _write_discover_cache(items: List[Dict[str, Any]], *, updated_at: float) -> None:
    _DISCOVER_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "updated_at": updated_at,
        "items": [
            {
                "identifier": item["identifier"],
                "name": item["name"],
                "description": item.get("description", ""),
                "source": item["source"],
                "category": item.get("category", "other"),
                "tags": item.get("tags", []),
            }
            for item in items
            if item.get("source") in _REMOTE_DISCOVER_SOURCES
        ],
    }
    tmp_path = _DISCOVER_CACHE_FILE.with_name(
        f".{_DISCOVER_CACHE_FILE.name}.{uuid.uuid4().hex}.tmp"
    )
    tmp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(_DISCOVER_CACHE_FILE)


def _discover_official_hub_page_items(installed_names: set[str]) -> List[Dict[str, Any]]:
    page_url = "https://hermes-agent.nousresearch.com/docs/skills/"

    try:
        page_resp = httpx.get(page_url, timeout=30, follow_redirects=True)
        page_resp.raise_for_status()
        html = page_resp.text
    except Exception as exc:
        logger.info("official_hub_page_fetch_failed err=%s", exc)
        return []

    runtime_match = re.search(r'<script src="([^"]*runtime~main[^"]+\.js)"', html)
    main_match = re.search(r'<script src="([^"]*/main\.[^"]+\.js)"', html)
    if not runtime_match or not main_match:
        logger.info("official_hub_page_parse_failed reason=missing_script_tags")
        return []

    runtime_url = f"https://hermes-agent.nousresearch.com{runtime_match.group(1)}"
    main_url = f"https://hermes-agent.nousresearch.com{main_match.group(1)}"

    try:
        main_js = httpx.get(main_url, timeout=30, follow_redirects=True).text
        chunk_id_match = re.search(
            r'Promise\.all\(\[n\.e\(\d+\),n\.e\((\d+)\)\]\)\.then\(n\.bind\(n,\d+\)\),"@site/src/pages/skills/index\.tsx"',
            main_js,
        )
        if not chunk_id_match:
            logger.info("official_hub_page_parse_failed reason=missing_chunk_id")
            return []
        chunk_id = chunk_id_match.group(1)

        runtime_js = httpx.get(runtime_url, timeout=30, follow_redirects=True).text
        filename_parts = re.findall(rf'{chunk_id}:"([^"]+)"', runtime_js)
        if len(filename_parts) < 2:
            logger.info("official_hub_page_parse_failed reason=missing_chunk_filename chunk_id=%s", chunk_id)
            return []

        chunk_url = (
            "https://hermes-agent.nousresearch.com/docs/assets/js/"
            f"{filename_parts[0]}.{filename_parts[1]}.js"
        )
        chunk_js = httpx.get(chunk_url, timeout=30, follow_redirects=True).text
        json_match = re.search(r"JSON\.parse\('(.+?)'\)", chunk_js, re.S)
        if not json_match:
            logger.info("official_hub_page_parse_failed reason=missing_embedded_json chunk_url=%s", chunk_url)
            return []
        decoded_json = ast.literal_eval("'" + json_match.group(1) + "'")
        records = json.loads(decoded_json)
    except Exception as exc:
        logger.info("official_hub_chunk_fetch_failed err=%s", exc)
        return []

    if not isinstance(records, list):
        logger.info("official_hub_page_parse_failed reason=records_not_list")
        return []

    trust_levels = {
        "optional": "builtin",
        "anthropic": "trusted",
        "lobehub": "community",
        "claude-marketplace": "community",
    }

    results: List[Dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        source = _normalize_remote_source(str(record.get("source", "")))
        if source == "built-in":
            continue
        if source not in trust_levels:
            continue
        name = str(record.get("name", "")).strip()
        category = str(record.get("category", "other") or "other")
        if not name:
            continue
        if source == "optional":
            identifier = f"official/{category}/{name}"
        elif source == "anthropic":
            identifier = f"anthropics/skills/skills/{name}"
        elif source == "lobehub":
            identifier = f"lobehub/{name}"
        else:
            identifier = name
        results.append(
            _build_discover_item(
                identifier=identifier,
                name=name,
                description=str(record.get("description", "") or ""),
                source=source,
                trust_level=trust_levels[source],
                install_kind="hub",
                installed_names=installed_names,
                category=category,
                tags=[str(tag) for tag in record.get("tags", []) if str(tag).strip()]
                if isinstance(record.get("tags"), list)
                else [],
            )
        )

    return [item for item in results if item["name"]]


def _discover_optional_items(installed_names: set[str]) -> List[Dict[str, Any]]:
    return _discover_remote_github_items(
        repo="NousResearch/hermes-agent",
        root_path="optional-skills",
        source="optional",
        trust_level="builtin",
        installed_names=installed_names,
        category_mode="path",
    )


def _discover_anthropic_items(installed_names: set[str]) -> List[Dict[str, Any]]:
    return _discover_remote_github_items(
        repo="anthropics/skills",
        root_path="skills",
        source="anthropic",
        trust_level="trusted",
        installed_names=installed_names,
        category_mode="tags",
    )


def _discover_lobehub_items(installed_names: set[str]) -> List[Dict[str, Any]]:
    try:
        response = httpx.get("https://chat-agents.lobehub.com/index.json", timeout=30)
        response.raise_for_status()
        index = response.json()
    except Exception as exc:
        logger.info("lobehub_skill_discovery_failed err=%s", exc)
        return []

    agents = index.get("agents", index) if isinstance(index, dict) else index
    if not isinstance(agents, list):
        return []

    results: List[Dict[str, Any]] = []
    for agent in agents:
        if not isinstance(agent, dict):
            continue
        meta = agent.get("meta", agent) if isinstance(agent.get("meta", agent), dict) else {}
        tags = meta.get("tags", [])
        category = meta.get("category") if isinstance(meta.get("category"), str) else ""
        results.append(
            _build_discover_item(
                identifier=f"lobehub/{agent.get('identifier', '')}",
                name=agent.get("identifier", ""),
                description=meta.get("description", "") or "",
                source="lobehub",
                trust_level="community",
                install_kind="hub",
                installed_names=installed_names,
                category=category or _guess_category(tags if isinstance(tags, list) else []),
                tags=tags if isinstance(tags, list) else [],
            )
        )
    return [item for item in results if item["identifier"] != "lobehub/"]


def _extract_skill_tags(frontmatter: Dict[str, Any]) -> List[str]:
    tags: List[str] = []
    metadata = frontmatter.get("metadata", {})
    if isinstance(metadata, dict):
        hermes_meta = metadata.get("hermes", {})
        if isinstance(hermes_meta, dict):
            raw = hermes_meta.get("tags", [])
            if isinstance(raw, list):
                tags.extend(str(tag) for tag in raw if str(tag).strip())
    raw_tags = frontmatter.get("tags", [])
    if isinstance(raw_tags, list):
        tags.extend(str(tag) for tag in raw_tags if str(tag).strip())
    elif isinstance(raw_tags, str) and raw_tags.strip():
        tags.append(raw_tags.strip())
    deduped: List[str] = []
    seen: set[str] = set()
    for tag in tags:
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(tag)
    return deduped


def _discover_remote_github_items(
    *,
    repo: str,
    root_path: str,
    source: str,
    trust_level: str,
    installed_names: set[str],
    category_mode: str,
) -> List[Dict[str, Any]]:
    from tools.skills_hub import GitHubAuth, GitHubSource

    auth = GitHubAuth()
    headers = auth.get_headers()
    parser = GitHubSource._parse_frontmatter_quick

    try:
        repo_resp = httpx.get(
            f"https://api.github.com/repos/{repo}",
            headers=headers,
            timeout=15,
            follow_redirects=True,
        )
        repo_resp.raise_for_status()
        default_branch = repo_resp.json().get("default_branch", "main")

        tree_resp = httpx.get(
            f"https://api.github.com/repos/{repo}/git/trees/{default_branch}",
            params={"recursive": "1"},
            headers=headers,
            timeout=30,
            follow_redirects=True,
        )
        tree_resp.raise_for_status()
        tree = tree_resp.json().get("tree", [])
    except Exception as exc:
        logger.info("%s_skill_discovery_failed err=%s", source, exc)
        return []

    prefix = root_path.rstrip("/") + "/"
    skill_md_paths = [
        item.get("path", "")
        for item in tree
        if item.get("type") == "blob"
        and str(item.get("path", "")).startswith(prefix)
        and str(item.get("path", "")).endswith("/SKILL.md")
    ]

    def _fetch_one(skill_md_path: str) -> Optional[Dict[str, Any]]:
        try:
            file_resp = httpx.get(
                f"https://api.github.com/repos/{repo}/contents/{skill_md_path}",
                headers={**headers, "Accept": "application/vnd.github.v3.raw"},
                timeout=15,
                follow_redirects=True,
            )
            if file_resp.status_code != 200:
                return None
            frontmatter = parser(file_resp.text)
        except Exception:
            return None

        rel_parts = Path(skill_md_path).relative_to(root_path).parts
        if len(rel_parts) < 2:
            return None
        skill_dir_parts = rel_parts[:-1]
        skill_name = str(frontmatter.get("name") or skill_dir_parts[-1]).strip()
        if not skill_name:
            return None
        tags = _extract_skill_tags(frontmatter)
        if category_mode == "path" and len(skill_dir_parts) >= 2:
            category = skill_dir_parts[0]
        else:
            category = _guess_category(tags)

        return _build_discover_item(
            identifier=(
                f"official/{'/'.join(skill_dir_parts)}"
                if source == "optional"
                else f"{repo}/{'/'.join(skill_dir_parts)}"
            ),
            name=skill_name,
            description=str(frontmatter.get("description", "") or ""),
            source=source,
            trust_level=trust_level,
            install_kind="hub",
            installed_names=installed_names,
            category=category,
            tags=tags,
        )

    results: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(16, max(4, len(skill_md_paths) or 1))) as pool:
        futures = [pool.submit(_fetch_one, path) for path in sorted(skill_md_paths)]
        for future in as_completed(futures):
            item = future.result()
            if item is not None:
                results.append(item)

    results.sort(key=lambda item: (item["category_label"].lower(), item["name"].lower()))
    return results


def list_templates() -> List[Dict[str, Any]]:
    """Scan vendored skills and return template list."""
    from tools.skills_tool import SKILLS_DIR, _EXCLUDED_SKILL_DIRS
    if not _VENDORED_SKILLS_DIR.exists():
        return []
    results = []
    seen_names: set = set()
    for skill_md in sorted(_VENDORED_SKILLS_DIR.rglob("SKILL.md")):
        if any(part in _EXCLUDED_SKILL_DIRS for part in skill_md.parts):
            continue
        skill_dir = skill_md.parent
        try:
            rel = skill_dir.relative_to(_VENDORED_SKILLS_DIR)
        except ValueError:
            continue
        parts = rel.parts
        if len(parts) < 2:
            continue
        category = parts[0]
        dirname = parts[1]
        try:
            name, description = _parse_skill_md(skill_md)
        except Exception as exc:
            logger.warning("list_templates: parse failed for %s: %s", skill_md, exc)
            continue
        if name in seen_names:
            continue
        seen_names.add(name)
        installed = (SKILLS_DIR / category / dirname / "SKILL.md").exists()
        results.append({
            "name": name,
            "category": category,
            "description": description,
            "identifier": f"builtin:{category}/{dirname}",
            "installed": installed,
        })
    results.sort(key=lambda x: (x["category"], x["name"]))
    return results


def install_template(identifier: str) -> Dict[str, Any]:
    """Copy a vendored skill to SKILLS_DIR. Raises ValueError/FileNotFoundError/FileExistsError."""
    from tools.skills_tool import SKILLS_DIR
    if not identifier.startswith("builtin:"):
        raise ValueError(f"identifier must start with 'builtin:': {identifier!r}")
    rel = identifier[len("builtin:"):]
    parts = rel.split("/", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError(f"invalid identifier format: {identifier!r}")
    category, dirname = parts
    src = _VENDORED_SKILLS_DIR / category / dirname
    dst = SKILLS_DIR / category / dirname
    if not src.exists() or not (src / "SKILL.md").exists():
        raise FileNotFoundError(f"vendored skill not found: {identifier}")
    if dst.exists():
        raise FileExistsError("already installed")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst)
    try:
        name, description = _parse_skill_md(dst / "SKILL.md")
    except Exception as exc:
        logger.warning("install_template: parse dst failed: %s", exc)
        name = dirname
        description = ""
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception as exc:
        logger.warning("install_template: clear_skills_system_prompt_cache failed: %s", exc)
    return {
        "name": name,
        "category": category,
        "description": description,
        "install_path": str(dst),
        "version": None,
        "source": "builtin",
        "enabled_global": True,
        "enabled_vonvon": True,
    }


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


def extract_inline_skills(text: str) -> tuple[List[str], str]:
    """Return (skill_names, text_without_skill_tokens) from an inline message.

    The renderer stores selected skill chips as raw ``@skill:...`` tokens so
    chat history can round-trip through SessionDB. Right before dispatching to
    hermes we strip those tokens back out and load the corresponding skills.
    """
    if not text:
        return [], ""

    found: List[str] = []
    seen: set[str] = set()
    parts: List[str] = []
    cursor = 0

    for match in _INLINE_SKILL_RE.finditer(text):
        parts.append(text[cursor:match.start()])
        cursor = match.end()
        name = (match.group(1) or match.group(2) or "").strip().lstrip("/")
        if not name:
            continue
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        found.append(name)

    if cursor == 0:
        return [], text

    parts.append(text[cursor:])
    stripped = "".join(parts)
    stripped = re.sub(r"[ \t]+\n", "\n", stripped)
    stripped = re.sub(r"\n[ \t]+", "\n", stripped)
    stripped = re.sub(r"[ \t]{2,}", " ", stripped).strip()
    return found, stripped


def build_skill_turn_message(
    skill_identifiers: List[str],
    *,
    user_instruction: str = "",
    task_id: str | None = None,
    runtime_note: str = "",
) -> tuple[str, List[str], List[str]]:
    """Load one or more skills and build a per-turn hermes invocation prompt."""
    cleaned_instruction = (user_instruction or "").strip()
    if not skill_identifiers:
        return cleaned_instruction, [], []

    try:
        from agent.skill_commands import _build_skill_message, _load_skill_payload
    except Exception as exc:
        logger.warning("build_skill_turn_message: skill helpers unavailable: %s", exc)
        return cleaned_instruction, [], list(skill_identifiers)

    prompt_parts: List[str] = []
    loaded_names: List[str] = []
    missing: List[str] = []
    seen: set[str] = set()

    for raw_identifier in skill_identifiers:
        identifier = (raw_identifier or "").strip()
        if not identifier:
            continue
        dedupe_key = identifier.casefold()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        loaded = _load_skill_payload(identifier, task_id=task_id)
        if not loaded:
            missing.append(identifier)
            continue

        loaded_skill, skill_dir, skill_name = loaded
        activation_note = (
            f'[SYSTEM: The user has activated the "{skill_name}" skill for this message. '
            "Follow its instructions while completing this turn.]"
        )
        prompt_parts.append(
            _build_skill_message(
                loaded_skill,
                skill_dir,
                activation_note,
            )
        )
        loaded_names.append(skill_name)

    if not loaded_names:
        return cleaned_instruction, [], missing

    if missing:
        prompt_parts.append(
            "[Skill load note: Unable to load these requested skills. Continue with "
            f"the loaded skills only: {', '.join(missing)}.]"
        )

    if runtime_note:
        prompt_parts.append(f"[Runtime note: {runtime_note}]")

    if cleaned_instruction:
        suffix = "s" if len(loaded_names) > 1 else ""
        prompt_parts.append(
            "The user has provided the following instruction alongside the "
            f"activated skill{suffix}: {cleaned_instruction}"
        )

    return "\n\n".join(part for part in prompt_parts if part.strip()), loaded_names, missing


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


def list_discoverable_skills(
    *,
    query: str = "",
    limit: int = 60,
    offset: int = 0,
    source: str = "all",
) -> Dict[str, Any]:
    installed_names = _installed_skill_names()
    remote_items = _read_discover_cache(installed_names)
    all_items = _discover_builtin_items(installed_names) + remote_items

    query_lower = query.strip().lower()
    source_key = source.strip().lower()
    filtered: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for item in all_items:
        if source_key not in ("", "all") and item["source"] != source_key:
            continue

        searchable = " ".join(
            [
                item["name"],
                item.get("description", ""),
                item.get("category", ""),
                item.get("category_label", ""),
                item.get("source_label", ""),
                " ".join(item.get("tags", [])),
            ]
        ).lower()
        if query_lower and query_lower not in searchable:
            continue

        dedupe_key = item["identifier"]
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        filtered.append(item)

    filtered.sort(
        key=lambda item: (
            _DISCOVER_SOURCE_ORDER.get(item["source"], 99),
            item["category_label"].lower(),
            item["name"].lower(),
        )
    )
    page_limit = max(1, min(limit, 120))
    page_offset = max(0, offset)
    page_items = filtered[page_offset: page_offset + page_limit]
    return {
        "items": page_items,
        "total": len(filtered),
        "offset": page_offset,
        "limit": page_limit,
        "has_more": page_offset + len(page_items) < len(filtered),
    }


def refresh_discoverable_skills_cache() -> Dict[str, Any]:
    remote_items = _discover_official_hub_page_items(set())
    if not remote_items:
        remote_items = (
            _discover_optional_items(set())
            + _discover_anthropic_items(set())
            + _discover_lobehub_items(set())
        )
    if not remote_items:
        raise RuntimeError("无法从远端 skill hub 获取数据")

    updated_at = time.time()
    _write_discover_cache(remote_items, updated_at=updated_at)

    sources: Dict[str, int] = {}
    for item in remote_items:
        source = item.get("source", "")
        sources[source] = sources.get(source, 0) + 1

    return {
        "count": len(remote_items),
        "updated_at": updated_at,
        "sources": sources,
    }


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

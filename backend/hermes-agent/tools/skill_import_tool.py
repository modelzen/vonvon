#!/usr/bin/env python3
"""Import external skills into the active Hermes/vonvon profile."""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx
import yaml

from agent.skill_utils import get_all_skills_dirs, parse_frontmatter
from hermes_constants import get_hermes_home
from tools.registry import registry, tool_error
from tools.skills_guard import scan_skill, should_allow_install
from tools.skills_hub import (
    GitHubAuth,
    GitHubSource,
    SkillBundle,
    append_audit_log,
    ensure_hub_dirs,
    install_from_quarantine,
    quarantine_bundle,
)
from tools.skills_hub import (
    _validate_bundle_rel_path,
    _validate_category_name,
    _validate_skill_name,
)
from tools.skills_tool import check_skills_requirements

logger = logging.getLogger(__name__)

HERMES_HOME = get_hermes_home()
SKILLS_DIR = HERMES_HOME / "skills"

_EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".github",
        ".hub",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        "dist",
        "build",
    }
)
_MAX_BUNDLE_BYTES = 50 * 1024 * 1024
_MAX_FILE_BYTES = 5 * 1024 * 1024
_GITHUB_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/.+)?$")


def _slugify(value: str, fallback: str = "imported-skill") -> str:
    raw = (value or "").strip().lower()
    raw = raw.replace(" ", "-")
    raw = re.sub(r"[^a-z0-9._-]+", "-", raw)
    raw = re.sub(r"-{2,}", "-", raw).strip("-._")
    return raw or fallback


def _detect_description(frontmatter: Dict[str, Any], body: str, name: str) -> str:
    raw = str(frontmatter.get("description") or "").strip()
    if raw:
        return raw
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        return stripped[:160]
    return f"Imported skill '{name}'"


def _render_frontmatter(frontmatter: Dict[str, Any], body: str) -> str:
    dumped = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).strip()
    return f"---\n{dumped}\n---\n\n{body.lstrip()}"


def _inject_provenance(
    skill_md: str,
    *,
    source_kind: str,
    identifier: str,
    original_format: str,
    adapted: bool,
) -> str:
    frontmatter, body = parse_frontmatter(skill_md)
    if not isinstance(frontmatter, dict):
        frontmatter = {}

    name = _slugify(str(frontmatter.get("name") or "").strip() or "imported-skill")
    description = _detect_description(frontmatter, body, name)
    frontmatter["name"] = name
    frontmatter["description"] = description

    metadata = frontmatter.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    hermes_meta = metadata.get("hermes")
    if not isinstance(hermes_meta, dict):
        hermes_meta = {}

    imported_from: Dict[str, Any] = {
        "source": source_kind,
        "identifier": identifier,
        "original_format": original_format,
        "imported_by": "skill_import",
    }
    if adapted:
        imported_from["adaptation_notes"] = [
            "skill_import synthesized or normalized this skill for Hermes compatibility"
        ]

    hermes_meta["imported_from"] = imported_from
    metadata["hermes"] = hermes_meta
    frontmatter["metadata"] = metadata

    if "~/.hermes" in body and "HERMES_HOME" not in body and "Imported Profile Note" not in body:
        note = (
            "> Imported Profile Note\n>\n"
            "> Use the active `HERMES_HOME` for profile-local paths. "
            "In vonvon this usually means `~/.vonvon/.hermes`, not `~/.hermes`.\n\n"
        )
        body = note + body.lstrip()

    return _render_frontmatter(frontmatter, body)


def _synthesize_skill_md(
    *,
    name: str,
    description: str,
    source_label: str,
) -> str:
    frontmatter = {
        "name": name,
        "description": description,
    }
    body = f"""# {name}

This skill was adapted from an external source.

## Source

- Original content: `references/original-source.md`
- Source label: `{source_label}`

## Usage

- Read `references/original-source.md` before acting.
- Extract the workflow, commands, and caveats from the imported source.
- Use the active `HERMES_HOME` for profile-local paths.
- If the original instructions mention `~/.hermes`, map that to the active profile directory.
"""
    return _render_frontmatter(frontmatter, body)


def _read_file_content(path: Path) -> str | bytes:
    raw = path.read_bytes()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw


def _bundle_from_local_skill_dir(skill_dir: Path) -> SkillBundle:
    files: Dict[str, str | bytes] = {}
    total_bytes = 0

    for entry in sorted(skill_dir.rglob("*")):
        if entry.is_dir():
            continue
        rel_path = entry.relative_to(skill_dir)
        if any(part in _EXCLUDED_DIRS for part in rel_path.parts):
            continue
        if entry.stat().st_size > _MAX_FILE_BYTES:
            raise RuntimeError(f"file too large to import: {rel_path}")

        safe_rel = _validate_bundle_rel_path(rel_path.as_posix())
        content = _read_file_content(entry)
        if isinstance(content, str):
            size = len(content.encode("utf-8"))
        else:
            size = len(content)
        total_bytes += size
        if total_bytes > _MAX_BUNDLE_BYTES:
            raise RuntimeError("skill bundle too large to import")
        files[safe_rel] = content

    if "SKILL.md" not in files:
        raise RuntimeError(f"no SKILL.md found in {skill_dir}")

    return SkillBundle(
        name=_slugify(skill_dir.name),
        files=files,
        source="local",
        identifier=str(skill_dir),
        trust_level="community",
    )


def _find_local_skill_dirs(base: Path) -> List[Path]:
    matches: List[Path] = []
    for skill_md in base.rglob("SKILL.md"):
        rel = skill_md.relative_to(base)
        if any(part in _EXCLUDED_DIRS for part in rel.parts):
            continue
        matches.append(skill_md.parent)
    return sorted(matches)


def _list_github_skill_candidates(
    repo: str,
    *,
    prefix: str = "",
    auth: Optional[GitHubAuth] = None,
) -> List[str]:
    auth = auth or GitHubAuth()
    repo_resp = httpx.get(
        f"https://api.github.com/repos/{repo}",
        headers=auth.get_headers(),
        timeout=15,
        follow_redirects=True,
    )
    repo_resp.raise_for_status()
    default_branch = repo_resp.json().get("default_branch", "main")

    tree_resp = httpx.get(
        f"https://api.github.com/repos/{repo}/git/trees/{default_branch}",
        params={"recursive": "1"},
        headers=auth.get_headers(),
        timeout=30,
        follow_redirects=True,
    )
    tree_resp.raise_for_status()
    tree = tree_resp.json().get("tree", [])

    normalized_prefix = prefix.strip("/").replace("\\", "/")
    wanted_prefix = f"{normalized_prefix}/" if normalized_prefix else ""

    candidates: List[str] = []
    for item in tree:
        item_path = str(item.get("path", ""))
        if item.get("type") != "blob" or not item_path.endswith("/SKILL.md"):
            continue
        if wanted_prefix and not item_path.startswith(wanted_prefix):
            continue
        candidates.append(item_path[: -len("/SKILL.md")])

    deduped = sorted(dict.fromkeys(candidates))
    if normalized_prefix and f"{normalized_prefix}/SKILL.md" in {
        str(item.get("path", "")) for item in tree if item.get("type") == "blob"
    }:
        exact = normalized_prefix
        if exact not in deduped:
            deduped.insert(0, exact)
    return deduped


def _derive_category_from_repo_path(path: str) -> str:
    parts = [part for part in PurePosixPath(path).parts if part not in ("", ".")]
    if len(parts) >= 3 and parts[0] in {"skills", "optional-skills"}:
        return _slugify(parts[1], "imports")
    return "imports"


def _parse_github_source(source: str) -> Optional[Tuple[str, str]]:
    raw = source.strip()
    parsed = urlparse(raw)

    if parsed.scheme in {"http", "https"} and parsed.netloc in {"github.com", "www.github.com"}:
        parts = [part for part in parsed.path.strip("/").split("/") if part]
        if len(parts) < 2:
            return None
        repo = f"{parts[0]}/{parts[1]}"
        if len(parts) == 2:
            return repo, ""
        if parts[2] in {"tree", "blob"} and len(parts) >= 5:
            rel = "/".join(parts[4:])
            if rel.endswith("/SKILL.md"):
                rel = rel[: -len("/SKILL.md")]
            elif rel == "SKILL.md":
                rel = ""
            return repo, rel
        return repo, "/".join(parts[2:])

    if parsed.scheme in {"http", "https"} and parsed.netloc == "raw.githubusercontent.com":
        parts = [part for part in parsed.path.strip("/").split("/") if part]
        if len(parts) < 4:
            return None
        repo = f"{parts[0]}/{parts[1]}"
        rel = "/".join(parts[3:])
        if rel.endswith("/SKILL.md"):
            rel = rel[: -len("/SKILL.md")]
        elif rel == "SKILL.md":
            rel = ""
        return repo, rel

    if _GITHUB_RE.match(raw):
        pieces = raw.split("/", 2)
        repo = f"{pieces[0]}/{pieces[1]}"
        rel = pieces[2] if len(pieces) == 3 else ""
        if rel.endswith("/SKILL.md"):
            rel = rel[: -len("/SKILL.md")]
        elif rel == "SKILL.md":
            rel = ""
        return repo, rel

    return None


def _resolve_http_markdown_source(
    source: str,
    *,
    name_override: Optional[str],
) -> Tuple[SkillBundle, Dict[str, Any]]:
    resp = httpx.get(source, timeout=30, follow_redirects=True)
    resp.raise_for_status()
    content_type = resp.headers.get("content-type", "").lower()
    text = resp.text

    url_path = urlparse(source).path
    stem = Path(url_path).stem or "imported-skill"
    source_name = _slugify(name_override or stem)

    if url_path.endswith("SKILL.md"):
        bundle = SkillBundle(
            name=source_name,
            files={"SKILL.md": text},
            source="url",
            identifier=source,
            trust_level="community",
        )
        return bundle, {
            "category": "imports",
            "classification": "compatible-single-file",
            "adapted": False,
            "source_kind": "url",
            "source_identifier": source,
        }

    if "markdown" not in content_type and not url_path.lower().endswith(".md"):
        raise RuntimeError("unsupported URL source; provide a raw markdown or GitHub skill URL")

    description = f"Adapted from external markdown source '{source_name}'"
    bundle = SkillBundle(
        name=source_name,
        files={
            "SKILL.md": _synthesize_skill_md(
                name=source_name,
                description=description,
                source_label=source,
            ),
            "references/original-source.md": text,
        },
        source="url",
        identifier=source,
        trust_level="community",
    )
    return bundle, {
        "category": "imports",
        "classification": "adapted-markdown-source",
        "adapted": True,
        "source_kind": "url",
        "source_identifier": source,
    }


def _resolve_source_to_bundle(
    source: str,
    *,
    name_override: Optional[str],
) -> Tuple[SkillBundle, Dict[str, Any]]:
    expanded = Path(os.path.expanduser(source))
    if expanded.exists():
        resolved = expanded.resolve()
        if resolved.is_file():
            if resolved.name == "SKILL.md":
                bundle = _bundle_from_local_skill_dir(resolved.parent)
                return bundle, {
                    "category": "imports",
                    "classification": "compatible-local-skill",
                    "adapted": False,
                    "source_kind": "local",
                    "source_identifier": str(resolved.parent),
                }
            if resolved.suffix.lower() == ".md":
                text = resolved.read_text(encoding="utf-8")
                skill_name = _slugify(name_override or resolved.stem)
                bundle = SkillBundle(
                    name=skill_name,
                    files={
                        "SKILL.md": _synthesize_skill_md(
                            name=skill_name,
                            description=f"Adapted from local markdown source '{resolved.name}'",
                            source_label=str(resolved),
                        ),
                        "references/original-source.md": text,
                    },
                    source="local",
                    identifier=str(resolved),
                    trust_level="community",
                )
                return bundle, {
                    "category": "imports",
                    "classification": "adapted-local-markdown",
                    "adapted": True,
                    "source_kind": "local",
                    "source_identifier": str(resolved),
                }
            raise RuntimeError("unsupported local file source; provide SKILL.md or a markdown file")

        if resolved.is_dir():
            skill_dir = resolved if (resolved / "SKILL.md").is_file() else None
            if skill_dir is None:
                candidates = _find_local_skill_dirs(resolved)
                if len(candidates) == 1:
                    skill_dir = candidates[0]
                elif len(candidates) > 1:
                    rel = [str(path.relative_to(resolved)) for path in candidates[:8]]
                    raise RuntimeError(
                        "multiple skill directories found; provide a narrower path: " + ", ".join(rel)
                    )
                elif (resolved / "README.md").is_file():
                    text = (resolved / "README.md").read_text(encoding="utf-8")
                    skill_name = _slugify(name_override or resolved.name)
                    bundle = SkillBundle(
                        name=skill_name,
                        files={
                            "SKILL.md": _synthesize_skill_md(
                                name=skill_name,
                                description=f"Adapted from local README source '{resolved.name}'",
                                source_label=str(resolved / 'README.md'),
                            ),
                            "references/original-source.md": text,
                        },
                        source="local",
                        identifier=str(resolved),
                        trust_level="community",
                    )
                    return bundle, {
                        "category": "imports",
                        "classification": "adapted-local-readme",
                        "adapted": True,
                        "source_kind": "local",
                        "source_identifier": str(resolved),
                    }
                else:
                    raise RuntimeError("no SKILL.md found in the provided directory")

            bundle = _bundle_from_local_skill_dir(skill_dir)
            return bundle, {
                "category": "imports",
                "classification": "compatible-local-skill",
                "adapted": False,
                "source_kind": "local",
                "source_identifier": str(skill_dir),
            }

    github = _parse_github_source(source)
    if github:
        repo, rel = github
        auth = GitHubAuth()
        gh = GitHubSource(auth=auth)
        candidates = _list_github_skill_candidates(repo, prefix=rel, auth=auth)
        chosen = ""
        normalized_rel = rel.strip("/").replace("\\", "/")
        if normalized_rel:
            if normalized_rel in candidates:
                chosen = normalized_rel
            elif len(candidates) == 1:
                chosen = candidates[0]
        elif len(candidates) == 1:
            chosen = candidates[0]

        if not chosen:
            if not candidates:
                raise RuntimeError("no SKILL.md found in the provided GitHub source")
            preview = ", ".join(candidates[:8])
            raise RuntimeError(
                "multiple skill candidates found; provide a skill path instead: " + preview
            )

        identifier = f"{repo}/{chosen}"
        bundle = gh.fetch(identifier)
        if bundle is None:
            raise RuntimeError(f"failed to fetch GitHub skill '{identifier}'")

        return bundle, {
            "category": _derive_category_from_repo_path(chosen),
            "classification": "compatible-github-skill",
            "adapted": False,
            "source_kind": "github",
            "source_identifier": identifier,
        }

    parsed = urlparse(source)
    if parsed.scheme in {"http", "https"}:
        return _resolve_http_markdown_source(source, name_override=name_override)

    raise RuntimeError("unsupported skill source; provide a GitHub URL, repo path, raw markdown URL, or local path")


def _pick_final_name_and_category(
    *,
    requested_name: str,
    requested_category: str,
    conflict_strategy: str,
) -> Tuple[str, str, Optional[Path]]:
    existing_matches: List[Path] = []
    for skills_dir in get_all_skills_dirs():
        if not skills_dir.exists():
            continue
        for skill_md in skills_dir.rglob("SKILL.md"):
            if skill_md.parent.name == requested_name:
                existing_matches.append(skill_md.parent)

    if not existing_matches:
        return requested_name, requested_category, None

    local_matches = []
    external_matches = []
    for match in existing_matches:
        try:
            match.resolve().relative_to(SKILLS_DIR.resolve())
            local_matches.append(match)
        except ValueError:
            external_matches.append(match)

    if conflict_strategy == "overwrite":
        if external_matches:
            paths = ", ".join(str(path) for path in external_matches[:4])
            raise RuntimeError(f"cannot overwrite external skill '{requested_name}': {paths}")
        if len(local_matches) > 1:
            paths = ", ".join(str(path) for path in local_matches[:4])
            raise RuntimeError(f"multiple local skills share the name '{requested_name}': {paths}")
        return requested_name, requested_category, local_matches[0]

    if conflict_strategy == "rename":
        index = 1
        while True:
            suffix = "-imported" if index == 1 else f"-imported-{index}"
            candidate = _slugify(f"{requested_name}{suffix}")
            occupied = False
            for skills_dir in get_all_skills_dirs():
                if not skills_dir.exists():
                    continue
                if any(skill_md.parent.name == candidate for skill_md in skills_dir.rglob("SKILL.md")):
                    occupied = True
                    break
            if not occupied:
                return candidate, requested_category, None
            index += 1

    locations = ", ".join(str(path) for path in existing_matches[:4])
    raise RuntimeError(
        f"skill '{requested_name}' already exists. Use conflict_strategy='overwrite' or 'rename'. Existing: {locations}"
    )


def import_skill_silent(
    source: str,
    *,
    name: Optional[str] = None,
    category: Optional[str] = None,
    conflict_strategy: str = "error",
    force: bool = False,
) -> Dict[str, Any]:
    if conflict_strategy not in {"error", "overwrite", "rename"}:
        raise RuntimeError("conflict_strategy must be one of: error, overwrite, rename")

    ensure_hub_dirs()
    bundle, info = _resolve_source_to_bundle(source, name_override=name)

    skill_md = bundle.files.get("SKILL.md")
    if not isinstance(skill_md, str):
        raise RuntimeError("imported skill is missing a readable SKILL.md")

    prepared_skill_md = _inject_provenance(
        skill_md,
        source_kind=str(info.get("source_kind") or bundle.source or "import"),
        identifier=str(info.get("source_identifier") or bundle.identifier or source),
        original_format=str(info.get("classification") or "imported-skill"),
        adapted=bool(info.get("adapted")),
    )

    prepared_frontmatter, _ = parse_frontmatter(prepared_skill_md)
    requested_name = _validate_skill_name(
        _slugify(name or str(prepared_frontmatter.get("name") or "") or bundle.name)
    )
    requested_category = _validate_category_name(
        _slugify(category or info.get("category") or "imports", "imports")
    )
    final_name, final_category, overwrite_path = _pick_final_name_and_category(
        requested_name=requested_name,
        requested_category=requested_category,
        conflict_strategy=conflict_strategy,
    )

    bundle.files["SKILL.md"] = prepared_skill_md
    bundle.name = final_name
    bundle.identifier = str(info.get("source_identifier") or bundle.identifier or source)
    bundle.metadata.update(
        {
            "imported_via": "skill_import",
            "classification": info.get("classification"),
            "source": info.get("source_kind"),
            "source_identifier": bundle.identifier,
        }
    )

    quarantine_path = None
    try:
        quarantine_path = quarantine_bundle(bundle)
        scan_source = bundle.identifier or source
        scan_result = scan_skill(quarantine_path, source=scan_source)
        allowed, reason = should_allow_install(scan_result, force=force)
        if not allowed:
            append_audit_log("BLOCKED", final_name, bundle.source, bundle.trust_level, scan_result.verdict, reason)
            raise RuntimeError(f"import blocked by scan policy: {reason}")

        if overwrite_path is not None and overwrite_path.exists():
            shutil.rmtree(overwrite_path)

        installed_path = install_from_quarantine(
            quarantine_path,
            final_name,
            final_category,
            bundle,
            scan_result,
        )
    except Exception:
        if quarantine_path is not None and quarantine_path.exists():
            shutil.rmtree(quarantine_path, ignore_errors=True)
        raise

    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache

        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception as exc:
        logger.warning("skill_import: failed to clear skill prompt cache: %s", exc)

    return {
        "name": final_name,
        "category": final_category,
        "description": _detect_description(*parse_frontmatter(prepared_skill_md), final_name),
        "install_path": str(installed_path),
        "source": bundle.source,
        "source_identifier": bundle.identifier,
        "classification": info.get("classification"),
        "adapted": bool(info.get("adapted")),
    }


def skill_import(
    *,
    source: str,
    name: Optional[str] = None,
    category: Optional[str] = None,
    conflict_strategy: str = "error",
    force: bool = False,
) -> str:
    if not source.strip():
        return tool_error("source is required", success=False)

    try:
        result = import_skill_silent(
            source=source,
            name=name,
            category=category,
            conflict_strategy=conflict_strategy,
            force=force,
        )
        return json.dumps({"success": True, **result})
    except Exception as exc:
        return tool_error(str(exc), success=False)


SKILL_IMPORT_SCHEMA = {
    "name": "skill_import",
    "description": (
        "Import an external skill into the active Hermes/vonvon profile from a GitHub repo/path, "
        "GitHub URL, raw markdown URL, or local path. Reuses Hermes-compatible SKILL.md trees when possible "
        "and adapts simple markdown sources when needed."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "source": {
                "type": "string",
                "description": "GitHub repo/path, GitHub URL, raw markdown URL, or local path to import from.",
            },
            "name": {
                "type": "string",
                "description": "Optional installed skill name override.",
            },
            "category": {
                "type": "string",
                "description": "Optional installed category override. Defaults to a derived category or 'imports'.",
            },
            "conflict_strategy": {
                "type": "string",
                "enum": ["error", "overwrite", "rename"],
                "description": "How to handle name collisions with existing skills.",
            },
            "force": {
                "type": "boolean",
                "description": "Bypass caution scan verdicts the same way hub force-install does.",
            },
        },
        "required": ["source"],
    },
}


registry.register(
    name="skill_import",
    toolset="skills",
    schema=SKILL_IMPORT_SCHEMA,
    handler=lambda args, **kw: skill_import(
        source=args.get("source", ""),
        name=args.get("name"),
        category=args.get("category"),
        conflict_strategy=args.get("conflict_strategy", "error"),
        force=bool(args.get("force", False)),
    ),
    check_fn=check_skills_requirements,
    emoji="📥",
)

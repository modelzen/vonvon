---
name: install-skills
description: Install or import external skills into the active Hermes or vonvon profile when the user provides a GitHub repo, tree URL, raw skill folder, or another agent-skill source. Reuse Hermes-compatible SKILL.md trees when possible, otherwise adapt the source into a Hermes-compatible skill under HERMES_HOME/skills with preserved provenance and minimal cleanup.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [skills, install, import, migration, github, compatibility]
    related_skills: [hermes-agent, openclaw-migration]
---

# Install Skills

Use this skill when the user wants Hermes or vonvon to install a skill from an external source.

The goal is not "copy files blindly". The goal is "produce a usable skill in the active profile".

## Core rules

- Always target the active `HERMES_HOME`.
- In vonvon, the default `HERMES_HOME` is usually `~/.vonvon/.hermes`, not `~/.hermes`.
- Install into `HERMES_HOME/skills/...`, not into the repo, temp folders, or the current workspace unless the user explicitly asks for a local draft.
- Prefer preserving an already-valid Hermes skill over rewriting it.
- If adaptation is needed, keep the adapted skill compact and move bulky source material into `references/`.
- Preserve provenance so future edits can trace where the skill came from.
- Do not run third-party installers or package managers unless the user asked for that side effect.

## What counts as "already compatible"

Treat the source as Hermes-compatible when you find a directory that already contains:

- `SKILL.md`
- optional `references/`, `templates/`, `scripts/`, or `assets/`

If that exists, the default action is:

1. copy the usable skill subtree
2. keep relative support files together
3. make only the smallest compatibility edits needed for Hermes/vonvon

Read [references/source-compatibility.md](references/source-compatibility.md) when the source shape is ambiguous.

## Default workflow

### 1. Inspect the source

Accept these source forms:

- GitHub repo URL
- GitHub tree URL
- raw `SKILL.md` URL
- `owner/repo/path/to/skill`
- local directory path

Figure out which of these cases you are in:

- **Direct skill directory**: the provided path already points at one skill
- **Repo containing skills**: the repo has one or more skill subdirectories
- **Foreign prompt package**: not a Hermes skill yet, but contains instructions worth converting
- **Unsupported**: mostly binaries, generated noise, or no durable instructions

If the source is a repo with multiple candidate skills and the user's target is unclear, stop and ask which one to import.

### 2. Choose the destination

Prefer preserving the upstream category when it is clear and reasonable.

Examples:

- `skills/productivity/foo` -> `HERMES_HOME/skills/productivity/foo`
- `optional-skills/migration/bar` -> `HERMES_HOME/skills/migration/bar`

If the source has no clear Hermes category, use `imports/<skill-name>`.

Before writing:

- check for name collisions with `skills_list`
- if a skill already exists, ask whether to:
  - keep the existing skill
  - overwrite it
  - import the new one under a renamed folder

### 3. Materialize the skill

Prefer `skill_manage` for structured writes:

- `skill_manage(action="create", ...)` for the initial `SKILL.md`
- `skill_manage(action="write_file", ...)` for `references/`, `templates/`, and text `scripts/`
- `skill_manage(action="patch", ...)` for small fixes to an imported skill

Use regular file or terminal tools only when `skill_manage` is not enough, for example:

- copying many existing text files unchanged
- copying binary assets
- moving an entire already-compatible subtree

Never copy these into the installed skill:

- `.git/`
- `.github/`
- `node_modules/`
- virtualenvs
- caches
- build output
- editor metadata

README or LICENSE files are not required inside the installed skill unless the file contains operational instructions the skill must read later.

### 4. Add provenance

When you install or adapt a skill, add or preserve provenance in frontmatter.

Use a structure like:

```yaml
metadata:
  hermes:
    imported_from:
      source: github
      identifier: owner/repo/path/to/skill
      original_format: hermes-compatible
      imported_by: install-skills
```

Read [references/provenance-template.md](references/provenance-template.md) for examples.

If you converted a foreign source instead of copying a native skill, also add:

- a short note in the `SKILL.md` body explaining what was adapted
- `references/original-source.md` with the raw source text, links, and important caveats

### 5. Validate before you finish

Before claiming success, verify all of the following:

- the installed directory exists under `HERMES_HOME/skills`
- `SKILL.md` exists
- the frontmatter still has `name` and `description`
- every file referenced from the new `SKILL.md` actually exists
- relative paths inside instructions do not still point at the old repo location
- any path examples mention `HERMES_HOME` or the actual installed location, not a guessed `~/.hermes/...` path when vonvon uses `~/.vonvon/.hermes`

### 6. Report the outcome

Summarize:

- source classification
- installed path
- whether the skill was copied or adapted
- what files were preserved
- what manual setup is still required

## Adaptation policy

### Case A: Native Hermes-style skill

If the upstream folder already has `SKILL.md` plus supporting files:

- keep the file tree
- patch only clearly incompatible path assumptions
- preserve useful references and scripts
- do not rewrite the whole skill just to make it prettier

This is the default for repos like `skills/<name>` style skill packs.

### Case B: Repo contains one or more skills

Find the actual skill directory first.

Common patterns:

- `skills/<name>/`
- `optional-skills/<category>/<name>/`
- `prompts/<name>/`
- `packages/<name>/skill/`

Do not install the whole repo if only one subtree is the real skill.

### Case C: Foreign prompt or agent profile

When no native `SKILL.md` exists, synthesize a Hermes skill:

1. write a compact `SKILL.md`
2. move long raw prompt material into `references/original-source.md`
3. preserve important setup instructions and constraints
4. clearly mark the skill as adapted

Keep the synthesized `SKILL.md` focused on:

- when to use it
- the workflow
- important caveats
- where extra source material lives

### Case D: Source needs external runtime setup

If the upstream skill depends on a CLI, API key, or package:

- preserve the setup steps in the skill
- do not execute them unless the user asked you to
- separate "skill imported successfully" from "runtime dependency installed"

Importing the skill and installing its external dependencies are different actions.

## Good defaults

- Prefer a working import over a perfect conversion.
- Prefer small, auditable edits over large rewrites.
- Prefer preserving upstream structure when it is already understandable.
- Prefer `references/` for source dumps and detailed docs.
- Prefer asking one targeted question over guessing when the repo has multiple candidate skills.

## Red flags

Do not:

- hardcode `~/.hermes` when the active profile is somewhere else
- dump an entire repo into `skills/`
- claim a skill is installed without verifying `SKILL.md` at the destination
- silently overwrite an existing skill with the same name
- throw away setup or caveat information that makes the imported skill usable
- leave rewritten files pointing at the upstream repo paths when the local installed path differs

## If tools are limited

If you do not have the tools needed to fetch the remote source contents:

- ask the user for the exact source path or the files to import
- or ask them to provide the raw `SKILL.md` and any supporting files

Do not hallucinate the upstream file tree.

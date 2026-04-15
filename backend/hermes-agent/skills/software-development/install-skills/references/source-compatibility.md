# Source Compatibility Matrix

Use this reference when deciding whether to copy, adapt, or reject an external skill source.

## 1. Native Hermes-compatible source

Signals:

- contains `SKILL.md`
- supporting files sit beside it in `references/`, `templates/`, `scripts/`, or `assets/`
- instructions already describe a skill workflow instead of a generic project README

Action:

- import the skill subtree with minimal edits
- preserve upstream structure
- patch only obviously wrong local paths or profile assumptions

## 2. Repo containing one or more skill directories

Signals:

- top-level repo is not itself a skill
- skill directories are nested under patterns like `skills/`, `optional-skills/`, `prompts/`, or feature subfolders

Action:

- identify the exact skill subtree first
- if the user named a specific skill, install only that subtree
- if multiple candidates match, ask which one they want

## 3. Prompt template or agent marketplace entry

Signals:

- no native `SKILL.md`
- source contains system prompt text, persona text, or agent config
- value is mostly in the instructions, not in executable repo structure

Action:

- synthesize a Hermes `SKILL.md`
- put raw source material into `references/original-source.md`
- preserve attribution and caveats

## 4. Runtime-heavy integration

Signals:

- source expects npm, pip, brew, cargo, Docker, or a hosted API
- repo includes installation instructions that are not part of the skill text itself

Action:

- import the skill content first
- preserve setup steps in the installed skill
- do not run installers unless the user explicitly asked for that side effect

## 5. Unsupported or unsafe source

Signals:

- mostly binaries or generated artifacts
- no durable text instructions
- obvious malware or path-traversal risk
- impossible to identify the real skill content

Action:

- do not install
- explain what was missing or unsafe
- ask the user for a narrower path or the actual source files

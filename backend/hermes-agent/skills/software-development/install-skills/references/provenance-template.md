# Provenance Template

When importing or adapting a skill, preserve enough provenance for future maintenance.

## Minimal provenance block

```yaml
metadata:
  hermes:
    imported_from:
      source: github
      identifier: owner/repo/path/to/skill
      original_format: hermes-compatible
      imported_by: install-skills
```

## Adapted foreign source

Use a richer block when you converted a non-Hermes source:

```yaml
metadata:
  hermes:
    imported_from:
      source: github
      identifier: owner/repo/path/to/source
      original_format: foreign-agent-prompt
      imported_by: install-skills
      adaptation_notes:
        - synthesized SKILL.md from upstream prompt
        - moved raw source text into references/original-source.md
```

## Notes

- Keep provenance compact and factual.
- Prefer stable identifiers such as repo path, source URL, or marketplace slug.
- Do not add noisy timestamps unless the runtime already has a standard way to maintain them.
- If the upstream skill was already Hermes-compatible, `original_format: hermes-compatible` is usually enough.

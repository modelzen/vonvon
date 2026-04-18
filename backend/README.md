# vonvon-backend

FastAPI service that wraps [hermes-agent](./hermes-agent/) and exposes a
custom REST + SSE API for the vonvon Electron frontend.

## Architecture

```
vonvon (Electron) ──HTTP/SSE──► vonvon-backend ──import──► hermes-agent
                                 (FastAPI)                  (AIAgent)
```

hermes-agent is vendored as a git subtree under `./hermes-agent/` so the
entire stack lives in one repo. Direct `import` of `AIAgent` gives the
backend full callback access (stream_delta, tool_progress, thinking, etc.)
without HTTP overhead.

## Setup

```bash
# 1. Create and activate virtualenv
python3.11 -m venv .venv
source .venv/bin/activate

# 2. Install backend (editable) with dev extras
pip install -e ".[dev]"

# 3. Install the vendored hermes-agent (editable)
pip install -e ./hermes-agent

# 4. Configure hermes-agent once via its CLI
hermes model   # configure model / API key / ChatGPT OAuth
```

Your hermes config lives in `~/.hermes/` (this repo's backend reads it on
startup).

## Run

```bash
uvicorn app.main:app --port 8000
```

## Test

```bash
pytest tests/ -v
```

Tests stub hermes-agent at the `sys.modules` level (see `conftest.py`), so
they run without a real hermes install. 18 tests cover chat SSE flow,
session CRUD, agent service lifecycle, and compression.

## Licensing

The overall vonvon repository is licensed under `AGPL-3.0-only`.

This backend vendors [Hermes Agent](./hermes-agent/) as a git subtree. That
subtree remains available under its original MIT license, and its upstream
license text is preserved at [`./hermes-agent/LICENSE`](./hermes-agent/LICENSE).

See [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for the repository
level third-party notice summary.

## API

Core endpoints:

- `POST /api/chat/send` — SSE stream with `tool.started`,
  `tool.completed`, `message.delta`, `run.completed`, `run.failed` events
- `POST /api/chat/compress` — manual context compression
- `GET/POST/DELETE /api/sessions` — session CRUD
- `GET /api/sessions/{id}/usage` — context window usage percentage
- `GET /api/models`, `POST /api/models/current` — model management
- `GET /api/health` — backend + hermes config status

## Updating the vendored hermes-agent

When upstream [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
publishes updates you want:

```bash
# From the vonvon repo root:
git subtree pull --prefix=backend/hermes-agent \
  https://github.com/NousResearch/hermes-agent.git main --squash
```

Resolve any conflicts with local modifications (e.g. the
`SessionDB.replace_messages` method added for context compression).

# Vonvon

Vonvon is a macOS desktop AI assistant built around a floating native companion
window, an Electron/React sidebar, and a bundled FastAPI backend powered by
Hermes Agent.

## What It Does

- Runs as a lightweight desktop companion instead of a traditional chat app window.
- Starts a local FastAPI backend that streams chat, tool progress, and session state.
- Bundles a native "Kirby" assistant window for snap/dock interactions on macOS.
- Supports provider configuration, session history, workspace-aware execution, and
  Feishu/Lark integration flows.

## Architecture

```text
Electron + React UI
        |
        | IPC / HTTP / SSE
        v
Native Kirby window + FastAPI backend
        |
        v
Vendored Hermes Agent runtime
```

## Repository Layout

- `src/`: Electron main process, preload bridge, and React renderer.
- `native/`: native macOS addon used by the Kirby assistant window.
- `backend/`: FastAPI service plus vendored `hermes-agent`.
- `scripts/`: packaging helpers such as the bundled Python runtime builder.

## Requirements

- macOS 12+
- Node.js 20+
- Python 3.11

## Development Setup

1. Install JavaScript dependencies:

```bash
npm install
```

2. Create the backend virtual environment and install dependencies:

```bash
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]" -e ./hermes-agent
```

3. Configure Hermes once so the backend has a model/provider available:

```bash
hermes model
```

4. Start the desktop app:

```bash
cd ..
npm run dev
```

In development, the Electron app auto-starts the backend from `backend/.venv`
unless `VONVON_SKIP_BACKEND=1` is set.

## Useful Commands

```bash
npm run dev        # start the Electron app in development
npm run build:app  # build the Electron bundles without packaging
npm run dist       # build a packaged app with electron-builder
npm run rebuild    # rebuild the native addon
cd backend && pytest tests -v
```

## Packaging Notes

The packaged macOS app ships:

- Electron renderer/main bundles
- the `backend/` source tree
- a standalone Python runtime built by `scripts/build-runtime.sh`

The current packaging configuration targets Apple Silicon macOS.

## License

This repository is licensed under `AGPL-3.0-only`.

Vonvon vendors third-party code, including `backend/hermes-agent`, which remains
available under its original license. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)
for details.

## Security

If you believe you have found a security issue, please avoid opening a public
issue with exploit details. Share a private report using the contact
instructions in [SECURITY.md](./SECURITY.md).

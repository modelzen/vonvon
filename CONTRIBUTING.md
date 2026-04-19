# Contributing

Thanks for helping improve Vonvon.

## Before You Start

- Open an issue or discussion if you want to propose a large feature or
  behavioral change.
- Keep pull requests focused. Small, reviewable changes land much faster than
  broad mixed refactors.
- Do not include secrets, local machine paths, or private handoff notes in
  commits.

## Development

```bash
npm install
cd backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]" -e ./hermes-agent
cd ..
npm run dev
```

## Validation

Run the checks relevant to your change before opening a pull request:

```bash
npm run build:app
cd backend && pytest tests -v
```

If your change affects the native addon, also run:

```bash
npm run rebuild
```

If you need to verify "what the DMG-installed app will really do" instead of
just `npm run dev`, use:

```bash
npm run test:packaged
```

That command refreshes packaged-only artifacts when needed, builds the macOS
app bundle, and launches the packaged app from the terminal so you can inspect
real packaged-mode logs. Add `-- --build-only` if you only want the bundle.

## Pull Requests

- Describe the user-visible change and how you tested it.
- Include screenshots or short recordings for UI behavior changes when helpful.
- Call out any packaging, native, or backend implications in the PR body.

By contributing, you agree that your contributions will be licensed under the
same license as this repository.

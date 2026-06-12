# WDIM

WDIM is a local-first macOS app that helps you catch up across sources you care about. It scans connected accounts and public sources, summarizes what changed, and uses a bundled Codex runtime for ChatGPT sign-in and local reasoning.

The desktop app lives in:

```text
desktop/
```

## What It Does

- Runs as a macOS app with a status-bar menu.
- Signs users into WDIM through ChatGPT via the bundled Codex app-server.
- Scans private account sources where configured:
  - Gmail through native OAuth
  - X / Twitter through the local bird connector (browser session cookies)
- Scans local/public sources:
  - Telegram account chats selected by the user
  - YouTube channels with transcript-backed summaries
- Stores settings, tokens, cursors, scan history, findings, and source health locally on the Mac.
- Runs read-only scans on an hourly cadence by default.
- Shows important catch-up items and source insights in the desktop UI.
- Sends macOS notifications only for high-signal items.

## Current Architecture

WDIM does not have a hosted backend in this repo.

1. Electron runs the app shell, status-bar menu, and renderer UI.
2. The main process stores local state in SQLite under the app's macOS user-data directory.
3. Native OAuth connectors store encrypted local tokens using Electron `safeStorage`.
4. Public source connectors poll YouTube channels directly via bundled yt-dlp.
5. Telegram uses a local user-account connector so the user can select DMs, groups, and channels.
6. The app starts the bundled `codex app-server` and sends JSON-RPC requests for triage and summaries.
7. The app vendors Codex and yt-dlp into the packaged `.app`, so retail users should not need terminal installs.

The MVP is read-only: no replying, deleting, archiving, joining chats, or mutating third-party sources.

## Repo Layout

- `desktop/` - Electron macOS app, source connectors, local store, scanner, release config.
- `shared/` - shared event types and prompt builders.
- `site/` - public landing/download site.
- `AGENTS.md` - repo guidance for coding agents.

## Local Development

```bash
cd desktop
bun install
bun run dev
```

The dev app loads `desktop/.env.local` when present.

For native OAuth source testing, copy:

```bash
cp desktop/.env.example desktop/.env.local
```

Then fill only the providers you want to test:

```text
WDIM_GMAIL_CLIENT_ID=
WDIM_GMAIL_CLIENT_SECRET=
```

## Useful Commands

```bash
bun run --cwd desktop typecheck
bun test desktop/src/main/codex.test.ts
bun run --cwd desktop smoke:codex
```

Build an unsigned local DMG:

```bash
bun run --cwd desktop dist
```

Build the signed/notarized public DMG from the repo root:

```bash
bun run release:desktop
```

## Versioning

WDIM uses Changesets.

```bash
bun run changeset
bun run version:packages
git add .changeset desktop/package.json desktop/CHANGELOG.md package.json bun.lock
git commit -m "Release v0.1.1"
git tag desktop-v0.1.1
bun run release:desktop
```

The public artifact is named like:

```text
desktop/release/wdim-0.1.0-arm64.dmg
```

# WDIM Desktop

Electron macOS app for local-first catch-up scans across private accounts and public sources.

## Current Product Shape

- macOS status-bar app with an optional full window.
- ChatGPT sign-in through bundled Codex app-server.
- Bundled Codex runtime in packaged builds.
- Bundled yt-dlp runtime for YouTube channel metadata and captions.
- Local SQLite persistence for settings, source connections, cursors, scan history, important items, and diagnostics.
- Read-only source scanning.

## Sources

Private account sources:

- Gmail through native OAuth when the matching client config is present
- X / Twitter through the local bird connector (browser session cookies)

Local/public sources do not require a private OAuth account:

- Telegram local account connector
- YouTube channels

## Requirements

- macOS
- Bun
- Apple Developer credentials only when building a public signed/notarized DMG

Retail users should not need to install Codex or yt-dlp in Terminal. Packaged builds vendor both runtimes into the app.

## Development

```bash
cd desktop
bun install
bun run dev
```

The dev script loads `desktop/.env.local` when present.

Copy the example env if you want to test native account OAuth:

```bash
cp .env.example .env.local
```

Configure only the providers you are testing:

```text
WDIM_GMAIL_CLIENT_ID=
WDIM_GMAIL_CLIENT_SECRET=

WDIM_GITHUB_CLIENT_ID=
WDIM_GITHUB_CLIENT_SECRET=

WDIM_TWITTER_CLIENT_ID=
WDIM_TWITTER_REDIRECT_URI=http://127.0.0.1:53145/oauth/callback/twitter
```

Set this for development when you do not want startup to immediately poll live sources:

```text
WDIM_SKIP_INITIAL_SCAN=1
```

## Testing

```bash
bun run typecheck
bun test
```

Focused checks used often:

```bash
bun test src/main/codex.test.ts
bun test src/main/connectors/registry.test.ts
bun run smoke:codex
```

`smoke:codex` verifies that the app can start the local Codex app-server and parse triage output from sample events. It does not need Gmail, Telegram, X, or YouTube credentials.

## Build

Unsigned local DMG:

```bash
bun run dist
```

Signed and notarized DMG:

```bash
cd <repo-root>
bun run release:desktop
```

The DMG is written to:

```text
desktop/release/wdim-0.1.0-arm64.dmg
```

The current public build target is Apple Silicon macOS (`arm64`).

## Versioning

WDIM uses Changesets from the repo root.

```bash
cd <repo-root>
bun run changeset
bun run version:packages
git add .changeset desktop/package.json desktop/CHANGELOG.md package.json bun.lock
git commit -m "Release v0.1.1"
git tag desktop-v0.1.1
bun run release:desktop
```

The app version comes from `desktop/package.json`; Electron Builder uses it in app metadata and the DMG filename.

## First Use

1. Open WDIM.
2. Click `Sign in with ChatGPT`.
3. Complete the browser sign-in flow.
4. Add sources from the Sources view:
   - connect private accounts where OAuth is configured;
   - paste YouTube channel URLs;
   - connect Telegram and select chats.
5. Use the refresh button or wait for the hourly scan.

## Diagnostics

The app can copy a redacted diagnostics snapshot with:

- app version and platform;
- user-data path;
- Codex readiness;
- connected source health;
- recent scan summaries;
- notification support;
- local schedule state.

Diagnostics intentionally redact email-like values and do not include OAuth tokens, Codex credentials, transcript bodies, or raw private messages.

## Release Notes

See [RELEASE.md](./RELEASE.md) for Apple signing, notarization, and clean-install verification.

# WDIM Agent Notes

## Product

WDIM is a local-first macOS catch-up app. It scans private account sources and public sources, then turns recent activity into a focused briefing. The app is read-only: do not add source mutations such as replying, archiving, deleting, joining chats, or changing third-party state unless the user explicitly asks for a new product direction.

Users sign in to WDIM with ChatGPT through the bundled Codex app-server. Do not introduce BYOK or user API-key onboarding unless explicitly requested.

## Architecture

- `desktop/` contains the Electron macOS app.
- `shared/` contains shared source event types and prompt builders.
- `site/` contains the landing/download site.
- Runtime state is local SQLite under the app's macOS user-data directory.
- OAuth tokens are stored locally and encrypted with Electron `safeStorage`.
- Packaged builds vendor Codex, yt-dlp, and the bird CLI into the `.app`; retail users should not need terminal installs.

There is no hosted WDIM backend in this repo.

## Sources

Private account sources:

- Gmail through native OAuth when configured
- X / Twitter through the local bird connector (browser session cookies)

Local/public sources:

- Telegram local account connector with explicit chat selection
- YouTube channels by URL, summarized from captions/transcripts via bundled yt-dlp

Keep source UI language user-facing. Prefer "sources", "sign in to WDIM", and "connect account" over implementation/provider jargon.

## Scanner Behavior

- Initial scans look back at most 24 hours.
- Later scans use the later of the last completed scan time or `now - 24h`.
- Store durable user-visible findings in `important_items`.
- Use `memory_keys.scanned` for raw source dedupe.
- Use `memory_keys.notified` for macOS notification dedupe.
- Telegram messages with obvious action signals should be promoted deterministically before AI filtering, especially mentions, direct asks, Calendly links, demo links, docs links, and call requests.
- YouTube rows should summarize transcript content into 4-6 readable bullets. Do not expose raw transcript notes in the feed.

## Privacy

Do not add diagnostics or logs that include raw private message bodies, OAuth tokens, Codex credentials, raw transcripts, or sensitive account identifiers. Diagnostics should stay redacted.

Raw YouTube transcripts are not product state. They may be written manually during debugging, but the app should store summarized findings and scan history.

## Development

From the desktop package:

```bash
cd desktop
bun run dev
bun run typecheck
bun test
```

Useful focused checks:

```bash
bun test src/main/scanner.test.ts
bun test src/main/codex.test.ts
bun test src/main/connectors/registry.test.ts
bun run smoke:codex
```

Use `desktop/.env.local` for local OAuth config. Copy from `desktop/.env.example` and fill only the providers being tested.

## Versioning And Release

WDIM uses Changesets from the repo root.

```bash
bun run changeset
bun run version:packages
bun run release:desktop
```

The app version comes from `desktop/package.json`. Electron Builder uses it for app metadata and the DMG filename.

For public macOS distribution, use Developer ID signing, notarization, and stapling. The desktop release details live in `desktop/RELEASE.md`.

## Repo Hygiene

- Keep generated experiments and one-off prototypes out of the repo unless they are part of the product.
- Do not add Superpowers docs/plans or process-heavy skill artifacts to this repo.
- Keep docs concise and project-owned.
- Preserve unrelated user changes in the working tree.

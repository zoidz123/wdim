# Source Architecture

WDIM sources are local-first and read-only. The scanner, dedupe memory, source cursors, important-item lifecycle, schedule, and Codex triage all run on the user's Mac.

## Source Types

WDIM has two source families:

- Account sources: private data connected through native OAuth and stored as encrypted local tokens.
- Public/local sources: data the user can add by URL or local account connection.

Current sources:

1. Gmail account inboxes through native Google OAuth.
2. X / Twitter For You timeline through the local bird connector (browser session cookies).
3. Telegram DMs, groups, and channels through the local Telegram connector.
4. YouTube channels by channel URL, summarized from captions/transcripts via bundled yt-dlp.

## Trust Model

- No WDIM-hosted backend is required by this repo.
- Third-party tokens stay on the user's Mac.
- Source data is fetched for local triage and stored only as local scan history/findings.
- The app uses bundled Codex for ChatGPT sign-in and app-server reasoning.
- The product remains read-only.

## Scan Window

First setup and recurring scans use a bounded catch-up window:

- initial scans look back at most 24 hours;
- later scans use the later of the last completed scan time or `now - 24h`;
- connector-specific cursors are also persisted when available.

## Gmail

Gmail uses native OAuth with the read-only Gmail scope:

```text
https://www.googleapis.com/auth/gmail.readonly
```

The connector fetches recent inbox messages, preserves source IDs and links, and keeps enough metadata for Codex to understand why a message may matter.


## YouTube

YouTube sources are channel URLs such as:

```text
https://www.youtube.com/@allin
```

WDIM uses bundled yt-dlp to read channel metadata and fetch caption/transcript URLs. When transcripts are available, Codex summarizes the episode into reader-friendly bullets so the user can understand a podcast/video without watching the whole thing.

Raw transcripts are not stored as product state. They may be written manually during debugging, but the app stores summarized findings and scan history.

## Telegram

Telegram stays local/custom because WDIM needs user-account monitoring with explicit user control over DMs, groups, and channels.

Rules:

- DMs can be included globally.
- Groups and channels are opt-in.
- The connector never replies, joins chats, or mutates Telegram state.

## Local Run Modes

- Manual scan from the app UI.
- Status-bar `Scan Now`.
- Hourly local scan while the app is running.
- Overdue scan after Mac wake.

No hosted WDIM backend is part of this architecture.

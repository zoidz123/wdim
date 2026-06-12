# @what-did-i-miss/shared

## 0.1.1

### Patch Changes

- Reliability, security, and performance fixes for the digest-cards release:

  - Ship the bird CLI inside the app (bundled to dist/bird.mjs, asar-unpacked) so X / Twitter scanning works in packaged builds.
  - Isolate per-source scan failures: Telegram errors report connector health instead of failing the whole scan, and the export-file path works again.
  - Harden the Codex client: non-JSON app-server output no longer crashes the app, and the transport re-handshakes after an app-server restart.
  - Skip a failed YouTube video summary instead of failing the entire scan; it retries next run.
  - Cap digest prompt size (newest 300 items, per-item truncation, compact JSON) to stay under the Codex turn timeout.
  - Paginate native Gmail scans up to 100 messages so busy inboxes are not silently truncated at 25.
  - Trim renderer state payloads (drop raw model responses and scan metadata from IPC).
  - Clamp the scan interval to 7 days to avoid a timer-overflow scan loop.
  - OAuth callback server ignores stray requests (favicon, probes) instead of aborting the sign-in.
  - Add a renderer Content-Security-Policy, warn when tokens fall back to unencrypted storage, and pin @steipete/bird to an exact version.

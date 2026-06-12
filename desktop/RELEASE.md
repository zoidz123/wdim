# WDIM macOS Release

WDIM is distributed as a Developer ID signed and notarized DMG outside the Mac App Store.

## One-time Apple setup

1. Join the Apple Developer Program.
2. Install a `Developer ID Application` certificate in Keychain.
   - Check with `security find-identity -v -p codesigning`.
   - `Apple Development` certificates are not enough for public DMG distribution.
   - For electron-builder, set `CSC_NAME` to the identity name without the `Developer ID Application:` prefix.
3. Create notarization credentials.
   - Preferred: App Store Connect API key from App Store Connect > Users and Access > Integrations > App Store Connect API.
   - Alternative: Apple ID app-specific password plus team ID.
4. Export the values from `release.env.example` in your shell. Do not commit real secrets.

## Build

For a new public version, create and apply a Changeset before building:

```bash
cd <repo-root>
bun run changeset
bun run version:packages
git add .changeset desktop/package.json desktop/CHANGELOG.md package.json bun.lock
git commit -m "Release v0.1.1"
git tag desktop-v0.1.1
```

The app version comes from `desktop/package.json`; Electron Builder uses it for app metadata and the DMG filename.

```bash
cd <repo-root>
bun run release:desktop
```

This vendors Codex and yt-dlp, builds the Electron app, signs it, notarizes it, and writes a DMG like `desktop/release/wdim-0.1.0-arm64.dmg`.

## Verify

```bash
spctl --assess --type open --context context:primary-signature -vv release/*.dmg
xcrun stapler validate release/*.dmg
```

Then download the DMG from the website on a clean macOS user profile and confirm:

- Gatekeeper opens it without a scary warning.
- The app name and icon show as `wdim`.
- ChatGPT sign-in works.
- X and YouTube scans work without terminal installs.

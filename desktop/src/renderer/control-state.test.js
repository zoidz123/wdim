import { describe, expect, test } from "bun:test";
import { codexOnboardingState, localContentVisibilityState, scanNowControlState } from "./control-state.js";

describe("scanNowControlState", () => {
  test("disables manual scans before any source is connected", () => {
    expect(scanNowControlState({
      actionBusy: false,
      state: appState({ gmailCredentialsPath: null, accounts: [] })
    })).toEqual({
      disabled: true,
      title: "Connect a source first",
      ariaLabel: "Connect a source first"
    });
  });

  test("disables manual scans while signed out of Codex", () => {
    expect(scanNowControlState({
      actionBusy: false,
      state: appState({ codexReady: false, gmailCredentialsPath: "/tmp/credentials.json", accounts: [{ id: "a" }] })
    })).toEqual({
      disabled: true,
      title: "Sign in to WDIM first",
      ariaLabel: "Sign in to WDIM first"
    });
  });

  test("disables manual scans while a scan is running", () => {
    expect(scanNowControlState({
      actionBusy: false,
      state: appState({ gmailCredentialsPath: "/tmp/credentials.json", accounts: [{ id: "a" }], isScanning: true })
    })).toEqual({
      disabled: true,
      title: "Scan running",
      ariaLabel: "Scan running"
    });
  });

  test("enables manual scans after Gmail setup is ready", () => {
    expect(scanNowControlState({
      actionBusy: false,
      state: appState({ gmailCredentialsPath: "/tmp/credentials.json", accounts: [{ id: "a" }] })
    })).toEqual({
      disabled: false,
      title: "Scan now",
      ariaLabel: "Scan now"
    });
  });

  test("enables manual scans after Telegram setup is ready", () => {
    expect(scanNowControlState({
      actionBusy: false,
      state: appState({ telegramExportPath: "/tmp/result.json", telegramIncludeDms: true })
    })).toEqual({
      disabled: false,
      title: "Scan now",
      ariaLabel: "Scan now"
    });
  });

  test("enables manual scans after a source connector is ready", () => {
    expect(scanNowControlState({
      actionBusy: false,
      state: appState({ sourceConnections: [{ enabled: true }] })
    })).toEqual({
      disabled: false,
      title: "Scan now",
      ariaLabel: "Scan now"
    });
  });
});

describe("codexOnboardingState", () => {
  test("asks users to install Codex when the CLI is missing", () => {
    expect(codexOnboardingState({
      codexReady: false,
      codexStatus: {
        state: "missing",
        detail: "WDIM uses your ChatGPT account through the local Codex app. Install Codex to continue.",
        command: "https://openai.com/codex/",
        actionLabel: "Download Codex"
      }
    })).toEqual({
      hidden: false,
      title: "Install Codex",
      detail: "WDIM uses your ChatGPT account through the local Codex app. Install Codex to continue.",
      actionLabel: "Download Codex",
      action: "download",
      command: "https://openai.com/codex/"
    });
  });

  test("asks users to sign in when Codex is installed but unauthenticated", () => {
    expect(codexOnboardingState({
      codexReady: false,
      codexStatus: {
        state: "needs_auth",
        detail: "Codex is installed but needs ChatGPT sign-in.",
        command: null,
        actionLabel: "Sign in with ChatGPT"
      }
    })).toEqual({
      hidden: false,
      title: "Sign in to WDIM",
      detail: "Use your ChatGPT account.",
      actionLabel: "Sign in with ChatGPT",
      action: "signin",
      command: null
    });
  });

  test("shows a reinstall message when WDIM's bundled runtime is missing", () => {
    expect(codexOnboardingState({
      codexReady: false,
      codexStatus: {
        state: "error",
        detail: "WDIM's bundled Codex runtime is missing. Reinstall WDIM.",
        command: null,
        actionLabel: null
      }
    })).toEqual({
      hidden: false,
      title: "Check WDIM",
      detail: "WDIM's bundled Codex runtime is missing. Reinstall WDIM.",
      actionLabel: null,
      action: null,
      command: null
    });
  });
});

describe("localContentVisibilityState", () => {
  test("locks locally stored content while Codex is signed out", () => {
    expect(localContentVisibilityState({ codexReady: false })).toEqual({
      locked: true,
      statusText: "Sign in to WDIM",
      emptyText: "Sign in to WDIM to view your saved items and sources.",
      showLastScan: false
    });
  });

  test("shows locally stored content after Codex is ready", () => {
    expect(localContentVisibilityState({ codexReady: true })).toEqual({
      locked: false,
      statusText: null,
      emptyText: null,
      showLastScan: true
    });
  });
});

function appState(overrides = {}) {
  return {
    codexReady: overrides.codexReady ?? true,
    isScanning: overrides.isScanning ?? false,
    settings: {
      gmailCredentialsPath: overrides.gmailCredentialsPath ?? null,
      telegramExportPath: overrides.telegramExportPath ?? null,
      telegramIncludeDms: overrides.telegramIncludeDms ?? true
    },
    accounts: overrides.accounts ?? [],
    sourceConnections: overrides.sourceConnections ?? [],
    telegramChats: overrides.telegramChats ?? []
  };
}

import { describe, expect, test } from "bun:test";
import { buildDiagnostics, buildLiveCheckCommand, maskEmail } from "./diagnostics";
import type { AppState } from "./types";

describe("diagnostics", () => {
  test("redacts credentials path and inbox emails", () => {
    const diagnostics = buildDiagnostics(appState(), {
      appVersion: "0.1.0",
      platform: "darwin",
      userDataPath: "/Users/example/Library/Application Support/What Did I Miss",
      notificationSupported: true,
      now: () => new Date("2026-06-02T12:00:00.000Z")
    });

    expect(diagnostics.generatedAt).toBe("2026-06-02T12:00:00.000Z");
    expect(diagnostics.setup.gmailCredentialsSelected).toBe(true);
    expect(diagnostics.setup.gmailCredentialsFileName).toBe("credentials.json");
    expect(JSON.stringify(diagnostics)).not.toContain("/Users/example/secrets");
    expect(JSON.stringify(diagnostics)).not.toContain("work@example.com");
    expect(diagnostics.setup.connectedInboxes).toEqual(["wk***@e***.com"]);
    expect(diagnostics.setup.nativeConfiguredSources).toEqual(["gmail", "twitter"]);
    expect(diagnostics.setup.legacyLocalGmailCount).toBe(1);
    expect(diagnostics.setup.sourceConnections).toEqual([
      {
        id: "gmail:native:wk***@e***.com",
        source: "gmail",
        backend: "native",
        label: "wk***@e***.com",
        accountIdentifier: "wk***@e***.com",
        enabled: true,
        connectedAt: "2026-06-02T10:00:00.000Z",
        updatedAt: "2026-06-02T10:00:00.000Z"
      },
      {
        id: "twitter:native:zoidz123",
        source: "twitter",
        backend: "native",
        label: "[redacted]",
        accountIdentifier: "[redacted]",
        enabled: true,
        connectedAt: "2026-06-02T10:05:00.000Z",
        updatedAt: "2026-06-02T10:05:00.000Z"
      }
    ]);
    expect(diagnostics.gmailScan).toEqual({
      query: "in:inbox after:2026/06/01",
      catchUpDays: 1,
      pageSize: 50,
      maxMessagesPerInbox: 200
    });
    expect(diagnostics.notifications.supported).toBe(true);
    expect(diagnostics.lastScan?.accountErrors?.[0]?.accountEmail).toBe("wk***@e***.com");
    expect(diagnostics.lastScan?.accountSummaries?.[0]).toEqual({
      accountEmail: "wk***@e***.com",
      messagesFound: 10,
      messagesScanned: 8,
      messagesSkipped: 2
    });
    expect(diagnostics.lastScan?.findingsCount).toBe(2);
    expect(diagnostics.lastScan?.highPriorityFindings).toBe(1);
    expect(diagnostics.inboxHealth).toEqual([
      {
        accountEmail: "wk***@e***.com",
        status: "error",
        detail: "Skipped last scan: Token expired"
      }
    ]);
    expect(diagnostics.connectorHealth).toEqual([
      {
        connectionId: "gmail:native:wk***@e***.com",
        status: "ready",
        detail: "Last read from wk***@e***.com succeeded",
        checkedAt: "2026-06-02T11:00:00.000Z"
      }
    ]);
  });

  test("reports redacted healthy inbox scan counts in diagnostics", () => {
    const state = appState();
    state.lastScan = {
      ...(state.lastScan as NonNullable<AppState["lastScan"]>),
      accountErrors: []
    };

    const diagnostics = buildDiagnostics(state, {
      appVersion: "0.1.0",
      platform: "darwin",
      userDataPath: "/Users/example/Library/Application Support/What Did I Miss",
      now: () => new Date("2026-06-02T12:00:00.000Z")
    });

    expect(diagnostics.inboxHealth).toEqual([
      {
        accountEmail: "wk***@e***.com",
        status: "ok",
        detail: "Last scan OK",
        messagesFound: 10,
        messagesScanned: 8,
        messagesSkipped: 2
      }
    ]);
    expect(JSON.stringify(diagnostics.inboxHealth)).not.toContain("work@example.com");
  });

  test("masks malformed emails as redacted", () => {
    expect(maskEmail("not-an-email")).toBe("[redacted]");
  });

  test("builds a shell-safe live Codex smoke command", () => {
    expect(buildLiveCheckCommand(
      "/Users/example/what did i miss/desktop",
      "/Users/example/OAuth files/client's credentials.json"
    )).toBe(
      "cd '/Users/example/what did i miss/desktop' && bun run smoke:codex"
    );
  });

  test("does not require a credentials path for live checks", () => {
    expect(buildLiveCheckCommand("/repo/desktop", null)).toBe(
      "cd '/repo/desktop' && bun run smoke:codex"
    );
  });
});

function appState(): AppState {
  return {
    settings: {
      scanIntervalMinutes: 60,
      gmailCredentialsPath: "/Users/example/secrets/credentials.json",
      telegramExportPath: "/Users/example/secrets/telegram-result.json",
      telegramIncludeDms: true,
      launchAtLogin: true,
      quietHours: { enabled: true, start: "22:00", end: "07:00" }
    },
    accounts: [{ id: "work@example.com", email: "work@example.com", displayName: "Work", connectedAt: "2026-06-02T10:00:00.000Z" }],
    sourceConnections: [
      {
        id: "gmail:native:work@example.com",
        source: "gmail",
        backend: "native",
        label: "work@example.com",
        accountIdentifier: "work@example.com",
        externalAccountId: null,
        enabled: true,
        config: { tokenId: "gmail_token" },
        connectedAt: "2026-06-02T10:00:00.000Z",
        updatedAt: "2026-06-02T10:00:00.000Z"
      },
      {
        id: "twitter:native:zoidz123",
        source: "twitter",
        backend: "native",
        label: "@zoidz123",
        accountIdentifier: "@zoidz123",
        externalAccountId: null,
        enabled: true,
        config: { tokenId: "twitter_token" },
        connectedAt: "2026-06-02T10:05:00.000Z",
        updatedAt: "2026-06-02T10:05:00.000Z"
      }
    ],
    nativeConfiguredSources: ["gmail", "twitter"],
    connectorHealth: [
      {
        connectionId: "gmail:native:work@example.com",
        status: "ready",
        detail: "Last read from work@example.com succeeded",
        checkedAt: "2026-06-02T11:00:00.000Z"
      }
    ],
    legacyLocalGmailAccounts: [{ id: "work@example.com", email: "work@example.com", displayName: "Work", connectedAt: "2026-06-02T10:00:00.000Z" }],
    telegramChats: [{ id: "market", title: "Market", enabled: true, kind: "group" }],
    codexReady: true,
    isScanning: false,
    nextScanAt: "2026-06-02T13:00:00.000Z",
    lastScan: {
      id: "scan_1",
      startedAt: "2026-06-02T11:00:00.000Z",
      completedAt: "2026-06-02T11:00:02.000Z",
      durationMs: 2000,
      status: "completed",
      accountsScanned: 1,
      messagesFound: 10,
      messagesScanned: 8,
      messagesSkipped: 2,
      accountSummaries: [{ accountEmail: "work@example.com", messagesFound: 10, messagesScanned: 8, messagesSkipped: 2 }],
      accountErrors: [{ accountEmail: "work@example.com", error: "Token expired" }],
      findings: [
        {
          priority: "high",
          source: "gmail",
          sourceId: "msg_1",
          accountEmail: "work@example.com",
          title: "Urgent",
          why: "Needs attention",
          suggestedAction: "Reply",
          evidence: "Please respond"
        },
        {
          priority: "medium",
          source: "gmail",
          sourceId: "msg_2",
          accountEmail: "work@example.com",
          title: "Follow-up",
          why: "Worth seeing",
          suggestedAction: "Review",
          evidence: "Checking in"
        }
      ]
    },
    lastCompletedScan: null,
    recentScans: [],
    lastError: null
  };
}

import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { formatHighPriorityNotification, formatScanFailureNotification, ScanService } from "./scanner";
import type { RawEvents } from "@what-did-i-miss/shared";
import type { ConnectorRegistry } from "./connectors/registry";
import type { ConnectorHealth, SourceConnection, SourceConnector, SourceCursor, SourceEvent } from "./connectors/types";
import type { AppSettings, GmailAccount, ImportantItem, ImportantItemStatus, ScanResult, TelegramChat } from "./types";

class FakeStore {
  settings: AppSettings = {
    scanIntervalMinutes: 60,
    gmailCredentialsPath: null,
    telegramExportPath: null,
    telegramIncludeDms: true,
    launchAtLogin: false,
    quietHours: { enabled: false, start: "22:00", end: "07:00" }
  };
  accounts: GmailAccount[] = [];
  telegramChats: TelegramChat[] = [];
  scans: ScanResult[] = [];
  notifiedFindingKeys: string[] = [];
  scannedMessageKeys: string[] = [];
  dismissedSourceInsightIds: string[] = [];
  dismissedDigestCardIds: string[] = [];
  importantItems: ImportantItem[] = [];
  sourceCursors: SourceCursor[] = [];
  connectorHealth: ConnectorHealth[] = [];

  async getSettings() {
    return this.settings;
  }

  async getAccounts() {
    return this.accounts;
  }

  async getTelegramChats() {
    return this.telegramChats;
  }

  async addScan(scan: ScanResult) {
    this.scans.unshift(scan);
    return this.scans;
  }

  async getLastScan() {
    return this.scans[0] ?? null;
  }

  async getLastCompletedScan() {
    return this.scans.find((scan) => scan.status === "completed") ?? null;
  }

  async getRecentScans(limit = 5) {
    return this.scans.slice(0, limit);
  }

  async claimNewNotifiedFindingKeys(keys: string[]) {
    const existing = new Set(this.notifiedFindingKeys);
    const newKeys = [...new Set(keys)].filter((key) => !existing.has(key));
    this.notifiedFindingKeys = [...newKeys, ...this.notifiedFindingKeys];
    return newKeys;
  }

  async clearNotifiedFindingKeysByPrefix(prefix: string) {
    this.notifiedFindingKeys = this.notifiedFindingKeys.filter((key) => !key.startsWith(prefix));
  }

  async getScannedMessageKeys() {
    return this.scannedMessageKeys;
  }

  async addScannedMessageKeys(keys: string[]) {
    this.scannedMessageKeys = [...new Set([...keys, ...this.scannedMessageKeys])];
    return this.scannedMessageKeys;
  }

  async clearScannedMessageKeys(keys: string[]) {
    const remove = new Set(keys);
    this.scannedMessageKeys = this.scannedMessageKeys.filter((key) => !remove.has(key));
  }

  async getDismissedSourceInsightIds() {
    return this.dismissedSourceInsightIds;
  }

  async getDismissedDigestCardIds() {
    return this.dismissedDigestCardIds;
  }

  async getImportantItems(status: ImportantItemStatus = "active") {
    return this.importantItems.filter((item) => item.status === status);
  }

  async saveSourceCursors(cursors: SourceCursor[]) {
    this.sourceCursors = [
      ...cursors,
      ...this.sourceCursors.filter((existing) => !cursors.some((cursor) =>
        cursor.connectionId === existing.connectionId && cursor.cursorKey === existing.cursorKey
      ))
    ];
  }

  async clearSourceCursors(connectionId: string) {
    this.sourceCursors = this.sourceCursors.filter((cursor) => cursor.connectionId !== connectionId);
  }

  async saveConnectorHealth(health: ConnectorHealth) {
    this.connectorHealth = [health, ...this.connectorHealth.filter((item) => item.connectionId !== health.connectionId)];
  }
}

describe("ScanService", () => {
  const services: ScanService[] = [];

  beforeEach(async () => {
    await fs.writeFile("/tmp/credentials.json", JSON.stringify({
      installed: {
        client_id: "client-id",
        client_secret: "client-secret"
      }
    }));
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.stop();
  });

  test("records a failed scan when no source is connected", async () => {
    const store = new FakeStore();
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Connect Gmail, Telegram, or another source");
    expect(typeof result.durationMs).toBe("number");
  });

  test("coalesces duplicate scan requests while a scan is already running", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    let fetchCount = 0;
    let releaseFetch!: () => void;
    const fetchStarted = new Promise<void>((resolveStarted) => {
      releaseFetch = resolveStarted;
    });
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => {
          fetchCount += 1;
          await fetchStarted;
          return [];
        }
      } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const first = service.scanNow();
    const second = service.scanNow();
    releaseFetch();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(fetchCount).toBe(1);
    expect(firstResult).toBe(secondResult);
    expect(firstResult.status).toBe("completed");
  });

  test("does not schedule hourly scans before Gmail setup is complete", async () => {
    const store = new FakeStore();
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const state = await service.getState();

    expect(state.codexReady).toBe(true);
    expect(state.nextScanAt).toBeNull();
  });

  test("schedules hourly retry when Gmail is ready but Codex is not signed in yet", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {
          throw new Error("Codex is not signed in.");
        },
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const state = await service.getState();

    expect(state.codexReady).toBe(false);
    expect(state.codexStatus).toEqual({
      state: "needs_auth",
      detail: "Codex is installed but needs ChatGPT sign-in.",
      command: null,
      actionLabel: "Sign in with ChatGPT"
    });
    expect(state.lastError).toContain("Codex is not signed in.");
    expect(typeof state.nextScanAt).toBe("string");
  });

  test("manually retries Codex initialization after sign-in", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    let initializeCount = 0;
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {
          initializeCount += 1;
          if (initializeCount === 1) throw new Error("Codex is not signed in.");
        },
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const state = await service.retryCodex();

    expect(state.codexReady).toBe(true);
    expect(state.lastError).toBeNull();
    expect(initializeCount).toBe(2);
  });

  test("marks Codex as needing sign-in after logout", async () => {
    const store = new FakeStore();
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    await service.markCodexSignedOut();
    const state = await service.getState();

    expect(state.codexReady).toBe(false);
    expect(state.codexStatus).toEqual({
      state: "needs_auth",
      detail: "Codex is installed but needs ChatGPT sign-in.",
      command: null,
      actionLabel: "Sign in with ChatGPT"
    });
  });

  test("setup check reports missing Gmail setup before inboxes are connected", async () => {
    const store = new FakeStore();
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.runSetupCheck();

    expect(result.ready).toBe(false);
    expect(result.checkedAt).toBe("2026-06-02T12:00:00.000Z");
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["codex", "ready"],
      ["gmailCredentials", "missing"],
      ["inboxes", "missing"],
      ["launchAtLogin", "missing"],
      ["schedule", "missing"]
    ]);
  });

  test("setup check reports missing native services in connector mode", async () => {
    const store = new FakeStore();
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      fakeRegistry([]),
      []
    );
    services.push(service);

    const result = await service.runSetupCheck();

    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.id === "sources")).toEqual({
      id: "sources",
      label: "Sources",
      status: "missing",
      detail: "No source services are configured. Connect Gmail, X/Twitter, YouTube, or Telegram."
    });
  });

  test("setup check reports configured native services before accounts are connected", async () => {
    const store = new FakeStore();
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      fakeRegistry([]),
      ["gmail", "twitter"]
    );
    services.push(service);

    const result = await service.runSetupCheck();

    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.id === "sources")).toEqual({
      id: "sources",
      label: "Sources",
      status: "missing",
      detail: "Configured: Gmail, X / Twitter. Connect Gmail, X/Twitter, YouTube, or Telegram."
    });
  });

  test("setup check treats an already-initialized Codex app-server as ready", async () => {
    const store = new FakeStore();
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {
          throw new Error("Already initialized");
        },
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z")
    );
    services.push(service);

    const result = await service.runSetupCheck();

    expect(result.checks.find((check) => check.id === "codex")).toEqual({
      id: "codex",
      label: "Codex",
      status: "ready",
      detail: "Signed in and app-server reachable"
    });
  });

  test("setup check validates the hourly scan path when setup is complete", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.settings.launchAtLogin = true;
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    const checkedAccounts: string[] = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async (account: GmailAccount, _credentialsPath: string, maxResults: number) => {
          checkedAccounts.push(`${account.email}:${maxResults}`);
          return [];
        }
      } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.runSetupCheck();

    expect(result.ready).toBe(true);
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["codex", "ready"],
      ["gmailCredentials", "ready"],
      ["inboxes", "ready"],
      ["launchAtLogin", "ready"],
      ["schedule", "ready"]
    ]);
    expect(result.checks.find((check) => check.id === "inboxes")?.detail).toBe("1 Gmail inbox reachable");
    expect(result.checks.find((check) => check.id === "schedule")?.detail).toContain("2026-06-02T13:00:00.000Z");
    expect(checkedAccounts).toEqual(["user@example.com:1"]);
  });

  test("setup check requires launch at login for unattended hourly scans", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.runSetupCheck();

    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.id === "launchAtLogin")).toEqual({
      id: "launchAtLogin",
      label: "Launch at login",
      status: "missing",
      detail: "Enable launch at login so hourly scans resume after reboot"
    });
  });

  test("setup check reports connected inboxes with broken Gmail access", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.settings.launchAtLogin = true;
    store.accounts = [
      { id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() },
      { id: "personal@example.com", email: "personal@example.com", displayName: "personal@example.com", connectedAt: new Date().toISOString() }
    ];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async (account: GmailAccount) => {
          if (account.email === "personal@example.com") throw new Error("Token expired");
          return [];
        }
      } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.runSetupCheck();

    expect(result.ready).toBe(false);
    const inboxes = result.checks.find((check) => check.id === "inboxes");
    expect(inboxes?.status).toBe("error");
    expect(inboxes?.detail).toContain("1/2 reachable");
    expect(inboxes?.detail).toContain("personal@example.com: Token expired");
  });

  test("schedules hourly scans after credentials and an inbox are connected", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const state = await service.getState();

    expect(typeof state.nextScanAt).toBe("string");
  });

  test("schedules scans when Telegram is the only connected source", async () => {
    const store = new FakeStore();
    store.settings.telegramExportPath = "/tmp/telegram-result.json";
    store.settings.telegramIncludeDms = true;
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      {
        fetchRecentMessages: async () => []
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const state = await service.getState();

    expect(typeof state.nextScanAt).toBe("string");
  });

  test("keeps hourly cadence from the last completed scan after restart", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    store.scans = [{
      id: "scan_1",
      startedAt: "2026-06-02T10:14:00.000Z",
      completedAt: "2026-06-02T10:15:00.000Z",
      status: "completed",
      accountsScanned: 1,
      messagesScanned: 0,
      findings: []
    }];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T10:30:00.000Z")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const state = await service.getState();

    expect(state.nextScanAt).toBe("2026-06-02T11:15:00.000Z");
  });

  test("scanWhenReady runs immediately when Codex, credentials, and inboxes are ready", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    let triageCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Confirm today",
            body: "Can you confirm today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanWhenReady();

    expect(result?.status).toBe("completed");
    expect(triageCount).toBe(1);
  });

  test("scanWhenReady skips when Codex is not ready", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    let fetchCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => {
          fetchCount += 1;
          return [];
        }
      } as never,
      {
        initialize: async () => {
          throw new Error("Codex is not signed in.");
        },
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanWhenReady();

    expect(result).toBeNull();
    expect(fetchCount).toBe(0);
  });

  test("does not schedule hourly scans when the saved Gmail credentials path is stale", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/missing-credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const state = await service.getState();

    expect(state.nextScanAt).toBeNull();
    expect(state.lastError).toContain("Choose the Google OAuth credentials.json file again");
  });

  test("runs an overdue scan when asked after macOS resume", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    let now = new Date("2026-06-02T10:00:00.000Z");
    let triageCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Confirm today",
            body: "Can you confirm today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never,
      () => {},
      () => now
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    now = new Date("2026-06-02T11:00:01.000Z");
    const result = await service.scanIfDue();

    expect(result?.status).toBe("completed");
    expect(triageCount).toBe(1);
  });

  test("does not scan before the next scheduled time after macOS resume", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    let now = new Date("2026-06-02T10:00:00.000Z");
    let triageCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Confirm today",
            body: "Can you confirm today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never,
      () => {},
      () => now
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    now = new Date("2026-06-02T10:30:00.000Z");
    const result = await service.scanIfDue();

    expect(result).toBeNull();
    expect(triageCount).toBe(0);
  });

  test("passes account-labeled messages from multiple inboxes to Codex", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [
      { id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() },
      { id: "personal@example.com", email: "personal@example.com", displayName: "personal@example.com", connectedAt: new Date().toISOString() }
    ];
    const seenAccounts: string[] = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async (account: GmailAccount) => [
          {
            id: `msg_${account.id}`,
            from: "sender@example.com",
            subject: "Confirm today",
            body: "Can you confirm today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async (events: RawEvents) => {
          seenAccounts.push(...(events.gmail ?? []).map((event) => event.accountEmail ?? "missing"));
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.accountsScanned).toBe(2);
    expect(result.messagesScanned).toBe(2);
    expect(result.accountSummaries).toEqual([
      {
        accountEmail: "work@example.com",
        messagesFound: 1,
        messagesScanned: 1,
        messagesSkipped: 0
      },
      {
        accountEmail: "personal@example.com",
        messagesFound: 1,
        messagesScanned: 1,
        messagesSkipped: 0
      }
    ]);
    expect(typeof result.durationMs).toBe("number");
    expect(seenAccounts.sort()).toEqual(["personal@example.com", "work@example.com"]);
  });

  test("passes selected Telegram chats and DMs to Codex", async () => {
    const store = new FakeStore();
    store.settings.telegramExportPath = "/tmp/telegram-result.json";
    store.settings.telegramIncludeDms = true;
    store.telegramChats = [
      { id: "market", title: "Market chat", enabled: true, kind: "group" },
      { id: "noise", title: "Noise chat", enabled: false, kind: "group" }
    ];
    let seenTelegram: RawEvents["telegram"] = [];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async (events: RawEvents) => {
          seenTelegram = events.telegram ?? [];
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      {
        fetchRecentMessages: async () => [
          { id: "tg_1", chatId: "market", chat: "Market chat", sender: "Ari", text: "Can you review this?", sentAt: "2026-06-02T10:00:00.000Z" },
          { id: "tg_2", chatId: "dm_1", chat: "Maya", sender: "Maya", text: "DM: are you around?", sentAt: "2026-06-02T11:00:00.000Z", direct: true },
          { id: "tg_3", chatId: "noise", chat: "Noise chat", sender: "Lee", text: "Chatter", sentAt: "2026-06-02T09:00:00.000Z" }
        ]
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.messagesScanned).toBe(2);
    expect(seenTelegram.map((event) => event.id)).toEqual(["tg_1", "tg_2"]);
  });

  test("promotes actionable Telegram messages before AI filtering", async () => {
    const store = new FakeStore();
    store.settings.telegramExportPath = "/tmp/telegram-result.json";
    store.settings.telegramIncludeDms = false;
    store.telegramChats = [
      { id: "chat:-5145273016", title: "Pluto <> Calm", enabled: true, kind: "group" }
    ];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-09T23:00:00.000Z"),
      () => {},
      {
        fetchRecentMessages: async () => [
          {
            id: "telegram:chat:-5145273016:41932",
            chatId: "chat:-5145273016",
            chat: "Pluto <> Calm",
            sender: "Kadar",
            text: "hey @kevin_9715, please see demo here; https://demo.calmtreasury.xyz/\n\nsharing our core SDK here: https://docs.calmtreasury.xyz/\n\nWould love to jump on call this week: https://calendly.com/kadar_a/30min",
            sentAt: "2026-06-09T22:07:00.000Z",
            mentionedMe: true
          }
        ]
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      priority: "high",
      source: "telegram",
      sourceId: "telegram:chat:-5145273016:41932",
      accountEmail: "Telegram · Pluto <> Calm",
      title: "Kadar asked to schedule a call",
      sourceKind: "telegram_action"
    });
    expect(result.findings[0]?.evidence).toContain("calmtreasury");
    expect(store.scannedMessageKeys).toContain("telegram:telegram:chat:-5145273016:41932");
  });

  test("keeps AI Telegram finding when it matches an automatic Telegram finding", async () => {
    const store = new FakeStore();
    store.settings.telegramExportPath = "/tmp/telegram-result.json";
    store.settings.telegramIncludeDms = false;
    store.telegramChats = [
      { id: "chat:20", title: "Launch group", enabled: true, kind: "group" }
    ];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => JSON.stringify({
          findings: [{
            priority: "medium",
            source: "telegram",
            sourceId: "telegram:chat:20:7",
            accountEmail: "telegram",
            title: "AI summarized launch ask",
            why: "The team asked for a launch review.",
            suggestedAction: "Review the launch note.",
            evidence: "Can you review this launch demo?"
          }]
        }),
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      {
        fetchRecentMessages: async () => [
          { id: "telegram:chat:20:7", chatId: "chat:20", chat: "Launch group", sender: "Ari", text: "Can you review this launch demo?", sentAt: "2026-06-02T10:00:00.000Z" }
        ]
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("AI summarized launch ask");
    expect(result.findings[0]?.accountEmail).toBe("Telegram · Launch group");
  });

  test("routes connector registry events through Codex and persists connector health", async () => {
    const store = new FakeStore();
    let triageCount = 0;
    const digestEvents = new Map<string, unknown[]>();
    const gmailConnection = nativeConnection("gmail", "ca_gmail", "kevin@example.com");
    const youtubeConnection: SourceConnection = {
      id: "youtube:local:@allin",
      source: "youtube",
      backend: "local",
      label: "@allin",
      accountIdentifier: "@allin",
      externalAccountId: null,
      enabled: true,
      config: { kind: "channel", url: "https://www.youtube.com/@allin" },
      connectedAt: "2026-06-04T10:00:00.000Z",
      updatedAt: "2026-06-04T10:00:00.000Z"
    };
    const twitterConnection = nativeConnection("twitter", "ca_twitter", "@zoidz123");
    const registry = fakeRegistry([
      {
        connection: gmailConnection,
        events: [{
          source: "gmail",
          connectionId: gmailConnection.id,
          id: "msg_1",
          accountEmail: "kevin@example.com",
          from: "maya@example.com",
          subject: "Launch approval",
          body: "Can you approve launch?",
          receivedAt: "2026-06-04T10:00:00.000Z"
        }]
      },
      {
        connection: youtubeConnection,
        events: [{
          source: "youtube",
          connectionId: youtubeConnection.id,
          id: "youtube_1",
          title: "All-In interview",
          body: "A transcript with useful market context.",
          actor: "All-In Podcast",
          url: "https://www.youtube.com/watch?v=youtube_1",
          receivedAt: "2026-06-04T10:02:00.000Z",
          channel: "All-In Podcast",
          channelUrl: "https://www.youtube.com/@allin",
          duration: 3600,
          viewCount: 120000,
          transcript: "Useful market context.",
          transcriptCues: [{ id: "c1", startSec: 230, endSec: 285, text: "Useful market context." }],
          transcriptSource: "auto"
        }]
      },
      {
        connection: twitterConnection,
        events: [{
          source: "twitter",
          connectionId: twitterConnection.id,
          id: "1800000000000000000",
          title: "X post from @maya",
          body: "A useful market update for catch-up.",
          actor: "Maya",
          url: "https://x.com/maya/status/1800000000000000000",
          receivedAt: "2026-06-04T10:03:00.000Z",
          metadata: {
            username: "maya",
            displayName: "Maya",
            publicMetrics: { like_count: 42, repost_count: 7 }
          }
        }]
      }
    ]);
    let summarizedTranscript = "";
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        summarizeYouTubeTranscript: async (event: NonNullable<RawEvents["youtube"]>[number]) => {
          summarizedTranscript = event.transcript ?? "";
          return {
            summary: "- The episode argues AI security automation is changing vulnerability discovery.\n- It covers market and strategy implications for security software.",
            anchors: [{
              label: "AI security automation",
              startSec: 227,
              endSec: 285,
              url: "https://www.youtube.com/watch?v=youtube_1&t=227s"
            }]
          };
        },
        triage: async (events: RawEvents) => {
          triageCount += 1;
          return JSON.stringify({
            findings: [{
              priority: "medium",
              source: "twitter",
              sourceId: "twitter:1800000000000000000",
              accountEmail: "",
              title: "Market update worth noting",
              why: "This is a useful catch-up item from X.",
              suggestedAction: "Read the post",
              evidence: "A useful market update for catch-up."
            }]
          });
        },
        generateDigest: async (source: string, events: unknown[]) => {
          digestEvents.set(source, events);
          return JSON.stringify({
          bullets: [{ title: `${source} headline`, detail: "why it matters", attribution: "@maya", timestamp: "2026-06-04T10:03:00.000Z", sourceUrl: "https://x.com/maya/status/1800000000000000000" }],
          skippedSummary: "routine posts"
        });
        },
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-04T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      registry
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.accountsScanned).toBe(3);
    expect(result.messagesScanned).toBe(3);
    expect(triageCount).toBe(0);
    expect(digestEvents.get("gmail")?.[0]).toMatchObject({ id: "msg_1" });
    expect(summarizedTranscript).toBe("Useful market context.");
    expect(digestEvents.get("twitter")?.[0]).toMatchObject({
      id: "1800000000000000000",
      author: "@maya",
      metrics: { like_count: 42 }
    });
    expect(result.findings.some((finding) => finding.source === "twitter")).toBe(false);
    expect(result.findings.find((finding) => finding.source === "youtube")).toMatchObject({
      source: "youtube",
      sourceId: "youtube_1",
      accountEmail: "YouTube · All-In Podcast",
      sourceUrl: "https://www.youtube.com/watch?v=youtube_1",
      receivedAt: "2026-06-04T10:02:00.000Z",
      sourceKind: "youtube_video",
      why: expect.stringContaining("AI security automation"),
      youtubeAnchors: [{
        label: "AI security automation",
        startSec: 227,
        endSec: 285,
        url: "https://www.youtube.com/watch?v=youtube_1&t=227s"
      }],
      sourceMetrics: { duration_seconds: 3600, view_count: 120000 }
    });
    expect(result.sourceSummaries).toEqual([
      { source: "gmail", messagesFound: 1, messagesScanned: 1, messagesSkipped: 0 },
      { source: "youtube", messagesFound: 1, messagesScanned: 1, messagesSkipped: 0 },
      { source: "twitter", messagesFound: 1, messagesScanned: 1, messagesSkipped: 0 }
    ]);
    expect(store.connectorHealth.map((health) => health.status)).toEqual(["ready", "ready", "ready"]);
    expect(store.sourceCursors).toHaveLength(3);
    expect(store.scannedMessageKeys).toEqual([
      "gmail:kevin@example.com:msg_1",
      "youtube:summary-v2:youtube_1",
      "twitter:1800000000000000000"
    ]);
    const twitterCard = result.digestCards?.find((card) => card.source === "twitter");
    expect(twitterCard).toMatchObject({
      source: "twitter",
      scanId: result.id,
      fetchedCount: 1,
      surfacedCount: 1,
      skippedSummary: "routine posts"
    });
    expect(twitterCard?.bullets[0]?.title).toBe("twitter headline");
    expect(twitterCard?.bullets[0]?.attribution).toBe("@maya");
    expect(result.digestCards?.some((card) => card.source === "gmail")).toBe(true);
    expect(result.digestCards?.some((card) => card.source === "youtube")).toBe(false);
  });

  test("shares a 15 video budget across YouTube connections", async () => {
    const store = new FakeStore();
    const youtubeA = youtubeConnection("@first");
    const youtubeB = youtubeConnection("@second");
    const requestedBudgets: number[] = [];
    const registry: ConnectorRegistry = {
      getLegacyLocalGmailAccounts: async () => [],
      listEnabledConnections: async () => [youtubeA, youtubeB].map((connection, connectionIndex) => ({
        connection,
        connector: {
          source: "youtube",
          backend: "local",
          listConnections: async () => [connection],
          scan: async (_connection: SourceConnection, context?: { maxVideos?: number }) => {
            const maxVideos = context?.maxVideos ?? 0;
            requestedBudgets.push(maxVideos);
            return {
              events: Array.from({ length: Math.min(maxVideos, 10) }, (_item, index) => ({
                source: "youtube",
                connectionId: connection.id,
                id: `youtube_${connectionIndex}_${index}`,
                title: `Video ${connectionIndex}.${index}`,
                body: "Transcript body.",
                actor: connection.label,
                url: `https://www.youtube.com/watch?v=${connectionIndex}${index}`,
                receivedAt: `2026-06-04T10:${String(index).padStart(2, "0")}:00.000Z`,
                channel: connection.label,
                transcript: "Transcript body.",
                transcriptSource: "auto"
              } as SourceEvent)),
              cursors: [],
              health: {
                connectionId: connection.id,
                status: "ready" as const,
                detail: "ok",
                checkedAt: "2026-06-04T12:00:00.000Z"
              }
            };
          }
        }
      }))
    };
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        summarizeYouTubeTranscript: async () => "- Summary bullet.",
        triage: async () => JSON.stringify({ findings: [] }),
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-04T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      registry
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(requestedBudgets).toEqual([15, 5]);
    expect(result.sourceSummaries).toEqual([
      { source: "youtube", messagesFound: 15, messagesScanned: 15, messagesSkipped: 0 }
    ]);
  });

  test("summarizes a selected YouTube video without scanning other sources", async () => {
    const store = new FakeStore();
    store.scannedMessageKeys = ["youtube:summary-v2:youtube:video_1"];
    store.sourceCursors = [{
      connectionId: "youtube:local:video_1",
      cursorKey: "video:scanned:summary-v2",
      cursorValue: "2026-06-04T10:00:00.000Z",
      updatedAt: "2026-06-04T10:00:00.000Z"
    }];
    const youtubeConnection: SourceConnection = {
      id: "youtube:local:video_1",
      source: "youtube",
      backend: "local",
      label: "Video video_1",
      accountIdentifier: "Video video_1",
      externalAccountId: null,
      enabled: true,
      config: { kind: "video", videoId: "video_1", url: "https://www.youtube.com/watch?v=video_1" },
      connectedAt: "2026-06-04T09:00:00.000Z",
      updatedAt: "2026-06-04T09:00:00.000Z"
    };
    const twitterConnection: SourceConnection = {
      id: "twitter:native:user_1",
      source: "twitter",
      backend: "native",
      label: "X account",
      accountIdentifier: "@maya",
      externalAccountId: "user_1",
      enabled: true,
      config: {},
      connectedAt: "2026-06-04T09:00:00.000Z",
      updatedAt: "2026-06-04T09:00:00.000Z"
    };
    let youtubeScans = 0;
    let twitterScans = 0;
    const registry: ConnectorRegistry = {
      getLegacyLocalGmailAccounts: async () => [],
      listEnabledConnections: async () => [
        {
          connection: youtubeConnection,
          connector: {
            source: "youtube",
            backend: "local",
            listConnections: async () => [youtubeConnection],
            scan: async () => {
              youtubeScans += 1;
              return {
                events: [{
                  source: "youtube",
                  connectionId: youtubeConnection.id,
                  id: "youtube:video_1",
                  title: "Quantum explainer",
                  body: "Transcript body.",
                  actor: "Big Think",
                  url: "https://www.youtube.com/watch?v=video_1",
                  receivedAt: "2026-06-04T10:00:00.000Z",
                  channel: "Big Think",
                  transcript: "Quantum probability is built into nature.",
                  transcriptCues: [{ id: "c1", startSec: 42, endSec: 54, text: "Quantum probability is built into nature." }],
                  transcriptSource: "auto"
                } as SourceEvent],
                cursors: [{
                  connectionId: youtubeConnection.id,
                  cursorKey: "video:scanned:summary-v2",
                  cursorValue: "2026-06-04T10:00:00.000Z",
                  updatedAt: "2026-06-04T12:00:00.000Z"
                }],
                health: {
                  connectionId: youtubeConnection.id,
                  status: "ready" as const,
                  detail: "ok",
                  checkedAt: "2026-06-04T12:00:00.000Z"
                }
              };
            }
          }
        },
        {
          connection: twitterConnection,
          connector: {
            source: "twitter",
            backend: "native",
            listConnections: async () => [twitterConnection],
            scan: async () => {
              twitterScans += 1;
              return {
                events: [],
                cursors: [],
                health: {
                  connectionId: twitterConnection.id,
                  status: "ready" as const,
                  detail: "ok",
                  checkedAt: "2026-06-04T12:00:00.000Z"
                }
              };
            }
          }
        }
      ] as Awaited<ReturnType<ConnectorRegistry["listEnabledConnections"]>>
    };
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        summarizeYouTubeTranscript: async () => "- **Real Probabilities:** Quantum probability is built into nature.",
        triage: async () => JSON.stringify({ findings: [] }),
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-04T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      registry
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.summarizeYouTubeVideoConnection(youtubeConnection.id);

    expect(result.status).toBe("completed");
    expect(youtubeScans).toBe(1);
    expect(twitterScans).toBe(0);
    expect(result.accountsScanned).toBe(1);
    expect(result.sourceSummaries).toEqual([
      { source: "youtube", messagesFound: 1, messagesScanned: 1, messagesSkipped: 0 }
    ]);
    expect(result.findings[0]).toMatchObject({
      source: "youtube",
      sourceId: "youtube:video_1",
      youtubeAnchors: [{
        label: "Real Probabilities",
        startSec: 39,
        url: "https://www.youtube.com/watch?v=video_1&t=39s"
      }]
    });
    expect(store.scannedMessageKeys).toContain("youtube:summary-v2:youtube:video_1");
    expect(store.sourceCursors).toContainEqual(expect.objectContaining({
      connectionId: youtubeConnection.id,
      cursorKey: "video:scanned:summary-v2"
    }));
  });

  test("skips Twitter posts that were already marked completed", async () => {
    const store = new FakeStore();
    store.importantItems = [{
      id: "twitter:1800000000000000000",
      status: "completed",
      firstSeenAt: "2026-06-04T12:00:00.000Z",
      lastSeenAt: "2026-06-04T12:00:00.000Z",
      scanId: "scan_previous",
      priority: "medium",
      source: "twitter",
      sourceId: "1800000000000000000",
      accountEmail: "X · @flood",
      title: "Flood post",
      why: "A market structure post was useful context.",
      suggestedAction: "Review if relevant.",
      evidence: "Flood said something important.",
      sourceUrl: "https://x.com/flood/status/1800000000000000000",
      receivedAt: "2026-06-04T10:03:00.000Z"
    }];
    let triageCount = 0;
    const twitterConnection = nativeConnection("twitter", "ca_twitter", "@zoidz123");
    const registry = fakeRegistry([{
      connection: twitterConnection,
      events: [{
        source: "twitter",
        connectionId: twitterConnection.id,
        id: "1800000000000000000",
        title: "Flood post",
        body: "Flood said something important.",
        actor: "@flood",
        url: "https://x.com/flood/status/1800000000000000000",
        receivedAt: "2026-06-04T10:03:00.000Z",
        metadata: { username: "flood" }
      }]
    }]);
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-04T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      registry,
      ["twitter"]
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.messagesFound).toBe(1);
    expect(result.messagesScanned).toBe(0);
    expect(result.messagesSkipped).toBe(1);
    expect(result.findings).toEqual([]);
    expect(triageCount).toBe(0);
  });

  test("triages grouped source events and records scan planning metadata", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    let seenGroupCounts: number[] = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            threadId: "thread_1",
            from: "sender@example.com",
            subject: "Confirm today",
            body: "Can you confirm today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          },
          {
            id: "msg_2",
            threadId: "thread_1",
            from: "sender@example.com",
            subject: "Re: Confirm today",
            body: "This is blocking launch.",
            receivedAt: "2026-06-02T10:01:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triageGroups: async (groups: unknown[]) => {
          seenGroupCounts.push(groups.length);
          return "{\"findings\":[]}";
        },
        triage: async () => {
          throw new Error("raw triage should not run when grouped triage is available");
        },
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(seenGroupCounts).toEqual([1]);
    expect(result.scanMetadata).toEqual(expect.objectContaining({
      route: "default",
      rawEventCount: 2,
      groupCount: 1,
      processedGroupCount: 1,
      skippedGroupCount: 0,
      batchCount: 1,
      oversizedGroupCount: 0
    }));
  });

  test("uses overflow batch triage and final synthesis for large grouped scans", async () => {
    const store = new FakeStore();
    store.settings.telegramExportPath = "/tmp/telegram-result.json";
    store.settings.telegramIncludeDms = true;
    const batchSizes: number[] = [];
    let synthesisPayload: unknown[] = [];
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triageGroups: async (groups: unknown[]) => {
          batchSizes.push(groups.length);
          return JSON.stringify({
            findings: [
              {
                priority: "medium",
                source: "telegram",
                sourceId: `tg_batch_${batchSizes.length}`,
                accountEmail: "Telegram · batch",
                title: `Batch ${batchSizes.length}`,
                why: "Needs review.",
                suggestedAction: "Review.",
                evidence: "Need review today."
              }
            ],
            sourceInsights: [
              {
                id: `telegram:batch:${batchSizes.length}`,
                source: "telegram",
                title: "Telegram batch pulse",
                summary: "The batch is mostly repeated review requests across busy chats.",
                generatedAt: "2026-06-02T12:00:00.000Z"
              }
            ]
          });
        },
        synthesizeBatchResults: async (payload: unknown[]) => {
          synthesisPayload = payload;
          return JSON.stringify({
            findings: [
              {
                priority: "medium",
                source: "telegram",
                sourceId: "tg_0",
                accountEmail: "Telegram · Busy",
                title: "Synthesized Telegram item",
                why: "The batches surfaced a recurring ask.",
                suggestedAction: "Review the chat.",
                evidence: "Need review today."
              }
            ],
            sourceInsights: [
              {
                id: "telegram:2026-06-02T12:00:00.000Z",
                source: "telegram",
                title: "Telegram review cluster",
                summary: "Telegram activity is clustered around repeated review requests rather than unrelated one-off asks.",
                generatedAt: "2026-06-02T12:00:00.000Z"
              }
            ]
          });
        },
        triage: async () => {
          throw new Error("raw triage should not run during overflow grouped triage");
        },
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      {
        fetchRecentMessages: async () => Array.from({ length: 120 }, (_, index) => ({
          id: `tg_${index}`,
          chatId: `chat_${index}`,
          chat: `Busy ${index}`,
          sender: "Maya",
          text: `Need review today. ${"x".repeat(5000)}`,
          sentAt: new Date(Date.UTC(2026, 5, 2, 10, index)).toISOString(),
          direct: true
        }))
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(synthesisPayload.length).toBe(batchSizes.length);
    expect(synthesisPayload).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceInsights: expect.arrayContaining([
          expect.objectContaining({ source: "telegram" })
        ])
      })
    ]));
    expect(result.findings[0]?.title).toBe("Synthesized Telegram item");
    expect(result.sourceInsights).toEqual([
      {
        id: `telegram:${result.completedAt}`,
        source: "telegram",
        title: "Telegram review cluster",
        summary: "Telegram activity is clustered around repeated review requests rather than unrelated one-off asks.",
        generatedAt: result.completedAt
      }
    ]);
    expect(result.scanMetadata).toEqual(expect.objectContaining({
      route: "overflow",
      rawEventCount: 120,
      groupCount: 120,
      processedGroupCount: 120,
      skippedGroupCount: 0,
      batchCount: batchSizes.length
    }));
    expect(result.scanMetadata?.candidateFindings?.length).toBe(batchSizes.length);
    expect(result.scanMetadata?.intermediateSummaries).toHaveLength(batchSizes.length);
  });

  test("scans multiple Gmail accounts through the native connector registry", async () => {
    const store = new FakeStore();
    let seenGmail: RawEvents["gmail"] = [];
    const personalConnection = nativeConnection("gmail", "ca_personal", "personal@example.com");
    const workConnection = nativeConnection("gmail", "ca_work", "work@example.com");
    const registry = fakeRegistry([
      {
        connection: personalConnection,
        events: [{
          source: "gmail",
          connectionId: personalConnection.id,
          id: "personal_msg",
          accountEmail: "personal@example.com",
          from: "maya@example.com",
          subject: "Personal follow-up",
          body: "Can you reply?",
          receivedAt: "2026-06-04T10:00:00.000Z"
        }]
      },
      {
        connection: workConnection,
        events: [{
          source: "gmail",
          connectionId: workConnection.id,
          id: "work_msg",
          accountEmail: "work@example.com",
          from: "ari@example.com",
          subject: "Work approval",
          body: "Can you approve this?",
          receivedAt: "2026-06-04T10:01:00.000Z"
        }]
      }
    ]);
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => {
          throw new Error("Legacy Gmail should not be used when registry sources are configured.");
        }
      } as never,
      {
        initialize: async () => {},
        triage: async (events: RawEvents) => {
          seenGmail = events.gmail ?? [];
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-04T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      registry,
      ["gmail"]
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.accountsScanned).toBe(2);
    expect(result.messagesScanned).toBe(2);
    expect(seenGmail.map((event) => event.accountEmail).sort()).toEqual(["personal@example.com", "work@example.com"]);
    expect(store.scannedMessageKeys).toEqual([
      "gmail:personal@example.com:personal_msg",
      "gmail:work@example.com:work_msg"
    ]);
  });

  test("includes scanned connector sources that returned no new events", async () => {
    const store = new FakeStore();
    const twitterConnection = nativeConnection("twitter", "ca_twitter", "Kevin X");
    const registry = fakeRegistry([
      {
        connection: twitterConnection,
        events: []
      }
    ]);
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-04T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      registry
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.accountsScanned).toBe(1);
    expect(result.messagesScanned).toBe(0);
    expect(result.sourceSummaries).toContainEqual({
      source: "twitter",
      messagesFound: 0,
      messagesScanned: 0,
      messagesSkipped: 0
    });
  });

  test("records connector source auth failures in scan summaries", async () => {
    const store = new FakeStore();
    const twitterConnection = nativeConnection("twitter", "ca_twitter", "Kevin X");
    const registry = fakeRegistry([
      {
        connection: twitterConnection,
        events: [],
        health: {
          connectionId: twitterConnection.id,
          status: "needs_auth",
          detail: "Missing auth_token - login to x.com in Chrome.",
          checkedAt: "2026-06-04T12:00:00.000Z"
        }
      }
    ]);
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-04T12:00:00.000Z"),
      () => {},
      { fetchRecentMessages: async () => [] } as never,
      registry
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.sourceSummaries).toContainEqual({
      source: "twitter",
      messagesFound: 0,
      messagesScanned: 0,
      messagesSkipped: 0,
      status: "needs_auth",
      detail: "Missing auth_token - login to x.com in Chrome."
    });
    expect(store.connectorHealth[0]).toMatchObject({ status: "needs_auth" });
  });

  test("passes a shared scan window capped at 24 hours to Gmail and Telegram", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.settings.telegramExportPath = "/tmp/telegram-result.json";
    store.accounts = [{ id: "user@example.com", email: "user@example.com", displayName: "user@example.com", connectedAt: new Date().toISOString() }];
    store.telegramChats = [{ id: "chat:20", title: "Launch group", enabled: true, kind: "group" }];
    store.scans = [{
      id: "old_scan",
      startedAt: "2026-05-01T12:00:00.000Z",
      completedAt: "2026-05-01T12:00:01.000Z",
      durationMs: 1000,
      status: "completed",
      accountsScanned: 1,
      messagesScanned: 0,
      findings: []
    }];
    const gmailSince: Array<string | undefined> = [];
    const telegramSince: Array<string | undefined> = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async (_account: GmailAccount, _credentialsPath: string, _maxResults?: number, since?: string) => {
          gmailSince.push(since);
          return [];
        }
      } as never,
      { initialize: async () => {}, triage: async () => "{\"findings\":[]}", close: () => {} } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      {
        fetchRecentMessages: async (input: { since?: string }) => {
          telegramSince.push(input.since);
          return [];
        }
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    await service.scanNow();

    expect(gmailSince).toEqual(["2026-06-01T12:00:00.000Z"]);
    expect(telegramSince).toEqual(["2026-06-01T12:00:00.000Z"]);

    store.scans[0] = {
      ...store.scans[0]!,
      id: "recent_scan",
      completedAt: "2026-06-02T11:15:00.000Z"
    };
    await service.scanNow();

    expect(gmailSince.at(-1)).toBe("2026-06-02T11:15:00.000Z");
    expect(telegramSince.at(-1)).toBe("2026-06-02T11:15:00.000Z");
  });

  test("skips Telegram messages that were already completed in a previous scan", async () => {
    const store = new FakeStore();
    store.settings.telegramExportPath = "/tmp/telegram-result.json";
    store.settings.telegramIncludeDms = true;
    let triageCount = 0;
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      {
        fetchRecentMessages: async () => [
          { id: "tg_1", chatId: "dm_1", chat: "Maya", sender: "Maya", text: "Are you around?", sentAt: "2026-06-02T11:00:00.000Z", direct: true }
        ]
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const first = await service.scanNow();
    const second = await service.scanNow();

    expect(first.messagesFound).toBe(1);
    expect(first.messagesScanned).toBe(1);
    expect(second.messagesFound).toBe(1);
    expect(second.messagesScanned).toBe(0);
    expect(second.messagesSkipped).toBe(1);
    expect(triageCount).toBe(1);
  });

  test("adds Telegram metadata to Codex findings", async () => {
    const store = new FakeStore();
    store.settings.telegramExportPath = "/tmp/telegram-result.json";
    store.settings.telegramIncludeDms = true;
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => JSON.stringify({
          findings: [
            {
              priority: "high",
              source: "telegram",
              sourceId: "tg_1",
              accountEmail: "telegram",
              title: "Missed DM",
              why: "Maya asked for a reply.",
              suggestedAction: "Reply this morning.",
              evidence: "Are you around?"
            }
          ]
        }),
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      () => {},
      {
        fetchRecentMessages: async () => [
          { id: "tg_1", chatId: "dm_1", chat: "Maya", sender: "Maya", text: "Are you around?", sentAt: "2026-06-02T11:00:00.000Z", direct: true, sourceUrl: "tg://resolve?domain=maya" }
        ]
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.findings[0]?.source).toBe("telegram");
    expect(result.findings[0]?.accountEmail).toBe("Telegram · Maya");
    expect(result.findings[0]?.receivedAt).toBe("2026-06-02T11:00:00.000Z");
    expect(result.findings[0]?.sourceUrl).toBe("tg://resolve?domain=maya");
  });

  test("fetches connected Gmail inboxes in parallel", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [
      { id: "slow@example.com", email: "slow@example.com", displayName: "slow@example.com", connectedAt: new Date().toISOString() },
      { id: "fast@example.com", email: "fast@example.com", displayName: "fast@example.com", connectedAt: new Date().toISOString() }
    ];
    const startedAccounts: string[] = [];
    let fastStarted = false;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async (account: GmailAccount) => {
          startedAccounts.push(account.email);
          if (account.email === "fast@example.com") {
            fastStarted = true;
            return [];
          }

          await waitFor(() => fastStarted);
          return [];
        }
      } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.accountsScanned).toBe(2);
    expect(startedAccounts).toEqual(["slow@example.com", "fast@example.com"]);
  });

  test("records a completed scan without calling Codex when there are no recent Gmail messages", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [
      { id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() },
      { id: "personal@example.com", email: "personal@example.com", displayName: "personal@example.com", connectedAt: new Date().toISOString() }
    ];
    let triageCount = 0;
    const service = new ScanService(
      store as never,
      { fetchRecentMessages: async () => [] } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.accountsScanned).toBe(2);
    expect(result.messagesScanned).toBe(0);
    expect(result.findings).toEqual([]);
    expect(triageCount).toBe(0);
  });

  test("skips Gmail messages that were already completed in a previous scan", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "Work@Example.com", displayName: "Work@Example.com", connectedAt: new Date().toISOString() }];
    let triageCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Confirm today",
            body: "Can you confirm today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const first = await service.scanNow();
    const second = await service.scanNow();

    expect(first.status).toBe("completed");
    expect(first.messagesFound).toBe(1);
    expect(first.messagesScanned).toBe(1);
    expect(second.status).toBe("completed");
    expect(second.messagesFound).toBe(1);
    expect(second.messagesScanned).toBe(0);
    expect(second.messagesSkipped).toBe(1);
    expect(second.accountSummaries).toEqual([
      {
        accountEmail: "Work@Example.com",
        messagesFound: 1,
        messagesScanned: 0,
        messagesSkipped: 1
      }
    ]);
    expect(triageCount).toBe(1);
  });

  test("notifies with high-priority findings after a scan", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    const notifiedTitles: string[] = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Blocked launch",
            body: "Can you approve today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () =>
          JSON.stringify({
            findings: [
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_1",
                accountEmail: "Work@Example.com",
                title: "Blocked launch",
                why: "Approval is blocking launch.",
                suggestedAction: "Approve or delegate.",
                evidence: "Can you approve today?"
              }
            ]
          }),
        close: () => {}
      } as never,
      (findings) => notifiedTitles.push(...findings.map((finding) => finding.title))
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(notifiedTitles).toEqual(["Blocked launch"]);
  });

  test("suppresses high-priority notifications during quiet hours", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.settings.quietHours = { enabled: true, start: "22:00", end: "07:00" };
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    let notificationCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Blocked launch",
            body: "Can you approve today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () =>
          JSON.stringify({
            findings: [
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_1",
                accountEmail: "work@example.com",
                title: "Blocked launch",
                why: "Approval is blocking launch.",
                suggestedAction: "Approve or delegate.",
                evidence: "Can you approve today?"
              }
            ]
          }),
        close: () => {}
      } as never,
      () => {
        notificationCount += 1;
      },
      () => new Date("2026-06-02T23:30:00.000")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(1);
    expect(notificationCount).toBe(0);
  });

  test("notifies once for repeated scan failures with the same reason", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    const notifiedErrors: string[] = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => {
          throw new Error("Gmail token expired.");
        }
      } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      (result) => notifiedErrors.push(result.error ?? "")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    await service.scanNow();
    await service.scanNow();

    expect(notifiedErrors).toEqual(["All Gmail inboxes failed to scan. work@example.com: Gmail token expired."]);
  });

  test("allows a failure notification again after a successful scan clears the failure streak", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    let fetchCount = 0;
    const notifiedErrors: string[] = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => {
          fetchCount += 1;
          if (fetchCount === 2) return [];
          throw new Error("Gmail token expired.");
        }
      } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T12:00:00.000Z"),
      (result) => notifiedErrors.push(result.error ?? "")
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    await service.scanNow();
    await service.scanNow();
    await service.scanNow();

    expect(notifiedErrors).toEqual([
      "All Gmail inboxes failed to scan. work@example.com: Gmail token expired.",
      "All Gmail inboxes failed to scan. work@example.com: Gmail token expired."
    ]);
  });

  test("suppresses scan failure notifications during quiet hours", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.settings.quietHours = { enabled: true, start: "22:00", end: "07:00" };
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    let notificationCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => {
          throw new Error("Gmail token expired.");
        }
      } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never,
      () => {},
      () => new Date("2026-06-02T23:30:00.000Z"),
      () => {
        notificationCount += 1;
      }
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    await service.scanNow();

    expect(notificationCount).toBe(0);
  });

  test("adds a Gmail source URL to Codex findings when the source message has one", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Blocked launch",
            body: "Can you approve today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            sourceUrl: "https://mail.google.com/mail/u/?authuser=work%40example.com#search/rfc822msgid%3Amsg_1%40example.com",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () =>
          JSON.stringify({
            findings: [
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_1",
                accountEmail: "work@example.com",
                title: "Blocked launch",
                why: "Approval is blocking launch.",
                suggestedAction: "Approve or delegate.",
                evidence: "Can you approve today?"
              }
            ]
          }),
        close: () => {}
      } as never,
      () => {}
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.findings[0]?.sourceUrl).toBe("https://mail.google.com/mail/u/?authuser=work%40example.com#search/rfc822msgid%3Amsg_1%40example.com");
  });

  test("matches Codex findings to Gmail events when account email casing differs", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Blocked launch",
            body: "Can you approve today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            sourceUrl: "https://mail.google.com/mail/u/?authuser=work%40example.com#search/rfc822msgid%3Amsg_1%40example.com",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () =>
          JSON.stringify({
            findings: [
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_1",
                accountEmail: "Work@Example.com",
                title: "Blocked launch",
                why: "Approval is blocking launch.",
                suggestedAction: "Approve or delegate.",
                evidence: "Can you approve today?"
              }
            ]
          }),
        close: () => {}
      } as never,
      () => {}
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.findings[0]?.accountEmail).toBe("work@example.com");
    expect(result.findings[0]?.receivedAt).toBe("2026-06-02T10:00:00.000Z");
    expect(result.findings[0]?.sourceUrl).toContain("mail.google.com");
  });

  test("matches Codex findings to a unique Gmail source id when account email is generic", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Blocked launch",
            body: "Can you approve today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            sourceUrl: "https://mail.google.com/mail/u/?authuser=work%40example.com#search/rfc822msgid%3Amsg_1%40example.com",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () =>
          JSON.stringify({
            findings: [
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_1",
                accountEmail: "all accounts",
                title: "Blocked launch",
                why: "Approval is blocking launch.",
                suggestedAction: "Approve or delegate.",
                evidence: "Can you approve today?"
              }
            ]
          }),
        close: () => {}
      } as never,
      () => {}
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.findings[0]?.accountEmail).toBe("work@example.com");
    expect(result.findings[0]?.sourceUrl).toContain("mail.google.com");
  });

  test("sorts findings by priority before storing the scan result", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_low",
            from: "sender@example.com",
            subject: "FYI",
            body: "Useful context.",
            receivedAt: "2026-06-02T09:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          },
          {
            id: "msg_high",
            from: "sender@example.com",
            subject: "Blocked launch",
            body: "Can you approve today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          },
          {
            id: "msg_medium",
            from: "sender@example.com",
            subject: "Schedule follow-up",
            body: "Can you pick a time?",
            receivedAt: "2026-06-02T11:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () =>
          JSON.stringify({
            findings: [
              {
                priority: "low",
                source: "gmail",
                sourceId: "msg_low",
                accountEmail: "work@example.com",
                title: "FYI",
                why: "Useful context.",
                suggestedAction: "Read later.",
                evidence: "Useful context."
              },
              {
                priority: "medium",
                source: "gmail",
                sourceId: "msg_medium",
                accountEmail: "work@example.com",
                title: "Schedule follow-up",
                why: "Needs scheduling.",
                suggestedAction: "Pick a time.",
                evidence: "Can you pick a time?"
              },
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_high",
                accountEmail: "work@example.com",
                title: "Blocked launch",
                why: "Approval is blocking launch.",
                suggestedAction: "Approve or delegate.",
                evidence: "Can you approve today?"
              }
            ]
          }),
        close: () => {}
      } as never,
      () => {}
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.priority)).toEqual(["high", "medium", "low"]);
  });

  test("sorts equal-priority findings by newest received time first", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_old",
            from: "sender@example.com",
            subject: "Approval needed",
            body: "Can you approve this?",
            receivedAt: "2026-06-02T09:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          },
          {
            id: "msg_new",
            from: "sender@example.com",
            subject: "Production issue",
            body: "Users are blocked now.",
            receivedAt: "2026-06-02T11:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () =>
          JSON.stringify({
            findings: [
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_old",
                accountEmail: "work@example.com",
                title: "Approval needed",
                why: "Approval is needed.",
                suggestedAction: "Review it.",
                evidence: "Can you approve this?"
              },
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_new",
                accountEmail: "work@example.com",
                title: "Production issue",
                why: "Users are blocked.",
                suggestedAction: "Investigate now.",
                evidence: "Users are blocked now."
              }
            ]
          }),
        close: () => {}
      } as never,
      () => {}
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.sourceId)).toEqual(["msg_new", "msg_old"]);
  });

  test("does not repeat notifications for the same high-priority Gmail finding", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    const notifiedTitles: string[] = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Blocked launch",
            body: "Can you approve today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () =>
          JSON.stringify({
            findings: [
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_1",
                accountEmail: "work@example.com",
                title: "Blocked launch",
                why: "Approval is blocking launch.",
                suggestedAction: "Approve or delegate.",
                evidence: "Can you approve today?"
              }
            ]
          }),
        close: () => {}
      } as never,
      (findings) => notifiedTitles.push(...findings.map((finding) => finding.title))
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    await service.scanNow();
    await service.scanNow();

    expect(notifiedTitles).toEqual(["Blocked launch"]);
  });

  test("continues scanning healthy inboxes when one Gmail inbox fails", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [
      { id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() },
      { id: "personal@example.com", email: "personal@example.com", displayName: "personal@example.com", connectedAt: new Date().toISOString() }
    ];
    const seenAccounts: string[] = [];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async (account: GmailAccount) => {
          if (account.email === "work@example.com") throw new Error("Refresh token expired.");
          return [
            {
              id: "msg_personal",
              from: "sender@example.com",
              subject: "Confirm today",
              body: "Can you confirm today?",
              receivedAt: "2026-06-02T10:00:00.000Z",
              read: false,
              labels: ["UNREAD"]
            }
          ];
        }
      } as never,
      {
        initialize: async () => {},
        triage: async (events: RawEvents) => {
          seenAccounts.push(...(events.gmail ?? []).map((event) => event.accountEmail ?? "missing"));
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("completed");
    expect(result.accountsScanned).toBe(1);
    expect(result.messagesScanned).toBe(1);
    expect(result.accountErrors).toEqual([
      { accountEmail: "work@example.com", error: "Refresh token expired." }
    ]);
    expect(seenAccounts).toEqual(["personal@example.com"]);
  });

  test("records each inbox error when all Gmail inboxes fail", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [
      { id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() },
      { id: "personal@example.com", email: "personal@example.com", displayName: "personal@example.com", connectedAt: new Date().toISOString() }
    ];
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async (account: GmailAccount) => {
          throw new Error(`${account.email} token expired.`);
        }
      } as never,
      {
        initialize: async () => {},
        triage: async () => "{\"findings\":[]}",
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const result = await service.scanNow();

    expect(result.status).toBe("failed");
    expect(result.accountErrors).toEqual([
      { accountEmail: "work@example.com", error: "work@example.com token expired." },
      { accountEmail: "personal@example.com", error: "personal@example.com token expired." }
    ]);
  });

  test("reinitializes Codex on the next scan after a triage runtime failure", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    let initializeCount = 0;
    let triageCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Confirm today",
            body: "Can you confirm today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {
          initializeCount += 1;
        },
        triage: async () => {
          triageCount += 1;
          if (triageCount === 1) throw new Error("codex app-server exited with code 1");
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const failed = await service.scanNow();
    const recovered = await service.scanNow();

    expect(failed.status).toBe("failed");
    expect(recovered.status).toBe("completed");
    expect(initializeCount).toBe(2);
  });

  test("keeps the last completed scan in state after a later scan fails", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    let triageCount = 0;
    let fetchCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => {
          fetchCount += 1;
          return [
            {
              id: fetchCount === 1 ? "msg_1" : "msg_2",
              from: "sender@example.com",
              subject: "Confirm today",
              body: "Can you confirm today?",
              receivedAt: "2026-06-02T10:00:00.000Z",
              read: false,
              labels: ["UNREAD"]
            }
          ];
        }
      } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          if (triageCount === 2) throw new Error("Codex triage timed out.");
          return JSON.stringify({
            findings: [
              {
                priority: "high",
                source: "gmail",
                sourceId: "msg_1",
                accountEmail: "work@example.com",
                title: "Confirm today",
                why: "It needs a reply.",
                suggestedAction: "Reply today.",
                evidence: "Can you confirm today?"
              }
            ]
          });
        },
        close: () => {}
      } as never,
      () => {}
    );
    services.push(service);

    await service.start({ scanImmediately: false });
    const completed = await service.scanNow();
    const failed = await service.scanNow();
    const state = await service.getState();

    expect(completed.status).toBe("completed");
    expect(failed.status).toBe("failed");
    expect(state.lastScan?.status).toBe("failed");
    expect(state.lastCompletedScan?.status).toBe("completed");
    expect(state.lastCompletedScan?.findings[0]?.title).toBe("Confirm today");
  });

  test("scans immediately on startup when setup is complete", async () => {
    const store = new FakeStore();
    store.settings.gmailCredentialsPath = "/tmp/credentials.json";
    store.accounts = [{ id: "work@example.com", email: "work@example.com", displayName: "work@example.com", connectedAt: new Date().toISOString() }];
    let triageCount = 0;
    const service = new ScanService(
      store as never,
      {
        fetchRecentMessages: async () => [
          {
            id: "msg_1",
            from: "sender@example.com",
            subject: "Confirm today",
            body: "Can you confirm today?",
            receivedAt: "2026-06-02T10:00:00.000Z",
            read: false,
            labels: ["UNREAD"]
          }
        ]
      } as never,
      {
        initialize: async () => {},
        triage: async () => {
          triageCount += 1;
          return "{\"findings\":[]}";
        },
        close: () => {}
      } as never
    );
    services.push(service);

    await service.start();
    await waitFor(() => triageCount > 0);

    expect(triageCount).toBe(1);
  });
});

describe("formatHighPriorityNotification", () => {
  test("uses the top high-priority finding in the notification body", () => {
    expect(formatHighPriorityNotification([
      finding("Blocked launch"),
      finding("Waiting contract")
    ])).toEqual({
      title: "wdim",
      body: "2 important items found. Top: Blocked launch"
    });
  });
});

describe("formatScanFailureNotification", () => {
  test("uses inbox error details when Gmail accounts fail", () => {
    const message = formatScanFailureNotification({
      id: "scan_1",
      startedAt: "2026-06-02T10:00:00.000Z",
      completedAt: "2026-06-02T10:00:01.000Z",
      status: "failed",
      error: "All Gmail inboxes failed to scan.",
      accountsScanned: 0,
      messagesScanned: 0,
      accountErrors: [
        { accountEmail: "work@example.com", error: "Refresh token expired." }
      ],
      findings: []
    });

    expect(message).toEqual({
      title: "wdim scan failed",
      body: "1 Gmail inbox failed. Reconnect work@example.com: Refresh token expired."
    });
  });

  test("summarizes multiple inbox errors in the notification body", () => {
    const message = formatScanFailureNotification({
      id: "scan_1",
      startedAt: "2026-06-02T10:00:00.000Z",
      completedAt: "2026-06-02T10:00:01.000Z",
      status: "failed",
      error: "All Gmail inboxes failed to scan.",
      accountsScanned: 0,
      messagesScanned: 0,
      accountErrors: [
        { accountEmail: "work@example.com", error: "Refresh token expired." },
        { accountEmail: "personal@example.com", error: "Permission denied." }
      ],
      findings: []
    });

    expect(message).toEqual({
      title: "wdim scan failed",
      body: "2 Gmail inboxes failed. Reconnect work@example.com: Refresh token expired."
    });
  });

  test("uses a compact failure reason in the notification body", () => {
    const message = formatScanFailureNotification({
      id: "scan_1",
      startedAt: "2026-06-02T10:00:00.000Z",
      completedAt: "2026-06-02T10:00:01.000Z",
      status: "failed",
      error: `Codex App Server is not ready. ${"Sign in again. ".repeat(20)}`,
      accountsScanned: 0,
      messagesScanned: 0,
      findings: []
    });

    expect(message.title).toBe("wdim scan failed");
    expect(message.body.length).toBeLessThanOrEqual(140);
    expect(message.body).toEndWith("...");
  });
});

function finding(title: string) {
  return {
    priority: "high" as const,
    source: "gmail" as const,
    sourceId: title,
    accountEmail: "work@example.com",
    title,
    why: "Needs attention",
    suggestedAction: "Reply",
    evidence: "Please reply"
  };
}

function nativeConnection(source: "gmail" | "twitter", accountId: string, label: string): SourceConnection {
  return {
    id: `${source}:native:${accountId}`,
    source,
    backend: "native",
    label,
    accountIdentifier: label,
    externalAccountId: null,
    enabled: true,
    config: {},
    connectedAt: "2026-06-04T10:00:00.000Z",
    updatedAt: "2026-06-04T10:00:00.000Z"
  };
}

function youtubeConnection(label: string): SourceConnection {
  return {
    id: `youtube:local:${label}`,
    source: "youtube",
    backend: "local",
    label,
    accountIdentifier: label,
    externalAccountId: null,
    enabled: true,
    config: { kind: "channel", url: `https://www.youtube.com/${label}`, videosUrl: `https://www.youtube.com/${label}/videos` },
    connectedAt: "2026-06-04T10:00:00.000Z",
    updatedAt: "2026-06-04T10:00:00.000Z"
  };
}

function fakeRegistry(items: Array<{ connection: SourceConnection; events: SourceEvent[]; health?: ConnectorHealth }>): ConnectorRegistry {
  return {
    getLegacyLocalGmailAccounts: async () => [],
    listEnabledConnections: async () => items.map(({ connection, events, health }) => ({
      connection,
      connector: fakeSourceConnector(connection, events, health)
    }))
  };
}

function fakeSourceConnector(connection: SourceConnection, events: SourceEvent[], health?: ConnectorHealth): SourceConnector {
  return {
    source: connection.source,
    backend: connection.backend,
    listConnections: async () => [connection],
    scan: async () => ({
      events,
      cursors: [{
        connectionId: connection.id,
        cursorKey: `${connection.source}:last_received_at`,
        cursorValue: "2026-06-04T10:02:00.000Z",
        updatedAt: "2026-06-04T12:00:00.000Z"
      }],
      health: health ?? {
        connectionId: connection.id,
        status: "ready",
        detail: "ok",
        checkedAt: "2026-06-04T12:00:00.000Z"
      }
    })
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("Timed out waiting for predicate.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

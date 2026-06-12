import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ConnectorHealth, SourceConnection, SourceCursor } from "./connectors/types";
import { AppStore } from "./store";
import type { ScanFinding, ScanResult } from "./types";

describe("AppStore settings validation", () => {
  test("normalizes an invalid persisted scan interval to the hourly default", async () => {
    const store = new AppStore(await writeState({
      settings: {
        scanIntervalMinutes: 0,
        gmailCredentialsPath: null,
        launchAtLogin: false,
        quietHours: { enabled: false, start: "22:00", end: "07:00" }
      },
      accounts: [],
      scans: [],
      notifiedFindingKeys: []
    }));

    const settings = await store.getSettings();

    expect(settings.scanIntervalMinutes).toBe(60);
  });

  test("rejects invalid scan interval updates", async () => {
    const store = new AppStore(await writeState(null));

    await expect(store.updateSettings({ scanIntervalMinutes: Number.NaN })).rejects.toThrow("scan interval");
    await expect(store.updateSettings({ scanIntervalMinutes: -1 })).rejects.toThrow("scan interval");
  });

  test("normalizes invalid persisted quiet hours to defaults", async () => {
    const store = new AppStore(await writeState({
      settings: {
        scanIntervalMinutes: 60,
        gmailCredentialsPath: null,
        launchAtLogin: false,
        quietHours: { enabled: true, start: "99:99", end: "later" }
      },
      accounts: [],
      scans: [],
      notifiedFindingKeys: [],
      scannedMessageKeys: []
    }));

    const settings = await store.getSettings();

    expect(settings.quietHours).toEqual({ enabled: true, start: "22:00", end: "07:00" });
  });

  test("rejects invalid quiet hours updates", async () => {
    const store = new AppStore(await writeState(null));

    await expect(store.updateSettings({ quietHours: { enabled: true, start: "24:00", end: "07:00" } })).rejects.toThrow("quiet hours");
    await expect(store.updateSettings({ quietHours: { enabled: true, start: "22:00", end: "7am" } })).rejects.toThrow("quiet hours");
  });

  test("clears scan memory without removing accounts, settings, or scan history", async () => {
    const store = new AppStore(await writeState({
      settings: {
        scanIntervalMinutes: 60,
        gmailCredentialsPath: "/tmp/credentials.json",
        launchAtLogin: false,
        quietHours: { enabled: false, start: "22:00", end: "07:00" }
      },
      accounts: [{ id: "work@example.com", email: "work@example.com", displayName: "Work", connectedAt: "2026-06-02T10:00:00.000Z" }],
      scans: [{
        id: "scan_1",
        startedAt: "2026-06-02T10:00:00.000Z",
        completedAt: "2026-06-02T10:00:01.000Z",
        status: "completed",
        accountsScanned: 1,
        messagesScanned: 1,
        findings: []
      }],
      notifiedFindingKeys: ["gmail:work@example.com:msg_1"],
      scannedMessageKeys: ["gmail:work@example.com:msg_1"]
    }));

    await store.clearScanMemory();

    expect(await store.getScannedMessageKeys()).toEqual([]);
    expect(await store.claimNewNotifiedFindingKeys(["gmail:work@example.com:msg_1"])).toEqual(["gmail:work@example.com:msg_1"]);
    expect(await store.getAccounts()).toHaveLength(1);
    expect(await store.getLastScan()).not.toBeNull();
    expect((await store.getSettings()).gmailCredentialsPath).toBe("/tmp/credentials.json");
  });

  test("clears scan memory for a removed Gmail account only", async () => {
    const store = new AppStore(await writeState({
      settings: {
        scanIntervalMinutes: 60,
        gmailCredentialsPath: "/tmp/credentials.json",
        launchAtLogin: false,
        quietHours: { enabled: false, start: "22:00", end: "07:00" }
      },
      accounts: [
        { id: "work@example.com", email: "work@example.com", displayName: "Work", connectedAt: "2026-06-02T10:00:00.000Z" },
        { id: "personal@example.com", email: "personal@example.com", displayName: "Personal", connectedAt: "2026-06-02T10:00:00.000Z" }
      ],
      scans: [],
      notifiedFindingKeys: ["gmail:Work@Example.com:msg_1", "gmail:personal@example.com:msg_2"],
      scannedMessageKeys: ["gmail:Work@Example.com:msg_1", "gmail:personal@example.com:msg_2"]
    }));

    await store.clearAccountScanMemory("work@example.com");

    expect(await store.getScannedMessageKeys()).toEqual(["gmail:personal@example.com:msg_2"]);
    expect(await store.claimNewNotifiedFindingKeys(["gmail:work@example.com:msg_1", "gmail:personal@example.com:msg_2"])).toEqual(["gmail:work@example.com:msg_1"]);
    expect(await store.getAccounts()).toHaveLength(2);
  });

  test("returns recent scans newest first with a limit", async () => {
    const store = new AppStore(await writeState({
      settings: {
        scanIntervalMinutes: 60,
        gmailCredentialsPath: "/tmp/credentials.json",
        launchAtLogin: false,
        quietHours: { enabled: false, start: "22:00", end: "07:00" }
      },
      accounts: [],
      scans: [
        scanResult("scan_3"),
        scanResult("scan_2"),
        scanResult("scan_1")
      ],
      notifiedFindingKeys: [],
      scannedMessageKeys: []
    }));

    expect((await store.getRecentScans(2)).map((scan) => scan.id)).toEqual(["scan_3", "scan_2"]);
  });

  test("keeps active important items after later scans find nothing", async () => {
    const store = new AppStore(await writeState(null));
    const importantScan = scanResult("scan_important", [{
      priority: "high",
      source: "gmail",
      sourceId: "msg_1",
      accountEmail: "work@example.com",
      title: "Security alert",
      why: "A login needs review.",
      suggestedAction: "Review the account.",
      evidence: "New login detected.",
      receivedAt: "2026-06-02T09:55:00.000Z"
    }]);
    const emptyScan = scanResult("scan_empty", []);

    await store.addScan(importantScan);
    await store.upsertImportantFindings(importantScan);
    await store.addScan(emptyScan);
    await store.upsertImportantFindings(emptyScan);

    const items = await store.getImportantItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Security alert");
    expect(items[0]?.status).toBe("active");
  });

  test("dedupes non-Gmail important items by source and source id", async () => {
    const store = new AppStore(await writeState(null));
    const firstScan = scanResult("scan_twitter_1", [{
      priority: "medium",
      source: "twitter",
      sourceId: "review_request:123",
      accountEmail: "X · org/repo",
      title: "Review requested",
      why: "A PR needs review.",
      suggestedAction: "Review the PR.",
      evidence: "Requested your review.",
      sourceUrl: "https://twitter.com/org/repo/pull/123",
      receivedAt: "2026-06-02T09:55:00.000Z"
    }]);
    const secondScan = scanResult("scan_twitter_2", [{
      ...firstScan.findings[0] as NonNullable<typeof firstScan.findings[0]>,
      accountEmail: "X · repo",
      title: "PR review still requested"
    }]);

    await store.addScan(firstScan);
    await store.upsertImportantFindings(firstScan);
    await store.addScan(secondScan);
    await store.upsertImportantFindings(secondScan);

    const items = await store.getImportantItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("twitter:review_request:123");
    expect(items[0]?.title).toBe("PR review still requested");
    expect(items[0]?.firstSeenAt).toBe(firstScan.completedAt);
    expect(items[0]?.lastSeenAt).toBe(secondScan.completedAt);
  });

  test("normalizes legacy prefixed Twitter important item ids", async () => {
    const storePath = await writeState(null);
    const store = new AppStore(storePath);
    const legacyScan = scanResult("scan_legacy_twitter", [{
      priority: "medium",
      source: "twitter",
      sourceId: "twitter:2063067201259917399",
      accountEmail: "X · @Jackkk",
      title: "Flood post",
      why: "Useful context.",
      suggestedAction: "Review if relevant.",
      evidence: "Flood said something important.",
      sourceUrl: "https://x.com/Jackkk/status/2063067201259917399",
      receivedAt: "2026-06-02T09:55:00.000Z"
    }]);
    await store.addScan(legacyScan);
    await store.upsertImportantFindings(legacyScan);

    const reloaded = new AppStore(storePath);
    const items = await reloaded.getImportantItems();

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("twitter:2063067201259917399");
    expect(items[0]?.sourceId).toBe("2063067201259917399");
  });

  test("backfills active important items from existing scan history after upgrade", async () => {
    const legacyStorePath = await writeState(null);
    const oldStore = new AppStore(legacyStorePath);
    await oldStore.addScan(scanResult("scan_before_upgrade", [{
      priority: "medium",
      source: "gmail",
      sourceId: "msg_upgrade",
      accountEmail: "work@example.com",
      title: "Reply needed",
      why: "A customer asked for an answer.",
      suggestedAction: "Reply to the customer.",
      evidence: "Can you send this today?",
      receivedAt: "2026-06-02T09:55:00.000Z"
    }]));

    const upgradedStore = new AppStore(legacyStorePath);
    const items = await upgradedStore.getImportantItems();

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("gmail:work@example.com:msg_upgrade");
    expect(items[0]?.title).toBe("Reply needed");
  });


  test("clears notified keys by prefix without touching other notification memory", async () => {
    const store = new AppStore(await writeState({
      settings: {
        scanIntervalMinutes: 60,
        gmailCredentialsPath: "/tmp/credentials.json",
        launchAtLogin: false,
        quietHours: { enabled: false, start: "22:00", end: "07:00" }
      },
      accounts: [],
      scans: [],
      notifiedFindingKeys: [
        "scan-failure:Codex not ready",
        "scan-failure:Gmail token expired",
        "gmail:work@example.com:msg_1"
      ],
      scannedMessageKeys: []
    }));

    await store.clearNotifiedFindingKeysByPrefix("scan-failure:");

    expect(await store.claimNewNotifiedFindingKeys([
      "scan-failure:Codex not ready",
      "gmail:work@example.com:msg_1"
    ])).toEqual(["scan-failure:Codex not ready"]);
  });

  test("persists dismissed source insight ids", async () => {
    const store = new AppStore(await writeState(null));

    await store.dismissSourceInsight("twitter:2026-06-08T16:00:00.000Z");
    await store.dismissSourceInsight("telegram:2026-06-08T16:00:00.000Z");
    await store.dismissSourceInsight("twitter:2026-06-08T16:00:00.000Z");

    expect(await store.getDismissedSourceInsightIds()).toEqual([
      "telegram:2026-06-08T16:00:00.000Z",
      "twitter:2026-06-08T16:00:00.000Z"
    ]);
  });

  test("migrates legacy JSON state into a local SQLite database", async () => {
    const legacyPath = await writeState({
      settings: {
        scanIntervalMinutes: 30,
        gmailCredentialsPath: "/tmp/credentials.json",
        launchAtLogin: true,
        quietHours: { enabled: true, start: "21:00", end: "06:00" }
      },
      accounts: [{ id: "work@example.com", email: "work@example.com", displayName: "Work", connectedAt: "2026-06-02T10:00:00.000Z" }],
      scans: [scanResult("scan_1")],
      notifiedFindingKeys: ["gmail:work@example.com:msg_1"],
      scannedMessageKeys: ["gmail:work@example.com:msg_1"]
    });
    const store = new AppStore(legacyPath);

    expect((await store.getSettings()).scanIntervalMinutes).toBe(30);
    expect(await store.getAccounts()).toHaveLength(1);
    expect(await store.getLastScan()).not.toBeNull();
    expect(await store.getScannedMessageKeys()).toEqual(["gmail:work@example.com:msg_1"]);
    await fs.access(legacyPath.replace(/\.json$/, ".sqlite"));
  });

  test("persists source connections, cursors, and connector health", async () => {
    const store = new AppStore(await writeState(null));
    const connection: SourceConnection = {
      id: "twitter:native:kevin",
      source: "twitter",
      backend: "native",
      label: "Kevin X",
      accountIdentifier: "kevin",
      externalAccountId: null,
      enabled: true,
      config: { tokenId: "twitter_token", repoFilter: ["owner/repo"] },
      connectedAt: "2026-06-04T10:00:00.000Z",
      updatedAt: "2026-06-04T10:00:00.000Z"
    };
    const cursor: SourceCursor = {
      connectionId: connection.id,
      cursorKey: "twitter:last_notification_updated_at",
      cursorValue: "2026-06-04T10:05:00.000Z",
      updatedAt: "2026-06-04T10:05:00.000Z"
    };
    const health: ConnectorHealth = {
      connectionId: connection.id,
      status: "ready",
      detail: "Connected",
      checkedAt: "2026-06-04T10:06:00.000Z"
    };

    await store.saveSourceConnection(connection);
    await store.saveSourceCursors([cursor]);
    await store.saveConnectorHealth(health);

    expect(await store.listSourceConnections()).toEqual([connection]);
    expect(await store.getSourceCursor(connection.id, cursor.cursorKey)).toEqual(cursor);
    expect(await store.getSourceCursor(connection.id, "missing")).toBeNull();
    expect(await store.listConnectorHealth()).toEqual([health]);

    await store.saveSourceConnection({
      ...connection,
      label: "Kevin X Updated",
      enabled: false,
      updatedAt: "2026-06-04T10:07:00.000Z"
    });

    expect(await store.listSourceConnections()).toEqual([{
      ...connection,
      label: "Kevin X Updated",
      enabled: false,
      updatedAt: "2026-06-04T10:07:00.000Z"
    }]);

    const updatedConfig = await store.updateSourceConnectionConfig(connection.id, { selectedChannelIds: ["C123", "C456"] });
    expect(updatedConfig.config).toEqual({ selectedChannelIds: ["C123", "C456"] });
    expect((await store.getSourceConnection(connection.id))?.config).toEqual({ selectedChannelIds: ["C123", "C456"] });

    await store.removeSourceConnection(connection.id);

    expect(await store.listSourceConnections()).toEqual([]);
    expect(await store.getSourceCursor(connection.id, cursor.cursorKey)).toBeNull();
    expect(await store.listConnectorHealth()).toEqual([]);
  });
});

async function writeState(value: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "what-did-i-miss-store-"));
  const filePath = path.join(dir, "state.json");
  if (value !== null) await fs.writeFile(filePath, JSON.stringify(value));
  return filePath;
}

function scanResult(id: string, findings: ScanFinding[] = []): ScanResult {
  return {
    id,
    startedAt: "2026-06-02T10:00:00.000Z",
    completedAt: "2026-06-02T10:00:01.000Z",
    status: "completed",
    accountsScanned: 1,
    messagesScanned: 0,
    findings
  };
}

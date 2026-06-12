import { describe, expect, test } from "bun:test";
import { trayScanNowItem, trayStatusLabel } from "./tray-status";
import type { AppState } from "./types";

describe("tray status", () => {
  test("shows setup blockers before schedule status", () => {
    expect(trayStatusLabel(state({ codexReady: false }))).toBe("Status: Codex sign-in needed");
    expect(trayStatusLabel(state({ gmailCredentialsPath: null, accounts: [] }))).toBe("Status: connect a source");
  });

  test("shows relative next scan time when hourly loop is scheduled", () => {
    expect(trayStatusLabel(
      state({ nextScanAt: "2026-06-02T13:15:00.000Z" }),
      () => new Date("2026-06-02T12:00:00.000Z")
    )).toBe("Next scan: 1h 15m");
  });

  test("shows scanning status while a scan is running", () => {
    expect(trayStatusLabel(state({ isScanning: true }))).toBe("Status: scanning sources");
  });

  test("disables manual tray scan while scanning", () => {
    expect(trayScanNowItem(state({ isScanning: true }))).toEqual({ label: "Scanning...", enabled: false });
    expect(trayScanNowItem(state({ isScanning: false }))).toEqual({ label: "Scan Now", enabled: true });
  });

  test("hides manual tray scan while signed out", () => {
    expect(trayScanNowItem(state({ codexReady: false }))).toBeNull();
  });

  test("disables manual tray scan until a source is connected", () => {
    expect(trayScanNowItem(state({ gmailCredentialsPath: null, accounts: [] }))).toEqual({ label: "Connect Source First", enabled: false });
  });

  test("enables manual tray scan for Telegram-only setup", () => {
    expect(trayScanNowItem(state({ gmailCredentialsPath: null, accounts: [], telegramExportPath: "/tmp/result.json" }))).toEqual({ label: "Scan Now", enabled: true });
  });

  test("enables manual tray scan for native source setup", () => {
    expect(trayStatusLabel(state({
      gmailCredentialsPath: null,
      accounts: [],
      sourceConnections: [sourceConnection("twitter:native:kevin")]
    }), () => new Date("2026-06-02T12:00:00.000Z"))).toBe("Next scan: 1h 0m");
    expect(trayScanNowItem(state({
      gmailCredentialsPath: null,
      accounts: [],
      sourceConnections: [sourceConnection("twitter:native:kevin")]
    }))).toEqual({ label: "Scan Now", enabled: true });
  });
});

function state(overrides: Partial<AppState> & { gmailCredentialsPath?: string | null; telegramExportPath?: string | null } = {}): AppState {
  return {
    settings: {
      scanIntervalMinutes: 60,
      gmailCredentialsPath: overrides.gmailCredentialsPath === undefined ? "/tmp/credentials.json" : overrides.gmailCredentialsPath,
      telegramExportPath: overrides.telegramExportPath ?? null,
      telegramIncludeDms: true,
      launchAtLogin: false,
      quietHours: { enabled: false, start: "22:00", end: "07:00" }
    },
    accounts: overrides.accounts ?? [{ id: "work@example.com", email: "work@example.com", displayName: "Work", connectedAt: "2026-06-02T10:00:00.000Z" }],
    telegramChats: overrides.telegramChats ?? [],
    codexReady: overrides.codexReady ?? true,
    isScanning: overrides.isScanning ?? false,
    nextScanAt: overrides.nextScanAt === undefined ? "2026-06-02T13:00:00.000Z" : overrides.nextScanAt,
    lastScan: null,
    lastCompletedScan: null,
    recentScans: [],
    sourceConnections: overrides.sourceConnections ?? [],
    lastError: null
  };
}

function sourceConnection(id: string) {
  return {
    id,
    source: "twitter" as const,
    backend: "native" as const,
    label: "X / Twitter",
    accountIdentifier: "kevin",
    externalAccountId: null,
    enabled: true,
    config: {},
    connectedAt: "2026-06-04T10:00:00.000Z",
    updatedAt: "2026-06-04T10:00:00.000Z"
  };
}

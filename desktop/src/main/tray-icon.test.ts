import { describe, expect, test } from "bun:test";
import { formatBadgeCount, importantCountFromState, renderTrayIconSvg } from "./tray-icon";
import type { AppState, ScanFinding } from "./types";

describe("tray icon helpers", () => {
  test("counts findings from the latest completed scan", () => {
    const state = appState({
      status: "completed",
      findings: [finding("one"), finding("two")]
    });

    expect(importantCountFromState(state)).toBe(2);
  });

  test("does not count findings when no completed scan exists", () => {
    expect(importantCountFromState(appState(null))).toBe(0);
    expect(importantCountFromState(appState({ status: "failed", findings: [finding("one")] }))).toBe(0);
  });

  test("keeps counting the last completed scan after a later failed scan", () => {
    const state = appState({ status: "failed", findings: [] }, {
      status: "completed",
      findings: [finding("one"), finding("two")]
    });

    expect(importantCountFromState(state)).toBe(2);
  });

  test("formats badge counts for compact macOS tray space", () => {
    expect(formatBadgeCount(0)).toBe("");
    expect(formatBadgeCount(4)).toBe("4");
    expect(formatBadgeCount(10)).toBe("9+");
  });

  test("renders a badge only when findings exist", () => {
    expect(renderTrayIconSvg(0)).not.toContain(">9+</text>");
    expect(renderTrayIconSvg(0)).not.toContain(">3</text>");
    expect(renderTrayIconSvg(3)).toContain(">3</text>");
    expect(renderTrayIconSvg(12)).toContain(">9+</text>");
  });

  test("renders a visible circular app mark", () => {
    const svg = renderTrayIconSvg(0);

    expect(svg).toContain("<circle cx=\"16\" cy=\"16\" r=\"13\" fill=\"#fff\"");
    expect(svg).toContain("mask=\"url(#wdim-cutout)\"");
    expect(svg).toContain("stroke=\"#000\"");
  });
});

function appState(
  scan: null | { status: "completed" | "failed"; findings: ScanFinding[] },
  lastCompletedScan: null | { status: "completed"; findings: ScanFinding[] } = completedScanFrom(scan)
): AppState {
  const lastScan = scan
    ? {
        id: "scan_1",
        startedAt: "2026-06-02T10:00:00.000Z",
        completedAt: "2026-06-02T10:01:00.000Z",
        status: scan.status,
        accountsScanned: 1,
        messagesScanned: 1,
        findings: scan.findings
      }
    : null;
  const completedScan = lastCompletedScan
    ? {
        id: "scan_completed",
        startedAt: "2026-06-02T09:00:00.000Z",
        completedAt: "2026-06-02T09:01:00.000Z",
        status: lastCompletedScan.status,
        accountsScanned: 1,
        messagesScanned: 1,
        findings: lastCompletedScan.findings
      }
    : null;

  return {
    settings: {
      scanIntervalMinutes: 60,
      gmailCredentialsPath: null,
      telegramExportPath: null,
      telegramIncludeDms: true,
      launchAtLogin: false,
      quietHours: { enabled: false, start: "22:00", end: "07:00" }
    },
    accounts: [],
    telegramChats: [],
    codexReady: true,
    isScanning: false,
    nextScanAt: null,
    lastScan,
    lastCompletedScan: completedScan,
    recentScans: [lastScan, completedScan].filter((item): item is NonNullable<typeof item> => Boolean(item)),
    lastError: null
  };
}

function completedScanFrom(scan: null | { status: "completed" | "failed"; findings: ScanFinding[] }): null | { status: "completed"; findings: ScanFinding[] } {
  if (scan?.status !== "completed") return null;
  return { status: "completed", findings: scan.findings };
}

function finding(sourceId: string): ScanFinding {
  return {
    priority: "high",
    source: "gmail",
    sourceId,
    accountEmail: "user@example.com",
    title: "Needs attention",
    why: "It blocks a response.",
    suggestedAction: "Reply today.",
    evidence: "Please confirm."
  };
}

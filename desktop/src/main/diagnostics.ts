import path from "node:path";
import { buildGmailRecentQuery, GMAIL_DEFAULT_MAX_RESULTS, GMAIL_PAGE_SIZE } from "./gmail-query";
import type {
  AppDiagnostics,
  AppState,
  GmailAccount,
  RedactedConnectorHealth,
  RedactedInboxHealth,
  RedactedScanSummary,
  RedactedSourceConnection,
  ScanResult
} from "./types";
import type { ConnectorHealth, SourceConnection } from "./connectors/types";

type BuildDiagnosticsOptions = {
  appVersion: string;
  userDataPath: string;
  notificationSupported?: boolean;
  platform?: NodeJS.Platform;
  now?: () => Date;
};

export function buildDiagnostics(state: AppState, options: BuildDiagnosticsOptions): AppDiagnostics {
  const now = (options.now ?? (() => new Date()))();
  const defaultScanSince = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return {
    generatedAt: now.toISOString(),
    appVersion: options.appVersion,
    platform: options.platform ?? process.platform,
    userDataPath: options.userDataPath,
    codexReady: state.codexReady,
    isScanning: state.isScanning,
    nextScanAt: state.nextScanAt,
    setup: {
      gmailCredentialsSelected: Boolean(state.settings.gmailCredentialsPath),
      gmailCredentialsFileName: state.settings.gmailCredentialsPath
        ? path.basename(state.settings.gmailCredentialsPath)
        : null,
      connectedInboxCount: state.accounts.length,
      connectedInboxes: state.accounts.map((account) => maskEmail(account.email)),
      nativeConfiguredSources: state.nativeConfiguredSources ?? [],
      sourceConnections: (state.sourceConnections ?? []).map(summarizeSourceConnection),
      legacyLocalGmailCount: state.legacyLocalGmailAccounts?.length ?? 0,
      telegramExportSelected: Boolean(state.settings.telegramExportPath),
      telegramChatCount: state.telegramChats.length,
      telegramEnabledChatCount: state.telegramChats.filter((chat) => chat.enabled).length,
      telegramIncludeDms: state.settings.telegramIncludeDms,
      scanIntervalMinutes: state.settings.scanIntervalMinutes,
      launchAtLogin: state.settings.launchAtLogin,
      quietHoursEnabled: state.settings.quietHours.enabled
    },
    gmailScan: {
      query: buildGmailRecentQuery(defaultScanSince),
      catchUpDays: 1,
      pageSize: GMAIL_PAGE_SIZE,
      maxMessagesPerInbox: GMAIL_DEFAULT_MAX_RESULTS
    },
    notifications: {
      supported: options.notificationSupported ?? false
    },
    lastScan: state.lastScan ? summarizeScan(state.lastScan) : null,
    recentScans: state.recentScans.map(summarizeScan),
    inboxHealth: state.accounts.map((account) => summarizeInboxHealth(account, state.lastScan)),
    connectorHealth: (state.connectorHealth ?? []).map(summarizeConnectorHealth),
    lastError: state.lastError
  };
}

export function buildLiveCheckCommand(appRoot: string, credentialsPath?: string | null): string {
  void credentialsPath;
  return `cd ${shellQuote(appRoot)} && bun run smoke:codex`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function summarizeScan(scan: ScanResult): RedactedScanSummary {
  return {
    id: scan.id,
    startedAt: scan.startedAt,
    completedAt: scan.completedAt,
    durationMs: scan.durationMs,
    status: scan.status,
    error: scan.error,
    accountsScanned: scan.accountsScanned,
    messagesFound: scan.messagesFound,
    messagesScanned: scan.messagesScanned,
    messagesSkipped: scan.messagesSkipped,
    accountSummaries: scan.accountSummaries?.map((summary) => ({
      ...summary,
      accountEmail: maskEmail(summary.accountEmail)
    })),
    sourceSummaries: scan.sourceSummaries,
    accountErrors: scan.accountErrors?.map((error) => ({
      ...error,
      accountEmail: maskEmail(error.accountEmail)
    })),
    findingsCount: scan.findings.length,
    highPriorityFindings: scan.findings.filter((finding) => finding.priority === "high").length,
    scanMetadata: scan.scanMetadata
  };
}

function summarizeSourceConnection(connection: SourceConnection): RedactedSourceConnection {
  return {
    id: redactEmailLikeValue(connection.id),
    source: connection.source,
    backend: connection.backend,
    label: redactConnectionValue(connection.label, connection),
    accountIdentifier: connection.accountIdentifier?.includes("@")
      ? maskEmail(connection.accountIdentifier)
      : connection.accountIdentifier ? redactConnectionValue(connection.accountIdentifier, connection) : connection.accountIdentifier,
    enabled: connection.enabled,
    connectedAt: connection.connectedAt,
    updatedAt: connection.updatedAt
  };
}

function summarizeConnectorHealth(health: ConnectorHealth): RedactedConnectorHealth {
  return {
    connectionId: redactEmailLikeValue(health.connectionId),
    status: health.status,
    detail: health.detail.includes("@") ? health.detail.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => maskEmail(email)) : health.detail,
    checkedAt: health.checkedAt
  };
}

function redactEmailLikeValue(value: string): string {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => maskEmail(email));
}

function redactConnectionValue(value: string, connection: SourceConnection): string {
  const redacted = redactEmailLikeValue(value);
  if (redacted !== value) return redacted;
  return connection.backend === "native" ? "[redacted]" : value;
}

function summarizeInboxHealth(account: GmailAccount, scan: ScanResult | null): RedactedInboxHealth {
  const accountEmail = maskEmail(account.email);
  if (!scan) {
    return {
      accountEmail,
      status: "waiting",
      detail: "Waiting for first scan"
    };
  }

  if (scan.status === "failed" && !scan.accountErrors?.length) {
    return {
      accountEmail,
      status: "error",
      detail: "Latest scan failed"
    };
  }

  const error = accountScanError(scan, account);
  if (error) {
    return {
      accountEmail,
      status: "error",
      detail: `Skipped last scan: ${error.error}`
    };
  }

  const summary = accountScanSummary(scan, account);
  if (summary) {
    return {
      accountEmail,
      status: "ok",
      detail: "Last scan OK",
      messagesFound: summary.messagesFound,
      messagesScanned: summary.messagesScanned,
      messagesSkipped: summary.messagesSkipped
    };
  }

  return {
    accountEmail,
    status: scan.status === "completed" ? "ok" : "waiting",
    detail: scan.status === "completed" ? "Last scan OK" : "Waiting for scan"
  };
}

function accountScanError(scan: ScanResult, account: GmailAccount) {
  const accountId = normalizedAccountId(account);
  return (scan.accountErrors ?? []).find((item) => item.accountEmail.toLowerCase() === accountId);
}

function accountScanSummary(scan: ScanResult, account: GmailAccount) {
  const accountId = normalizedAccountId(account);
  return (scan.accountSummaries ?? []).find((item) => item.accountEmail.toLowerCase() === accountId);
}

function normalizedAccountId(account: GmailAccount): string {
  return String(account.id || account.email).toLowerCase();
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (!local || !domain) return "[redacted]";

  const visibleLocal = local.length <= 2
    ? local[0] ?? ""
    : `${local[0]}${local.at(-1)}`;
  const domainParts = domain.split(".");
  const root = domainParts[0] ?? "";
  const suffix = domainParts.slice(1).join(".");
  const visibleDomain = root
    ? `${root[0]}${root.length > 1 ? "***" : ""}${suffix ? `.${suffix}` : ""}`
    : "[redacted]";

  return `${visibleLocal}${local.length > 1 ? "***" : ""}@${visibleDomain}`;
}

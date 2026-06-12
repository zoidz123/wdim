import type { DigestCard, GmailEvent, ScanRoute, TelegramEvent, YouTubeSummaryAnchor } from "@what-did-i-miss/shared";
import type { CodexReadinessStatus } from "./codex";
import type { ConnectorHealth, SourceConnection } from "./connectors/types";

export type GmailAccount = {
  id: string;
  email: string;
  displayName: string;
  connectedAt: string;
};

export type AppSettings = {
  scanIntervalMinutes: number;
  gmailCredentialsPath: string | null;
  telegramExportPath: string | null;
  telegramIncludeDms: boolean;
  launchAtLogin: boolean;
  quietHours: {
    enabled: boolean;
    start: string;
    end: string;
  };
};

export type ScanFinding = {
  priority: "high" | "medium" | "low";
  source: "gmail" | "telegram" | "youtube" | "twitter";
  sourceId: string;
  accountEmail: string;
  title: string;
  why: string;
  suggestedAction: string;
  evidence: string;
  sourceUrl?: string;
  receivedAt?: string;
  sourceMetrics?: Record<string, number>;
  sourceKind?: string;
  sourceRepo?: string;
  youtubeAnchors?: YouTubeSummaryAnchor[];
};

export type SourceInsight = {
  id: string;
  source: "gmail" | "telegram" | "youtube" | "twitter";
  title: string;
  summary: string;
  generatedAt: string;
};

export type ImportantItemStatus = "active" | "completed" | "dismissed";

export type ImportantItem = ScanFinding & {
  id: string;
  status: ImportantItemStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  scanId: string;
};

export type ScanResult = {
  id: string;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
  status: "completed" | "failed";
  error?: string;
  accountsScanned: number;
  messagesFound?: number;
  messagesScanned: number;
  messagesSkipped?: number;
  accountSummaries?: AccountScanSummary[];
  sourceSummaries?: SourceScanSummary[];
  sourceInsights?: SourceInsight[];
  accountErrors?: AccountScanError[];
  findings: ScanFinding[];
  digestCards?: DigestCard[];
  rawResponse?: string;
  scanMetadata?: ScanMetadata;
};

export type ScanMetadata = {
  route: ScanRoute;
  rawEventCount: number;
  groupCount: number;
  processedGroupCount: number;
  skippedGroupCount: number;
  estimatedTokens: number;
  batchCount: number;
  oversizedGroupCount: number;
  intermediateSummaries?: string[];
  candidateFindings?: ScanFinding[];
  evidenceSnippets?: string[];
};

export type AccountScanSummary = {
  accountEmail: string;
  messagesFound: number;
  messagesScanned: number;
  messagesSkipped: number;
};

export type SourceScanSummary = {
  source: "gmail" | "telegram" | "youtube" | "twitter";
  messagesFound: number;
  messagesScanned: number;
  messagesSkipped: number;
  status?: ConnectorHealth["status"];
  detail?: string;
};

export type AccountScanError = {
  accountEmail: string;
  error: string;
};

export type AppState = {
  settings: AppSettings;
  accounts: GmailAccount[];
  sourceConnections?: SourceConnection[];
  connectorHealth?: ConnectorHealth[];
  legacyLocalGmailAccounts?: GmailAccount[];
  nativeConfiguredSources?: Array<"gmail" | "twitter">;
  telegramChats: TelegramChat[];
  telegramConnected?: boolean;
  codexReady: boolean;
  codexStatus?: CodexReadinessStatus;
  isScanning: boolean;
  scanProgress?: { label: string; startedAt: string } | null;
  nextScanAt: string | null;
  lastScan: ScanResult | null;
  lastCompletedScan: ScanResult | null;
  recentScans: ScanResult[];
  importantItems?: ImportantItem[];
  dismissedSourceInsightIds?: string[];
  dismissedDigestCardIds?: string[];
  lastError: string | null;
};

export type SetupCheckStatus = "ready" | "missing" | "error";

export type SetupCheckItem = {
  id: "codex" | "gmailCredentials" | "inboxes" | "sources" | "telegram" | "launchAtLogin" | "schedule" | "notifications";
  label: string;
  status: SetupCheckStatus;
  detail: string;
};

export type SetupCheckResult = {
  checkedAt: string;
  ready: boolean;
  checks: SetupCheckItem[];
};

export type AppDiagnostics = {
  generatedAt: string;
  appVersion: string;
  platform: NodeJS.Platform;
  userDataPath: string;
  codexReady: boolean;
  isScanning: boolean;
  nextScanAt: string | null;
  setup: {
    gmailCredentialsSelected: boolean;
    gmailCredentialsFileName: string | null;
    connectedInboxCount: number;
    connectedInboxes: string[];
    nativeConfiguredSources?: Array<"gmail" | "twitter">;
    sourceConnections: RedactedSourceConnection[];
    legacyLocalGmailCount: number;
    telegramExportSelected: boolean;
    telegramChatCount: number;
    telegramEnabledChatCount: number;
    telegramIncludeDms: boolean;
    scanIntervalMinutes: number;
    launchAtLogin: boolean;
    quietHoursEnabled: boolean;
  };
  gmailScan: {
    query: string;
    catchUpDays: number;
    pageSize: number;
    maxMessagesPerInbox: number;
  };
  notifications: {
    supported: boolean;
  };
  lastScan: RedactedScanSummary | null;
  recentScans: RedactedScanSummary[];
  inboxHealth: RedactedInboxHealth[];
  connectorHealth: RedactedConnectorHealth[];
  lastError: string | null;
};

export type RedactedSourceConnection = {
  id: string;
  source: SourceConnection["source"];
  backend: SourceConnection["backend"];
  label: string;
  accountIdentifier: string | null;
  enabled: boolean;
  connectedAt: string;
  updatedAt: string;
};

export type RedactedConnectorHealth = {
  connectionId: string;
  status: ConnectorHealth["status"];
  detail: string;
  checkedAt: string;
};

export type RedactedInboxHealth = {
  accountEmail: string;
  status: "waiting" | "ok" | "error";
  detail: string;
  messagesFound?: number;
  messagesScanned?: number;
  messagesSkipped?: number;
};

export type RedactedScanSummary = {
  id: string;
  startedAt: string;
  completedAt: string;
  durationMs?: number;
  status: "completed" | "failed";
  error?: string;
  accountsScanned: number;
  messagesFound?: number;
  messagesScanned: number;
  messagesSkipped?: number;
  accountSummaries?: AccountScanSummary[];
  sourceSummaries?: SourceScanSummary[];
  accountErrors?: AccountScanError[];
  findingsCount: number;
  highPriorityFindings: number;
  scanMetadata?: ScanMetadata;
};

export type GmailAccountMessages = {
  account: GmailAccount;
  messages: GmailEvent[];
};

export type TelegramChat = {
  id: string;
  title: string;
  enabled: boolean;
  kind: "group" | "channel" | "dm";
  username?: string;
  memberCount?: number;
  folders?: string[];
  peerKey?: string;
  inputEntity?: string;
};

export type TelegramScanInput = {
  exportPath?: string | null;
  chats: TelegramChat[];
  includeDms: boolean;
  limitPerChat?: number;
  maxDirectChats?: number;
  since?: string;
};

export type TelegramSourceMessages = {
  messages: TelegramEvent[];
};

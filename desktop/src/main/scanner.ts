import type { DigestCard, DigestPromptEvent, DigestSource, EventGroup, RawEvents, ScanPlan, YouTubeSummaryAnchor } from "@what-did-i-miss/shared";
import { groupEvents, parseDigestResponse, planGroupedScan, rawEventsFromGroups } from "@what-did-i-miss/shared";
import { GmailConnector } from "./gmail";
import { TelegramConnector } from "./telegram";
import { CODEX_READY_STATUS, CodexAppServerClient, classifyCodexReadinessError, deriveYouTubeAnchorsFromSummary, parseTriageResult, type CodexLoginStartResult, type CodexReadinessStatus, type YouTubeTranscriptSummary } from "./codex";
import type { ConnectorRegistry } from "./connectors/registry";
import type { ConnectorHealth, SourceCursor, SourceEvent } from "./connectors/types";
import { AppStore } from "./store";
import { validateCredentialsFile } from "./gmail-credentials";
import type { AccountScanError, AccountScanSummary, AppSettings, AppState, GmailAccount, GmailAccountMessages, ImportantItem, ImportantItemStatus, ScanFinding, ScanResult, SetupCheckItem, SetupCheckResult, SourceInsight, TelegramChat } from "./types";

type ScanListener = (state: AppState) => void;
type HighPriorityNotifier = (findings: ScanFinding[]) => void;
type ScanFailureNotifier = (result: ScanResult) => void;
type ScanSummarySource = NonNullable<ScanResult["sourceSummaries"]>[number]["source"];
type StartOptions = {
  scanImmediately?: boolean;
};
type PlannedTriageResult = {
  rawResponse: string;
  intermediateSummaries: string[];
  candidateFindings: ScanFinding[];
  sourceInsights: SourceInsight[];
};
type GroupAwareCodexClient = CodexAppServerClient & {
  triageGroups?: (groups: EventGroup[]) => Promise<string>;
  synthesizeBatchResults?: (batchResults: unknown[]) => Promise<string>;
  summarizeYouTubeTranscript?: (video: NonNullable<RawEvents["youtube"]>[number]) => Promise<string | YouTubeTranscriptSummary>;
  generateDigest?: (source: DigestSource, events: DigestPromptEvent[], window: { start: string; end: string }) => Promise<string>;
};

const MAX_SCAN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const YOUTUBE_CONNECTOR_SCAN_DELAY_MS = 750;
const MAX_YOUTUBE_VIDEOS_PER_SCAN = 15;

type ConnectorScanTarget = Awaited<ReturnType<ConnectorRegistry["listEnabledConnections"]>>[number];
type ConnectorScanResult = {
  rawEvents: RawEvents;
  source: SourceEvent["source"];
  health: ConnectorHealth;
};

export class ScanService {
  private timer: NodeJS.Timeout | null = null;
  private isScanning = false;
  private scanProgress: AppState["scanProgress"] = null;
  private activeScan: Promise<ScanResult> | null = null;
  private codexReady = false;
  private codexStatus: CodexReadinessStatus = {
    state: "error",
    detail: "Codex has not been checked yet.",
    command: null,
    actionLabel: "Sign in with ChatGPT"
  };
  private nextScanAt: string | null = null;
  private lastError: string | null = null;
  private listeners = new Set<ScanListener>();

  constructor(
    private readonly store: AppStore,
    private readonly gmail: GmailConnector,
    private readonly codex: CodexAppServerClient,
    private readonly highPriorityNotifier: HighPriorityNotifier = defaultHighPriorityNotifier,
    private readonly now: () => Date = () => new Date(),
    private readonly scanFailureNotifier: ScanFailureNotifier = defaultScanFailureNotifier,
    private readonly telegram: Pick<TelegramConnector, "fetchRecentMessages"> & Partial<Pick<TelegramConnector, "isConnected">> = new TelegramConnector(),
    private readonly connectorRegistry: ConnectorRegistry | null = null,
    private readonly nativeConfiguredSources: AppState["nativeConfiguredSources"] = []
  ) {}

  async start(options: StartOptions = {}): Promise<void> {
    await this.initializeCodex();
    await this.scheduleNextScan();
    if (options.scanImmediately !== false && (await this.isReadyToScanNow())) {
      void this.scanNow();
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.codex.close();
  }

  async scanNow(): Promise<ScanResult> {
    if (this.activeScan) return this.activeScan;

    this.activeScan = this.runScanNow();
    try {
      return await this.activeScan;
    } finally {
      this.activeScan = null;
    }
  }

  async summarizeYouTubeVideoConnection(connectionId: string): Promise<ScanResult> {
    if (this.activeScan) return this.activeScan;

    this.activeScan = this.runYouTubeVideoConnectionScan(connectionId);
    try {
      return await this.activeScan;
    } finally {
      this.activeScan = null;
    }
  }

  private async runYouTubeVideoConnectionScan(connectionId: string): Promise<ScanResult> {
    this.isScanning = true;
    this.lastError = null;
    await this.setScanProgress("Fetching video details");

    const startedAt = new Date().toISOString();
    try {
      await this.ensureCodexReady();
      if (!this.codexReady) throw new Error("Codex App Server is not ready. Make sure Codex is installed and signed in.");
      if (!this.connectorRegistry) throw new Error("YouTube video sources are not available in this build.");

      const target = (await this.connectorRegistry.listEnabledConnections())
        .find(({ connection }) => connection.id === connectionId);
      if (!target || target.connection.source !== "youtube" || target.connection.backend !== "local" || target.connection.config?.kind !== "video") {
        throw new Error("That YouTube video source is no longer available.");
      }

      await this.clearYouTubeVideoScanMemory(target.connection.id, stringConfigValue(target.connection.config.videoId));
      const connectorScan = await this.scanConnectorTarget(target, new Date(0).toISOString(), { maxVideos: 1 });
      const allRawEvents = connectorScan.rawEvents;
      const messagesFound = eventCount(allRawEvents);
      const preparedRawEvents = await this.prepareYouTubeEventsWithExistingSummaryFallback(allRawEvents);
      const messagesScanned = eventCount(preparedRawEvents);
      const completedAt = new Date().toISOString();
      const findings = youtubeFindingsFromEvents(preparedRawEvents.youtube ?? []);
      const sourceSummaries = summarizeSourceMessages(allRawEvents, preparedRawEvents, ["youtube"]);
      const result: ScanResult = {
        id: crypto.randomUUID(),
        startedAt,
        completedAt,
        durationMs: scanDurationMs(startedAt, completedAt),
        status: "completed",
        accountsScanned: 1,
        messagesFound,
        messagesScanned,
        messagesSkipped: messagesFound - messagesScanned,
        sourceSummaries,
        findings,
        rawResponse: JSON.stringify({ findings, sourceInsights: [] }, null, 2),
        scanMetadata: scanMetadataFromPlan(planGroupedScan(groupEvents(preparedRawEvents)))
      };

      await this.store.addScan(result);
      await this.upsertImportantFindings(result);
      await this.clearScanFailureNotificationMemory();
      await this.markMessagesScanned(preparedRawEvents);
      return result;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const result: ScanResult = {
        id: crypto.randomUUID(),
        startedAt,
        completedAt,
        durationMs: scanDurationMs(startedAt, completedAt),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        accountsScanned: 0,
        messagesFound: 0,
        messagesScanned: 0,
        messagesSkipped: 0,
        findings: []
      };
      this.lastError = result.error ?? null;
      await this.store.addScan(result);
      await this.notifyIfFailed(result);
      return result;
    } finally {
      this.isScanning = false;
      this.clearScanProgress();
      await this.scheduleNextScan();
      await this.emit();
    }
  }

  private async runScanNow(): Promise<ScanResult> {
    this.isScanning = true;
    this.lastError = null;
    await this.setScanProgress("Checking sources");

    const startedAt = new Date().toISOString();
    let failedAccountErrors: AccountScanError[] | undefined;
    try {
      const settings = await this.store.getSettings();
      await this.ensureCodexReady();
      if (!this.codexReady) throw new Error("Codex App Server is not ready. Make sure Codex is installed and signed in.");
      const accounts = await this.store.getAccounts();
      const telegramChats = await this.store.getTelegramChats();
      const registryMode = Boolean(this.connectorRegistry);
      const gmailReady = registryMode ? false : await this.canScanGmail(settings, accounts);
      const telegramReady = registryMode ? false : await this.canScanTelegram(settings, telegramChats);
      const connectorTargets = await this.connectorRegistry?.listEnabledConnections() ?? [];
      const connectorReady = connectorTargets.length > 0;
      const scanSince = await this.scanWindowStart();
      console.info("[scan] source readiness", {
        gmailReady,
        telegramReady,
        connectorReady,
        connectorConnections: connectorTargets.length,
        gmailAccounts: accounts.length,
        telegramChats: telegramChats.length,
        enabledTelegramChats: telegramChats.filter((chat) => chat.kind !== "dm" && chat.enabled).length,
        telegramIncludeDms: settings.telegramIncludeDms
      });
      if (!gmailReady && !telegramReady && !connectorReady) throw new Error("Connect Gmail, Telegram, or another source before scanning.");

      const { accountMessages, accountErrors } = gmailReady
        ? await this.fetchAllAccounts(settings.gmailCredentialsPath as string, scanSince)
        : { accountMessages: [], accountErrors: [] };
      if (!accountMessages.length && accountErrors.length) {
        failedAccountErrors = accountErrors;
        throw new Error(`All Gmail inboxes failed to scan. ${accountErrors[0]?.accountEmail}: ${accountErrors[0]?.error}`);
      }
      await this.setScanProgress("Reading your sources");
      let telegramMessages: NonNullable<RawEvents["telegram"]> = [];
      if (telegramReady) {
        const fetchedTelegramMessages = await this.telegram.fetchRecentMessages({
            exportPath: settings.telegramExportPath,
            chats: telegramChats,
            includeDms: settings.telegramIncludeDms,
            limitPerChat: 25,
            maxDirectChats: 25,
            since: scanSince
        });
        telegramMessages = filterTelegramMessages(fetchedTelegramMessages, settings, telegramChats);
        console.info("[scan] telegram messages", {
          fetched: fetchedTelegramMessages.length,
          afterSelectionFilter: telegramMessages.length,
          directFetched: fetchedTelegramMessages.filter((message) => message.direct).length,
          directAfterSelectionFilter: telegramMessages.filter((message) => message.direct).length
        });
      }
      const connectorScan = connectorReady
        ? await this.fetchConnectorEvents(connectorTargets, scanSince)
        : { rawEvents: {}, connectionsScanned: 0, scannedSources: [], sourceHealth: {} };
      const allRawEvents = mergeRawEvents(flattenAccountMessages(accountMessages), { telegram: telegramMessages }, connectorScan.rawEvents);
      const messagesFound = eventCount(allRawEvents);
      const rawEvents = await this.filterAlreadyScannedMessages(allRawEvents);
      const preparedRawEvents = await this.prepareYouTubeEvents(rawEvents);
      const messagesScanned = eventCount(preparedRawEvents);
      const messagesSkipped = messagesFound - messagesScanned;
      console.info("[scan] messages", {
        found: messagesFound,
        scanned: messagesScanned,
        skipped: messagesSkipped,
        gmailFound: allRawEvents.gmail?.length ?? 0,
        telegramFound: allRawEvents.telegram?.length ?? 0,
        youtubeFound: allRawEvents.youtube?.length ?? 0,
        twitterFound: allRawEvents.twitter?.length ?? 0,
        gmailScanned: preparedRawEvents.gmail?.length ?? 0,
        telegramScanned: preparedRawEvents.telegram?.length ?? 0,
        youtubeScanned: preparedRawEvents.youtube?.length ?? 0,
        twitterScanned: preparedRawEvents.twitter?.length ?? 0
      });
      const accountSummaries = summarizeAccountMessages(accountMessages, preparedRawEvents);
      const sourceSummaries = summarizeSourceMessages(allRawEvents, preparedRawEvents, connectorScan.scannedSources, connectorScan.sourceHealth);
      const groups = groupEvents(preparedRawEvents);
      const scanPlan = planGroupedScan(groups);
      const scanId = crypto.randomUUID();
      // Digest cards summarize the whole fetched window, not just never-seen
      // items — a "what's happening" card must consider all recent posts, or it
      // starves to nothing once the feed has been scanned once. Built here so it
      // runs even when there are no brand-new items to triage.
      const digestCards = await this.buildDigestCards(allRawEvents, scanId, { start: scanSince ?? startedAt, end: new Date().toISOString() }, new Date().toISOString());
      if (!messagesScanned) {
        const completedAt = new Date().toISOString();
        const result: ScanResult = {
          id: scanId,
          startedAt,
          completedAt,
          durationMs: scanDurationMs(startedAt, completedAt),
          status: "completed",
          accountsScanned: accountMessages.length + connectorScan.connectionsScanned,
          messagesFound,
          messagesScanned: 0,
          messagesSkipped,
          accountSummaries,
          sourceSummaries,
          accountErrors,
          findings: [],
          digestCards,
          scanMetadata: scanMetadataFromPlan(scanPlan)
        };

        await this.store.addScan(result);
        await this.upsertImportantFindings(result);
        await this.clearScanFailureNotificationMemory();
        return result;
      }
      const completedAt = new Date().toISOString();
      const automaticYouTubeFindings = youtubeFindingsFromEvents(preparedRawEvents.youtube ?? []);
      const digestOnly = this.hasDigestCardSynthesis();
      const triageRawEvents = digestOnly ? {} : withoutYouTubeEvents(preparedRawEvents);
      const triageGroups = digestOnly ? [] : groupEvents(triageRawEvents);
      const triagePlan = digestOnly ? scanPlan : planGroupedScan(triageGroups);
      if (!digestOnly && triageGroups.length) await this.setScanProgress("Analyzing messages");
      const triageResult = !digestOnly && triageGroups.length
        ? await this.runPlannedTriage(triageGroups, triagePlan, triageRawEvents)
        : emptyPlannedTriageResult(automaticYouTubeFindings);
      const parsed = digestOnly ? { findings: [], sourceInsights: [] } : parseTriageResult(triageResult.rawResponse);
      const automaticTelegramFindings = digestOnly ? [] : telegramFindingsFromHeuristics(preparedRawEvents.telegram ?? []);
      const findings = digestOnly
        ? automaticYouTubeFindings
        : sortFindings(enrichFindingsFromEvents(dedupeFindingsBySourceMessage([
            ...automaticYouTubeFindings,
            ...automaticTelegramFindings,
            ...normalizeFindingSourceIds(parsed.findings, preparedRawEvents)
          ]), preparedRawEvents));
      const sourceInsights = digestOnly
        ? []
        : normalizeSourceInsights(parsed.sourceInsights.length ? parsed.sourceInsights : triageResult.sourceInsights, completedAt);
      const result: ScanResult = {
        id: scanId,
        startedAt,
        completedAt,
        durationMs: scanDurationMs(startedAt, completedAt),
        status: "completed",
        accountsScanned: accountMessages.length + connectorScan.connectionsScanned,
        messagesFound,
        messagesScanned,
        messagesSkipped,
        accountSummaries,
        sourceSummaries,
        sourceInsights,
        accountErrors,
        findings,
        digestCards,
        rawResponse: JSON.stringify(digestOnly ? { digestCards, findings } : { findings, sourceInsights }, null, 2),
        scanMetadata: scanMetadataFromPlan(triagePlan, digestOnly ? undefined : triageResult)
      };

      await this.store.addScan(result);
      await this.upsertImportantFindings(result);
      await this.clearScanFailureNotificationMemory();
      await this.markMessagesScanned(preparedRawEvents);
      await this.notifyIfImportant(result);
      return result;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const result: ScanResult = {
        id: crypto.randomUUID(),
        startedAt,
        completedAt,
        durationMs: scanDurationMs(startedAt, completedAt),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        accountsScanned: 0,
        messagesFound: 0,
        messagesScanned: 0,
        messagesSkipped: 0,
        accountErrors: failedAccountErrors,
        findings: []
      };
      this.lastError = result.error ?? null;
      await this.store.addScan(result);
      await this.notifyIfFailed(result);
      return result;
    } finally {
      this.isScanning = false;
      this.clearScanProgress();
      await this.scheduleNextScan();
      await this.emit();
    }
  }

  async getState(): Promise<AppState> {
    const sourceConnections = "listSourceConnections" in this.store
      ? await this.store.listSourceConnections()
      : [];
    const connectorHealth = "listConnectorHealth" in this.store
      ? await this.store.listConnectorHealth()
      : [];
    const legacyLocalGmailAccounts = await this.connectorRegistry?.getLegacyLocalGmailAccounts() ?? [];
    return {
      settings: await this.store.getSettings(),
      accounts: await this.store.getAccounts(),
      sourceConnections,
      connectorHealth,
      legacyLocalGmailAccounts,
      nativeConfiguredSources: this.nativeConfiguredSources,
      telegramChats: await this.store.getTelegramChats(),
      telegramConnected: await this.telegram.isConnected?.() ?? false,
      codexReady: this.codexReady,
      codexStatus: this.codexStatus,
      isScanning: this.isScanning,
      scanProgress: this.scanProgress,
      nextScanAt: this.nextScanAt,
      lastScan: stateScan(await this.store.getLastScan()),
      lastCompletedScan: stateScan(await this.store.getLastCompletedScan()),
      recentScans: (await this.store.getRecentScans(50)).map((scan) => stateScan(scan) as ScanResult),
      importantItems: await this.getImportantItems(),
      dismissedSourceInsightIds: await this.store.getDismissedSourceInsightIds(),
      dismissedDigestCardIds: await this.store.getDismissedDigestCardIds(),
      lastError: this.lastError
    };
  }

  async retryCodex(): Promise<AppState> {
    await this.initializeCodex();
    await this.scheduleNextScan();
    await this.emit();
    return this.getState();
  }

  async startCodexSignIn(): Promise<CodexLoginStartResult> {
    const result = await this.codex.startChatGptLogin();
    this.codexReady = false;
    this.codexStatus = classifyCodexReadinessError(new Error("Codex is not signed in."));
    this.lastError = null;
    await this.scheduleNextScan();
    await this.emit();
    return result;
  }

  async logoutCodex(): Promise<AppState> {
    await this.codex.logoutAccount();
    await this.markCodexSignedOut();
    return this.getState();
  }

  async markCodexSignedOut(): Promise<void> {
    this.codexReady = false;
    this.codexStatus = classifyCodexReadinessError(new Error("Codex is not signed in."));
    this.lastError = "Codex is not signed in.";
    await this.scheduleNextScan();
    await this.emit();
  }

  async runSetupCheck(): Promise<SetupCheckResult> {
    await this.initializeCodex();

    const checks: SetupCheckItem[] = [
      {
        id: "codex",
        label: "Codex",
        status: this.codexReady ? "ready" : "error",
        detail: this.codexReady ? "Signed in and app-server reachable" : this.codexStatus.detail
      }
    ];
    const settings = await this.store.getSettings();
    if (this.connectorRegistry) {
      checks.push(await this.sourcesCheck());
    } else {
      const accounts = await this.store.getAccounts();
      const gmailCredentials = await this.gmailCredentialsCheck(settings);
      checks.push(gmailCredentials, await this.inboxesCheck(settings, accounts, gmailCredentials.status === "ready"));
    }
    checks.push(launchAtLoginCheck(settings));

    await this.scheduleNextScan();
    checks.push({
      id: "schedule",
      label: "Schedule",
      status: this.nextScanAt ? "ready" : "missing",
      detail: this.nextScanAt ? `Next scan ${this.nextScanAt}` : "Hourly scan is not scheduled yet"
    });

    const result = {
      checkedAt: this.now().toISOString(),
      ready: checks.every((check) => check.status === "ready"),
      checks
    };

    await this.emit();
    return result;
  }

  async scanIfDue(): Promise<ScanResult | null> {
    if (this.isScanning) return null;

    if (!(await this.hasAnySourceSetup())) {
      await this.scheduleNextScan();
      return null;
    }

    if (!this.nextScanAt) {
      await this.scheduleNextScan();
      return null;
    }

    const nextScanMs = new Date(this.nextScanAt).getTime();
    if (Number.isNaN(nextScanMs) || nextScanMs > this.now().getTime()) return null;

    return this.scanNow();
  }

  async scanWhenReady(): Promise<ScanResult | null> {
    if (this.isScanning) return null;
    if (!(await this.isReadyToScanNow())) return null;

    return this.scanNow();
  }

  onChange(listener: ScanListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async scheduleNextScan(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    if (!(await this.hasAnySourceSetup())) {
      this.nextScanAt = null;
      await this.emit();
      return;
    }

    const settings = await this.store.getSettings();
    const intervalMs = settings.scanIntervalMinutes * 60 * 1000;
    const nextScanMs = await this.nextScanTimeMs(intervalMs);
    const delayMs = Math.max(0, nextScanMs - this.now().getTime());
    this.nextScanAt = new Date(nextScanMs).toISOString();
    this.timer = setTimeout(() => {
      void this.scanNow().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }, delayMs);
    await this.emit();
  }

  private async nextScanTimeMs(intervalMs: number): Promise<number> {
    const nowMs = this.now().getTime();
    const lastCompletedScan = await this.store.getLastCompletedScan();
    const completedMs = lastCompletedScan?.completedAt ? new Date(lastCompletedScan.completedAt).getTime() : Number.NaN;
    const cadenceMs = completedMs + intervalMs;

    if (!Number.isNaN(cadenceMs) && cadenceMs > nowMs) return cadenceMs;
    return nowMs + intervalMs;
  }

  private async fetchAllAccounts(credentialsPath: string, since: string): Promise<{ accountMessages: GmailAccountMessages[]; accountErrors: AccountScanError[] }> {
    const accounts = await this.store.getAccounts();
    const results = await Promise.all(
      accounts.map(async (account) => {
        try {
          const messages = await this.gmail.fetchRecentMessages(account, credentialsPath, undefined, since);
          return { account, messages };
        } catch (error) {
          return {
            account,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );

    return {
      accountMessages: results
        .filter((result): result is GmailAccountMessages => "messages" in result)
        .map(({ account, messages }) => ({ account, messages })),
      accountErrors: results
        .filter((result): result is { account: GmailAccount; error: string } => "error" in result)
        .map(({ account, error }) => ({ accountEmail: account.email, error }))
    };
  }

  private async scanWindowStart(): Promise<string> {
    const maxLookbackStart = new Date(this.now().getTime() - MAX_SCAN_LOOKBACK_MS);
    const lastCompletedScan = await this.store.getLastCompletedScan();
    const lastCompletedAt = lastCompletedScan?.completedAt ? new Date(lastCompletedScan.completedAt) : null;
    if (!lastCompletedAt || Number.isNaN(lastCompletedAt.getTime())) return maxLookbackStart.toISOString();
    return (lastCompletedAt > maxLookbackStart ? lastCompletedAt : maxLookbackStart).toISOString();
  }

  private async isReadyToScanNow(): Promise<boolean> {
    return this.codexReady && (await this.hasAnySourceSetup());
  }

  private async hasAnySourceSetup(): Promise<boolean> {
    if (this.connectorRegistry) {
      return (await this.connectorRegistry.listEnabledConnections()).length > 0;
    }

    const settings = await this.store.getSettings();
    const accounts = await this.store.getAccounts();
    const telegramChats = await this.store.getTelegramChats();
    return (await this.canScanGmail(settings, accounts)) || (await this.canScanTelegram(settings, telegramChats));
  }

  private async hasGmailSetup(): Promise<boolean> {
    const settings = await this.store.getSettings();
    const accounts = await this.store.getAccounts();
    if (!settings.gmailCredentialsPath || !accounts.length) return false;

    try {
      await this.ensureGmailCredentials(settings.gmailCredentialsPath);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private async canScanGmail(settings: AppSettings, accounts: GmailAccount[]): Promise<boolean> {
    if (!settings.gmailCredentialsPath || !accounts.length) return false;

    try {
      await this.ensureGmailCredentials(settings.gmailCredentialsPath);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private async canScanTelegram(settings: AppSettings, chats: TelegramChat[]): Promise<boolean> {
    if (!hasTelegramSelection(settings, chats)) return false;
    if (settings.telegramExportPath) return true;
    return await this.telegram.isConnected?.() ?? false;
  }

  private async sourcesCheck(): Promise<SetupCheckItem> {
    const targets = await this.connectorRegistry?.listEnabledConnections() ?? [];
    if (!targets.length) {
      const configured = [...new Set([
        ...(this.nativeConfiguredSources ?? [])
      ])];
      const configuredText = configured.length
        ? `Configured: ${configured.map(sourceDisplayName).join(", ")}.`
        : "No source services are configured.";
      return {
        id: "sources",
        label: "Sources",
        status: "missing",
        detail: `${configuredText} Connect Gmail, X/Twitter, YouTube, or Telegram.`
      };
    }

    const bySource = new Map<string, number>();
    for (const { connection } of targets) {
      bySource.set(connection.source, (bySource.get(connection.source) ?? 0) + 1);
    }
    const detail = [...bySource.entries()]
      .map(([source, count]) => `${count} ${source}`)
      .join(", ");
    return {
      id: "sources",
      label: "Sources",
      status: "ready",
      detail
    };
  }

  private async gmailCredentialsCheck(settings: AppSettings): Promise<SetupCheckItem> {
    if (!settings.gmailCredentialsPath) {
      return {
        id: "gmailCredentials",
        label: "Gmail OAuth",
        status: "missing",
        detail: "Choose a Google OAuth desktop credentials.json file"
      };
    }

    try {
      await this.ensureGmailCredentials(settings.gmailCredentialsPath);
      return {
        id: "gmailCredentials",
        label: "Gmail OAuth",
        status: "ready",
        detail: "Desktop credentials file is valid"
      };
    } catch (error) {
      return {
        id: "gmailCredentials",
        label: "Gmail OAuth",
        status: "error",
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async inboxesCheck(settings: AppSettings, accounts: GmailAccount[], canFetch: boolean): Promise<SetupCheckItem> {
    if (!accounts.length) {
      return {
        id: "inboxes",
        label: "Inboxes",
        status: "missing",
        detail: "Connect at least one Gmail inbox"
      };
    }

    if (!canFetch || !settings.gmailCredentialsPath) {
      return {
        id: "inboxes",
        label: "Inboxes",
        status: "missing",
        detail: `${accounts.length} connected; choose valid credentials to verify access`
      };
    }

    const results = await Promise.all(
      accounts.map(async (account) => {
        try {
          await this.gmail.fetchRecentMessages(account, settings.gmailCredentialsPath as string, 1);
          return { account };
        } catch (error) {
          return {
            account,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
    const failures = results.filter((result): result is { account: GmailAccount; error: string } => "error" in result);
    if (failures.length) {
      const first = failures[0];
      return {
        id: "inboxes",
        label: "Inboxes",
        status: "error",
        detail: `${accounts.length - failures.length}/${accounts.length} reachable; ${first.account.email}: ${first.error}`
      };
    }

    return {
      id: "inboxes",
      label: "Inboxes",
      status: "ready",
      detail: `${accounts.length} Gmail inbox${accounts.length === 1 ? "" : "es"} reachable`
    };
  }

  private async ensureGmailCredentials(credentialsPath: string): Promise<void> {
    try {
      await validateCredentialsFile(credentialsPath);
    } catch (error) {
      throw new Error(`Gmail credentials are unavailable. Choose the Google OAuth credentials.json file again. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async ensureCodexReady(): Promise<void> {
    if (this.codexReady) return;

    await this.initializeCodex();
  }

  private async initializeCodex(): Promise<void> {
    try {
      await this.codex.initialize();
      this.codexReady = true;
      this.codexStatus = CODEX_READY_STATUS;
      this.lastError = null;
    } catch (error) {
      if (isAlreadyInitializedError(error)) {
        this.codexReady = true;
        this.codexStatus = CODEX_READY_STATUS;
        this.lastError = null;
        return;
      }
      this.codexReady = false;
      this.codexStatus = classifyCodexReadinessError(error);
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async runCodexTriage(rawEvents: RawEvents): Promise<string> {
    try {
      return await this.codex.triage(rawEvents);
    } catch (error) {
      this.codexReady = false;
      this.codexStatus = classifyCodexReadinessError(error);
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async runPlannedTriage(groups: EventGroup[], plan: ScanPlan, rawEvents: RawEvents): Promise<PlannedTriageResult> {
    if (plan.route === "default") {
      return {
        rawResponse: await this.runCodexTriageGroups(plan.batches[0] ?? groups, rawEvents),
        intermediateSummaries: [],
        candidateFindings: [],
        sourceInsights: []
      };
    }

    const batchResults: Array<{
      batch: number;
      groupsProcessed: number;
      rawResponse: string;
      candidateFindings: ScanFinding[];
      sourceInsights: SourceInsight[];
    }> = [];

    for (const [index, batch] of plan.batches.entries()) {
      const rawResponse = await this.runCodexTriageGroups(batch);
      const parsed = parseTriageResult(rawResponse);
      batchResults.push({
        batch: index + 1,
        groupsProcessed: batch.length,
        rawResponse,
        candidateFindings: parsed.findings,
        sourceInsights: parsed.sourceInsights
      });
    }

    const rawResponse = await this.runCodexSynthesis(batchResults);
    return {
      rawResponse,
      intermediateSummaries: batchResults.map((result) => result.rawResponse),
      candidateFindings: batchResults.flatMap((result) => result.candidateFindings),
      sourceInsights: batchResults.flatMap((result) => result.sourceInsights)
    };
  }

  private async runCodexTriageGroups(groups: EventGroup[], fallbackRawEvents?: RawEvents): Promise<string> {
    const codex = this.codex as GroupAwareCodexClient;
    return this.runCodexOperation(async () => {
      if (typeof codex.triageGroups === "function") return codex.triageGroups(groups);
      return codex.triage(fallbackRawEvents ?? rawEventsFromGroups(groups));
    });
  }

  private async runCodexSynthesis(batchResults: unknown[]): Promise<string> {
    const codex = this.codex as GroupAwareCodexClient;
    return this.runCodexOperation(async () => {
      if (typeof codex.synthesizeBatchResults === "function") return codex.synthesizeBatchResults(batchResults);
      return JSON.stringify({
        findings: batchResults.flatMap((result) =>
          isRecord(result) && Array.isArray(result.candidateFindings) ? result.candidateFindings : []
        ),
        sourceInsights: batchResults.flatMap((result) =>
          isRecord(result) && Array.isArray(result.sourceInsights) ? result.sourceInsights : []
        )
      });
    });
  }

  private async prepareYouTubeEvents(rawEvents: RawEvents, options: { throwOnVideoError?: boolean } = {}): Promise<RawEvents> {
    const youtubeEvents = rawEvents.youtube ?? [];
    if (!youtubeEvents.length) return rawEvents;

    const codex = this.codex as GroupAwareCodexClient;
    if (typeof codex.summarizeYouTubeTranscript !== "function") {
      return {
        ...rawEvents,
        youtube: []
      };
    }

    const summarizable = youtubeEvents.filter((event) => event.transcript?.trim());
    const prepared: NonNullable<RawEvents["youtube"]> = [];
    for (const [index, event] of summarizable.entries()) {
      const transcript = event.transcript?.trim() ?? "";

      await this.setScanProgress(summarizable.length > 1
        ? `Summarizing video ${index + 1}/${summarizable.length}: ${truncateText(event.title, 60)}`
        : `Summarizing: ${truncateText(event.title, 60)}`);
      let youtubeSummary: { summary: string; anchors: YouTubeSummaryAnchor[] };
      try {
        youtubeSummary = normalizeYouTubeTranscriptSummary(
          await this.runCodexOperation(() => codex.summarizeYouTubeTranscript?.(event) ?? Promise.resolve(""))
        );
      } catch (error) {
        // One bad video must not fail the whole scan. It is not marked scanned,
        // so the next run retries it. The explicit single-video path opts into
        // throwing to keep its existing-summary fallback and error surfacing.
        if (options.throwOnVideoError) throw error;
        console.warn("[scan] youtube summary failed; skipping video", {
          videoId: event.id,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      if (!youtubeSummary.summary.trim()) continue;
      const youtubeAnchors = youtubeSummary.anchors.length
        ? youtubeSummary.anchors
        : deriveYouTubeAnchorsFromSummary(youtubeSummary.summary, event);

      prepared.push({
        ...event,
        episodeSummary: youtubeSummary.summary.trim(),
        youtubeAnchors,
        body: buildYouTubeSummaryBody(event, youtubeSummary.summary.trim()),
        transcript: "",
        transcriptCues: [],
        transcriptCharCount: event.transcriptCharCount ?? transcript.length
      });
    }

    return {
      ...rawEvents,
      youtube: prepared
    };
  }

  private async prepareYouTubeEventsWithExistingSummaryFallback(rawEvents: RawEvents): Promise<RawEvents> {
    try {
      return await this.prepareYouTubeEvents(rawEvents, { throwOnVideoError: true });
    } catch (error) {
      const event = rawEvents.youtube?.[0];
      if (!event) throw error;
      const existingSummary = await this.existingYouTubeSummary(event.id);
      if (!existingSummary) throw error;
      const anchors = deriveYouTubeAnchorsFromSummary(existingSummary, event);
      if (!anchors.length) throw error;
      return {
        ...rawEvents,
        youtube: [{
          ...event,
          episodeSummary: existingSummary,
          youtubeAnchors: anchors,
          body: buildYouTubeSummaryBody(event, existingSummary),
          transcript: "",
          transcriptCues: [],
          transcriptCharCount: event.transcriptCharCount ?? event.transcript?.length ?? 0
        }]
      };
    }
  }

  private async existingYouTubeSummary(sourceId: string): Promise<string> {
    const readItems = (this.store as unknown as {
      getImportantItems?: (status?: ImportantItemStatus) => Promise<ImportantItem[]>;
    }).getImportantItems;
    if (!readItems) return "";
    const items = await readItems.call(this.store, "active");
    return items.find((item) => item.source === "youtube" && item.sourceId === sourceId)?.why?.trim() ?? "";
  }

  private async runCodexOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.codexReady = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private async fetchConnectorEvents(
    targets: Awaited<ReturnType<ConnectorRegistry["listEnabledConnections"]>>,
    since: string
  ): Promise<{ rawEvents: RawEvents; connectionsScanned: number; scannedSources: ScanSummarySource[]; sourceHealth: Partial<Record<ScanSummarySource, ConnectorHealth>> }> {
    const youtubeTargets = targets.filter(({ connection }) => connection.source === "youtube");
    const otherTargets = targets.filter(({ connection }) => connection.source !== "youtube");
    console.info("[scan] connector scan plan", {
      totalConnections: targets.length,
      youtubeConnections: youtubeTargets.length,
      otherConnections: otherTargets.length,
      youtubeMode: youtubeTargets.length ? "sequential" : "none",
      youtubeVideoBudget: youtubeTargets.length ? MAX_YOUTUBE_VIDEOS_PER_SCAN : 0
    });

    const scannedSources = new Set<ScanSummarySource>();
    const sourceHealth: Partial<Record<ScanSummarySource, ConnectorHealth>> = {};
    const scanResults: ConnectorScanResult[] = [];

    scanResults.push(...await Promise.all(otherTargets.map((target) => this.scanConnectorTarget(target, since))));
    let youtubeVideosRemaining = MAX_YOUTUBE_VIDEOS_PER_SCAN;
    for (const [index, target] of youtubeTargets.entries()) {
      if (youtubeVideosRemaining <= 0) {
        console.info("[scan] youtube video budget exhausted", {
          remainingConnections: youtubeTargets.length - index,
          maxVideos: MAX_YOUTUBE_VIDEOS_PER_SCAN
        });
        break;
      }
      if (index > 0) await sleep(YOUTUBE_CONNECTOR_SCAN_DELAY_MS);
      const result = await this.scanConnectorTarget(target, since, { maxVideos: youtubeVideosRemaining });
      const usedVideos = result.rawEvents.youtube?.length ?? 0;
      youtubeVideosRemaining = Math.max(0, youtubeVideosRemaining - usedVideos);
      console.info("[scan] youtube video budget", {
        connectionId: target.connection.id,
        usedVideos,
        remainingVideos: youtubeVideosRemaining,
        maxVideos: MAX_YOUTUBE_VIDEOS_PER_SCAN
      });
      scanResults.push(result);
    }

    for (const result of scanResults) {
      if (!isScanSummarySource(result.source)) continue;
      scannedSources.add(result.source);
      sourceHealth[result.source] = mergeSourceHealth(sourceHealth[result.source], result.health);
    }

    return {
      rawEvents: mergeRawEvents(...scanResults.map((result) => result.rawEvents)),
      connectionsScanned: scanResults.length,
      scannedSources: [...scannedSources],
      sourceHealth
    };
  }

  private async scanConnectorTarget(
    { connector, connection }: ConnectorScanTarget,
    since: string,
    options: { maxVideos?: number } = {}
  ): Promise<ConnectorScanResult> {
    const result = await connector.scan(connection, { since, ...options });
    await this.saveConnectorHealth(result.health);
    await this.saveSourceCursors(result.cursors);
    return {
      rawEvents: rawEventsFromSourceEvents(result.events),
      source: connection.source,
      health: result.health
    };
  }

  private async filterAlreadyScannedMessages(rawEvents: RawEvents): Promise<RawEvents> {
    const gmailEvents = rawEvents.gmail ?? [];
    const telegramEvents = rawEvents.telegram ?? [];
    const youtubeEvents = rawEvents.youtube ?? [];
    const twitterEvents = rawEvents.twitter ?? [];
    if (!gmailEvents.length && !telegramEvents.length && !youtubeEvents.length && !twitterEvents.length) return rawEvents;

    const scannedKeys = new Set([
      ...await this.store.getScannedMessageKeys(),
      ...await this.reviewedImportantMessageKeys()
    ]);
    return {
      ...rawEvents,
      gmail: gmailEvents.filter((event) => !scannedKeys.has(gmailMessageKey(event.accountEmail, event.id))),
      telegram: telegramEvents.filter((event) => !scannedKeys.has(sourceMessageKey("telegram", event.id))),
      youtube: youtubeEvents.filter((event) => !scannedKeys.has(sourceMessageKey("youtube", event.id))),
      twitter: twitterEvents.filter((event) => !scannedKeys.has(sourceMessageKey("twitter", event.id)))
    };
  }

  // One digest card per synthesis source (Twitter, Gmail, Telegram) with events
  // this run. Each is a <=5-bullet analyst note. YouTube keeps its own per-video
  // summary path and is not turned into a synthesis card here. Empty sources
  // produce no card.
  private async buildDigestCards(
    rawEvents: RawEvents,
    scanId: string,
    window: { start: string; end: string },
    generatedAt: string
  ): Promise<DigestCard[]> {
    if (typeof this.codex.generateDigest !== "function") return [];
    const sources: Array<{ source: DigestSource; events: DigestPromptEvent[] }> = [
      { source: "twitter", events: (rawEvents.twitter ?? []).map(twitterDigestEvent) },
      { source: "gmail", events: (rawEvents.gmail ?? []).map(gmailDigestEvent) },
      { source: "telegram", events: (rawEvents.telegram ?? []).map(telegramDigestEvent) }
    ];

    const cards: DigestCard[] = [];
    for (const { source, events } of sources) {
      if (!events.length) continue;
      try {
        await this.setScanProgress(`Writing ${sourceDisplayName(source)} briefing (${events.length} item${events.length === 1 ? "" : "s"} read)`);
        const raw = await this.codex.generateDigest(source, events, window);
        const { bullets, skippedSummary } = parseDigestResponse(raw);
        const enrichedBullets = enrichDigestBullets(source, bullets, events);
        if (!enrichedBullets.length) continue; // empty card renders nothing; scan history records the run
        cards.push({
          id: `${scanId}:${source}`,
          scanId,
          source,
          windowStart: window.start,
          windowEnd: window.end,
          fetchedCount: events.length,
          surfacedCount: enrichedBullets.length,
          skippedCount: Math.max(0, events.length - enrichedBullets.length),
          skippedSummary,
          bullets: enrichedBullets,
          generatedAt
        });
      } catch (error) {
        console.warn("[digest] card generation failed", { source, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return cards;
  }

  private hasDigestCardSynthesis(): boolean {
    return typeof (this.codex as GroupAwareCodexClient).generateDigest === "function";
  }

  private async markMessagesScanned(rawEvents: RawEvents): Promise<void> {
    const keys = [
      ...(rawEvents.gmail ?? []).map((event) => gmailMessageKey(event.accountEmail, event.id)),
      ...(rawEvents.telegram ?? []).map((event) => sourceMessageKey("telegram", event.id)),
      ...(rawEvents.youtube ?? []).map((event) => sourceMessageKey("youtube", event.id)),
      ...(rawEvents.twitter ?? []).map((event) => sourceMessageKey("twitter", event.id))
    ];
    if (keys.length) await this.store.addScannedMessageKeys(keys);
  }

  private async reviewedImportantMessageKeys(): Promise<string[]> {
    const readItems = (this.store as unknown as {
      getImportantItems?: (status?: ImportantItemStatus) => Promise<ImportantItem[]>;
    }).getImportantItems;
    if (!readItems) return [];

    const reviewed = [
      ...await readItems.call(this.store, "completed"),
      ...await readItems.call(this.store, "dismissed")
    ];
    return reviewed.flatMap((item) => importantItemMessageKeys(item));
  }

  private async notifyIfImportant(result: ScanResult): Promise<void> {
    const highPriority = result.findings.filter((finding) => finding.priority === "high");
    if (!highPriority.length) return;

    const settings = await this.store.getSettings();
    if (isWithinQuietHours(settings.quietHours, this.now())) return;

    const keys = highPriority.map(notificationKey);
    const newKeys = new Set(await this.store.claimNewNotifiedFindingKeys(keys));
    const newFindings = highPriority.filter((finding) => newKeys.has(notificationKey(finding)));
    if (!newFindings.length) return;

    this.highPriorityNotifier(newFindings);
  }

  private async notifyIfFailed(result: ScanResult): Promise<void> {
    if (result.status !== "failed") return;

    const settings = await this.store.getSettings();
    if (isWithinQuietHours(settings.quietHours, this.now())) return;

    const [key] = await this.store.claimNewNotifiedFindingKeys([scanFailureNotificationKey(result)]);
    if (!key) return;

    this.scanFailureNotifier(result);
  }

  private async clearScanFailureNotificationMemory(): Promise<void> {
    await this.store.clearNotifiedFindingKeysByPrefix(scanFailureNotificationPrefix());
  }

  private async upsertImportantFindings(result: ScanResult): Promise<void> {
    if (!("upsertImportantFindings" in this.store)) return;
    await this.store.upsertImportantFindings(result);
  }

  private async getImportantItems(): Promise<AppState["importantItems"]> {
    if (!("getImportantItems" in this.store)) return [];
    return this.store.getImportantItems();
  }

  private async saveSourceCursors(cursors: SourceCursor[]): Promise<void> {
    if (!cursors.length || !("saveSourceCursors" in this.store)) return;
    await this.store.saveSourceCursors(cursors);
  }

  private async saveConnectorHealth(health: ConnectorHealth): Promise<void> {
    if (!("saveConnectorHealth" in this.store)) return;
    await this.store.saveConnectorHealth(health);
  }

  private async clearYouTubeVideoScanMemory(connectionId: string, videoId: string | undefined): Promise<void> {
    const store = this.store as unknown as {
      clearSourceCursors?: (connectionId: string) => Promise<void>;
      clearScannedMessageKeys?: (keys: string[]) => Promise<void>;
    };
    await store.clearSourceCursors?.(connectionId);
    if (!videoId) return;
    await store.clearScannedMessageKeys?.([
      sourceMessageKey("youtube", `youtube:${videoId}`),
      sourceMessageKey("youtube", videoId)
    ]);
  }

  // Long scans (transcript summaries, briefing writes) used to sit behind a
  // static "Scanning..." for minutes. Each checkpoint pushes a fresh label so
  // the UI can show the agent's actual current step.
  private async setScanProgress(label: string): Promise<void> {
    this.scanProgress = {
      label,
      startedAt: this.scanProgress?.startedAt ?? new Date().toISOString()
    };
    await this.emit();
  }

  private clearScanProgress(): void {
    this.scanProgress = null;
  }

  private async emit(): Promise<void> {
    const state = await this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

// State sent over IPC on every emit. rawResponse and scanMetadata (intermediate
// summaries, candidate findings) are debug payloads that can run to megabytes
// across 50 scans; the renderer never reads them. They stay in the database.
function stateScan(scan: ScanResult | null): ScanResult | null {
  if (!scan) return null;
  const { rawResponse: _rawResponse, scanMetadata: _scanMetadata, ...rest } = scan;
  return rest;
}

function sourceDisplayName(source: string): string {
  switch (source) {
    case "gmail":
      return "Gmail";
    case "telegram":
      return "Telegram";
    case "twitter":
      return "X / Twitter";
    default:
      return source;
  }
}

function scanMetadataFromPlan(plan: ScanPlan, triageResult?: PlannedTriageResult): NonNullable<ScanResult["scanMetadata"]> {
  return {
    route: plan.route,
    rawEventCount: plan.rawEventCount,
    groupCount: plan.groupCount,
    processedGroupCount: plan.groupCount,
    skippedGroupCount: 0,
    estimatedTokens: plan.estimatedTokens,
    batchCount: plan.batches.length,
    oversizedGroupCount: plan.oversizedGroupCount,
    intermediateSummaries: triageResult?.intermediateSummaries.length ? triageResult.intermediateSummaries : undefined,
    candidateFindings: triageResult?.candidateFindings.length ? triageResult.candidateFindings : undefined,
    evidenceSnippets: triageResult?.candidateFindings
      .map((finding) => finding.evidence)
      .filter((evidence) => evidence.trim())
      .slice(0, 20)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function notificationKey(finding: ScanFinding): string {
  return `${finding.source}:${normalizedAccountEmail(finding.accountEmail)}:${finding.sourceId}`;
}

function scanFailureNotificationKey(result: ScanResult): string {
  return `${scanFailureNotificationPrefix()}${result.error ?? "unknown"}`;
}

function scanFailureNotificationPrefix(): string {
  return "scan-failure:";
}

function gmailMessageKey(accountEmail: string | undefined, messageId: string): string {
  return `gmail:${normalizedAccountEmail(accountEmail)}:${messageId}`;
}

function sourceMessageKey(source: "telegram" | "youtube" | "twitter", messageId: string): string {
  if (source === "youtube") return `${source}:summary-v2:${messageId}`;
  return `${source}:${messageId}`;
}

function twitterDigestEvent(event: NonNullable<RawEvents["twitter"]>[number]): DigestPromptEvent {
  return {
    id: event.id,
    text: event.body,
    author: event.username ? `@${event.username}` : event.actor,
    url: event.url,
    receivedAt: event.receivedAt,
    metrics: event.publicMetrics
  };
}

function gmailDigestEvent(event: NonNullable<RawEvents["gmail"]>[number]): DigestPromptEvent {
  return {
    id: event.id,
    text: [event.subject, event.snippet ?? event.body].filter(Boolean).join(" — "),
    author: event.from,
    recipient: event.accountEmail,
    url: event.sourceUrl,
    receivedAt: event.receivedAt
  };
}

function telegramDigestEvent(event: NonNullable<RawEvents["telegram"]>[number]): DigestPromptEvent {
  return {
    id: event.id,
    text: event.text,
    author: event.chat ? `${event.chat} · ${event.sender}` : event.sender,
    url: event.sourceUrl,
    receivedAt: event.sentAt
  };
}

function enrichDigestBullets(source: DigestSource, bullets: DigestCard["bullets"], events: DigestPromptEvent[]): DigestCard["bullets"] {
  if (source !== "gmail") return bullets;
  return bullets.map((bullet) => {
    const event = matchDigestEvent(bullet.sourceUrl, events);
    if (!event) return bullet;
    return {
      ...bullet,
      attribution: bullet.attribution || event.author,
      recipient: bullet.recipient || event.recipient,
      timestamp: bullet.timestamp || event.receivedAt,
      sourceUrl: bullet.sourceUrl || event.url
    };
  });
}

function matchDigestEvent(sourceUrl: string | undefined, events: DigestPromptEvent[]): DigestPromptEvent | undefined {
  if (sourceUrl) {
    const normalizedUrl = normalizeDigestUrl(sourceUrl);
    const match = events.find((event) => event.url && normalizeDigestUrl(event.url) === normalizedUrl);
    if (match) return match;
  }
  return events.length === 1 ? events[0] : undefined;
}

function normalizeDigestUrl(value: string): string {
  return String(value).trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function importantItemMessageKeys(item: ImportantItem): string[] {
  if (item.source === "gmail") return [gmailMessageKey(item.accountEmail, item.sourceId)];
  if (item.source === "telegram" || item.source === "youtube" || item.source === "twitter") {
    const keys = [sourceMessageKey(item.source, item.sourceId)];
    const prefix = `${item.source}:`;
    if (item.sourceId.startsWith(prefix)) {
      keys.push(sourceMessageKey(item.source, item.sourceId.slice(prefix.length)));
    }
    return keys;
  }
  return [];
}

function normalizedAccountEmail(accountEmail: string | undefined): string {
  return (accountEmail ?? "unknown").toLowerCase();
}

function stringConfigValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function launchAtLoginCheck(settings: AppSettings): SetupCheckItem {
  if (settings.launchAtLogin) {
    return {
      id: "launchAtLogin",
      label: "Launch at login",
      status: "ready",
      detail: "Enabled; hourly scans resume after reboot"
    };
  }

  return {
    id: "launchAtLogin",
    label: "Launch at login",
    status: "missing",
    detail: "Enable launch at login so hourly scans resume after reboot"
  };
}

function defaultHighPriorityNotifier(findings: ScanFinding[]): void {
  void import("electron").then(({ Notification }) => {
    if (typeof Notification !== "function") return;
    new Notification(formatHighPriorityNotification(findings)).show();
  });
}

function defaultScanFailureNotifier(result: ScanResult): void {
  void import("electron").then(({ Notification }) => {
    if (typeof Notification !== "function") return;
    new Notification(formatScanFailureNotification(result)).show();
  });
}

export function formatHighPriorityNotification(findings: ScanFinding[]): { title: string; body: string } {
  const count = findings.length;
  const topFinding = findings[0];
  return {
    title: "wdim",
    body: topFinding
      ? `${count} important item${count === 1 ? "" : "s"} found. Top: ${topFinding.title}`
      : `${count} important item${count === 1 ? "" : "s"} found.`
  };
}

export function formatScanFailureNotification(result: ScanResult): { title: string; body: string } {
  return {
    title: "wdim scan failed",
    body: truncateNotificationBody(scanFailureNotificationBody(result))
  };
}

function scanFailureNotificationBody(result: ScanResult): string {
  const accountErrors = result.accountErrors ?? [];
  if (accountErrors.length) {
    const first = accountErrors[0];
    const inboxText = `${accountErrors.length} Gmail inbox${accountErrors.length === 1 ? "" : "es"} failed`;
    return first
      ? `${inboxText}. Reconnect ${first.accountEmail}: ${first.error}`
      : `${inboxText}. Open the app to reconnect Gmail.`;
  }

  return result.error || "Open the app to reconnect Gmail or retry Codex.";
}

export function isWithinQuietHours(quietHours: AppSettings["quietHours"], date: Date): boolean {
  if (!quietHours.enabled) return false;

  const start = parseClockMinutes(quietHours.start);
  const end = parseClockMinutes(quietHours.end);
  if (start === null || end === null || start === end) return false;

  const current = date.getHours() * 60 + date.getMinutes();
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function truncateNotificationBody(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 137)}...`;
}

function parseClockMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

function flattenAccountMessages(accountMessages: GmailAccountMessages[]): RawEvents {
  return {
    gmail: accountMessages.flatMap(({ account, messages }) =>
      messages.map((message) => ({
        ...message,
        accountEmail: account.email
      }))
    ),
    telegram: [],
    youtube: [],
    twitter: []
  };
}

function mergeRawEvents(...eventGroups: RawEvents[]): RawEvents {
  return {
    gmail: eventGroups.flatMap((events) => events.gmail ?? []),
    telegram: eventGroups.flatMap((events) => events.telegram ?? []),
    youtube: eventGroups.flatMap((events) => events.youtube ?? []),
    twitter: eventGroups.flatMap((events) => events.twitter ?? [])
  };
}

function rawEventsFromSourceEvents(events: SourceEvent[]): RawEvents {
  return {
    gmail: events.flatMap((event) => event.source === "gmail" ? [event] : []),
    telegram: events.flatMap((event) => event.source === "telegram" ? [event] : []),
    youtube: events.flatMap((event) => event.source === "youtube" ? [{
      id: event.id,
      title: event.title,
      body: event.body,
      actor: event.actor,
      url: event.url,
      receivedAt: event.receivedAt,
      channel: event.channel,
      channelUrl: event.channelUrl,
      duration: event.duration,
      viewCount: event.viewCount,
      transcript: event.transcript,
      transcriptCues: event.transcriptCues,
      transcriptCharCount: event.transcriptCharCount,
      transcriptSource: event.transcriptSource,
      episodeSummary: event.episodeSummary,
      youtubeAnchors: event.youtubeAnchors
    }] : []),
    twitter: events.flatMap((event) => event.source === "twitter" ? [{
      id: event.id,
      title: event.title,
      body: event.body,
      actor: event.actor,
      url: event.url,
      receivedAt: event.receivedAt,
      authorId: typeof event.metadata?.authorId === "string" ? event.metadata.authorId : undefined,
      username: typeof event.metadata?.username === "string" ? event.metadata.username : undefined,
      displayName: typeof event.metadata?.displayName === "string" ? event.metadata.displayName : undefined,
      conversationId: typeof event.metadata?.conversationId === "string" ? event.metadata.conversationId : undefined,
      publicMetrics: isRecord(event.metadata?.publicMetrics) ? numberMetadata(event.metadata.publicMetrics) : undefined,
      referencedTweets: Array.isArray(event.metadata?.referencedTweets)
        ? event.metadata.referencedTweets.filter(isTwitterReference)
        : undefined
    }] : [])
  };
}

function sourceEventKind<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

function buildYouTubeSummaryBody(event: NonNullable<RawEvents["youtube"]>[number], episodeSummary: string): string {
  const transcriptDetail = event.transcriptCharCount
    ? `Transcript: ${event.transcriptSource ?? "unknown"} captions, ${event.transcriptCharCount.toLocaleString()} cleaned characters processed.`
    : `Transcript: ${event.transcriptSource ?? "unknown"}.`;
  return [
    episodeSummary ? `Episode summary:\n${episodeSummary}` : "",
    transcriptDetail,
    event.body && !event.body.includes("Transcript:") ? event.body : ""
  ].filter(Boolean).join("\n\n");
}

function withoutYouTubeEvents(rawEvents: RawEvents): RawEvents {
  return {
    ...rawEvents,
    youtube: []
  };
}

function emptyPlannedTriageResult(findings: ScanFinding[] = []): PlannedTriageResult {
  return {
    rawResponse: JSON.stringify({ findings: [], sourceInsights: [] }, null, 2),
    intermediateSummaries: [],
    candidateFindings: findings,
    sourceInsights: []
  };
}

function youtubeFindingsFromEvents(events: NonNullable<RawEvents["youtube"]>): ScanFinding[] {
  return events.flatMap((event) => {
    const summary = event.episodeSummary?.trim();
    if (!summary) return [];
    const transcriptEvidence = event.transcriptCharCount
      ? `Transcript: ${event.transcriptSource ?? "unknown"} captions, ${event.transcriptCharCount.toLocaleString()} cleaned characters processed.`
      : `Transcript: ${event.transcriptSource ?? "unknown"}.`;
    return [{
      priority: "low",
      source: "youtube",
      sourceId: event.id,
      accountEmail: event.channel ? `YouTube · ${event.channel}` : "YouTube",
      title: event.title,
      why: summary,
      suggestedAction: "",
      evidence: [
        transcriptEvidence,
        typeof event.viewCount === "number" ? `Views: ${event.viewCount.toLocaleString()}` : "",
        typeof event.duration === "number" ? `Duration: ${formatDuration(event.duration)}` : "",
        event.url ? `URL: ${event.url}` : ""
      ].filter(Boolean).join("\n"),
      sourceUrl: event.url,
      receivedAt: event.receivedAt,
      sourceKind: "youtube_video",
      sourceMetrics: {
        ...(typeof event.viewCount === "number" ? { view_count: event.viewCount } : {}),
        ...(typeof event.duration === "number" ? { duration_seconds: event.duration } : {})
      },
      youtubeAnchors: event.youtubeAnchors
    }];
  });
}

function normalizeYouTubeTranscriptSummary(value: string | YouTubeTranscriptSummary): { summary: string; anchors: YouTubeSummaryAnchor[] } {
  if (typeof value === "string") return { summary: value, anchors: [] };
  return {
    summary: value.summary,
    anchors: Array.isArray(value.anchors) ? value.anchors : []
  };
}

function telegramFindingsFromHeuristics(events: NonNullable<RawEvents["telegram"]>): ScanFinding[] {
  return events.flatMap((event) => {
    const triggers = telegramActionTriggers(event);
    if (!triggers.length) return [];

    const sender = event.sender?.trim() || "Someone";
    const chat = event.chat?.trim() || "Telegram";
    return [{
      priority: telegramTriggerPriority(triggers),
      source: "telegram",
      sourceId: event.id,
      accountEmail: `Telegram · ${chat}`,
      title: telegramHeuristicTitle(sender, triggers),
      why: `${sender} sent a Telegram message that looks actionable: ${triggers.join(", ")}.`,
      suggestedAction: "Review the message and respond if it needs follow-up.",
      evidence: truncateText(event.text, 600),
      sourceUrl: event.sourceUrl,
      receivedAt: event.sentAt,
      sourceKind: "telegram_action"
    }];
  });
}

function telegramActionTriggers(event: NonNullable<RawEvents["telegram"]>[number]): string[] {
  const text = event.text.toLowerCase();
  const triggers: string[] = [];
  if (event.mentionedMe || /@\w+/.test(event.text)) triggers.push("mention");
  if (/\bcalendly\.com\b/.test(text)) triggers.push("calendar link");
  if (/\bdemo\b/.test(text) || /\bdemo\.[\w.-]+\b/.test(text)) triggers.push("demo link");
  if (/\bdocs?\.[\w.-]+\b/.test(text) || /\/docs?\b/.test(text)) triggers.push("docs link");
  if (/\b(?:jump|hop|get)\s+on\s+(?:a\s+)?call\b/.test(text)) triggers.push("call request");
  if (/\bwould love to\b/.test(text)) triggers.push("direct ask");
  if (/\b(?:can|could|would)\s+you\b/.test(text)) triggers.push("direct ask");
  if (/\bplease\s+(?:see|review|check|take a look|confirm|send|share)\b/.test(text)) triggers.push("direct ask");
  if (/\b(?:schedule|book|set up)\s+(?:a\s+)?(?:call|meeting|time)\b/.test(text)) triggers.push("scheduling");
  return [...new Set(triggers)];
}

function telegramTriggerPriority(triggers: string[]): ScanFinding["priority"] {
  return triggers.some((trigger) => trigger === "mention" || trigger === "calendar link" || trigger === "call request")
    ? "high"
    : "medium";
}

function telegramHeuristicTitle(sender: string, triggers: string[]): string {
  if (triggers.includes("calendar link") || triggers.includes("call request")) return `${sender} asked to schedule a call`;
  if (triggers.includes("demo link")) return `${sender} shared a demo`;
  if (triggers.includes("docs link")) return `${sender} shared docs to review`;
  return `${sender} sent an actionable Telegram message`;
}

function truncateText(value: string, maxLength: number): string {
  const text = value.trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function compactYouTubeBody(body: string | undefined): string {
  const match = body?.match(/Episode summary:\s*([\s\S]*?)(?:\n\nTranscript:|$)/);
  return (match?.[1] ?? "").trim();
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanMetadata(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberMetadataValue(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function stringArrayMetadata(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  return items.length ? items : undefined;
}

function numberMetadata(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(numeric)) result[key] = numeric;
  }
  return result;
}

function isTwitterReference(value: unknown): value is { type: string; id: string } {
  if (!isRecord(value)) return false;
  return typeof value.type === "string" && typeof value.id === "string";
}

function eventCount(events: RawEvents): number {
  return (events.gmail?.length ?? 0)
    + (events.telegram?.length ?? 0)
    + (events.youtube?.length ?? 0)
    + (events.twitter?.length ?? 0);
}

function hasTelegramSelection(settings: AppSettings, chats: TelegramChat[]): boolean {
  return settings.telegramIncludeDms || chats.some((chat) => chat.enabled);
}

function filterTelegramMessages(messages: NonNullable<RawEvents["telegram"]>, settings: AppSettings, chats: TelegramChat[]): NonNullable<RawEvents["telegram"]> {
  const enabledChatIds = new Set(chats.filter((chat) => chat.enabled).map((chat) => chat.id));
  return messages.filter((message) => {
    if (message.direct && settings.telegramIncludeDms) return true;
    if (message.direct) return false;
    if (message.chatId && enabledChatIds.has(message.chatId)) return true;
    return enabledChatIds.has(message.chat);
  });
}

function summarizeAccountMessages(accountMessages: GmailAccountMessages[], scannedEvents: RawEvents): AccountScanSummary[] {
  const scannedByAccount = new Map<string, number>();
  for (const event of scannedEvents.gmail ?? []) {
    const key = normalizedAccountEmail(event.accountEmail);
    scannedByAccount.set(key, (scannedByAccount.get(key) ?? 0) + 1);
  }

  return accountMessages.map(({ account, messages }) => {
    const messagesFound = messages.length;
    const messagesScanned = scannedByAccount.get(normalizedAccountEmail(account.email)) ?? 0;
    return {
      accountEmail: account.email,
      messagesFound,
      messagesScanned,
      messagesSkipped: messagesFound - messagesScanned
    };
  });
}

function summarizeSourceMessages(
  foundEvents: RawEvents,
  scannedEvents: RawEvents,
  scannedSources: ScanSummarySource[] = [],
  sourceHealth: Partial<Record<ScanSummarySource, ConnectorHealth>> = {}
): NonNullable<ScanResult["sourceSummaries"]> {
  const scannedSourceSet = new Set(scannedSources);
  return [
    summarizeSourceMessageGroup("gmail", foundEvents.gmail ?? [], scannedEvents.gmail ?? [], sourceHealth.gmail),
    summarizeSourceMessageGroup("telegram", foundEvents.telegram ?? [], scannedEvents.telegram ?? [], sourceHealth.telegram),
    summarizeSourceMessageGroup("youtube", foundEvents.youtube ?? [], scannedEvents.youtube ?? [], sourceHealth.youtube),
    summarizeSourceMessageGroup("twitter", foundEvents.twitter ?? [], scannedEvents.twitter ?? [], sourceHealth.twitter)
  ].filter((summary) => summary.messagesFound > 0 || summary.messagesScanned > 0 || scannedSourceSet.has(summary.source));
}

function isScanSummarySource(source: SourceEvent["source"]): source is ScanSummarySource {
  return source === "gmail" || source === "telegram" || source === "youtube" || source === "twitter";
}

function summarizeSourceMessageGroup(
  source: NonNullable<ScanResult["sourceSummaries"]>[number]["source"],
  found: unknown[],
  scanned: unknown[],
  health?: ConnectorHealth
): NonNullable<ScanResult["sourceSummaries"]>[number] {
  const summary: NonNullable<ScanResult["sourceSummaries"]>[number] = {
    source,
    messagesFound: found.length,
    messagesScanned: scanned.length,
    messagesSkipped: found.length - scanned.length
  };
  if (health?.status && health.status !== "ready") {
    summary.status = health.status;
    summary.detail = health.detail;
  }
  return summary;
}

function mergeSourceHealth(existing: ConnectorHealth | undefined, next: ConnectorHealth): ConnectorHealth {
  if (!existing) return next;
  if (healthSeverity(next.status) > healthSeverity(existing.status)) return next;
  return existing;
}

function healthSeverity(status: ConnectorHealth["status"]): number {
  if (status === "error") return 2;
  if (status === "needs_auth") return 1;
  return 0;
}

function enrichFindingsFromEvents(findings: ScanFinding[], rawEvents: RawEvents): ScanFinding[] {
  const gmailEvents = rawEvents.gmail ?? [];
  const telegramEvents = rawEvents.telegram ?? [];
  const youtubeEvents = rawEvents.youtube ?? [];
  const twitterEvents = rawEvents.twitter ?? [];
  const gmailByKey = new Map(gmailEvents.map((event) => [gmailEventKey(event.accountEmail, event.id), event]));
  const gmailById = new Map<string, (typeof gmailEvents)[number]>();
  const telegramById = new Map(telegramEvents.map((event) => [event.id, event]));
  const youtubeById = new Map(youtubeEvents.map((event) => [event.id, event]));
  const twitterById = new Map(twitterEvents.map((event) => [event.id, event]));

  for (const event of gmailEvents) {
    if (!gmailById.has(event.id)) {
      gmailById.set(event.id, event);
      continue;
    }

    gmailById.delete(event.id);
  }

  return findings.map((finding) => {
    if (finding.source === "telegram") {
      const event = telegramById.get(finding.sourceId);
      if (!event) return finding;

      return {
        ...finding,
        accountEmail: `Telegram · ${event.chat}`,
        sourceUrl: finding.sourceUrl ?? event.sourceUrl,
        receivedAt: finding.receivedAt ?? event.sentAt
      };
    }

    if (finding.source === "youtube") {
      const event = youtubeById.get(finding.sourceId);
      if (!event) return finding;

      return {
        ...finding,
        accountEmail: sourceAccountLabel(finding.accountEmail, event.channel ? `YouTube · ${event.channel}` : "YouTube"),
        sourceUrl: finding.sourceUrl ?? event.url,
        receivedAt: finding.receivedAt ?? event.receivedAt,
        sourceKind: finding.sourceKind ?? "youtube_video",
        sourceMetrics: finding.sourceMetrics ?? {
          ...(typeof event.viewCount === "number" ? { view_count: event.viewCount } : {}),
          ...(typeof event.duration === "number" ? { duration_seconds: event.duration } : {})
        }
      };
    }

    if (finding.source === "twitter") {
      const event = twitterById.get(finding.sourceId);
      if (!event) return finding;

      return {
        ...finding,
        accountEmail: sourceAccountLabel(
          finding.accountEmail,
          event.username ? `X · @${event.username}` : event.actor ? `X · ${event.actor}` : "X / Twitter"
        ),
        sourceUrl: finding.sourceUrl ?? event.url,
        receivedAt: finding.receivedAt ?? event.receivedAt,
        sourceMetrics: finding.sourceMetrics ?? event.publicMetrics
      };
    }

    if (finding.source !== "gmail") return finding;
    const event = gmailByKey.get(gmailEventKey(finding.accountEmail, finding.sourceId)) ?? gmailById.get(finding.sourceId);
    if (!event) return finding;

    return {
      ...finding,
      accountEmail: event.accountEmail ?? finding.accountEmail,
      sourceUrl: finding.sourceUrl ?? event.sourceUrl,
      receivedAt: finding.receivedAt ?? event.receivedAt
    };
  });
}

function normalizeFindingSourceIds(findings: ScanFinding[], rawEvents: RawEvents): ScanFinding[] {
  const eventIds = sourceEventIds(rawEvents);
  return findings.map((finding) => {
    const prefix = `${finding.source}:`;
    if (!finding.sourceId.startsWith(prefix)) return finding;

    const unprefixed = finding.sourceId.slice(prefix.length);
    if (!eventIds.get(finding.source)?.has(unprefixed)) return finding;

    return {
      ...finding,
      sourceId: unprefixed
    };
  });
}

function sourceEventIds(rawEvents: RawEvents): Map<ScanFinding["source"], Set<string>> {
  return new Map<ScanFinding["source"], Set<string>>([
    ["gmail", new Set((rawEvents.gmail ?? []).map((event) => event.id))],
    ["telegram", new Set((rawEvents.telegram ?? []).map((event) => event.id))],
    ["youtube", new Set((rawEvents.youtube ?? []).map((event) => event.id))],
    ["twitter", new Set((rawEvents.twitter ?? []).map((event) => event.id))]
  ]);
}

function sourceAccountLabel(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized && normalized !== "all accounts" && normalized !== fallback.toLowerCase().split(" · ")[0] ? value as string : fallback;
}

function gmailEventKey(accountEmail: string | undefined, id: string): string {
  return `${normalizedAccountEmail(accountEmail)}:${id}`;
}

function sortFindings(findings: ScanFinding[]): ScanFinding[] {
  const priorityRank: Record<ScanFinding["priority"], number> = { high: 0, medium: 1, low: 2 };
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const priorityDelta = priorityRank[a.finding.priority] - priorityRank[b.finding.priority];
      if (priorityDelta !== 0) return priorityDelta;

      const receivedAtDelta = receivedAtMillis(b.finding.receivedAt) - receivedAtMillis(a.finding.receivedAt);
      return receivedAtDelta || a.index - b.index;
    })
    .map(({ finding }) => finding);
}

function dedupeFindingsBySourceMessage(findings: ScanFinding[]): ScanFinding[] {
  const order: string[] = [];
  const byKey = new Map<string, ScanFinding>();
  for (const finding of findings) {
    const key = `${finding.source}:${finding.sourceId}`;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, finding);
  }
  return order.map((key) => byKey.get(key)).filter((finding): finding is ScanFinding => Boolean(finding));
}

function normalizeSourceInsights(insights: SourceInsight[], generatedAt: string): SourceInsight[] {
  return insights
    .filter((insight) => insight.summary.trim())
    .map((insight) => ({
      ...insight,
      generatedAt,
      id: `${insight.source}:${generatedAt}`
    }));
}

function receivedAtMillis(value: string | undefined): number {
  if (!value) return 0;
  const millis = new Date(value).getTime();
  return Number.isNaN(millis) ? 0 : millis;
}

function scanDurationMs(startedAt: string, completedAt: string): number {
  const startedMs = new Date(startedAt).getTime();
  const completedMs = new Date(completedAt).getTime();
  if (Number.isNaN(startedMs) || Number.isNaN(completedMs)) return 0;
  return Math.max(0, completedMs - startedMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyInitializedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\balready initialized\b/i.test(message);
}

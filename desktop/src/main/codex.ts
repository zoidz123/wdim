import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import readline from "node:readline";
import type { EventGroup, RawEvents, YouTubeEvent, YouTubeSummaryAnchor, YouTubeTranscriptCue } from "@what-did-i-miss/shared";
import { buildGroupedTriagePrompt, buildSynthesisPrompt, buildTriagePrompt } from "@what-did-i-miss/shared";
import { buildDigestCardPrompt, type DigestPromptEvent, type DigestSource, type DigestWindow } from "@what-did-i-miss/shared";
import desktopPackage from "../../package.json";
import type { ScanFinding, SourceInsight } from "./types";

type JsonRpcResponse<T = unknown> = {
  id: number;
  result?: T;
  error?: { message: string };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type ThreadStartResponse = {
  thread: {
    id: string;
  };
};

type CodexAccount = {
  type?: string;
  email?: string;
  planType?: string | null;
};

type AccountReadResponse = {
  account: CodexAccount | null;
  requiresOpenaiAuth?: boolean;
};

export type CodexLoginStartResult = {
  type: "chatgpt" | "chatgptDeviceCode";
  loginId?: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
};

const REQUEST_TIMEOUT_MS = 60_000;
const THREAD_START_TIMEOUT_MS = 180_000;
const TURN_TIMEOUT_MS = 120_000;
const YOUTUBE_TRANSCRIPT_CHUNK_CHARS = 35_000;
const YOUTUBE_ANCHOR_PREROLL_SECONDS = 3;
const YOUTUBE_MAX_RANGE_SECONDS = 6 * 60;
export const WDIM_CODEX_MODEL = "gpt-5.5";

export function codexClientInfo(): { name: string; version: string } {
  return {
    name: desktopPackage.name,
    version: desktopPackage.version
  };
}

type SpawnCodexAppServer = (
  cwd: string,
  executablePath?: string | null,
  requireExecutablePath?: boolean,
  env?: NodeJS.ProcessEnv
) => ChildProcessWithoutNullStreams;

export type CodexReadinessState = "ready" | "missing" | "needs_auth" | "error";

export type CodexReadinessStatus = {
  state: CodexReadinessState;
  detail: string;
  command: string | null;
  actionLabel: string | null;
};

export type YouTubeTranscriptSummary = {
  summary: string;
  anchors: YouTubeSummaryAnchor[];
};

export const CODEX_READY_STATUS: CodexReadinessStatus = {
  state: "ready",
  detail: "Codex is installed, signed in, and reachable.",
  command: null,
  actionLabel: null
};

export class CodexAppServerClient {
  private nextId = 1;
  private child: ChildProcessWithoutNullStreams | null = null;
  private processError: Error | null = null;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notifications = new Set<(notification: JsonRpcNotification) => void>();
  private closed = false;
  private transportInitialized = false;

  constructor(
    private readonly cwd: string,
    private readonly spawnAppServer: SpawnCodexAppServer = defaultSpawnCodexAppServer,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly bundledExecutablePath: string | null = null,
    private readonly requireBundledRuntime = false
  ) {}

  async initialize(): Promise<void> {
    await this.initializeTransport();
    await this.ensureChatGptAuthenticated();
  }

  async readAccount(refreshToken = false): Promise<AccountReadResponse> {
    await this.initializeTransport();
    return this.request<AccountReadResponse>("account/read", { refreshToken });
  }

  async startChatGptLogin(): Promise<CodexLoginStartResult> {
    await this.initializeTransport();
    return this.request<CodexLoginStartResult>("account/login/start", { type: "chatgpt" });
  }

  async logoutAccount(): Promise<void> {
    await this.initializeTransport();
    await this.request("account/logout");
  }

  private async initializeTransport(): Promise<void> {
    if (this.transportInitialized) return;
    const simulatedError = simulatedCodexReadinessError(this.env);
    if (simulatedError) throw simulatedError;

    await this.request("initialize", {
        clientInfo: codexClientInfo(),
        capabilities: { experimentalApi: false }
      },
      REQUEST_TIMEOUT_MS,
      "Codex initialize"
    );
    this.notify("initialized");
    this.transportInitialized = true;
  }

  private async ensureChatGptAuthenticated(): Promise<void> {
    const account = await this.readAccount(false);
    if (isChatGptAccount(account.account) || account.requiresOpenaiAuth === false) return;
    throw new Error("Codex is installed but needs ChatGPT sign-in.");
  }

  async triage(events: RawEvents): Promise<string> {
    return this.runPrompt(buildDesktopPrompt(events));
  }

  async triageGroups(groups: EventGroup[]): Promise<string> {
    return this.runPrompt(buildDesktopGroupedPrompt(groups));
  }

  async generateDigest(source: DigestSource, events: DigestPromptEvent[], window: DigestWindow): Promise<string> {
    return this.runPrompt(buildDigestCardPrompt(source, events, window));
  }

  async synthesizeBatchResults(batchResults: unknown[]): Promise<string> {
    return this.runPrompt(buildDesktopSynthesisPrompt(batchResults));
  }

  async summarizeYouTubeTranscript(video: YouTubeEvent): Promise<YouTubeTranscriptSummary> {
    const transcript = video.transcript?.trim() ?? "";
    if (!transcript) return { summary: "", anchors: [] };

    const cueChunks = video.transcriptCues?.length
      ? chunkTranscriptCues(video.transcriptCues, YOUTUBE_TRANSCRIPT_CHUNK_CHARS)
      : [];
    const chunks = cueChunks.length
      ? cueChunks.map((chunk) => formatCueChunk(chunk.cues))
      : chunkText(transcript, YOUTUBE_TRANSCRIPT_CHUNK_CHARS);
    const chunkSummaries: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      chunkSummaries.push(await this.runPrompt(buildYouTubeChunkSummaryPrompt(video, chunk, index + 1, chunks.length)));
    }

    const response = await this.runPrompt(buildYouTubeEpisodeSummaryPrompt(video, chunkSummaries, Boolean(cueChunks.length)));
    if (!cueChunks.length) return { summary: response, anchors: [] };

    return parseYouTubeTranscriptSummary(response, video);
  }

  close(): void {
    this.closed = true;
    this.transportInitialized = false;
    this.child?.kill();
    this.child = null;
  }

  private async runPrompt(prompt: string): Promise<string> {
    let finalText = "";
    const completed = new Promise<void>((resolve, reject) => {
      const unsubscribe = this.onNotification((notification) => {
        if (notification.method === "item/agentMessage/delta") {
          const params = notification.params as { delta?: string; text?: string };
          finalText += params.delta ?? params.text ?? "";
        }

        if (notification.method === "turn/completed") {
          unsubscribe();
          resolve();
        }

        if (notification.method === "error" && !notificationWillRetry(notification.params)) {
          unsubscribe();
          reject(new Error(`Codex App Server error: ${notificationErrorMessage(notification.params)}`));
        }
      });
    });

    const thread = await this.startThreadWithRetry();

    await this.request("turn/start", {
        threadId: thread.thread.id,
        input: [{ type: "text", text: prompt }]
      },
      REQUEST_TIMEOUT_MS,
      "Codex turn start"
    );

    await withTimeout(completed, TURN_TIMEOUT_MS, "Codex triage turn");
    return finalText.trim();
  }

  private async startThreadWithRetry(): Promise<ThreadStartResponse> {
    try {
      return await this.startThread();
    } catch (error) {
      if (!isTimeoutError(error, "Codex thread start")) throw error;
      console.warn("[codex] thread start timed out; restarting app-server and retrying once");
      this.restartProcess(new Error("Codex thread start timed out; restarting app-server."));
      return this.startThread();
    }
  }

  private async startThread(): Promise<ThreadStartResponse> {
    // Re-handshake when the app-server child has exited or been restarted since
    // the last initialize; thread/start against a fresh process fails otherwise.
    await this.initializeTransport();
    return this.request<ThreadStartResponse>("thread/start", {
        cwd: this.cwd,
        approvalPolicy: "never",
        sandbox: "read-only",
        serviceName: "what_did_i_miss_desktop",
        personality: "friendly"
      },
      THREAD_START_TIMEOUT_MS,
      "Codex thread start"
    );
  }

  private onNotification(callback: (notification: JsonRpcNotification) => void): () => void {
    this.notifications.add(callback);
    return () => this.notifications.delete(callback);
  }

  private async request<T>(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS, label = `Codex ${method}`): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server client is closed."));
    const child = this.startProcess();

    const id = this.nextId++;
    let timeout: NodeJS.Timeout | undefined;
    const response = new Promise<T>((resolve, reject) => {
      timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${label} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          if (timeout) clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        }
      });
    });

    try {
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    } catch (error) {
      this.pending.delete(id);
      if (timeout) clearTimeout(timeout);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return response;
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;
    } catch {
      // Non-JSON stdout (warnings, banners) must not crash the main process.
      console.warn("[codex] ignoring non-JSON app-server output", line.slice(0, 200));
      return;
    }

    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }

    for (const callback of this.notifications) callback(message);
  }

  private rejectPending(error: Error): void {
    this.processError = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private restartProcess(error: Error): void {
    const child = this.child;
    this.transportInitialized = false;
    this.child = null;
    this.rejectPending(error);
    child?.kill();
  }

  private startProcess(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    this.processError = null;
    const child = this.spawnAppServer(this.cwd, this.bundledExecutablePath, this.requireBundledRuntime, this.env);
    this.child = child;

    readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      if (process.env.CODEX_APP_SERVER_DEBUG === "1") process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      if (this.child === child) this.child = null;
      this.transportInitialized = false;
      this.rejectPending(codexProcessError(error));
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      this.transportInitialized = false;
      if (!this.closed) this.rejectPending(new Error(`codex app-server exited with code ${code ?? "unknown"}`));
    });

    return child;
  }
}

function defaultSpawnCodexAppServer(cwd: string, executablePath?: string | null, requireExecutablePath = false, env: NodeJS.ProcessEnv = process.env): ChildProcessWithoutNullStreams {
  return spawn(codexExecutablePath(executablePath, requireExecutablePath), codexAppServerArgs(), {
    cwd,
    env: codexCliEnv(env),
    stdio: ["pipe", "pipe", "pipe"]
  });
}

export function codexAppServerArgs(): string[] {
  return [
    "app-server",
    "-c",
    `model=${WDIM_CODEX_MODEL}`,
    "-c",
    "features.memories=false",
    "-c",
    "features.goals=false"
  ];
}

export function codexExecutablePath(bundledPath?: string | null, requireBundledPath = false): string {
  if (bundledPath && (requireBundledPath || existsSync(bundledPath))) return bundledPath;
  return "codex";
}

export function codexProcessError(error: NodeJS.ErrnoException): Error {
  if (error.code === "ENOENT") {
    if (String(error.path ?? "").includes("/codex/darwin-")) {
      return new Error("WDIM's bundled Codex runtime is missing. Reinstall WDIM.");
    }
    return new Error("Codex was not found. Install the Codex app from OpenAI, open it once, and sign in with ChatGPT. WDIM also checks the bundled Codex app runtime and common CLI locations.");
  }

  return new Error(`Failed to start codex app-server: ${error.message}`);
}

export function classifyCodexReadinessError(error: unknown): CodexReadinessStatus {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes("codex was not found") || normalized.includes("codex cli was not found") || normalized.includes("spawn codex enoent")) {
    return {
      state: "missing",
      detail: "WDIM uses your ChatGPT account through the local Codex app. Install Codex to continue.",
      command: "https://openai.com/codex/",
      actionLabel: "Download Codex"
    };
  }

  if (normalized.includes("bundled codex runtime is missing")) {
    return {
      state: "error",
      detail: "WDIM's bundled Codex runtime is missing. Reinstall WDIM.",
      command: null,
      actionLabel: null
    };
  }

  if (
    normalized.includes("not signed in") ||
    normalized.includes("sign in") ||
    normalized.includes("login") ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication")
  ) {
    return {
      state: "needs_auth",
      detail: "Codex is installed but needs ChatGPT sign-in.",
      command: null,
      actionLabel: "Sign in with ChatGPT"
    };
  }

  return {
    state: "error",
    detail: message || "Codex app-server is not reachable.",
    command: null,
    actionLabel: "Sign in with ChatGPT"
  };
}

export function codexCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    PATH: codexCliPath(env)
  };
}

export function codexCliPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir();
  const candidates = [
    env.PATH,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    home ? `${home}/.local/bin` : "",
    home ? `${home}/.cargo/bin` : "",
    home ? `${home}/.bun/bin` : "",
    "/Applications/Codex.app/Contents/Resources",
    "/Applications/Codex.app/Contents/MacOS"
  ];

  return uniquePathEntries(candidates.flatMap((entry) => entry?.split(":") ?? []))
    .join(":");
}

function simulatedCodexReadinessError(env: NodeJS.ProcessEnv): Error | null {
  if (env.WDIM_SIMULATE_CODEX_STATUS === "missing") {
    const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    return codexProcessError(error);
  }

  if (env.WDIM_SIMULATE_CODEX_STATUS === "needs_auth") {
    return new Error("Codex is not signed in.");
  }

  return null;
}

function uniquePathEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  return entries
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
}

function isChatGptAccount(account: CodexAccount | null): boolean {
  return account?.type === "chatgpt" || account?.type === "chatgptAuthTokens";
}

function isTimeoutError(error: unknown, label: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`${label} timed out`);
}

function notificationWillRetry(params: unknown): boolean {
  return isRecord(params) && params.willRetry === true;
}

function notificationErrorMessage(params: unknown): string {
  if (!isRecord(params)) return "unknown error";

  const error = params.error;
  if (isRecord(error)) {
    const message = textValue(error.message, "");
    const details = textValue(error.additionalDetails, "");
    if (message && details) return `${message}: ${details}`;
    if (message) return message;
    if (details) return details;
  }

  return textValue(params.message, "unknown error");
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout;

  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });

  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

export function parseFindings(text: string): ScanFinding[] {
  return parseTriageResult(text).findings;
}

export function parseTriageResult(text: string): { findings: ScanFinding[]; sourceInsights: SourceInsight[] } {
  const findings: ScanFinding[] = [];

  try {
    const parsed = JSON.parse(extractJson(text)) as { findings?: unknown[]; sourceInsights?: unknown[] };
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings.map(sanitizeFinding) : [],
      sourceInsights: Array.isArray(parsed.sourceInsights) ? parsed.sourceInsights.map(sanitizeSourceInsight) : []
    };
  } catch {
    // Fall back to a single rendered finding so the UI still shows the result.
  }

  if (text.trim()) {
    findings.push({
      priority: "medium",
      source: "gmail",
      sourceId: "codex-summary",
      accountEmail: "all accounts",
      title: "Codex triage summary",
      why: text.trim(),
      suggestedAction: "Review the summary.",
      evidence: text.trim()
    });
  }

  return { findings, sourceInsights: [] };
}

function sanitizeFinding(value: unknown): ScanFinding {
  const finding = isRecord(value) ? value : {};
  const sanitized: ScanFinding = {
    priority: sanitizePriority(finding.priority),
    source: sanitizeSource(finding.source),
    sourceId: textValue(finding.sourceId, "codex-summary"),
    accountEmail: textValue(finding.accountEmail, "all accounts"),
    title: textValue(finding.title, "Untitled finding"),
    why: textValue(finding.why, "No rationale provided."),
    suggestedAction: textValue(finding.suggestedAction, "Review the source message."),
    evidence: textValue(finding.evidence, "No evidence provided.")
  };

  if (typeof finding.sourceUrl === "string" && finding.sourceUrl.trim()) sanitized.sourceUrl = finding.sourceUrl;
  if (typeof finding.receivedAt === "string" && finding.receivedAt.trim()) sanitized.receivedAt = finding.receivedAt;

  return sanitized;
}

function sanitizeSourceInsight(value: unknown): SourceInsight {
  const insight = isRecord(value) ? value : {};
  const source = sanitizeSource(insight.source);
  const generatedAt = textValue(insight.generatedAt, new Date().toISOString());
  return {
    id: textValue(insight.id, `${source}:${generatedAt}`),
    source,
    title: truncateWords(textValue(insight.title, `${sourceLabel(source)} summary`), 12),
    summary: truncateWords(textValue(insight.summary, ""), 150),
    generatedAt
  };
}

function sourceLabel(source: ScanFinding["source"]): string {
  switch (source) {
    case "gmail": return "Gmail";
    case "telegram": return "Telegram";
    case "youtube": return "YouTube";
    case "twitter": return "X / Twitter";
  }
}

function truncateWords(value: string, maxWords: number): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? value.trim() : `${words.slice(0, maxWords).join(" ")}...`;
}

function sanitizeSource(value: unknown): ScanFinding["source"] {
  return value === "gmail" || value === "telegram" || value === "youtube" || value === "twitter"
    ? value
    : "gmail";
}

function sanitizePriority(value: unknown): ScanFinding["priority"] {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function textValue(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

function buildDesktopPrompt(events: RawEvents): string {
  return buildDesktopJsonPrompt(buildTriagePrompt(events));
}

function buildDesktopGroupedPrompt(groups: EventGroup[]): string {
  return buildDesktopJsonPrompt(buildGroupedTriagePrompt(groups));
}

function buildDesktopSynthesisPrompt(batchResults: unknown[]): string {
  return buildDesktopJsonPrompt(buildSynthesisPrompt(batchResults));
}

function buildDesktopJsonPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Return JSON only. Use this exact shape:",
    JSON.stringify(
      {
        findings: [
          {
            priority: "high | medium | low",
            source: "gmail | telegram | youtube | twitter",
            sourceId: "message id",
            accountEmail: "gmail account email or readable source label",
            title: "short title",
            why: "why this matters",
            suggestedAction: "concrete next action",
            evidence: "raw source context for the dropdown: include a compact conversation/email excerpt with speaker names and 2-5 relevant adjacent messages or lines when available",
            sourceUrl: "source URL from the source event when available",
            receivedAt: "ISO timestamp if available"
          }
        ],
        sourceInsights: [
          {
            id: "stable id like twitter:2026-06-08T16:00:00.000Z",
            source: "gmail | telegram | youtube | twitter",
            title: "short source summary label",
            summary: "50-90 words explaining the 2-3 most important discovered patterns, insights, similarities, differences, changes, repeated issues, or themes across that source's raw events",
            generatedAt: "ISO timestamp"
          }
        ]
      },
      null,
      2
    ),
    "",
    "Also create `sourceInsights` for each source with meaningful scanned events. Each source insight should synthesize across raw events, not repeat individual finding cards. Prefer 2-3 concrete themes with named repos, chats, accounts, issues, PRs, releases, or topics when available. Keep the summary 50-90 words unless extra context is truly necessary, and never exceed 150 words. Avoid laundry lists, vague labels like 'reliability dominates', and broad cross-source comparisons unless the contrast is directly useful. Omit sourceInsights for sources with no meaningful scanned events."
  ].join("\n");
}

function buildYouTubeChunkSummaryPrompt(video: YouTubeEvent, transcriptChunk: string, chunkIndex: number, chunkCount: number): string {
  return [
    "You summarize podcast/video transcript chunks for What Did I Miss?.",
    "Use only the transcript chunk. Do not use outside knowledge.",
    "Capture specific ideas, claims, disagreements, numbers, examples, and memorable quotes.",
    "When cue ids like [c123 03:49] are present, include the most relevant cue ids inline at the end of each bullet as `cues: c123,c124`.",
    "Do not mention that this is a chunk unless needed for continuity.",
    "Return concise markdown bullets only, 6-10 bullets max.",
    "",
    `Video: ${video.title}`,
    `Channel: ${video.channel ?? "YouTube"}`,
    `Chunk: ${chunkIndex}/${chunkCount}`,
    "",
    "Transcript chunk:",
    transcriptChunk
  ].join("\n");
}

function buildYouTubeEpisodeSummaryPrompt(video: YouTubeEvent, chunkSummaries: string[], includeCueIds = false): string {
  const outputRule = includeCueIds
    ? [
        "Return JSON only with this shape:",
        JSON.stringify({
          bullets: [{
            label: "short label",
            summary: "reader-friendly explanation",
            cueIds: ["c123", "c124"]
          }]
        }, null, 2),
        "Return 4-6 bullets. Each bullet must include cueIds copied from the chunk summaries when available.",
        "cueIds identify the section that supports the summary. Use multiple cue ids for broad arguments."
      ]
    : [
        "Return 4-6 concise markdown bullets. No intro, no outro, no nested bullets.",
        "Start every bullet with a short bold label in this exact style: **Label:** explanation."
      ];
  return [
    "You synthesize full podcast/video summaries for What Did I Miss?.",
    "Use only the provided chunk summaries, which cover the full transcript in order.",
    ...outputRule,
    "Each bullet should be one reader-friendly idea card: a concrete takeaway first, then supporting detail.",
    "The user should understand the substance without watching.",
    "Include concrete claims, useful numbers, arguments, disagreements, examples, and memorable quotes when available.",
    "Avoid generic framing, chapter-list restatement, and vague hype.",
    "",
    `Video: ${video.title}`,
    `Channel: ${video.channel ?? "YouTube"}`,
    "",
    "Chunk summaries:",
    chunkSummaries.map((summary, index) => `Chunk ${index + 1}:\n${summary}`).join("\n\n")
  ].join("\n");
}

function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    const targetEnd = Math.min(text.length, index + chunkSize);
    const nextBreak = text.lastIndexOf(" ", targetEnd);
    const end = nextBreak > index + Math.floor(chunkSize * 0.7) ? nextBreak : targetEnd;
    chunks.push(text.slice(index, end).trim());
    index = end;
  }
  return chunks.filter(Boolean);
}

function chunkTranscriptCues(cues: YouTubeTranscriptCue[], chunkSize: number): Array<{ cues: YouTubeTranscriptCue[] }> {
  const chunks: Array<{ cues: YouTubeTranscriptCue[] }> = [];
  let current: YouTubeTranscriptCue[] = [];
  let currentChars = 0;

  for (const cue of cues) {
    const cueChars = cue.text.length + 24;
    if (current.length && currentChars + cueChars > chunkSize) {
      chunks.push({ cues: current });
      current = [];
      currentChars = 0;
    }
    current.push(cue);
    currentChars += cueChars;
  }
  if (current.length) chunks.push({ cues: current });
  return chunks;
}

function formatCueChunk(cues: YouTubeTranscriptCue[]): string {
  return cues
    .map((cue) => `[${cue.id} ${formatTimestamp(cue.startSec)}] ${cue.text}`)
    .join("\n");
}

function parseYouTubeTranscriptSummary(text: string, video: YouTubeEvent): YouTubeTranscriptSummary {
  try {
    const parsed = JSON.parse(extractJson(text)) as { bullets?: unknown[] };
    if (!Array.isArray(parsed.bullets)) throw new Error("Missing bullets");

    const cueById = new Map((video.transcriptCues ?? []).map((cue) => [cue.id, cue]));
    const anchors: YouTubeSummaryAnchor[] = [];
    const summaryLines: string[] = [];

    for (const bullet of parsed.bullets) {
      if (!isRecord(bullet)) continue;
      const label = textValue(bullet.label, "Video section");
      const summary = textValue(bullet.summary, "");
      if (!summary) continue;

      const cueIds = Array.isArray(bullet.cueIds)
        ? bullet.cueIds.filter((id): id is string => typeof id === "string")
        : [];
      const citedCues = cueIds.map((id) => cueById.get(id)).filter((cue): cue is YouTubeTranscriptCue => Boolean(cue));
      const anchor = anchorFromCues(label, video.url, citedCues);
      if (anchor) anchors.push(anchor);
      summaryLines.push(`- **${label}:** ${summary}`);
    }

    if (summaryLines.length) {
      const summary = summaryLines.join("\n");
      return {
        summary,
        anchors: anchors.length ? anchors : deriveYouTubeAnchorsFromSummary(summary, video)
      };
    }
  } catch {
    // Fall through to markdown fallback.
  }

  return { summary: text.trim(), anchors: deriveYouTubeAnchorsFromSummary(text, video) };
}

function anchorFromCues(label: string, videoUrl: string | undefined, cues: YouTubeTranscriptCue[]): YouTubeSummaryAnchor | null {
  if (!videoUrl || !cues.length) return null;
  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  const startSec = Math.max(0, Math.floor(sorted[0].startSec - YOUTUBE_ANCHOR_PREROLL_SECONDS));
  const endSec = Math.ceil(sorted[sorted.length - 1].endSec);
  const rangeSeconds = endSec - startSec;
  return {
    label,
    startSec,
    endSec: rangeSeconds > 45 && rangeSeconds <= YOUTUBE_MAX_RANGE_SECONDS ? endSec : undefined,
    url: withYouTubeTimestamp(videoUrl, startSec)
  };
}

function withYouTubeTimestamp(rawUrl: string, startSec: number): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("t", `${Math.max(0, Math.floor(startSec))}s`);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function deriveYouTubeAnchorsFromSummary(text: string, video: YouTubeEvent): YouTubeSummaryAnchor[] {
  const cues = video.transcriptCues ?? [];
  if (!video.url || !cues.length) return [];

  return markdownSummaryBullets(text)
    .map((bullet) => {
      const cueIndex = bestCueWindowIndexForSummary(cues, bullet);
      if (cueIndex < 0) return null;
      const start = cues[cueIndex].startSec;
      const windowCues = cues
        .slice(cueIndex)
        .filter((cue) => cue.startSec <= start + 90);
      return anchorFromCues(bullet.label, video.url, windowCues);
    })
    .filter((anchor): anchor is YouTubeSummaryAnchor => Boolean(anchor));
}

function markdownSummaryBullets(text: string): Array<{ label: string; summary: string }> {
  const bullets: Array<{ label: string; summary: string }> = [];
  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const bulletMatch = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    if (!bulletMatch?.[1]) {
      if (bullets.length) bullets[bullets.length - 1].summary += ` ${line}`;
      continue;
    }
    const content = bulletMatch[1].trim();
    const labelMatch = content.match(/^\*\*([^*]{1,64}?:?)\*\*:?\s*(.+)$/) ?? content.match(/^([^:]{2,64}):\s+(.+)$/);
    if (!labelMatch) {
      bullets.push({ label: "Video section", summary: content });
      continue;
    }
    bullets.push({
      label: labelMatch[1].replace(/:+$/, ""),
      summary: labelMatch[2].trim()
    });
  }

  return bullets.slice(0, 6);
}

function bestCueWindowIndexForSummary(cues: YouTubeTranscriptCue[], bullet: { label: string; summary: string }): number {
  const labelTokens = significantTokens(bullet.label);
  const summaryTokens = significantTokens(bullet.summary).slice(0, 28);
  const tokenWeights = new Map<string, number>();
  for (const token of summaryTokens) tokenWeights.set(token, 1);
  for (const token of labelTokens) tokenWeights.set(token, 4);
  if (!tokenWeights.size) return -1;

  let bestIndex = -1;
  let bestScore = 0;
  for (const [index, cue] of cues.entries()) {
    const start = cue.startSec;
    const windowText = cues
      .slice(index)
      .filter((candidate) => candidate.startSec <= start + 75)
      .map((candidate) => candidate.text)
      .join(" ");
    const cueTokens = new Set(significantTokens(windowText));
    let score = 0;
    for (const [token, weight] of tokenWeights) {
      if (cueTokens.has(token)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestScore >= 2 ? bestIndex : -1;
}

function significantTokens(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/['']/g, "")
      .match(/[a-z0-9]{4,}/g)
      ?.filter((token) => !ANCHOR_STOPWORDS.has(token)) ?? []
  )];
}

const ANCHOR_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "being",
  "between",
  "could",
  "every",
  "from",
  "have",
  "into",
  "like",
  "more",
  "most",
  "only",
  "same",
  "says",
  "that",
  "their",
  "there",
  "these",
  "this",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "with",
  "would"
]);

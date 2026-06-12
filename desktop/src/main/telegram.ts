import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TelegramEvent } from "@what-did-i-miss/shared";
import QRCode from "qrcode";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import type { TelegramChat, TelegramScanInput } from "./types";

type TelegramExport = {
  chats?: {
    list?: TelegramExportChat[];
  };
};

type TelegramExportChat = {
  id?: number | string;
  name?: string;
  type?: string;
  messages?: TelegramExportMessage[];
};

type TelegramExportMessage = {
  id?: number | string;
  type?: string;
  date?: string;
  from?: string;
  from_id?: string;
  text?: string | TelegramTextPart[];
};

type TelegramTextPart = string | {
  text?: string;
};

export type TelegramSessionCodec = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

export type GramTelegramClient = {
  connect(): Promise<void>;
  signInUserWithQrCode(
    credentials: { apiId: number; apiHash: string },
    params: {
      qrCode?: (qrCode: { token: Buffer; expires: number }) => Promise<void>;
      password?: (hint?: string) => Promise<string>;
      onError: (error: Error) => Promise<boolean> | boolean | void;
    }
  ): Promise<unknown>;
  signInWithPassword?(
    credentials: { apiId: number; apiHash: string },
    params: {
      password?: (hint?: string) => Promise<string>;
      onError: (error: Error) => Promise<boolean> | boolean | void;
    }
  ): Promise<unknown>;
  signInUser?(
    credentials: { apiId: number; apiHash: string },
    params: {
      phoneNumber: string | (() => Promise<string>);
      phoneCode: (isCodeViaApp?: boolean) => Promise<string>;
      password?: (hint?: string) => Promise<string>;
      onError: (error: Error) => Promise<boolean> | boolean | void;
      forceSMS?: boolean;
    }
  ): Promise<unknown>;
  invoke?(request: unknown): Promise<unknown>;
  addEventHandler?(callback: (update: unknown) => void): void;
  _switchDC?(dcId: number): Promise<boolean>;
  session: { save(): string };
  getDialogs(params?: { limit?: number }): Promise<unknown[]>;
  getMessages(entity: unknown, params?: { limit?: number }): Promise<unknown[]>;
  disconnect(): void;
};

export type TelegramAuthState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "phone_required" }
  | { status: "code_required"; phoneNumber: string; isCodeViaApp?: boolean }
  | { status: "pending"; loginUrl: string; qrDataUrl: string; expiresAt: string }
  | { status: "password_required"; hint?: string }
  | { status: "connected" }
  | { status: "error"; error: string };

type TelegramConnectorOptions = {
  sessionPath?: string;
  codec?: TelegramSessionCodec;
  apiId?: number;
  apiHash?: string;
  initialSession?: string;
  createClient?: (session: string) => GramTelegramClient;
  now?: () => Date;
};

type StoredTelegramSession = {
  version: 1;
  encryptedSession?: string;
  session?: string;
};

type TelegramFetchTarget = {
  chat: TelegramChat;
  entity: unknown;
};

const TELEGRAM_CHAT_DISCOVERY_LIMIT = 1000;
const TELEGRAM_SCAN_DIALOG_LIMIT = 200;

export class TelegramConnector {
  private readonly sessionPath: string;
  private readonly codec?: TelegramSessionCodec;
  private readonly apiId?: number;
  private readonly apiHash?: string;
  private readonly createClient: (session: string) => GramTelegramClient;
  private readonly now: () => Date;
  private authState: TelegramAuthState = { status: "idle" };
  private client: GramTelegramClient | null = null;
  private loginPromise: Promise<void> | null = null;
  private phoneResolver: ((phoneNumber: string) => void) | null = null;
  private codeResolver: ((code: string) => void) | null = null;
  private passwordResolver: ((password: string) => void) | null = null;
  private pendingPhoneNumber: string | null = null;
  private pendingPhoneCodeHash: string | null = null;

  constructor(options: TelegramConnectorOptions = {}) {
    this.sessionPath = options.sessionPath ?? path.join(os.homedir(), ".what-did-i-miss", "telegram-session.json");
    this.codec = options.codec;
    this.apiId = options.apiId ?? numberFromEnv(process.env.TELEGRAM_API_ID);
    this.apiHash = options.apiHash ?? process.env.TELEGRAM_API_HASH;
    this.now = options.now ?? (() => new Date());
    this.createClient = options.createClient ?? ((session) => {
      if (!this.apiId || !this.apiHash) throw missingTelegramCredentialsError();
      return new TelegramClient(new StringSession(session), this.apiId, this.apiHash, {
        connectionRetries: 5
      }) as unknown as GramTelegramClient;
    });
    if (options.initialSession) {
      this.loginPromise = this.saveSession(options.initialSession).then(() => {
        this.authState = { status: "connected" };
      });
    }
  }

  async beginAccountLogin(): Promise<TelegramAuthState> {
    const credentials = this.telegramCredentials();
    const client = this.createClient("");
    this.client = client;
    console.info("[telegram-auth] begin QR login");
    await client.connect();

    const firstQr = new Promise<TelegramAuthState>((resolve, reject) => {
      let resolved = false;
      this.loginPromise = this.runQrLogin(client, credentials, (state) => {
        console.info("[telegram-auth] state", state.status);
        this.authState = state;
        if (!resolved) {
          resolved = true;
          resolve(state);
        }
      }).then(async () => {
        console.info("[telegram-auth] login completed; saving session");
        await this.saveSession(client.session.save());
        this.authState = { status: "connected" };
      }).catch((error: unknown) => {
        console.error("[telegram-auth] login failed", error);
        this.authState = { status: "error", error: error instanceof Error ? error.message : String(error) };
        if (!resolved) {
          resolved = true;
          reject(error);
        }
        throw error;
      });
    });

    return firstQr;
  }

  async beginPhoneLogin(): Promise<TelegramAuthState> {
    const credentials = this.telegramCredentials();
    const client = this.createClient("");
    this.client = client;
    console.info("[telegram-auth] begin phone login");
    await client.connect();

    this.authState = { status: "phone_required" };
    return this.authState;
  }

  private async runQrLogin(
    client: GramTelegramClient,
    credentials: { apiId: number; apiHash: string },
    onState: (state: TelegramAuthState) => void
  ): Promise<void> {
    try {
      await client.signInUserWithQrCode(credentials, {
        qrCode: async (qrCode) => {
          console.info("[telegram-auth] state pending");
          onState(await telegramQrState(qrCode));
        },
        password: async (hint) => this.waitForPassword(hint, onState),
        onError: () => false
      });
    } catch (error) {
      if (isTelegramPasswordRequiredError(error)) {
        throw new Error("Telegram requires your 2FA cloud password to finish connecting this device.");
      }
      throw error;
    }
  }

  private waitForPassword(hint: string | undefined, onState: (state: TelegramAuthState) => void): Promise<string> {
    console.info("[telegram-auth] state password_required");
    onState({ status: "password_required", hint });
    return new Promise<string>((passwordResolve) => {
      this.passwordResolver = passwordResolve;
    });
  }

  async submitPhoneNumber(phoneNumber: string): Promise<TelegramAuthState> {
    const client = this.client;
    if (!client?.invoke) throw new Error("Telegram client is not ready for phone login.");
    const normalized = phoneNumber.trim();
    if (!normalized) throw new Error("Enter a Telegram phone number.");
    this.pendingPhoneNumber = normalized;
    const code = await this.sendTelegramCode(client, this.telegramCredentials(), normalized);
    this.pendingPhoneCodeHash = code.phoneCodeHash;
    this.authState = { status: "code_required", phoneNumber: normalized, isCodeViaApp: code.isCodeViaApp };
    return this.authState;
  }

  async submitPhoneCode(code: string): Promise<TelegramAuthState> {
    const client = this.client;
    if (!client?.invoke) throw new Error("Telegram client is not ready for code login.");
    if (!this.pendingPhoneNumber || !this.pendingPhoneCodeHash) throw new Error("Telegram is not waiting for a login code.");
    const normalized = code.trim().replace(/\s+/g, "");
    if (!normalized) throw new Error("Enter the Telegram login code.");
    try {
      await client.invoke(new Api.auth.SignIn({
        phoneNumber: this.pendingPhoneNumber,
        phoneCodeHash: this.pendingPhoneCodeHash,
        phoneCode: normalized
      }));
      await this.saveSession(client.session.save());
      this.authState = { status: "connected" };
      return this.authState;
    } catch (error) {
      if (isTelegramPasswordRequiredError(error) && client.signInWithPassword) {
        this.loginPromise = client.signInWithPassword(this.telegramCredentials(), {
          password: (hint) => this.waitForPassword(hint, (state) => {
            this.authState = state;
          }),
          onError: () => false
        }).then(async () => {
          await this.saveSession(client.session.save());
          this.authState = { status: "connected" };
        });
        await this.waitForAuthStateChange("password_required");
        return this.authState;
      }
      throw error;
    }
  }

  async submitPassword(password: string): Promise<TelegramAuthState> {
    if (!this.passwordResolver) throw new Error("Telegram is not waiting for a 2FA password.");
    this.passwordResolver(password);
    this.passwordResolver = null;
    await this.loginPromise;
    return this.authState;
  }

  private async waitForAuthStateChange(status: TelegramAuthState["status"], timeoutMs = 20_000): Promise<void> {
    const started = Date.now();
    while (this.authState.status !== status) {
      if (this.authState.status === "error" || this.authState.status === "connected") return;
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for Telegram ${status}.`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async waitForLoginProgress(timeoutMs = 20_000): Promise<void> {
    const started = Date.now();
    while (this.authState.status === "code_required") {
      if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for Telegram to accept the login code.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async sendTelegramCode(
    client: GramTelegramClient,
    credentials: { apiId: number; apiHash: string },
    phoneNumber: string
  ): Promise<{ phoneCodeHash: string; isCodeViaApp: boolean }> {
    if (!client.invoke) throw new Error("Telegram client cannot send a login code.");
    try {
      const result = await client.invoke(new Api.auth.SendCode({
        phoneNumber,
        apiId: credentials.apiId,
        apiHash: credentials.apiHash,
        settings: new Api.CodeSettings({})
      }));
      if (!(result instanceof Api.auth.SentCode)) throw new Error(`Telegram returned ${telegramClassName(result)} while sending login code.`);
      return {
        phoneCodeHash: result.phoneCodeHash,
        isCodeViaApp: result.type instanceof Api.auth.SentCodeTypeApp
      };
    } catch (error) {
      const dcId = telegramMigrationDcId(error);
      if (dcId && client._switchDC) {
        console.info("[telegram-auth] phone migrated", dcId);
        await client._switchDC(dcId);
        return this.sendTelegramCode(client, credentials, phoneNumber);
      }
      throw error;
    }
  }

  getAuthState(): TelegramAuthState {
    return this.authState;
  }

  async isConnected(): Promise<boolean> {
    if (this.authState.status === "connected") return true;
    if (this.authState.status !== "idle") return false;
    if (this.loginPromise) await this.loginPromise.catch(() => undefined);
    return Boolean(await this.loadSession());
  }

  async listAccountChats(): Promise<TelegramChat[]> {
    const client = await this.connectedClient();
    const dialogs = await client.getDialogs({ limit: TELEGRAM_CHAT_DISCOVERY_LIMIT });
    const folderMap = client.invoke ? await this.telegramFolderMap(client) : new Map<string, string[]>();
    console.info("[telegram] listed dialogs", { dialogs: dialogs.length, limit: TELEGRAM_CHAT_DISCOVERY_LIMIT });
    return dialogs.map((dialog) => telegramChatFromDialog(dialog as Record<string, unknown>, folderMap));
  }

  private async telegramFolderMap(client: GramTelegramClient): Promise<Map<string, string[]>> {
    const folders = new Map<string, string[]>();
    const result = await client.invoke?.(new Api.messages.GetDialogFilters()).catch(() => null);
    const filters = result && typeof result === "object" && "filters" in result
      ? (result as { filters?: unknown[] }).filters ?? []
      : [];
    for (const filter of filters) {
      if (!(filter instanceof Api.DialogFilter || filter instanceof Api.DialogFilterChatlist)) continue;
      const name = dialogFilterTitle(filter.title);
      if (!name) continue;
      if (filter instanceof Api.DialogFilter) {
        if (filter.groups) pushFolder(folders, "kind:group", name);
        if (filter.broadcasts) pushFolder(folders, "kind:channel", name);
        if (filter.contacts || filter.nonContacts) pushFolder(folders, "kind:dm", name);
      }
      for (const peer of [...filter.includePeers, ...filter.pinnedPeers]) {
        const key = inputPeerKey(peer);
        if (key) pushFolder(folders, key, name);
      }
    }
    return folders;
  }

  async listChats(exportPath: string): Promise<TelegramChat[]> {
    const data = await readTelegramExport(exportPath);
    return exportChats(data).map((chat) => ({
      id: chatId(chat),
      title: chatTitle(chat),
      enabled: false,
      kind: chatKind(chat)
    }));
  }

  async fetchRecentMessages(input: TelegramScanInput): Promise<TelegramEvent[]> {
    if (!input.exportPath) return this.fetchAccountMessages(input);

    const data = await readTelegramExport(input.exportPath);
    const enabledChatIds = new Set(input.chats.filter((chat) => chat.enabled).map((chat) => chat.id));
    const events: TelegramEvent[] = [];
    const sinceMs = scanSinceMs(input.since);

    for (const chat of exportChats(data)) {
      const id = chatId(chat);
      const kind = chatKind(chat);
      if (!enabledChatIds.has(id) && !(input.includeDms && kind === "dm")) continue;

      for (const message of chat.messages ?? []) {
        if (message.type && message.type !== "message") continue;
        const text = telegramText(message.text);
        if (!text) continue;
        const sentAt = message.date ?? new Date(0).toISOString();
        if (!isInsideScanWindow(sentAt, sinceMs)) continue;

        events.push({
          id: `telegram:${id}:${String(message.id ?? events.length)}`,
          chatId: id,
          chat: chatTitle(chat),
          sender: senderName(message),
          text,
          sentAt,
          direct: kind === "dm",
          mentionedMe: /@\w+/.test(text),
          sourceUrl: telegramSourceUrl(chat)
        });
      }
    }

    return events.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  }

  private async fetchAccountMessages(input: TelegramScanInput): Promise<TelegramEvent[]> {
    const client = await this.connectedClient();
    const dialogs = await client.getDialogs({ limit: TELEGRAM_SCAN_DIALOG_LIMIT });
    const liveTargets = dialogs.map((dialog) => liveTargetFromDialog(dialog as Record<string, unknown>));
    const targets: TelegramFetchTarget[] = [];
    const sinceMs = scanSinceMs(input.since);

    for (const selectedChat of input.chats.filter((chat) => chat.kind !== "dm" && chat.enabled)) {
      const liveTarget = liveTargets.find((target) => sameTelegramChat(target.chat, selectedChat));
      const entity = liveTarget?.entity ?? selectedChat.inputEntity;
      if (!entity) {
        console.warn("[telegram] skipping unresolved chat", {
          id: selectedChat.id,
          title: selectedChat.title,
          kind: selectedChat.kind,
          peerKey: selectedChat.peerKey
        });
        continue;
      }
      targets.push({
        chat: { ...selectedChat, ...(liveTarget?.chat ?? {}) },
        entity
      });
    }

    if (input.includeDms) {
      const selectedIds = new Set(targets.map((target) => target.chat.id));
      let directTargetsAdded = 0;
      const maxDirectChats = input.maxDirectChats ?? Number.POSITIVE_INFINITY;
      for (const target of liveTargets) {
        if (target.chat.kind !== "dm") continue;
        if (selectedIds.has(target.chat.id)) continue;
        if (directTargetsAdded >= maxDirectChats) continue;
        targets.push(target);
        selectedIds.add(target.chat.id);
        directTargetsAdded += 1;
      }
    }

    console.info("[telegram] fetching messages", {
      targets: targets.length,
      directTargets: targets.filter((target) => target.chat.kind === "dm").length,
      directTargetsAvailable: liveTargets.filter((target) => target.chat.kind === "dm").length,
      maxDirectChats: input.maxDirectChats ?? null,
      limitPerChat: input.limitPerChat ?? 100
    });
    const events: TelegramEvent[] = [];

    for (const target of targets) {
      let messages: unknown[];
      try {
        messages = await client.getMessages(target.entity, { limit: input.limitPerChat ?? 100 });
      } catch (error) {
        console.error("[telegram] failed to fetch chat", {
          id: target.chat.id,
          title: target.chat.title,
          kind: target.chat.kind,
          peerKey: target.chat.peerKey,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      for (const message of messages) {
        const record = message as Record<string, unknown>;
        const text = typeof record.message === "string" ? record.message.trim() : "";
        if (!text) continue;
        const sentAt = telegramMessageDate(record.date);
        if (!isInsideScanWindow(sentAt, sinceMs)) continue;
        events.push({
          id: `telegram:${target.chat.id}:${String(record.id ?? events.length)}`,
          chatId: target.chat.id,
          chat: target.chat.title,
          sender: String(record.senderId ?? record.fromId ?? "Unknown"),
          text,
          sentAt,
          direct: target.chat.kind === "dm",
          mentionedMe: Boolean(record.mentioned),
          sourceUrl: telegramChatSourceUrl(target.chat)
        });
      }
    }

    console.info("[telegram] fetched messages", { messages: events.length });
    return events.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  }

  private telegramCredentials(): { apiId: number; apiHash: string } {
    if (!this.apiId || !this.apiHash) throw missingTelegramCredentialsError();
    return { apiId: this.apiId, apiHash: this.apiHash };
  }

  private async connectedClient(): Promise<GramTelegramClient> {
    if (this.loginPromise) await this.loginPromise.catch(() => undefined);
    if (this.client && this.authState.status === "connected") return this.client;
    const session = await this.loadSession();
    if (!session) throw new Error("Connect Telegram before scanning chats.");
    const client = this.createClient(session);
    await client.connect();
    this.client = client;
    this.authState = { status: "connected" };
    return client;
  }

  private async saveSession(session: string): Promise<void> {
    await fs.mkdir(path.dirname(this.sessionPath), { recursive: true });
    const stored: StoredTelegramSession = { version: 1 };
    if (this.codec?.isEncryptionAvailable()) {
      stored.encryptedSession = this.codec.encryptString(session).toString("base64");
    } else {
      console.warn("[telegram] safeStorage encryption unavailable; storing Telegram session unencrypted on disk");
      stored.session = session;
    }
    await fs.writeFile(this.sessionPath, JSON.stringify(stored, null, 2));
  }

  private async loadSession(): Promise<string | null> {
    try {
      const stored = JSON.parse(await fs.readFile(this.sessionPath, "utf8")) as StoredTelegramSession;
      if (stored.encryptedSession && this.codec?.isEncryptionAvailable()) {
        return this.codec.decryptString(Buffer.from(stored.encryptedSession, "base64"));
      }
      return stored.session ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

async function readTelegramExport(exportPath: string): Promise<TelegramExport> {
  return JSON.parse(await fs.readFile(exportPath, "utf8")) as TelegramExport;
}

function exportChats(data: TelegramExport): TelegramExportChat[] {
  return data.chats?.list ?? [];
}

function chatId(chat: TelegramExportChat): string {
  return String(chat.id ?? chat.name ?? "unknown");
}

function chatTitle(chat: TelegramExportChat): string {
  return chat.name?.trim() || chatId(chat);
}

function chatKind(chat: TelegramExportChat): TelegramChat["kind"] {
  if (chat.type === "personal_chat" || chat.type === "private") return "dm";
  if (chat.type === "channel") return "channel";
  return "group";
}

function senderName(message: TelegramExportMessage): string {
  return message.from?.trim() || message.from_id || "Unknown";
}

function telegramText(value: TelegramExportMessage["text"]): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => typeof part === "string" ? part : part.text ?? "")
    .join("")
    .trim();
}

function telegramSourceUrl(chat: TelegramExportChat): string | undefined {
  const name = chat.name?.trim();
  if (!name || /\s/.test(name)) return undefined;
  return `tg://resolve?domain=${encodeURIComponent(name.replace(/^@/, ""))}`;
}

function telegramChatSourceUrl(chat: TelegramChat): string | undefined {
  const username = chat.username?.trim();
  if (!username) return undefined;
  return `tg://resolve?domain=${encodeURIComponent(username.replace(/^@/, ""))}`;
}

async function telegramQrState(qrCode: { token: Buffer; expires: number }): Promise<TelegramAuthState> {
  const loginUrl = `tg://login?token=${qrCode.token.toString("base64url")}`;
  return {
    status: "pending",
    loginUrl,
    qrDataUrl: await QRCode.toDataURL(loginUrl, { margin: 1, width: 220 }),
    expiresAt: new Date(qrCode.expires * 1000).toISOString()
  };
}

function telegramErrorMessage(error: unknown): string | undefined {
  if (typeof error === "object" && error && "errorMessage" in error) return String((error as { errorMessage: unknown }).errorMessage);
  return error instanceof Error ? error.message : undefined;
}

function telegramClassName(value: unknown): string {
  if (typeof value === "object" && value && "className" in value) return String((value as { className: unknown }).className);
  return value instanceof Error ? value.name : String(value);
}

function isTelegramPasswordRequiredError(error: unknown): boolean {
  const message = telegramErrorMessage(error);
  return Boolean(message && message.includes("SESSION_PASSWORD_NEEDED"));
}

function telegramMigrationDcId(error: unknown): number | null {
  const message = telegramErrorMessage(error);
  const match = message?.match(/(?:PHONE_|NETWORK_|USER_|FILE_)?MIGRATE_(\d+)/);
  if (!match) return null;
  const dcId = Number(match[1]);
  return Number.isFinite(dcId) ? dcId : null;
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function missingTelegramCredentialsError(): Error {
  return new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before connecting Telegram.");
}

function dialogKind(dialog: Record<string, unknown>): TelegramChat["kind"] {
  if (dialog.isUser) return "dm";
  if (dialog.isChannel) return "channel";
  return "group";
}

function telegramChatFromDialog(dialog: Record<string, unknown>, folderMap: Map<string, string[]>): TelegramChat {
  const kind = dialogKind(dialog);
  const nestedDialog = dialog.dialog as Record<string, unknown> | undefined;
  const entity = (dialog.entity ?? dialog.inputEntity ?? dialog.peer) as Record<string, unknown> | undefined;
  const rawId = String(dialog.id ?? nestedDialog?.id ?? entity?.id ?? dialog.title ?? "unknown");
  const peerKey = dialogPeerKey(dialog) ?? entityPeerKey(entity) ?? `${kind}:${rawId}`;
  return {
    id: peerKey,
    title: String(dialog.title ?? dialog.name ?? entityTitle(entity) ?? dialog.id ?? "Unknown chat"),
    enabled: kind === "dm",
    kind,
    username: stringValue(dialog.username ?? entity?.username),
    memberCount: numberValue(dialog.participantsCount ?? entity?.participantsCount),
    folders: folderMap.get(peerKey) ?? broadFolderNames(folderMap, kind),
    peerKey,
    inputEntity: entityInputValue(dialog)
  };
}

function liveTargetFromDialog(dialog: Record<string, unknown>): TelegramFetchTarget {
  return {
    chat: telegramChatFromDialog(dialog, new Map()),
    entity: dialogEntity(dialog)
  };
}

function dialogEntity(dialog: Record<string, unknown>): unknown {
  return dialog.inputEntity ?? dialog.entity ?? dialog.peer ?? dialog.id;
}

function sameTelegramChat(left: TelegramChat, right: TelegramChat): boolean {
  if (left.id === right.id) return true;
  if (left.id === right.peerKey || left.peerKey === right.id) return true;
  return Boolean(left.peerKey && right.peerKey && left.peerKey === right.peerKey);
}

function entityInputValue(dialog: Record<string, unknown>): string | undefined {
  const inputEntity = dialog.inputEntity;
  if (typeof inputEntity === "string") return inputEntity;
  const entity = dialog.entity;
  if (typeof entity === "string") return entity;
  return undefined;
}

function dialogPeerKey(dialog: Record<string, unknown>): string | null {
  if (dialog.isUser) return `user:${String(dialog.id)}`;
  if (dialog.isChannel) return `channel:${String(dialog.id)}`;
  return `chat:${String(dialog.id)}`;
}

function entityPeerKey(entity: Record<string, unknown> | undefined): string | null {
  if (!entity) return null;
  const id = stringValue(entity.id);
  if (!id) return null;
  const className = stringValue(entity.className);
  if (className?.includes("User")) return `user:${id}`;
  if (className?.includes("Channel")) return `channel:${id}`;
  if (className?.includes("Chat")) return `chat:${id}`;
  return null;
}

function inputPeerKey(peer: unknown): string | null {
  if (peer instanceof Api.InputPeerUser) return `user:${String(peer.userId)}`;
  if (peer instanceof Api.InputPeerChat) return `chat:${String(peer.chatId)}`;
  if (peer instanceof Api.InputPeerChannel) return `channel:${String(peer.channelId)}`;
  return null;
}

function broadFolderNames(folders: Map<string, string[]>, kind: TelegramChat["kind"]): string[] {
  return folders.get(`kind:${kind}`) ?? [];
}

function pushFolder(folders: Map<string, string[]>, key: string, name: string): void {
  folders.set(key, [...new Set([...(folders.get(key) ?? []), name])]);
}

function dialogFilterTitle(title: unknown): string | null {
  if (typeof title === "string") return title.trim() || null;
  if (typeof title === "object" && title && "text" in title) {
    const text = stringValue((title as { text?: unknown }).text);
    return text?.trim() || null;
  }
  return null;
}

function entityTitle(entity: Record<string, unknown> | undefined): string | null {
  if (!entity) return null;
  const firstName = stringValue(entity.firstName);
  const lastName = stringValue(entity.lastName);
  const name = [firstName, lastName].filter(Boolean).join(" ").trim();
  return stringValue(entity.title) ?? (name ? name : stringValue(entity.username) ?? null);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isFinite(value) ? value : undefined;
}

function telegramMessageDate(value: unknown): string {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function scanSinceMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function isInsideScanWindow(value: string, sinceMs: number): boolean {
  const ms = new Date(value).getTime();
  return !Number.isNaN(ms) && ms >= sinceMs;
}

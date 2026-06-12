import type { TelegramEvent } from "@what-did-i-miss/shared";
import type { AppStore } from "../store";
import type { TelegramConnector } from "../telegram";
import type { TelegramChat } from "../types";
import type { ConnectorHealth, SourceConnection, SourceConnector, SourceCursor, SourceEvent } from "./types";
import { makeSourceConnectionId } from "./types";

type TelegramLocalClient = Pick<TelegramConnector, "fetchRecentMessages"> & Partial<Pick<TelegramConnector, "isConnected">>;
const TELEGRAM_LOCAL_CONNECTION_ID = makeSourceConnectionId("telegram", "local", "account");
const TELEGRAM_CURSOR_KEY = "telegram:last_sent_at";
const TELEGRAM_DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_MAX_DIRECT_CHATS_PER_SCAN = 25;

export class TelegramLocalConnector implements SourceConnector {
  readonly source = "telegram";
  readonly backend = "local";

  constructor(
    private readonly store: AppStore,
    private readonly telegram: TelegramLocalClient
  ) {}

  async listConnections(): Promise<SourceConnection[]> {
    const settings = await this.store.getSettings();
    const chats = await this.store.getTelegramChats();
    if (!settings.telegramIncludeDms && !chats.some((chat) => chat.enabled)) return [];
    if (!settings.telegramExportPath && await this.telegram.isConnected?.() === false) return [];
    return [telegramConnectionFromSettings(settings.telegramIncludeDms, chats)];
  }

  async scan(connection: SourceConnection): Promise<{
    events: SourceEvent[];
    cursors: SourceCursor[];
    health: ConnectorHealth;
  }> {
    const now = new Date().toISOString();
    try {
      const settings = await this.store.getSettings();
      const chats = await this.store.getTelegramChats();
      const cursor = await this.store.getSourceCursor(connection.id, TELEGRAM_CURSOR_KEY);
      const messages = await this.telegram.fetchRecentMessages({
        exportPath: settings.telegramExportPath ?? undefined,
        chats,
        includeDms: settings.telegramIncludeDms,
        limitPerChat: 25,
        maxDirectChats: TELEGRAM_MAX_DIRECT_CHATS_PER_SCAN,
        since: cursor?.cursorValue ?? new Date(Date.now() - TELEGRAM_DEFAULT_LOOKBACK_MS).toISOString()
      });
      return {
        events: messages.map((message) => telegramEventFromMessage(message, connection.id)),
        cursors: latestTelegramCursor(connection.id, messages, now),
        health: {
          connectionId: connection.id,
          status: !settings.telegramExportPath && await this.telegram.isConnected?.() === false ? "needs_auth" : "ready",
          detail: "Telegram local connector ready",
          checkedAt: now
        }
      };
    } catch (error) {
      // One failing source must not fail the whole scan; report via health like
      // the other connectors and let the next run retry.
      const message = error instanceof Error ? error.message : String(error);
      return {
        events: [],
        cursors: [],
        health: {
          connectionId: connection.id,
          status: /connect telegram/i.test(message) ? "needs_auth" : "error",
          detail: message,
          checkedAt: now
        }
      };
    }
  }
}

function telegramConnectionFromSettings(includeDms: boolean, chats: TelegramChat[]): SourceConnection {
  const now = new Date().toISOString();
  const enabledChats = chats.filter((chat) => chat.kind !== "dm" && chat.enabled);
  return {
    id: TELEGRAM_LOCAL_CONNECTION_ID,
    source: "telegram",
    backend: "local",
    label: "Telegram",
    accountIdentifier: "local",
    externalAccountId: null,
    enabled: true,
    config: {
      includeDms,
      selectedChatIds: enabledChats.map((chat) => chat.id)
    },
    connectedAt: now,
    updatedAt: now
  };
}

function telegramEventFromMessage(message: TelegramEvent, connectionId: string): SourceEvent {
  return {
    ...message,
    source: "telegram",
    connectionId
  };
}

function latestTelegramCursor(connectionId: string, messages: TelegramEvent[], updatedAt: string): SourceCursor[] {
  const latest = messages
    .map((message) => message.sentAt)
    .sort()
    .at(-1);
  return latest
    ? [{
        connectionId,
        cursorKey: TELEGRAM_CURSOR_KEY,
        cursorValue: latest,
        updatedAt
      }]
    : [];
}

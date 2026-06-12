import type { GmailEvent, TelegramEvent, YouTubeEvent } from "@what-did-i-miss/shared";

export type ConnectorSource = "gmail" | "telegram" | "youtube" | "twitter" | "news";
export type ConnectorBackend = "local" | "native";

export type SourceConnection = {
  id: string;
  source: ConnectorSource;
  backend: ConnectorBackend;
  label: string;
  accountIdentifier: string | null;
  externalAccountId: string | null;
  enabled: boolean;
  config: Record<string, unknown>;
  connectedAt: string;
  updatedAt: string;
};

export type SourceCursor = {
  connectionId: string;
  cursorKey: string;
  cursorValue: string;
  updatedAt: string;
};

export type SourceEvent =
  | (GmailEvent & { source: "gmail"; connectionId: string })
  | (TelegramEvent & { source: "telegram"; connectionId: string })
  | (YouTubeEvent & { source: "youtube"; connectionId: string })
  | {
      source: "twitter" | "news";
      connectionId: string;
      id: string;
      title: string;
      body: string;
      actor?: string;
      url?: string;
      receivedAt: string;
      metadata?: Record<string, unknown>;
    };

export type ConnectorHealth = {
  connectionId: string;
  status: "ready" | "needs_auth" | "error";
  detail: string;
  checkedAt: string;
};

export type SourceScanContext = {
  since?: string;
  maxVideos?: number;
};

export type SourceConnector = {
  source: ConnectorSource;
  backend: ConnectorBackend;
  listConnections(): Promise<SourceConnection[]>;
  scan(connection: SourceConnection, context?: SourceScanContext): Promise<{
    events: SourceEvent[];
    cursors: SourceCursor[];
    health: ConnectorHealth;
  }>;
};

export function makeSourceConnectionId(source: ConnectorSource, backend: ConnectorBackend, externalId: string): string {
  return `${source}:${backend}:${externalId}`;
}

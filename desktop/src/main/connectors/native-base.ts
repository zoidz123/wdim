import type { AppStore } from "../store";
import type { NativeOAuthClient } from "./native-oauth-client";
import type { OAuthProvider, OAuthTokenSet } from "../oauth/types";
import type { ConnectorHealth, SourceConnection, SourceConnector, SourceCursor, SourceEvent, SourceScanContext } from "./types";
import { makeSourceConnectionId } from "./types";

export type NativeProviderProfile = {
  externalId: string;
  label: string;
  accountIdentifier: string | null;
  config?: Record<string, unknown>;
};

export type NativeProviderClient = {
  getProfile(tokens: OAuthTokenSet): Promise<NativeProviderProfile>;
  scan(params: {
    connection: SourceConnection;
    tokens: OAuthTokenSet;
    cursor: SourceCursor | null;
    context?: SourceScanContext;
  }): Promise<{ events: SourceEvent[]; cursors?: SourceCursor[] }>;
};

export abstract class NativeSourceConnector implements SourceConnector {
  readonly backend = "native" as const;

  protected constructor(
    readonly source: OAuthProvider,
    protected readonly store: AppStore,
    protected readonly oauth: NativeOAuthClient,
    protected readonly provider: NativeProviderClient,
    protected readonly now: () => Date = () => new Date()
  ) {}

  async startConnection(label: string): Promise<{ redirectUrl: string; connectionRequestId: string }> {
    const request = await this.oauth.startConnection(this.source, label);
    return {
      redirectUrl: request.redirectUrl,
      connectionRequestId: request.requestId
    };
  }

  async completeConnection(connectionRequestId: string): Promise<SourceConnection> {
    const result = await this.oauth.completeConnection(connectionRequestId);
    const profile = await this.provider.getProfile(result.tokens);
    const now = this.now().toISOString();
    const connection: SourceConnection = {
      id: makeSourceConnectionId(this.source, "native", profile.externalId),
      source: this.source,
      backend: "native",
      label: profile.label,
      accountIdentifier: profile.accountIdentifier,
      externalAccountId: null,
      enabled: true,
      config: {
        ...(profile.config ?? {}),
        tokenId: result.tokenId
      },
      connectedAt: now,
      updatedAt: now
    };
    await this.store.saveSourceConnection(connection);
    return connection;
  }

  async listConnections(): Promise<SourceConnection[]> {
    return (await this.store.listSourceConnections())
      .filter((connection) => connection.backend === "native" && connection.source === this.source);
  }

  async scan(connection: SourceConnection, context?: SourceScanContext): Promise<{
    events: SourceEvent[];
    cursors: SourceCursor[];
    health: ConnectorHealth;
  }> {
    const now = this.now().toISOString();
    try {
      const tokenId = tokenIdFromConnection(connection);
      const tokens = await this.oauth.loadFreshTokens(this.source, tokenId);
      if (!tokens) throw new Error("Native OAuth tokens were not found for this connection.");
      const cursor = await this.store.getSourceCursor(connection.id, cursorKeyForSource(this.source));
      const result = await this.provider.scan({ connection, tokens, cursor, context });
      return {
        events: result.events,
        cursors: result.cursors ?? latestCursorForEvents(connection.id, this.source, result.events, now),
        health: {
          connectionId: connection.id,
          status: "ready",
          detail: "Native connector ready",
          checkedAt: now
        }
      };
    } catch (error) {
      return {
        events: [],
        cursors: [],
        health: {
          connectionId: connection.id,
          status: isNativeAuthError(error) ? "needs_auth" : "error",
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: now
        }
      };
    }
  }
}

function isNativeAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /OAuth token (expired|refresh failed)|tokens were not found|reconnect this account/i.test(message);
}

export function tokenIdFromConnection(connection: SourceConnection): string {
  const tokenId = connection.config?.tokenId;
  if (typeof tokenId !== "string" || !tokenId.trim()) {
    throw new Error("Native source connection is missing a local token reference.");
  }
  return tokenId;
}

export function cursorKeyForSource(source: OAuthProvider): string {
  switch (source) {
    case "twitter":
      return "timeline_newest_id";
    default:
      return "last_seen_at";
  }
}

export function latestCursorForEvents(connectionId: string, source: OAuthProvider, events: SourceEvent[], updatedAt: string): SourceCursor[] {
  if (!events.length) return [];
  if (source === "twitter") {
    const newestId = events
      .filter((event) => event.source === "twitter")
      .map((event) => event.id)
      .sort((a, b) => compareNumericStringsDescending(a, b))[0];
    return newestId ? [{ connectionId, cursorKey: "timeline_newest_id", cursorValue: newestId, updatedAt }] : [];
  }
  const newestAt = events
    .map((event) => "receivedAt" in event ? event.receivedAt : undefined)
    .filter(Boolean)
    .sort()
    .at(-1);
  return newestAt ? [{ connectionId, cursorKey: "last_seen_at", cursorValue: newestAt, updatedAt }] : [];
}

function compareNumericStringsDescending(a: string, b: string): number {
  try {
    return BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0;
  } catch {
    return b.localeCompare(a);
  }
}

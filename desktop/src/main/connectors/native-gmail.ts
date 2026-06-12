import type { OAuthTokenSet } from "../oauth/types";
import type { AppStore } from "../store";
import type { NativeOAuthClient } from "./native-oauth-client";
import { NativeSourceConnector, type NativeProviderClient, type NativeProviderProfile } from "./native-base";
import type { SourceConnection, SourceCursor, SourceEvent, SourceScanContext } from "./types";

const GMAIL_SCAN_PAGE_SIZE = 50;
const GMAIL_SCAN_MAX_MESSAGES = 100;

export class NativeGmailConnector extends NativeSourceConnector {
  constructor(store: AppStore, oauth: NativeOAuthClient, provider: NativeProviderClient = new GmailApiClient(), now?: () => Date) {
    super("gmail", store, oauth, provider, now);
  }
}

export class GmailApiClient implements NativeProviderClient {
  async getProfile(tokens: OAuthTokenSet): Promise<NativeProviderProfile> {
    const profile = await authedJson("https://openidconnect.googleapis.com/v1/userinfo", tokens) as Record<string, unknown>;
    const email = typeof profile.email === "string" ? profile.email : "Gmail";
    return {
      externalId: email.toLowerCase(),
      label: email,
      accountIdentifier: email
    };
  }

  async scan(params: {
    connection: SourceConnection;
    tokens: OAuthTokenSet;
    cursor: SourceCursor | null;
    context?: SourceScanContext;
  }): Promise<{ events: SourceEvent[] }> {
    const queryParts = ["in:inbox"];
    const since = params.context?.since ?? params.cursor?.cursorValue;
    if (since) queryParts.push(`after:${Math.floor(new Date(since).getTime() / 1000)}`);
    const ids = await this.listMessageIds(params.tokens, queryParts.join(" "), GMAIL_SCAN_MAX_MESSAGES);
    const messages = await Promise.all(ids.map((id) => this.fetchMessage(params.connection, params.tokens, id)));
    return { events: messages.filter((event): event is SourceEvent => Boolean(event)) };
  }

  // Paginate: a single 25-result page silently drops inbox mail on busy days
  // and the advancing scan window means it is never fetched again.
  private async listMessageIds(tokens: OAuthTokenSet, query: string, maxResults: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      listUrl.searchParams.set("q", query);
      listUrl.searchParams.set("maxResults", String(Math.min(GMAIL_SCAN_PAGE_SIZE, maxResults - ids.length)));
      if (pageToken) listUrl.searchParams.set("pageToken", pageToken);
      const list = await authedJson(listUrl.toString(), tokens) as { messages?: Array<{ id?: string }>; nextPageToken?: string };
      for (const message of list.messages ?? []) {
        if (message.id) ids.push(message.id);
      }
      pageToken = list.nextPageToken;
    } while (pageToken && ids.length < maxResults);
    return ids.slice(0, maxResults);
  }

  private async fetchMessage(connection: SourceConnection, tokens: OAuthTokenSet, id: string): Promise<SourceEvent | null> {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
    const message = await authedJson(url, tokens) as Record<string, unknown>;
    const payload = message.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined;
    const headers = new Map((payload?.headers ?? []).map((header) => [String(header.name ?? "").toLowerCase(), String(header.value ?? "")]));
    const receivedAt = parseDate(headers.get("date")) ?? new Date().toISOString();
    return {
      source: "gmail",
      connectionId: connection.id,
      id,
      threadId: typeof message.threadId === "string" ? message.threadId : undefined,
      from: headers.get("from") ?? "",
      subject: headers.get("subject") ?? "(no subject)",
      snippet: typeof message.snippet === "string" ? message.snippet : "",
      body: typeof message.snippet === "string" ? message.snippet : "",
      receivedAt,
      sourceUrl: `https://mail.google.com/mail/u/0/#inbox/${id}`,
      read: Array.isArray(message.labelIds) ? !message.labelIds.includes("UNREAD") : undefined,
      labels: Array.isArray(message.labelIds) ? message.labelIds.filter((label): label is string => typeof label === "string") : undefined
    };
  }
}

async function authedJson(url: string, tokens: OAuthTokenSet): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  if (!response.ok) throw new Error(`Gmail API request failed with HTTP ${response.status}.`);
  return response.json();
}

function parseDate(value: string | undefined): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

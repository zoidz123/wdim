import type { OAuthTokenSet } from "../oauth/types";
import type { AppStore } from "../store";
import type { NativeOAuthClient } from "./native-oauth-client";
import { NativeSourceConnector, type NativeProviderClient, type NativeProviderProfile } from "./native-base";
import type { SourceConnection, SourceCursor, SourceEvent, SourceScanContext } from "./types";

export class NativeTwitterConnector extends NativeSourceConnector {
  constructor(store: AppStore, oauth: NativeOAuthClient, provider: NativeProviderClient = new TwitterApiClient(), now?: () => Date) {
    super("twitter", store, oauth, provider, now);
  }
}

export class TwitterApiClient implements NativeProviderClient {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async getProfile(tokens: OAuthTokenSet): Promise<NativeProviderProfile> {
    const response = await twitterJson("https://api.twitter.com/2/users/me?user.fields=username,name", tokens) as { data?: Record<string, unknown> };
    const user = response.data ?? {};
    const id = typeof user.id === "string" ? user.id : "me";
    const username = typeof user.username === "string" ? user.username : id;
    return {
      externalId: id,
      label: `@${username}`,
      accountIdentifier: username,
      config: { userId: id, username }
    };
  }

  async scan(params: {
    connection: SourceConnection;
    tokens: OAuthTokenSet;
    cursor: SourceCursor | null;
    context?: SourceScanContext;
  }): Promise<{ events: SourceEvent[]; cursors?: SourceCursor[] }> {
    const userId = typeof params.connection.config.userId === "string" ? params.connection.config.userId : "me";
    const url = new URL(`https://api.twitter.com/2/users/${encodeURIComponent(userId)}/timelines/reverse_chronological`);
    url.searchParams.set("max_results", "25");
    url.searchParams.set("tweet.fields", "created_at,author_id,text,conversation_id,public_metrics,referenced_tweets");
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("user.fields", "id,username,name,verified,public_metrics");
    const scanSince = normalizeStartTime(params.context?.since ?? new Date(this.now().getTime() - 24 * 60 * 60 * 1000).toISOString());
    const windowStart = params.cursor?.cursorValue && isCursorInsideWindow(params.cursor, scanSince)
      ? undefined
      : scanSince;
    if (params.cursor?.cursorValue && !windowStart) url.searchParams.set("since_id", params.cursor.cursorValue);
    if (windowStart) url.searchParams.set("start_time", windowStart);
    const response = await twitterJson(url.toString(), params.tokens) as { data?: unknown[]; includes?: { users?: unknown[] } };
    const users = twitterUsersById(response.includes?.users);
    const events = (response.data ?? [])
      .map((item) => normalizeTweet(item, params.connection, users))
      .filter((event): event is SourceEvent => Boolean(event));
    return {
      events: windowStart
        ? events.filter((event) => event.source === "twitter" && new Date(event.receivedAt).getTime() >= new Date(windowStart).getTime())
        : events
    };
  }
}

async function twitterJson(url: string, tokens: OAuthTokenSet): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  if (!response.ok) throw new Error(`X API request failed with HTTP ${response.status}.`);
  return response.json();
}

function normalizeTweet(item: unknown, connection: SourceConnection, users: Map<string, Record<string, unknown>>): SourceEvent | null {
  if (!item || typeof item !== "object") return null;
  const data = item as Record<string, unknown>;
  const id = typeof data.id === "string" ? data.id : null;
  const text = typeof data.text === "string" ? data.text : "";
  if (!id) return null;
  const authorId = typeof data.author_id === "string" ? data.author_id : undefined;
  const author = authorId ? users.get(authorId) : undefined;
  const username = typeof author?.username === "string"
    ? author.username
    : typeof connection.config.username === "string" ? connection.config.username : connection.accountIdentifier ?? undefined;
  const displayName = typeof author?.name === "string" ? author.name : username;
  return {
    source: "twitter",
    connectionId: connection.id,
    id,
    title: text.slice(0, 80) || "X post",
    body: text,
    actor: username ? `@${username}` : displayName,
    url: username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/web/status/${id}`,
    receivedAt: typeof data.created_at === "string" ? data.created_at : new Date().toISOString(),
    metadata: {
      authorId,
      authorName: displayName,
      conversationId: data.conversation_id,
      publicMetrics: data.public_metrics,
      referencedTweets: data.referenced_tweets
    }
  };
}

function twitterUsersById(users: unknown[] | undefined): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of users ?? []) {
    if (!item || typeof item !== "object") continue;
    const user = item as Record<string, unknown>;
    if (typeof user.id === "string") byId.set(user.id, user);
  }
  return byId;
}

function normalizeStartTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function isCursorInsideWindow(cursor: SourceCursor, scanSince: string | undefined): boolean {
  if (!scanSince) return Boolean(cursor.cursorValue);
  const cursorUpdatedAt = new Date(cursor.updatedAt).getTime();
  const scanSinceMs = new Date(scanSince).getTime();
  if (Number.isNaN(cursorUpdatedAt) || Number.isNaN(scanSinceMs)) return Boolean(cursor.cursorValue);
  return cursorUpdatedAt >= scanSinceMs;
}

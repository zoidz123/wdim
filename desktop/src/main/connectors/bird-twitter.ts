import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { AppStore } from "../store";
import type { ConnectorHealth, SourceConnection, SourceCursor, SourceEvent, SourceScanContext } from "./types";

const execFileAsync = promisify(execFile);

// How many For You tweets to read per scan. bird paginates internally, so `-n`
// is the lever; 300 verified to return a full 300 in one call. The whole point
// of the product is to comb a large feed and surface only what matters.
const DEFAULT_HOME_COUNT = 300;

export type BirdRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

// The non-account variant of the SourceEvent union (the one with url/receivedAt/
// metadata). parseBirdTweets only ever produces twitter events of this shape.
type TwitterSourceEvent = Extract<SourceEvent, { source: "twitter" | "news" }>;

// Local, cookie-backed Twitter connector built on the `bird` CLI
// (https://npmjs.com/package/@steipete/bird). Reads the user's For You timeline
// using their browser session cookies — no X API keys. Read-only: this connector
// never calls bird's write commands (tweet/reply/follow).
export class BirdTwitterConnector {
  readonly source = "twitter" as const;
  readonly backend = "local" as const;
  private readonly runBird: BirdRunner;

  constructor(
    private readonly store: AppStore,
    private readonly now: () => Date = () => new Date(),
    runBird?: BirdRunner,
    birdCliPath?: string
  ) {
    this.runBird = runBird ?? ((args) => defaultBirdRunner(args, birdCliPath));
  }

  async listConnections(): Promise<SourceConnection[]> {
    return (await this.store.listSourceConnections())
      .filter((connection) => connection.source === "twitter" && connection.backend === "local");
  }

  // Confirms the user is logged into x.com in a supported browser by running
  // `bird whoami` and reading the @handle. Throws if no cookies are found.
  async verifyAccount(): Promise<{ username: string }> {
    const { stdout } = await this.runBird(["whoami"]);
    const username = parseBirdUsername(stdout);
    if (!username) throw new Error("Could not read your X login. Log into x.com in Chrome, then try again.");
    return { username };
  }

  async scan(connection: SourceConnection, context?: SourceScanContext): Promise<{
    events: SourceEvent[];
    cursors: SourceCursor[];
    health: ConnectorHealth;
  }> {
    const now = this.now().toISOString();
    try {
      const count = typeof connection.config?.homeCount === "number" ? connection.config.homeCount : DEFAULT_HOME_COUNT;
      const { stdout } = await this.runBird(["home", "-n", String(count), "--json"]);
      const allEvents = parseBirdTweets(stdout, connection);
      const events = filterByWindow(allEvents, context?.since);
      const newestAt = newestReceivedAt(events);
      console.info("[bird] home scan complete", {
        connectionId: connection.id,
        fetched: allEvents.length,
        withinWindow: events.length
      });
      return {
        events,
        cursors: newestAt ? [{
          connectionId: connection.id,
          cursorKey: "twitter:home:last_tweet_at",
          cursorValue: newestAt,
          updatedAt: now
        }] : [],
        health: {
          connectionId: connection.id,
          status: "ready",
          detail: "X / Twitter source ready",
          checkedAt: now
        }
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        events: [],
        cursors: [],
        health: {
          connectionId: connection.id,
          status: /cookie|credential|auth/i.test(message) ? "needs_auth" : "error",
          detail: message,
          checkedAt: now
        }
      };
    }
  }
}

export function parseBirdUsername(stdout: string): string | null {
  const match = stdout.match(/@([A-Za-z0-9_]{1,15})/);
  return match ? match[1] : null;
}

export function parseBirdTweets(stdout: string, connection: SourceConnection): TwitterSourceEvent[] {
  const raw = safeJsonParse(stdout);
  const tweets = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.tweets)
      ? raw.tweets
      : [];
  return tweets
    .map((tweet) => normalizeTweet(tweet, connection))
    .filter((event): event is TwitterSourceEvent => Boolean(event));
}

function normalizeTweet(tweet: unknown, connection: SourceConnection): TwitterSourceEvent | null {
  if (!isRecord(tweet)) return null;
  const id = typeof tweet.id === "string" ? tweet.id : typeof tweet.id === "number" ? String(tweet.id) : "";
  const text = typeof tweet.text === "string" ? tweet.text : "";
  if (!id || !text) return null;

  const author = isRecord(tweet.author) ? tweet.author : undefined;
  const username = typeof author?.username === "string"
    ? author.username
    : typeof tweet.username === "string" ? tweet.username : undefined;
  const displayName = typeof author?.name === "string"
    ? author.name
    : typeof tweet.name === "string" ? tweet.name : username;
  const authorId = typeof tweet.authorId === "string"
    ? tweet.authorId
    : typeof author?.id === "string" ? author.id : undefined;

  const publicMetrics = compactMetrics({
    like_count: tweet.likeCount,
    reply_count: tweet.replyCount,
    retweet_count: tweet.retweetCount
  });

  return {
    source: "twitter",
    connectionId: connection.id,
    id,
    title: text.slice(0, 80) || "X post",
    body: text,
    actor: username ? `@${username}` : displayName,
    url: username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/web/status/${id}`,
    receivedAt: typeof tweet.createdAt === "string" ? tweet.createdAt : new Date().toISOString(),
    metadata: {
      authorId,
      username,
      displayName,
      conversationId: typeof tweet.conversationId === "string" ? tweet.conversationId : undefined,
      ...(publicMetrics ? { publicMetrics } : {})
    }
  };
}

function filterByWindow(events: TwitterSourceEvent[], since: string | undefined): TwitterSourceEvent[] {
  if (!since) return events;
  const sinceMs = new Date(since).getTime();
  if (Number.isNaN(sinceMs)) return events;
  return events.filter((event) => new Date(event.receivedAt).getTime() >= sinceMs);
}

function newestReceivedAt(events: TwitterSourceEvent[]): string | undefined {
  let newest: string | undefined;
  for (const event of events) {
    if (!newest || new Date(event.receivedAt).getTime() > new Date(newest).getTime()) newest = event.receivedAt;
  }
  return newest;
}

function compactMetrics(values: Record<string, unknown>): Record<string, number> | undefined {
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value;
  }
  return Object.keys(metrics).length ? metrics : undefined;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function defaultBirdRunner(args: string[], preferredCliPath?: string): Promise<{ stdout: string; stderr: string }> {
  const options = { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 } as const;

  // Prefer the bundled dist/bird.mjs run through the current runtime as Node
  // (ELECTRON_RUN_AS_NODE), then fall back to a `bird` on PATH. A plain Node
  // child cannot read inside app.asar, so map to the unpacked copy.
  const cli = preferredCliPath ? unpackedAsarPath(preferredCliPath) : undefined;
  if (cli && existsSync(cli)) {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      ...options,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  }

  const result = await execFileAsync("bird", args, options);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export function unpackedAsarPath(filePath: string): string {
  return filePath.replace("app.asar/", "app.asar.unpacked/");
}

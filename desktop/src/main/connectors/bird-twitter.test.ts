import { describe, expect, test } from "bun:test";
import { compactBirdError, isBirdAuthFailure, parseBirdTweets, parseBirdUsername } from "./bird-twitter";
import type { SourceConnection } from "./types";

const connection: SourceConnection = {
  id: "twitter:local:home",
  source: "twitter",
  backend: "local",
  label: "X / Twitter",
  accountIdentifier: "home",
  externalAccountId: null,
  enabled: true,
  config: {},
  connectedAt: "2026-06-10T00:00:00.000Z",
  updatedAt: "2026-06-10T00:00:00.000Z"
};

// Shape verified against `bird home -n N --json` during the integration spike.
const sample = JSON.stringify([
  {
    id: "1",
    text: "OpenAI is acquiring @ona_hq.",
    author: { username: "OpenAINewsroom", name: "OpenAI Newsroom" },
    authorId: "111",
    createdAt: "2026-06-10T09:00:00.000Z",
    conversationId: "1",
    likeCount: 405,
    replyCount: 12,
    retweetCount: 30
  },
  {
    id: "2",
    text: "Dario on why he started Anthropic.",
    author: { username: "kimmonismus" },
    authorId: "222",
    createdAt: "2026-06-10T08:00:00.000Z",
    conversationId: "2",
    likeCount: 1855
  }
]);

describe("parseBirdTweets", () => {
  test("maps bird home JSON to twitter SourceEvents", () => {
    const events = parseBirdTweets(sample, connection);
    expect(events).toHaveLength(2);
    const [first] = events;
    expect(first).toMatchObject({
      source: "twitter",
      connectionId: "twitter:local:home",
      id: "1",
      body: "OpenAI is acquiring @ona_hq.",
      actor: "@OpenAINewsroom",
      url: "https://x.com/OpenAINewsroom/status/1",
      receivedAt: "2026-06-10T09:00:00.000Z"
    });
    expect(first?.metadata).toMatchObject({
      username: "OpenAINewsroom",
      displayName: "OpenAI Newsroom",
      conversationId: "1",
      authorId: "111",
      publicMetrics: { like_count: 405, reply_count: 12, retweet_count: 30 }
    });
  });

  test("falls back to the web status URL when username is missing", () => {
    const events = parseBirdTweets(JSON.stringify([
      { id: "9", text: "no author", createdAt: "2026-06-10T07:00:00.000Z" }
    ]), connection);
    expect(events[0]?.url).toBe("https://x.com/i/web/status/9");
  });

  test("skips entries without an id or text", () => {
    const events = parseBirdTweets(JSON.stringify([
      { id: "", text: "x" },
      { id: "5" },
      { id: "6", text: "keep me" }
    ]), connection);
    expect(events.map((event) => event.id)).toEqual(["6"]);
  });

  test("tolerates a { tweets: [...] } envelope and bad JSON", () => {
    const wrapped = JSON.stringify({ tweets: [{ id: "7", text: "wrapped", createdAt: "2026-06-10T06:00:00.000Z" }] });
    expect(parseBirdTweets(wrapped, connection).map((e) => e.id)).toEqual(["7"]);
    expect(parseBirdTweets("not json", connection)).toEqual([]);
  });
});

describe("parseBirdUsername", () => {
  test("reads the @handle from whoami output", () => {
    expect(parseBirdUsername("🙋 @Mysterious35725 (mysteriouscreature)\n🪪 1948208458337296384")).toBe("Mysterious35725");
  });

  test("returns null when no handle is present", () => {
    expect(parseBirdUsername("❌ Missing required credentials")).toBeNull();
  });
});

describe("isBirdAuthFailure", () => {
  test("transient X server errors are not auth failures, even with Safari cookie warnings present", () => {
    const message = [
      "Command failed: /Applications/wdim.app/Contents/MacOS/wdim bird.mjs home -n 300 --json",
      "⚠️ Failed to read Safari cookies: EPERM: operation not permitted, open '/Users/u/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'",
      "⚠️ No Twitter cookies found in Safari. Make sure you are logged into x.com in Safari.",
      "❌ Failed to fetch home timeline: Internal server error, Internal server error, Internal server error"
    ].join("\n");
    expect(isBirdAuthFailure(message)).toBe(false);
  });

  test("missing login is an auth failure", () => {
    expect(isBirdAuthFailure("Could not read your X login. Log into x.com in Chrome, Brave, Edge, or Firefox, then try again.")).toBe(true);
    expect(isBirdAuthFailure("❌ No Twitter cookies found in any browser.")).toBe(true);
  });

  test("unauthorized fatal line is an auth failure", () => {
    expect(isBirdAuthFailure("⚠️ No Twitter cookies found in Safari.\n❌ Failed to fetch home timeline: Unauthorized")).toBe(true);
  });
});

describe("compactBirdError", () => {
  test("collapses repeated per-page errors into one line", () => {
    const message = [
      "⚠️ Failed to read Safari cookies: EPERM",
      `❌ Failed to fetch home timeline: ${Array(90).fill("Internal server error").join(", ")}`
    ].join("\n");
    const compact = compactBirdError(message);
    expect(compact).toBe("❌ Failed to fetch home timeline: Internal server error");
  });

  test("falls back to the raw message when there is no fatal line", () => {
    expect(compactBirdError("spawn bird ENOENT")).toBe("spawn bird ENOENT");
  });
});

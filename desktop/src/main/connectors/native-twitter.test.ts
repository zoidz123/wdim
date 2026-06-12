import { describe, expect, test } from "bun:test";
import type { NativeProviderClient } from "./native-base";
import { NativeTwitterConnector, TwitterApiClient } from "./native-twitter";
import { nativeConnectorFixture } from "./native-test-helpers";

describe("NativeTwitterConnector", () => {
  test("scans through native OAuth tokens", async () => {
    const fixture = await nativeConnectorFixture("twitter");
    const provider: NativeProviderClient = {
      async getProfile() {
        return { externalId: "u123", label: "@wdim", accountIdentifier: "wdim" };
      },
      async scan({ connection, tokens }) {
        expect(tokens.accessToken).toBe("access_123");
        return {
          events: [{
            source: "twitter",
            connectionId: connection.id,
            id: "123456789",
            title: "New post",
            body: "New post body",
            receivedAt: "2026-01-01T00:00:00.000Z"
          }]
        };
      }
    };

    const connector = new NativeTwitterConnector(fixture.store, fixture.oauth, provider);
    const result = await connector.scan(fixture.connection);

    expect(result.health.status).toBe("ready");
    expect(result.events[0]?.source).toBe("twitter");
    expect(result.cursors[0]?.cursorKey).toBe("timeline_newest_id");
  });

  test("limits first timeline scans to the scan window", async () => {
    const fixture = await nativeConnectorFixture("twitter");
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({
        data: [
          {
            id: "200",
            author_id: "author_1",
            text: "inside window",
            created_at: "2026-01-02T11:00:00.000Z"
          },
          {
            id: "100",
            text: "too old",
            created_at: "2025-12-31T12:00:00.000Z"
          }
        ],
        includes: {
          users: [{
            id: "author_1",
            username: "timeline_author",
            name: "Timeline Author"
          }]
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    try {
      const result = await new TwitterApiClient(() => new Date("2026-01-02T12:00:00.000Z")).scan({
        connection: fixture.connection,
        tokens: fixture.tokens,
        cursor: null,
        context: { since: "2026-01-01T12:00:00.000Z" }
      });

      const url = new URL(requestedUrl);
      expect(url.pathname).toBe("/2/users/u123/timelines/reverse_chronological");
      expect(url.searchParams.get("start_time")).toBe("2026-01-01T12:00:00.000Z");
      expect(url.searchParams.get("expansions")).toBe("author_id");
      expect(result.events.map((event) => event.id)).toEqual(["200"]);
      const event = result.events[0];
      expect(event?.source).toBe("twitter");
      if (event?.source !== "twitter") throw new Error("Expected Twitter event");
      expect(event.actor).toBe("@timeline_author");
      expect(event.url).toBe("https://x.com/timeline_author/status/200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses newest cursor for incremental timeline scans", async () => {
    const fixture = await nativeConnectorFixture("twitter");
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    try {
      await new TwitterApiClient(() => new Date("2026-01-02T12:00:00.000Z")).scan({
        connection: fixture.connection,
        tokens: fixture.tokens,
        cursor: {
          connectionId: fixture.connection.id,
          cursorKey: "timeline_newest_id",
          cursorValue: "2063987203831652678",
          updatedAt: "2026-01-02T11:55:00.000Z"
        },
        context: { since: "2026-01-02T11:00:00.000Z" }
      });

      const url = new URL(requestedUrl);
      expect(url.pathname).toBe("/2/users/u123/timelines/reverse_chronological");
      expect(url.searchParams.get("since_id")).toBe("2063987203831652678");
      expect(url.searchParams.has("start_time")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

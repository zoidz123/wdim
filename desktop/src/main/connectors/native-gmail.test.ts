import { describe, expect, test } from "bun:test";
import type { NativeProviderClient } from "./native-base";
import { NativeGmailConnector } from "./native-gmail";
import { nativeConnectorFixture } from "./native-test-helpers";

describe("NativeGmailConnector", () => {
  test("scans through native OAuth tokens", async () => {
    const fixture = await nativeConnectorFixture("gmail");
    const provider: NativeProviderClient = {
      async getProfile() {
        return { externalId: "me@example.com", label: "me@example.com", accountIdentifier: "me@example.com" };
      },
      async scan({ connection, tokens }) {
        expect(tokens.accessToken).toBe("access_123");
        return {
          events: [{
            source: "gmail",
            connectionId: connection.id,
            id: "msg_1",
            from: "sender@example.com",
            subject: "Planning",
            snippet: "Can you review this?",
            body: "Can you review this?",
            receivedAt: "2026-01-01T00:00:00.000Z",
            read: false
          }]
        };
      }
    };

    const connector = new NativeGmailConnector(fixture.store, fixture.oauth, provider);
    const result = await connector.scan(fixture.connection);

    expect(result.health.status).toBe("ready");
    expect(result.events[0]?.source).toBe("gmail");
    expect(result.cursors[0]?.cursorKey).toBe("last_seen_at");
  });
});

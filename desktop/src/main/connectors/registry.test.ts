import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { AppStore } from "../store";
import { createConnectorRegistry } from "./registry";
import type { SourceConnector } from "./types";

describe("connector registry", () => {
  test("lists local Telegram connections and marks local Gmail as legacy", async () => {
    const store = new AppStore(await writeState(null));
    await store.upsertAccount({
      id: "work@example.com",
      email: "work@example.com",
      displayName: "Work",
      connectedAt: "2026-06-04T10:00:00.000Z"
    });
    await store.replaceTelegramChats([
      { id: "user:10", title: "Maya", enabled: true, kind: "dm" },
      { id: "chat:20", title: "Launch group", enabled: true, kind: "group" },
      { id: "channel:30", title: "Announcements", enabled: false, kind: "channel" }
    ]);
    const registry = createConnectorRegistry(store, {
      telegram: {
        fetchRecentMessages: async () => []
      }
    });

    const connections = await registry.listEnabledConnections();

    expect(await registry.getLegacyLocalGmailAccounts()).toEqual([{
      id: "work@example.com",
      email: "work@example.com",
      displayName: "Work",
      connectedAt: "2026-06-04T10:00:00.000Z"
    }]);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.connection).toMatchObject({
      id: "telegram:local:account",
      source: "telegram",
      backend: "local",
      label: "Telegram",
      accountIdentifier: "local",
      config: {
        includeDms: true,
        selectedChatIds: ["chat:20"]
      }
    });
  });

  test("includes enabled native connections when a source connector is available", async () => {
    const store = new AppStore(await writeState(null));
    await store.updateSettings({ telegramIncludeDms: false });
    await store.saveSourceConnection({
      id: "twitter:native:kevin",
      source: "twitter",
      backend: "native",
      label: "Kevin X",
      accountIdentifier: "kevin",
      externalAccountId: null,
      enabled: true,
      config: { tokenId: "token_123" },
      connectedAt: "2026-06-04T10:00:00.000Z",
      updatedAt: "2026-06-04T10:00:00.000Z"
    });
    const twitterConnector = fakeConnector("twitter", "native");
    const registry = createConnectorRegistry(store, {
      telegram: { fetchRecentMessages: async () => [] },
      nativeConnectors: { twitter: twitterConnector }
    });

    const connections = await registry.listEnabledConnections();

    expect(connections).toHaveLength(1);
    expect(connections[0]?.connector).toBe(twitterConnector);
    expect(connections[0]?.connection.id).toBe("twitter:native:kevin");
  });

  test("does not list local Telegram when DMs are selected but the account is disconnected", async () => {
    const store = new AppStore(await writeState(null));
    const registry = createConnectorRegistry(store, {
      telegram: {
        fetchRecentMessages: async () => [],
        isConnected: async () => false
      }
    });

    const connections = await registry.listEnabledConnections();

    expect(connections).toEqual([]);
  });

  test("includes enabled native provider connections", async () => {
    const store = new AppStore(await writeState(null));
    await store.saveSourceConnection({
      id: "twitter:native:zoid",
      source: "twitter",
      backend: "native",
      label: "Zoid X",
      accountIdentifier: "zoid",
      externalAccountId: null,
      enabled: true,
      config: { tokenId: "token_123" },
      connectedAt: "2026-06-04T10:00:00.000Z",
      updatedAt: "2026-06-04T10:00:00.000Z"
    });
    const twitterConnector = fakeConnector("twitter", "native");
    const registry = createConnectorRegistry(store, {
      telegram: { fetchRecentMessages: async () => [] },
      nativeConnectors: { twitter: twitterConnector }
    });

    const connections = await registry.listEnabledConnections();

    const twitter = connections.find((item) => item.connection.id === "twitter:native:zoid");
    expect(twitter?.connector).toBe(twitterConnector);
    expect(twitter?.connection.backend).toBe("native");
  });

  test("ignores deprecated local X repo connections", async () => {
    const store = new AppStore(await writeState(null));
    await store.saveSourceConnection({
      id: "twitter:repo:openai/codex",
      source: "twitter",
      backend: "local",
      label: "openai/codex",
      accountIdentifier: "openai/codex",
      externalAccountId: null,
      enabled: true,
      config: { owner: "openai", repo: "codex" },
      connectedAt: "2026-06-04T10:00:00.000Z",
      updatedAt: "2026-06-04T10:00:00.000Z"
    });
    const registry = createConnectorRegistry(store, {
      telegram: {
        fetchRecentMessages: async () => [],
        isConnected: async () => false
      }
    });

    await expect(registry.listEnabledConnections()).resolves.toEqual([]);
  });
});

async function writeState(value: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "what-did-i-miss-registry-"));
  const filePath = path.join(dir, "state.json");
  if (value !== null) await fs.writeFile(filePath, JSON.stringify(value));
  return filePath;
}

function fakeConnector(source: "twitter" | "gmail", backend: "native" = "native"): SourceConnector {
  return {
    source,
    backend,
    listConnections: async () => [],
    scan: async (connection) => ({
      events: [],
      cursors: [],
      health: {
        connectionId: connection.id,
        status: "ready",
        detail: "ok",
        checkedAt: "2026-06-04T10:00:00.000Z"
      }
    })
  };
}

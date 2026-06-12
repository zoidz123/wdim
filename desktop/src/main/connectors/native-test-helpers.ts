import os from "node:os";
import path from "node:path";
import type { AppStore } from "../store";
import { OAuthTokenStore } from "../oauth/token-store";
import type { OAuthProvider, OAuthTokenSet } from "../oauth/types";
import { NativeOAuthClient } from "./native-oauth-client";
import type { SourceConnection } from "./types";
import { makeSourceConnectionId } from "./types";

export async function nativeConnectorFixture(provider: OAuthProvider): Promise<{
  store: AppStore;
  oauth: NativeOAuthClient;
  connection: SourceConnection;
  tokens: OAuthTokenSet;
}> {
  const { AppStore } = await import("../store");
  const root = path.join(os.tmpdir(), `wdim-native-${provider}-${Date.now()}-${Math.random()}`);
  const store = new AppStore(path.join(root, "state.json"));
  const tokenStore = new OAuthTokenStore(path.join(root, "tokens"));
  const oauth = new NativeOAuthClient({
    [provider]: {
      provider,
      clientId: "client_123",
      authorizationUrl: "https://example.com/oauth/authorize",
      tokenUrl: "https://example.com/oauth/token",
      scopes: ["read"]
    }
  }, tokenStore);
  const tokens = await tokenStore.save(provider, { accessToken: "access_123" }, "token_123");
  const connection: SourceConnection = {
    id: makeSourceConnectionId(provider, "native", "account_123"),
    source: provider,
    backend: "native",
    label: `${provider} account`,
    accountIdentifier: "account_123",
    externalAccountId: null,
    enabled: true,
    config: provider === "twitter"
        ? { tokenId: tokens.tokenId, userId: "u123", username: "wdim" }
        : { tokenId: tokens.tokenId },
    connectedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  await store.saveSourceConnection(connection);
  return { store, oauth, connection, tokens };
}

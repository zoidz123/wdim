import os from "node:os";
import path from "node:path";
import http from "node:http";
import { describe, expect, test } from "bun:test";
import { OAuthTokenStore } from "../oauth/token-store";
import { NativeOAuthClient } from "./native-oauth-client";

describe("NativeOAuthClient", () => {
  test("creates a PKCE authorize URL and stores exchanged tokens", async () => {
    const root = path.join(os.tmpdir(), `wdim-oauth-client-${Date.now()}-${Math.random()}`);
    const tokenStore = new OAuthTokenStore(root);
    const client = new NativeOAuthClient({
      twitter: {
        provider: "twitter",
        clientId: "client_123",
        authorizationUrl: "https://x.com/i/oauth2/authorize",
        tokenUrl: "https://api.twitter.com/2/oauth2/token",
        scopes: ["tweet.read", "users.read", "offline.access"],
        redirectUri: "http://127.0.0.1:53148/oauth/callback/twitter",
        usePkce: true
      }
    }, tokenStore, async ({ code }) => ({
      accessToken: `access_for_${code}`,
      refreshToken: "refresh_123"
    }));

    const request = await client.startConnection("twitter", "X");
    const authorizeUrl = new URL(request.redirectUrl);
    expect(authorizeUrl.origin).toBe("https://x.com");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client_123");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:53148/oauth/callback/twitter");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("scope")).toBe("tweet.read users.read offline.access");

    const pendingResult = await client.completeConnection(request.requestId).then(
      () => {
        throw new Error("Expected pending OAuth completion to reject.");
      },
      (error) => error as Error
    );
    expect(pendingResult.message).toBe("OAuth connection is still pending.");

    await fetch(`${request.redirectUri}?code=code_123&state=${authorizeUrl.searchParams.get("state")}`);
    const result = await client.completeConnection(request.requestId);
    const stored = await client.loadTokens("twitter", result.tokenId);

    expect(result.tokens.accessToken).toBe("access_for_code_123");
    expect(stored?.refreshToken).toBe("refresh_123");
  });

  test("exchanges public PKCE tokens without a client secret", async () => {
    const root = path.join(os.tmpdir(), `wdim-oauth-client-${Date.now()}-${Math.random()}`);
    const tokenStore = new OAuthTokenStore(root);
    let authorizationHeader = "";
    let requestBody = "";
    const server = http.createServer((request, response) => {
      authorizationHeader = String(request.headers.authorization ?? "");
      request.on("data", (chunk) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "access_123", token_type: "bearer" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(53149, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const client = new NativeOAuthClient({
        twitter: {
          provider: "twitter",
          clientId: "client_123",
          authorizationUrl: "https://x.com/i/oauth2/authorize",
          tokenUrl: "http://127.0.0.1:53149/token",
          scopes: ["tweet.read"],
          redirectUri: "http://127.0.0.1:53150/oauth/callback/twitter",
          usePkce: true
        }
      }, tokenStore);

      const request = await client.startConnection("twitter", "X");
      const authorizeUrl = new URL(request.redirectUrl);
      await fetch(`${request.redirectUri}?code=code_123&state=${authorizeUrl.searchParams.get("state")}`);
      await client.completeConnection(request.requestId);

      expect(authorizationHeader).toBe("");
      expect(requestBody).toContain("client_id=client_123");
      expect(requestBody).toContain("code=code_123");
      expect(requestBody).toContain("code_verifier=");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("refreshes expired tokens and preserves the existing refresh token", async () => {
    const root = path.join(os.tmpdir(), `wdim-oauth-refresh-${Date.now()}-${Math.random()}`);
    const tokenStore = new OAuthTokenStore(root);
    const saved = await tokenStore.save("twitter", {
      accessToken: "old_access",
      refreshToken: "refresh_123",
      expiresAt: "2026-01-01T00:00:00.000Z"
    }, "token_123");
    let requestBody = "";
    const server = http.createServer((request, response) => {
      request.on("data", (chunk) => {
        requestBody += chunk.toString();
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          access_token: "new_access",
          expires_in: 3600,
          token_type: "bearer"
        }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(53151, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    try {
      const client = new NativeOAuthClient({
        twitter: {
          provider: "twitter",
          clientId: "client_123",
          authorizationUrl: "https://x.com/i/oauth2/authorize",
          tokenUrl: "http://127.0.0.1:53151/token",
          scopes: ["tweet.read"],
          usePkce: true
        }
      }, tokenStore, undefined, () => new Date("2026-01-01T00:10:00.000Z"));

      const tokens = await client.loadFreshTokens("twitter", saved.tokenId);
      const stored = await client.loadTokens("twitter", saved.tokenId);

      expect(tokens?.accessToken).toBe("new_access");
      expect(tokens?.refreshToken).toBe("refresh_123");
      expect(stored?.accessToken).toBe("new_access");
      expect(stored?.refreshToken).toBe("refresh_123");
      expect(requestBody).toContain("grant_type=refresh_token");
      expect(requestBody).toContain("refresh_token=refresh_123");
      expect(requestBody).toContain("client_id=client_123");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("requires reconnect when an expired token has no refresh token", async () => {
    const root = path.join(os.tmpdir(), `wdim-oauth-refresh-missing-${Date.now()}-${Math.random()}`);
    const tokenStore = new OAuthTokenStore(root);
    const saved = await tokenStore.save("twitter", {
      accessToken: "old_access",
      expiresAt: "2026-01-01T00:00:00.000Z"
    }, "token_123");
    const client = new NativeOAuthClient({
      twitter: {
        provider: "twitter",
        clientId: "client_123",
        authorizationUrl: "https://x.com/i/oauth2/authorize",
        tokenUrl: "https://api.twitter.com/2/oauth2/token",
        scopes: ["tweet.read"],
        usePkce: true
      }
    }, tokenStore, undefined, () => new Date("2026-01-01T00:10:00.000Z"));

    await expect(client.loadFreshTokens("twitter", saved.tokenId)).rejects.toThrow("reconnect");
  });
});

import type { OAuthCallbackServer } from "../oauth/local-callback";
import { startOAuthCallbackServer } from "../oauth/local-callback";
import { createOAuthState, pkceChallengeFromVerifier, randomBase64Url } from "../oauth/pkce";
import { OAuthTokenStore } from "../oauth/token-store";
import type { OAuthClientConfig, OAuthConnectionRequest, OAuthConnectionResult, OAuthProvider, OAuthTokenSet } from "../oauth/types";

type PendingOAuthRequest = {
  provider: OAuthProvider;
  label: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  callback: OAuthCallbackServer;
};

export type OAuthTokenExchanger = (request: {
  config: OAuthClientConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) => Promise<OAuthTokenSet>;

export class NativeOAuthClient {
  private readonly pending = new Map<string, PendingOAuthRequest>();

  constructor(
    private readonly configs: Partial<Record<OAuthProvider, OAuthClientConfig>>,
    private readonly tokenStore: OAuthTokenStore,
    private readonly exchangeTokens: OAuthTokenExchanger = exchangeOAuthCode,
    private readonly now: () => Date = () => new Date()
  ) {}

  async startConnection(provider: OAuthProvider, label: string): Promise<OAuthConnectionRequest> {
    const config = this.configFor(provider);
    const oauthState = createOAuthState();
    const callback = await startOAuthCallbackServer({
      expectedState: oauthState.state,
      ...callbackOptionsFromRedirectUri(config.redirectUri)
    });
    const redirectUri = config.redirectUri ?? callback.redirectUri;
    const redirectUrl = await this.buildAuthorizeUrl(config, {
      state: oauthState.state,
      codeVerifier: oauthState.codeVerifier,
      redirectUri
    });
    const requestId = randomBase64Url(18);
    this.pending.set(requestId, {
      provider,
      label,
      state: oauthState.state,
      codeVerifier: oauthState.codeVerifier,
      redirectUri,
      callback
    });
    return {
      requestId,
      provider,
      redirectUrl,
      redirectUri
    };
  }

  async completeConnection(requestId: string): Promise<OAuthConnectionResult> {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("OAuth connection request is no longer pending.");
    let keepPending = false;
    try {
      const { code } = await waitForCallbackResult(pending.callback.result);
      const tokens = await this.exchangeTokens({
        config: this.configFor(pending.provider),
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri
      });
      const stored = await this.tokenStore.save(pending.provider, tokens);
      return {
        provider: pending.provider,
        tokenId: stored.tokenId,
        tokens
      };
    } catch (error) {
      keepPending = error instanceof Error && error.message === "OAuth connection is still pending.";
      throw error;
    } finally {
      if (!keepPending) {
        this.pending.delete(requestId);
        await pending.callback.close();
      }
    }
  }

  async loadTokens(provider: OAuthProvider, tokenId: string): Promise<OAuthTokenSet | null> {
    return this.tokenStore.load(provider, tokenId);
  }

  async loadFreshTokens(provider: OAuthProvider, tokenId: string): Promise<OAuthTokenSet | null> {
    const tokens = await this.tokenStore.load(provider, tokenId);
    if (!tokens) return null;
    if (!shouldRefresh(tokens, this.now())) return tokens;
    if (!tokens.refreshToken) throw new Error("Native OAuth token expired. Please reconnect this account.");
    const refreshed = await refreshOAuthToken({
      config: this.configFor(provider),
      refreshToken: tokens.refreshToken
    });
    const merged: OAuthTokenSet = {
      ...tokens,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken
    };
    await this.tokenStore.save(provider, merged, tokenId);
    return merged;
  }

  private async buildAuthorizeUrl(config: OAuthClientConfig, request: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string> {
    const url = new URL(config.authorizationUrl);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.scopes.join(" "));
    url.searchParams.set("state", request.state);
    for (const [key, value] of Object.entries(config.extraAuthorizeParams ?? {})) {
      url.searchParams.set(key, value);
    }
    if (config.usePkce !== false) {
      url.searchParams.set("code_challenge", await pkceChallengeFromVerifier(request.codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  private configFor(provider: OAuthProvider): OAuthClientConfig {
    const config = this.configs[provider];
    if (!config) throw new Error(`${provider} OAuth is not configured.`);
    return config;
  }
}

function shouldRefresh(tokens: OAuthTokenSet, now: Date): boolean {
  if (!tokens.expiresAt) return false;
  const expiresAt = new Date(tokens.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - now.getTime() <= 5 * 60 * 1000;
}

async function waitForCallbackResult(result: Promise<{ code: string; state: string }>): Promise<{ code: string; state: string }> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("OAuth connection is still pending.")), 250);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function callbackOptionsFromRedirectUri(redirectUri: string | undefined): {
  host?: string;
  port?: number;
  path?: string;
} {
  if (!redirectUri) return {};
  const url = new URL(redirectUri);
  if (url.protocol !== "http:") throw new Error("Native OAuth redirect URI must use http.");
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("Native OAuth redirect URI must use localhost or 127.0.0.1.");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port <= 0) throw new Error("Native OAuth redirect URI must include a fixed port.");
  return {
    host: url.hostname,
    port,
    path: url.pathname || "/oauth/callback"
  };
}

async function exchangeOAuthCode(request: {
  config: OAuthClientConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: request.config.clientId,
    code: request.code,
    redirect_uri: request.redirectUri
  });
  if (request.config.usePkce !== false) body.set("code_verifier", request.codeVerifier);
  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/x-www-form-urlencoded"
  };
  if (request.config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${request.config.clientId}:${request.config.clientSecret}`).toString("base64")}`;
  }

  const response = await fetch(request.config.tokenUrl, {
    method: "POST",
    headers,
    body
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") {
    const detail = typeof data.error_description === "string"
      ? data.error_description
      : typeof data.error === "string" ? data.error : response.statusText;
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    tokenType: typeof data.token_type === "string" ? data.token_type : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    expiresAt: typeof data.expires_in === "number"
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined,
    raw: data
  };
}

async function refreshOAuthToken(request: {
  config: OAuthClientConfig;
  refreshToken: string;
}): Promise<OAuthTokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: request.config.clientId,
    refresh_token: request.refreshToken
  });
  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/x-www-form-urlencoded"
  };
  if (request.config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${request.config.clientId}:${request.config.clientSecret}`).toString("base64")}`;
  }

  const response = await fetch(request.config.tokenUrl, {
    method: "POST",
    headers,
    body
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof data.access_token !== "string") {
    const detail = typeof data.error_description === "string"
      ? data.error_description
      : typeof data.error === "string" ? data.error : response.statusText;
    throw new Error(`OAuth token refresh failed: ${detail}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    tokenType: typeof data.token_type === "string" ? data.token_type : undefined,
    scope: typeof data.scope === "string" ? data.scope : undefined,
    expiresAt: typeof data.expires_in === "number"
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : undefined,
    raw: data
  };
}

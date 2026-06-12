import type { ConnectorSource } from "../connectors/types";

export type OAuthProvider = Extract<ConnectorSource, "gmail" | "twitter">;

export type OAuthClientConfig = {
  provider: OAuthProvider;
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri?: string;
  usePkce?: boolean;
  extraAuthorizeParams?: Record<string, string>;
};

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: string;
  raw?: Record<string, unknown>;
};

export type StoredOAuthTokens = OAuthTokenSet & {
  provider: OAuthProvider;
  tokenId: string;
  updatedAt: string;
};

export type OAuthConnectionRequest = {
  requestId: string;
  provider: OAuthProvider;
  redirectUrl: string;
  redirectUri: string;
};

export type OAuthConnectionResult = {
  tokenId: string;
  provider: OAuthProvider;
  tokens: OAuthTokenSet;
};

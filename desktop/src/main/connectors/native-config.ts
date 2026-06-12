import type { OAuthClientConfig, OAuthProvider } from "../oauth/types";

export const NATIVE_OAUTH_SCOPES: Record<OAuthProvider, string[]> = {
  gmail: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.readonly"
  ],
  twitter: [
    "tweet.read",
    "users.read",
    "offline.access"
  ]
};

export function loadNativeOAuthConfigs(env: NodeJS.ProcessEnv = process.env): Partial<Record<OAuthProvider, OAuthClientConfig>> {
  return {
    gmail: clientConfig("gmail", env.WDIM_GMAIL_CLIENT_ID, {
      clientSecret: env.WDIM_GMAIL_CLIENT_SECRET,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      extraAuthorizeParams: {
        access_type: "offline",
        prompt: "consent"
      }
    }),
    twitter: clientConfig("twitter", env.WDIM_TWITTER_CLIENT_ID, {
      authorizationUrl: "https://x.com/i/oauth2/authorize",
      tokenUrl: "https://api.twitter.com/2/oauth2/token",
      redirectUri: env.WDIM_TWITTER_REDIRECT_URI || "http://127.0.0.1:53145/oauth/callback/twitter",
      usePkce: true
    })
  };
}

export function enabledNativeSources(configs: Partial<Record<OAuthProvider, OAuthClientConfig>>): OAuthProvider[] {
  return (Object.keys(NATIVE_OAUTH_SCOPES) as OAuthProvider[])
    .filter((source) => Boolean(configs[source]?.clientId));
}

function clientConfig(
  provider: OAuthProvider,
  clientId: string | undefined,
  options: Omit<OAuthClientConfig, "provider" | "clientId" | "scopes">
): OAuthClientConfig | undefined {
  if (!clientId) return undefined;
  return {
    provider,
    clientId,
    scopes: NATIVE_OAUTH_SCOPES[provider],
    usePkce: true,
    ...options
  };
}

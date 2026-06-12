import { describe, expect, test } from "bun:test";
import { loadNativeOAuthConfigs } from "./native-config";

describe("native OAuth config", () => {
  test("uses the current X OAuth authorize host", () => {
    const configs = loadNativeOAuthConfigs({
      WDIM_TWITTER_CLIENT_ID: "client_123"
    });

    expect(configs.twitter?.authorizationUrl).toBe("https://x.com/i/oauth2/authorize");
    expect(configs.twitter?.clientSecret).toBeUndefined();
    expect(configs.twitter?.tokenUrl).toBe("https://api.twitter.com/2/oauth2/token");
    expect(configs.twitter?.redirectUri).toBe("http://127.0.0.1:53145/oauth/callback/twitter");
  });

  test("allows overriding the X callback URL for local port conflicts", () => {
    const configs = loadNativeOAuthConfigs({
      WDIM_TWITTER_CLIENT_ID: "client_123",
      WDIM_TWITTER_REDIRECT_URI: "http://127.0.0.1:53147/oauth/callback/twitter"
    });

    expect(configs.twitter?.redirectUri).toBe("http://127.0.0.1:53147/oauth/callback/twitter");
  });
});

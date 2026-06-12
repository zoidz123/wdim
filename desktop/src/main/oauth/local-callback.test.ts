import { describe, expect, test } from "bun:test";
import { startOAuthCallbackServer } from "./local-callback";

describe("OAuth local callback server", () => {
  test("resolves the authorization code when state matches", async () => {
    const callback = await startOAuthCallbackServer({ expectedState: "state_123" });
    const response = await fetch(`${callback.redirectUri}?code=code_123&state=state_123`);
    const result = await callback.result;
    expect(response.status).toBe(200);
    expect(result.code).toBe("code_123");
  });

  test("rejects when state does not match", async () => {
    const callback = await startOAuthCallbackServer({ expectedState: "state_123" });
    const result = callback.result.then(
      () => {
        throw new Error("Expected OAuth callback to reject.");
      },
      (error) => error as Error
    );
    await fetch(`${callback.redirectUri}?code=code_123&state=wrong`);
    expect((await result).message).toBe("OAuth state did not match.");
  });

  test("can bind a stable callback path on a fixed localhost port", async () => {
    const callback = await startOAuthCallbackServer({
      expectedState: "state_123",
      port: 53146,
      path: "/oauth/callback/test"
    });

    expect(callback.redirectUri).toBe("http://127.0.0.1:53146/oauth/callback/test");
    await fetch(`${callback.redirectUri}?code=code_123&state=state_123`);
    expect((await callback.result).code).toBe("code_123");
  });
});

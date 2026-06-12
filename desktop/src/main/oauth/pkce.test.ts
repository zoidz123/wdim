import { describe, expect, test } from "bun:test";
import { createOAuthState, pkceChallengeFromVerifier } from "./pkce";

describe("OAuth PKCE helpers", () => {
  test("creates a base64url SHA-256 code challenge", async () => {
    const challenge = await pkceChallengeFromVerifier("test-verifier");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toContain("=");
    expect(challenge).toBe("JBbiqONGWPaAmwXk_8bT6UnlPfrn65D32eZlJS-zGG0");
  });

  test("creates verifier and state values with enough entropy", () => {
    const first = createOAuthState();
    const second = createOAuthState();
    expect(first.state).not.toBe(second.state);
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
    expect(first.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(first.state.length).toBeGreaterThanOrEqual(32);
  });
});

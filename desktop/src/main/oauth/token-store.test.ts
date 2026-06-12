import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { OAuthTokenStore, type TokenCipher } from "./token-store";

describe("OAuthTokenStore", () => {
  test("stores token payloads outside SQLite as encrypted envelopes", async () => {
    const root = path.join(os.tmpdir(), `wdim-token-store-${Date.now()}-${Math.random()}`);
    const cipher = fakeCipher();
    const store = new OAuthTokenStore(root, cipher);

    const saved = await store.save("twitter", {
      accessToken: "access_123",
      refreshToken: "refresh_123",
      expiresAt: "2026-01-01T00:00:00.000Z"
    }, "token_1");
    const loaded = await store.load("twitter", saved.tokenId);

    expect(saved.tokenId).toBe("token_1");
    expect(loaded?.accessToken).toBe("access_123");
    expect(loaded?.refreshToken).toBe("refresh_123");
    expect(cipher.encryptedValues[0]).toContain("access_123");
  });

  test("returns null for missing tokens", async () => {
    const root = path.join(os.tmpdir(), `wdim-token-store-${Date.now()}-${Math.random()}`);
    const store = new OAuthTokenStore(root, fakeCipher());
    expect(await store.load("twitter", "missing")).toBeNull();
  });
});

function fakeCipher(): TokenCipher & { encryptedValues: string[] } {
  const encryptedValues: string[] = [];
  return {
    encryptedValues,
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      encryptedValues.push(value);
      return Buffer.from(value.split("").reverse().join(""), "utf8");
    },
    decryptString(value: Buffer) {
      return value.toString("utf8").split("").reverse().join("");
    }
  };
}

import { describe, expect, test } from "bun:test";
import { decodeStoredToken, encodeStoredToken, mergeTokenCredentials, type TokenStorageCodec } from "./token-codec";

const account = {
  id: "user@example.com",
  email: "user@example.com",
  displayName: "user@example.com",
  connectedAt: "2026-06-02T10:00:00.000Z"
};

describe("token codec", () => {
  test("encrypts and decrypts token credentials when encryption is available", () => {
    const codec: TokenStorageCodec = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, "")
    };

    const encoded = encodeStoredToken({ account, credentials: { refresh_token: "secret" } }, codec);
    expect("encryptedCredentials" in encoded).toBe(true);

    const decoded = decodeStoredToken(encoded, codec);
    const credentials = decoded.credentials as { refresh_token: string };
    expect(credentials.refresh_token).toBe("secret");
  });

  test("keeps plaintext shape when encryption is unavailable", () => {
    const codec: TokenStorageCodec = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from(""),
      decryptString: () => ""
    };

    const encoded = encodeStoredToken({ account, credentials: { refresh_token: "secret" } }, codec);
    expect("credentials" in encoded).toBe(true);
  });

  test("merges refreshed access tokens without dropping the refresh token", () => {
    const merged = mergeTokenCredentials(
      { refresh_token: "refresh", access_token: "old", expiry_date: 1 },
      { access_token: "new", expiry_date: 2 }
    );

    expect(merged).toEqual({
      refresh_token: "refresh",
      access_token: "new",
      expiry_date: 2
    });
  });
});

import type { GmailAccount } from "./types";

export type StoredToken = {
  account: GmailAccount;
  credentials: unknown;
};

export type StoredEncryptedToken = {
  version: 2;
  account: GmailAccount;
  encryptedCredentials: string;
};

export type StoredPlainToken = StoredToken;

export type TokenStorageCodec = {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
};

export function encodeStoredToken(token: StoredToken, codec: TokenStorageCodec): StoredEncryptedToken | StoredPlainToken {
  if (!codec.isEncryptionAvailable()) return token;

  return {
    version: 2,
    account: token.account,
    encryptedCredentials: codec.encryptString(JSON.stringify(token.credentials)).toString("base64")
  };
}

export function decodeStoredToken(stored: StoredEncryptedToken | StoredPlainToken, codec: TokenStorageCodec): StoredToken {
  if ("encryptedCredentials" in stored) {
    const decrypted = codec.decryptString(Buffer.from(stored.encryptedCredentials, "base64"));
    return {
      account: stored.account,
      credentials: JSON.parse(decrypted) as unknown
    };
  }

  return stored;
}

export function mergeTokenCredentials(existing: unknown, update: unknown): unknown {
  if (!isRecord(existing)) return update;
  if (!isRecord(update)) return existing;

  return {
    ...existing,
    ...update
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

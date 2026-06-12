import fs from "node:fs/promises";
import path from "node:path";
import type { OAuthProvider, OAuthTokenSet, StoredOAuthTokens } from "./types";
import { randomBase64Url } from "./pkce";

export type TokenCipher = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type TokenEnvelope = {
  encrypted: boolean;
  payload: string;
};

export class OAuthTokenStore {
  constructor(
    private readonly rootDir: string,
    private readonly cipher?: TokenCipher
  ) {}

  async save(provider: OAuthProvider, tokens: OAuthTokenSet, tokenId = randomBase64Url(18)): Promise<StoredOAuthTokens> {
    const updatedAt = new Date().toISOString();
    const stored: StoredOAuthTokens = { ...tokens, provider, tokenId, updatedAt };
    await fs.mkdir(this.providerDir(provider), { recursive: true });
    await fs.writeFile(this.tokenPath(provider, tokenId), JSON.stringify(this.encrypt(stored), null, 2));
    return stored;
  }

  async load(provider: OAuthProvider, tokenId: string): Promise<StoredOAuthTokens | null> {
    try {
      const envelope = JSON.parse(await fs.readFile(this.tokenPath(provider, tokenId), "utf8")) as TokenEnvelope;
      return this.decrypt(envelope) as StoredOAuthTokens;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async remove(provider: OAuthProvider, tokenId: string): Promise<void> {
    await fs.rm(this.tokenPath(provider, tokenId), { force: true });
  }

  private providerDir(provider: OAuthProvider): string {
    return path.join(this.rootDir, provider);
  }

  private tokenPath(provider: OAuthProvider, tokenId: string): string {
    return path.join(this.providerDir(provider), `${safeTokenId(tokenId)}.json`);
  }

  private encrypt(value: StoredOAuthTokens): TokenEnvelope {
    const raw = JSON.stringify(value);
    if (this.cipher?.isEncryptionAvailable()) {
      return {
        encrypted: true,
        payload: this.cipher.encryptString(raw).toString("base64")
      };
    }
    console.warn("[oauth] safeStorage encryption unavailable; storing OAuth tokens unencrypted on disk");
    return {
      encrypted: false,
      payload: Buffer.from(raw, "utf8").toString("base64")
    };
  }

  private decrypt(envelope: TokenEnvelope): StoredOAuthTokens {
    const payload = Buffer.from(envelope.payload, "base64");
    const raw = envelope.encrypted
      ? this.requireCipher().decryptString(payload)
      : payload.toString("utf8");
    return JSON.parse(raw) as StoredOAuthTokens;
  }

  private requireCipher(): TokenCipher {
    if (!this.cipher) throw new Error("OAuth tokens are encrypted, but no token cipher was provided.");
    return this.cipher;
  }
}

function safeTokenId(tokenId: string): string {
  return tokenId.replace(/[^A-Za-z0-9_-]/g, "_");
}

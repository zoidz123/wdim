import { createHash, randomBytes } from "node:crypto";

export type OAuthState = {
  state: string;
  codeVerifier: string;
};

export function createOAuthState(): OAuthState {
  return {
    state: base64Url(randomBytes(32)),
    codeVerifier: base64Url(randomBytes(64))
  };
}

export async function pkceChallengeFromVerifier(codeVerifier: string): Promise<string> {
  return base64Url(createHash("sha256").update(codeVerifier).digest());
}

export function randomBase64Url(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

function base64Url(value: Buffer): string {
  return value.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

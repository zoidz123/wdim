import fs from "node:fs/promises";

export type DesktopCredentials = {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris?: string[];
  };
};

export async function loadCredentials(credentialsPath: string): Promise<DesktopCredentials> {
  const credentials = JSON.parse(await fs.readFile(credentialsPath, "utf8")) as DesktopCredentials;
  validateDesktopCredentials(credentials);
  return credentials;
}

export async function validateCredentialsFile(credentialsPath: string): Promise<void> {
  await loadCredentials(credentialsPath);
}

export function validateDesktopCredentials(credentials: DesktopCredentials): void {
  if (!credentials.installed?.client_id || !credentials.installed.client_secret) {
    throw new Error("Expected a Google OAuth desktop credentials.json file with installed.client_id and installed.client_secret.");
  }
}

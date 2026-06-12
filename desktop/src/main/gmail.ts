import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { safeStorage, shell } from "electron";
import { google, gmail_v1 } from "googleapis";
import type { GmailEvent } from "@what-did-i-miss/shared";
import type { GmailAccount } from "./types";
import { decodeStoredToken, encodeStoredToken, mergeTokenCredentials, type StoredEncryptedToken, type StoredPlainToken, type StoredToken } from "./token-codec";
import { loadCredentials, type DesktopCredentials } from "./gmail-credentials";
import { GMAIL_AUTH_PROMPT, GMAIL_SCOPES, withGmailOAuthTimeout } from "./gmail-oauth";
import { assertExpectedGmailAccount } from "./gmail-account";
import { appendGmailMessageIds, buildGmailRecentQuery, GMAIL_DEFAULT_MAX_RESULTS, GMAIL_PAGE_SIZE } from "./gmail-query";
import { fetchMessagesByIds } from "./gmail-message";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export class GmailConnector {
  constructor(private readonly tokenDir: string) {}

  async connectAccount(credentialsPath: string, expectedAccountId?: string): Promise<GmailAccount> {
    const credentials = await loadCredentials(credentialsPath);
    const auth = await authorizeWithLocalCallback(credentials);
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    const email = profile.data.emailAddress;

    if (!email) throw new Error("Gmail profile did not return an email address.");

    const account: GmailAccount = {
      id: email.toLowerCase(),
      email,
      displayName: email,
      connectedAt: new Date().toISOString()
    };

    assertExpectedGmailAccount(expectedAccountId, account.id, email);

    await this.saveToken(account, auth.credentials);
    return account;
  }

  async removeAccount(accountId: string): Promise<void> {
    await fs.rm(this.tokenPath(accountId), { force: true });
  }

  async fetchRecentMessages(account: GmailAccount, credentialsPath: string, maxResults = GMAIL_DEFAULT_MAX_RESULTS, since?: string): Promise<GmailEvent[]> {
    const credentials = await loadCredentials(credentialsPath);
    const stored = await readStoredToken(this.tokenPath(account.id));
    const auth = createOAuthClient(credentials);
    auth.setCredentials(stored.credentials as Parameters<OAuth2Client["setCredentials"]>[0]);
    auth.on("tokens", (tokens) => {
      void this.saveToken(account, mergeTokenCredentials(stored.credentials, tokens) as Parameters<OAuth2Client["setCredentials"]>[0]);
    });

    const gmail = google.gmail({ version: "v1", auth });
    const sinceDate = scanSinceDate(since);
    const ids = await listRecentMessageIds(gmail, maxResults, sinceDate);
    const messages = await fetchMessagesByIds(gmail, ids, account.email);
    return messages.filter((message) => new Date(message.receivedAt).getTime() >= sinceDate.getTime());
  }

  private async saveToken(account: GmailAccount, credentials: Parameters<OAuth2Client["setCredentials"]>[0]): Promise<void> {
    await fs.mkdir(this.tokenDir, { recursive: true });
    await fs.writeFile(
      this.tokenPath(account.id),
      JSON.stringify(encodeStoredToken({ account, credentials }, safeStorage), null, 2)
    );
  }

  private tokenPath(accountId: string): string {
    return path.join(this.tokenDir, `${encodeURIComponent(accountId)}.json`);
  }
}

async function listRecentMessageIds(gmail: gmail_v1.Gmail, maxResults: number, since: Date): Promise<string[]> {
  let ids: string[] = [];
  let pageToken: string | null = null;

  do {
    const page = await gmail.users.messages.list({
      userId: "me",
      maxResults: Math.min(GMAIL_PAGE_SIZE, maxResults - ids.length),
      pageToken: pageToken ?? undefined,
      q: buildGmailRecentQuery(since)
    });
    const next = appendGmailMessageIds(ids, page.data, maxResults);
    ids = next.ids;
    pageToken = next.nextPageToken;
  } while (pageToken && ids.length < maxResults);

  return ids;
}

function scanSinceDate(value: string | undefined): Date {
  const parsed = value ? new Date(value) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (Number.isNaN(parsed.getTime())) return new Date(Date.now() - 24 * 60 * 60 * 1000);
  return parsed;
}

async function readStoredToken(tokenPath: string): Promise<StoredToken> {
  const stored = JSON.parse(await fs.readFile(tokenPath, "utf8")) as StoredEncryptedToken | StoredPlainToken;
  const decoded = decodeStoredToken(stored, safeStorage);

  if (!("encryptedCredentials" in stored) && safeStorage.isEncryptionAvailable()) {
    await fs.writeFile(tokenPath, JSON.stringify(encodeStoredToken(decoded, safeStorage), null, 2));
  }

  return decoded;
}

function createOAuthClient(credentials: DesktopCredentials, redirectUri?: string): OAuth2Client {
  const installed = credentials.installed;
  if (!installed) throw new Error("Missing installed OAuth credentials.");
  return new google.auth.OAuth2(installed.client_id, installed.client_secret, redirectUri);
}

async function authorizeWithLocalCallback(credentials: DesktopCredentials): Promise<OAuth2Client> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start local OAuth callback server.");

  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const auth = createOAuthClient(credentials, redirectUri);
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: GMAIL_AUTH_PROMPT,
    scope: GMAIL_SCOPES
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    server.on("request", (request, response) => {
      const requestUrl = new URL(request.url ?? "/", redirectUri);
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      response.setHeader("Content-Type", "text/html");
      if (error) {
        response.end("<h1>Authorization failed</h1><p>You can close this window.</p>");
        reject(new Error(error));
        return;
      }

      if (!code) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      response.end("<h1>Gmail connected</h1><p>You can close this window and return to wdim.</p>");
      resolve(code);
    });
  });

  await shell.openExternal(url);
  const code = await withGmailOAuthTimeout(codePromise).finally(() => server.close());

  const token = await auth.getToken(code);
  auth.setCredentials(token.tokens);
  return auth;
}

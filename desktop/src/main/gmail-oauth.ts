const DEFAULT_GMAIL_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
export const GMAIL_AUTH_PROMPT = "consent select_account";

export function gmailOAuthTimeoutMs(): number {
  const value = Number(process.env.WHAT_DID_I_MISS_GMAIL_OAUTH_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_GMAIL_OAUTH_TIMEOUT_MS;
}

export function withGmailOAuthTimeout<T>(promise: Promise<T>, timeoutMs = gmailOAuthTimeoutMs()): Promise<T> {
  let timeout: NodeJS.Timeout;

  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Gmail OAuth timed out after ${timeoutMs}ms.`)), timeoutMs);
  });

  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

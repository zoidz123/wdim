import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { assertExpectedGmailAccount } from "./gmail-account";
import { buildGmailSourceUrl } from "./gmail-url";
import { withGmailOAuthTimeout } from "./gmail-oauth";
import { validateCredentialsFile } from "./gmail-credentials";
import { parseGmailReceivedAt } from "./gmail-date";
import { appendGmailMessageIds, buildGmailRecentQuery, GMAIL_DEFAULT_MAX_RESULTS, GMAIL_PAGE_SIZE } from "./gmail-query";
import { fetchMessagesByIds } from "./gmail-message";

describe("Gmail credentials validation", () => {
  test("accepts Google OAuth desktop credentials", async () => {
    const filePath = await writeTempJson({
      installed: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: ["http://localhost"]
      }
    });

    await expect(validateCredentialsFile(filePath)).resolves.toBeUndefined();
  });

  test("rejects non-desktop OAuth credentials", async () => {
    const filePath = await writeTempJson({
      web: {
        client_id: "client-id",
        client_secret: "client-secret"
      }
    });

    await expect(validateCredentialsFile(filePath)).rejects.toThrow("desktop credentials");
  });
});

describe("Gmail source URLs", () => {
  test("builds a Gmail search URL for an account and RFC822 message id", () => {
    const url = buildGmailSourceUrl("work@example.com", "<abc.123@example.com>");

    expect(url).toBe("https://mail.google.com/mail/u/?authuser=work%40example.com#search/rfc822msgid%3Aabc.123%40example.com");
  });
});

describe("Gmail scan query", () => {
  test("builds an inbox query from the shared scan window", () => {
    expect(buildGmailRecentQuery(new Date("2026-06-03T15:30:00.000Z"))).toBe("in:inbox after:2026/06/03");
    expect(GMAIL_PAGE_SIZE).toBe(50);
    expect(GMAIL_DEFAULT_MAX_RESULTS).toBe(200);
  });

  test("collects Gmail message ids across pages until the cap is reached", () => {
    const first = appendGmailMessageIds(["old"], {
      messages: [{ id: "a" }, { id: null }, { id: "b" }],
      nextPageToken: "next"
    }, 4);

    expect(first).toEqual({ ids: ["old", "a", "b"], nextPageToken: "next" });

    const second = appendGmailMessageIds(first.ids, {
      messages: [{ id: "c" }, { id: "d" }],
      nextPageToken: "ignored"
    }, 4);

    expect(second).toEqual({ ids: ["old", "a", "b", "c"], nextPageToken: null });
  });
});

describe("Gmail account reconnect guard", () => {
  test("allows reconnecting the expected Gmail account regardless of casing", () => {
    expect(() => assertExpectedGmailAccount("Work@Example.com", "work@example.com", "work@example.com")).not.toThrow();
  });

  test("rejects reconnecting a different Gmail account", () => {
    expect(() => assertExpectedGmailAccount("work@example.com", "personal@example.com", "personal@example.com")).toThrow("Expected Google sign-in for work@example.com");
  });
});

describe("Gmail OAuth timeout", () => {
  test("returns the OAuth code when it arrives before the timeout", async () => {
    await expect(withGmailOAuthTimeout(Promise.resolve("code"), 50)).resolves.toBe("code");
  });

  test("rejects when the OAuth callback does not arrive before the timeout", async () => {
    await expect(withGmailOAuthTimeout(new Promise(() => {}), 1)).rejects.toThrow("Gmail OAuth timed out");
  });
});

describe("Gmail received date parsing", () => {
  test("uses a valid Date header when available", () => {
    const receivedAt = parseGmailReceivedAt("Tue, 02 Jun 2026 10:00:00 -0400", "1790000000000", () => new Date("2026-06-02T12:00:00.000Z"));

    expect(receivedAt).toBe("2026-06-02T14:00:00.000Z");
  });

  test("falls back to Gmail internalDate when the Date header is malformed", () => {
    const receivedAt = parseGmailReceivedAt("not a date", "1790000000000", () => new Date("2026-06-02T12:00:00.000Z"));

    expect(receivedAt).toBe(new Date(1790000000000).toISOString());
  });

  test("falls back to now when Date header and internalDate are malformed", () => {
    const receivedAt = parseGmailReceivedAt("not a date", "not millis", () => new Date("2026-06-02T12:00:00.000Z"));

    expect(receivedAt).toBe("2026-06-02T12:00:00.000Z");
  });
});

describe("Gmail message fetching", () => {
  test("keeps successfully fetched messages when one listed message fails", async () => {
    const gmail = {
      users: {
        messages: {
          get: async ({ id }: { id: string }) => {
            if (id === "bad") throw new Error("Message disappeared");
            return {
              data: {
                id,
                threadId: `thread_${id}`,
                snippet: `Snippet ${id}`,
                internalDate: "1790000000000",
                labelIds: id === "unread" ? ["INBOX", "UNREAD"] : ["INBOX"],
                payload: {
                  headers: [
                    { name: "Subject", value: `Subject ${id}` },
                    { name: "From", value: "sender@example.com" },
                    { name: "Message-ID", value: `<${id}@example.com>` }
                  ],
                  mimeType: "text/plain",
                  body: {
                    data: Buffer.from(`Body ${id}`).toString("base64url")
                  }
                }
              }
            };
          }
        }
      }
    };

    const messages = await fetchMessagesByIds(gmail as never, ["ok", "bad", "unread"], "work@example.com");

    expect(messages.map((message) => message.id)).toEqual(["ok", "unread"]);
    expect(messages[0]?.sourceUrl).toContain("rfc822msgid%3Aok%40example.com");
    expect(messages[1]?.read).toBe(false);
  });
});

async function writeTempJson(value: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "what-did-i-miss-"));
  const filePath = path.join(dir, "credentials.json");
  await fs.writeFile(filePath, JSON.stringify(value));
  return filePath;
}

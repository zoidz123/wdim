import type { gmail_v1 } from "googleapis";
import type { GmailEvent } from "@what-did-i-miss/shared";
import { parseGmailReceivedAt } from "./gmail-date";
import { buildGmailSourceUrl } from "./gmail-url";

export async function fetchMessagesByIds(gmail: gmail_v1.Gmail, ids: string[], accountEmail: string): Promise<GmailEvent[]> {
  const results = await Promise.allSettled(ids.map((id) => fetchMessage(gmail, id, accountEmail)));

  return results
    .filter((result): result is PromiseFulfilledResult<GmailEvent | null> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((message): message is GmailEvent => Boolean(message));
}

async function fetchMessage(gmail: gmail_v1.Gmail, id: string, accountEmail: string): Promise<GmailEvent | null> {
  const message = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full"
  });
  const data = message.data;
  const headers = data.payload?.headers ?? [];

  const subject = header(headers, "Subject") ?? "(No subject)";
  const from = header(headers, "From") ?? "Unknown sender";
  const messageId = header(headers, "Message-ID");
  const receivedAt = parseGmailReceivedAt(header(headers, "Date"), data.internalDate);
  const body = extractBody(data.payload) || data.snippet || "";
  const labels = data.labelIds ?? [];

  return {
    id,
    threadId: data.threadId ?? undefined,
    from,
    subject,
    snippet: data.snippet ?? undefined,
    body: body.slice(0, 4000),
    receivedAt,
    sourceUrl: messageId ? buildGmailSourceUrl(accountEmail, messageId) : undefined,
    read: !labels.includes("UNREAD") ? true : false,
    labels
  };
}

function header(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string | undefined {
  return headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";

  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  const childText = part.parts?.map(extractBody).filter(Boolean).join("\n") ?? "";
  if (childText) return childText;

  if (part.body?.data) return stripHtml(decodeBase64Url(part.body.data));
  return "";
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

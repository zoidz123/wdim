export function buildGmailSourceUrl(accountEmail: string, messageId: string): string {
  const normalizedMessageId = messageId.trim().replace(/^<|>$/g, "");
  const search = encodeURIComponent(`rfc822msgid:${normalizedMessageId}`);
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(accountEmail)}#search/${search}`;
}

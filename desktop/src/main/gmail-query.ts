export const GMAIL_PAGE_SIZE = 50;
export const GMAIL_DEFAULT_MAX_RESULTS = 200;

export function buildGmailRecentQuery(since: Date): string {
  const year = since.getUTCFullYear();
  const month = String(since.getUTCMonth() + 1).padStart(2, "0");
  const day = String(since.getUTCDate()).padStart(2, "0");
  return `in:inbox after:${year}/${month}/${day}`;
}

export type GmailListPage = {
  messages?: Array<{ id?: string | null }> | null;
  nextPageToken?: string | null;
};

export function appendGmailMessageIds(existingIds: string[], page: GmailListPage, maxResults: number): { ids: string[]; nextPageToken: string | null } {
  const ids = [...existingIds];
  for (const message of page.messages ?? []) {
    if (!message.id) continue;
    if (ids.length >= maxResults) break;
    ids.push(message.id);
  }

  return {
    ids,
    nextPageToken: ids.length < maxResults ? page.nextPageToken ?? null : null
  };
}

export function assertExpectedGmailAccount(expectedAccountId: string | undefined, actualAccountId: string, actualEmail: string): void {
  if (!expectedAccountId || actualAccountId === expectedAccountId.toLowerCase()) return;

  throw new Error(`Expected Google sign-in for ${expectedAccountId}, but got ${actualEmail}. Try reconnecting and choose the matching Gmail account.`);
}

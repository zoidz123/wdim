export function parseGmailReceivedAt(dateHeader: string | undefined, internalDate: string | null | undefined, now: () => Date = () => new Date()): string {
  const headerDate = validDate(dateHeader);
  if (headerDate) return headerDate.toISOString();

  const internalDateValue = Number(internalDate);
  const fallbackDate = Number.isFinite(internalDateValue) ? validDate(internalDateValue) : null;
  return (fallbackDate ?? now()).toISOString();
}

function validDate(value: string | number | undefined): Date | null {
  if (value === undefined) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

import type { AppState } from "./types";

export function importantCountFromState(state: AppState): number {
  return state.importantItems?.length ?? state.lastCompletedScan?.findings.length ?? 0;
}

export function formatBadgeCount(count: number): string {
  if (count <= 0) return "";
  if (count > 9) return "9+";
  return String(count);
}

export function renderTrayIconSvg(count = 0): string {
  const badge = formatBadgeCount(count);
  const badgeMarkup = badge
    ? `
      <circle cx="23.5" cy="8.5" r="6.5" fill="#FF453A" stroke="#fff" stroke-width="1.5"/>
      <text x="23.5" y="11.2" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif" font-size="${badge.length > 1 ? 6.5 : 8}" font-weight="800" fill="#fff">${badge}</text>`
    : "";

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <defs>
        <mask id="wdim-cutout">
          <rect width="32" height="32" fill="#fff"/>
          <path d="M8.4 11.1 11.5 21l3.2-7.3L18.4 21l3.9-9.9" fill="none" stroke="#000" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round"/>
        </mask>
      </defs>
      <circle cx="16" cy="16" r="13" fill="#fff" mask="url(#wdim-cutout)"/>
      ${badgeMarkup}
    </svg>`;
}

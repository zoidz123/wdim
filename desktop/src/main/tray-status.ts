import type { AppState } from "./types";

export function trayStatusLabel(state: AppState, now: () => Date = () => new Date()): string {
  if (state.isScanning) return "Status: scanning sources";
  if (!state.codexReady) return "Status: Codex sign-in needed";
  if (!hasAnySource(state)) return "Status: connect a source";
  if (!state.nextScanAt) return "Status: hourly scan not scheduled";

  return `Next scan: ${relativeTime(state.nextScanAt, now())}`;
}

export function trayScanNowItem(state?: AppState): { label: string; enabled: boolean } | null {
  if (state && !state.codexReady) {
    return null;
  }

  if (state?.isScanning) {
    return { label: "Scanning...", enabled: false };
  }

  if (state && !hasAnySource(state)) {
    return { label: "Connect Source First", enabled: false };
  }

  return { label: "Scan Now", enabled: true };
}

function hasAnySource(state: AppState): boolean {
  const hasConnector = Boolean(state.sourceConnections?.some((connection) => connection.enabled));
  const hasGmail = Boolean(state.settings.gmailCredentialsPath && state.accounts.length);
  const hasTelegram = Boolean(
    (state.telegramConnected || state.settings.telegramExportPath) &&
    (state.settings.telegramIncludeDms || state.telegramChats.some((chat) => chat.enabled))
  );
  return hasConnector || hasGmail || hasTelegram;
}

function relativeTime(iso: string, from: Date): string {
  const deltaMs = new Date(iso).getTime() - from.getTime();
  const minutes = Math.max(0, Math.round(deltaMs / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

import type { AppDiagnostics, AppSettings, AppState, ScanResult, SetupCheckResult } from "../main/types";

type CodexLoginStartResult = {
  type: "chatgpt" | "chatgptDeviceCode";
  loginId?: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
};

declare global {
  interface Window {
    whatDidIMiss: {
      getState: () => Promise<AppState>;
      getDiagnostics: () => Promise<AppDiagnostics>;
      copyDiagnostics: () => Promise<void>;
      copyLiveCheckCommand: () => Promise<void>;
      copyCodexSignInCommand: () => Promise<void>;
      startCodexSignIn: () => Promise<CodexLoginStartResult>;
      logoutCodex: () => Promise<AppState>;
      retryCodex: () => Promise<AppState>;
      runSetupCheck: () => Promise<SetupCheckResult>;
      scanNow: () => Promise<ScanResult>;
      sourcesStartConnection: (source: "gmail" | "twitter",label: string) => Promise<{ redirectUrl: string; connectionRequestId: string }>;
      sourcesCompleteConnection: (source: "gmail" | "twitter",connectionRequestId: string) => Promise<AppState>;
      sourcesAddYouTubeChannel: (channelUrl: string) => Promise<AppState>;
      sourcesConnectTwitterLocal: () => Promise<AppState>;
      sourcesRemoveConnection: (connectionId: string) => Promise<AppState>;
      sourcesSummarizeYouTubeVideo: (connectionId: string) => Promise<ScanResult>;
      sourcesUpdateConnectionConfig: (connectionId: string, config: Record<string, unknown>) => Promise<AppState>;
      sourcesRefreshConnectionMetadata: (connectionId: string) => Promise<AppState>;
      clearScanMemory: () => Promise<AppState>;
      updateImportantItemStatus: (itemId: string, status: "active" | "completed" | "dismissed") => Promise<AppState>;
      dismissSourceInsight: (insightId: string) => Promise<AppState>;
      dismissDigestCard: (digestCardId: string) => Promise<AppState>;
      updateSettings: (update: Partial<AppSettings>) => Promise<AppState>;
      openExternal: (url: string) => Promise<void>;
      openSetupLink: (linkId: "google-cloud-console" | "gmail-api" | "oauth-clients") => Promise<void>;
      chooseTelegramExport: () => Promise<AppState | null>;
      beginTelegramLogin: () => Promise<import("../main/telegram").TelegramAuthState>;
      beginTelegramPhoneLogin: () => Promise<import("../main/telegram").TelegramAuthState>;
      getTelegramAuthState: () => Promise<{ authState: import("../main/telegram").TelegramAuthState; appState: AppState }>;
      submitTelegramPhoneNumber: (phoneNumber: string) => Promise<{ authState: import("../main/telegram").TelegramAuthState; appState: AppState }>;
      submitTelegramPhoneCode: (code: string) => Promise<{ authState: import("../main/telegram").TelegramAuthState; appState: AppState }>;
      submitTelegramPassword: (password: string) => Promise<{ authState: import("../main/telegram").TelegramAuthState; appState: AppState }>;
      setTelegramChatEnabled: (chatId: string, enabled: boolean) => Promise<AppState>;
      refreshTelegramChats: () => Promise<AppState>;
      onStateChanged: (callback: (state: AppState) => void) => () => void;
      getUpdateStatus: () => Promise<import("../main/updater").UpdateStatus>;
      installUpdate: () => Promise<void>;
      onUpdateStatusChanged: (callback: (status: import("../main/updater").UpdateStatus) => void) => () => void;
    };
  }
}

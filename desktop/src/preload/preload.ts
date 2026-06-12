import { contextBridge, ipcRenderer } from "electron";
import type { TelegramAuthState } from "../main/telegram";
import type { UpdateStatus } from "../main/updater";
import type { AppDiagnostics, AppSettings, AppState, ScanResult, SetupCheckResult } from "../main/types";

type TelegramAuthResponse = {
  authState: TelegramAuthState;
  appState: AppState;
};

type CodexLoginStartResult = {
  type: "chatgpt" | "chatgptDeviceCode";
  loginId?: string;
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
};

const api = {
  getState: () => ipcRenderer.invoke("app:getState") as Promise<AppState>,
  getDiagnostics: () => ipcRenderer.invoke("app:getDiagnostics") as Promise<AppDiagnostics>,
  copyDiagnostics: () => ipcRenderer.invoke("app:copyDiagnostics") as Promise<void>,
  copyLiveCheckCommand: () => ipcRenderer.invoke("app:copyLiveCheckCommand") as Promise<void>,
  copyCodexSignInCommand: () => ipcRenderer.invoke("app:copyCodexSignInCommand") as Promise<void>,
  startCodexSignIn: () => ipcRenderer.invoke("app:startCodexSignIn") as Promise<CodexLoginStartResult>,
  logoutCodex: () => ipcRenderer.invoke("app:logoutCodex") as Promise<AppState>,
  retryCodex: () => ipcRenderer.invoke("app:retryCodex") as Promise<AppState>,
  runSetupCheck: () => ipcRenderer.invoke("app:runSetupCheck") as Promise<SetupCheckResult>,
  scanNow: () => ipcRenderer.invoke("app:scanNow") as Promise<ScanResult>,
  sourcesStartConnection: (source: "gmail" | "twitter",label: string) =>
    ipcRenderer.invoke("app:sourcesStartConnection", source, label) as Promise<{ redirectUrl: string; connectionRequestId: string }>,
  sourcesCompleteConnection: (source: "gmail" | "twitter",connectionRequestId: string) =>
    ipcRenderer.invoke("app:sourcesCompleteConnection", source, connectionRequestId) as Promise<AppState>,
  sourcesAddYouTubeChannel: (channelUrl: string) =>
    ipcRenderer.invoke("app:sourcesAddYouTubeChannel", channelUrl) as Promise<AppState>,
  sourcesConnectTwitterLocal: () =>
    ipcRenderer.invoke("app:sourcesConnectTwitterLocal") as Promise<AppState>,
  sourcesRemoveConnection: (connectionId: string) =>
    ipcRenderer.invoke("app:sourcesRemoveConnection", connectionId) as Promise<AppState>,
  sourcesSummarizeYouTubeVideo: (connectionId: string) =>
    ipcRenderer.invoke("app:sourcesSummarizeYouTubeVideo", connectionId) as Promise<ScanResult>,
  sourcesUpdateConnectionConfig: (connectionId: string, config: Record<string, unknown>) =>
    ipcRenderer.invoke("app:sourcesUpdateConnectionConfig", connectionId, config) as Promise<AppState>,
  sourcesRefreshConnectionMetadata: (connectionId: string) =>
    ipcRenderer.invoke("app:sourcesRefreshConnectionMetadata", connectionId) as Promise<AppState>,
  chooseTelegramExport: () => ipcRenderer.invoke("app:chooseTelegramExport") as Promise<AppState | null>,
  beginTelegramLogin: () => ipcRenderer.invoke("app:beginTelegramLogin") as Promise<TelegramAuthState>,
  beginTelegramPhoneLogin: () => ipcRenderer.invoke("app:beginTelegramPhoneLogin") as Promise<TelegramAuthState>,
  getTelegramAuthState: () => ipcRenderer.invoke("app:getTelegramAuthState") as Promise<TelegramAuthResponse>,
  submitTelegramPhoneNumber: (phoneNumber: string) => ipcRenderer.invoke("app:submitTelegramPhoneNumber", phoneNumber) as Promise<TelegramAuthResponse>,
  submitTelegramPhoneCode: (code: string) => ipcRenderer.invoke("app:submitTelegramPhoneCode", code) as Promise<TelegramAuthResponse>,
  submitTelegramPassword: (password: string) => ipcRenderer.invoke("app:submitTelegramPassword", password) as Promise<TelegramAuthResponse>,
  setTelegramChatEnabled: (chatId: string, enabled: boolean) => ipcRenderer.invoke("app:setTelegramChatEnabled", chatId, enabled) as Promise<AppState>,
  refreshTelegramChats: () => ipcRenderer.invoke("app:refreshTelegramChats") as Promise<AppState>,
  clearScanMemory: () => ipcRenderer.invoke("app:clearScanMemory") as Promise<AppState>,
  updateImportantItemStatus: (itemId: string, status: "active" | "completed" | "dismissed") => ipcRenderer.invoke("app:updateImportantItemStatus", itemId, status) as Promise<AppState>,
  dismissSourceInsight: (insightId: string) => ipcRenderer.invoke("app:dismissSourceInsight", insightId) as Promise<AppState>,
  dismissDigestCard: (digestCardId: string) => ipcRenderer.invoke("app:dismissDigestCard", digestCardId) as Promise<AppState>,
  updateSettings: (update: Partial<AppSettings>) => ipcRenderer.invoke("app:updateSettings", update) as Promise<AppState>,
  openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url) as Promise<void>,
  openSetupLink: (linkId: "google-cloud-console" | "gmail-api" | "oauth-clients") => ipcRenderer.invoke("app:openSetupLink", linkId) as Promise<void>,
  onStateChanged: (callback: (state: AppState) => void) => {
    const listener = (_event: unknown, state: AppState) => callback(state);
    ipcRenderer.on("app:stateChanged", listener);
    return () => ipcRenderer.off("app:stateChanged", listener);
  },
  getUpdateStatus: () => ipcRenderer.invoke("app:getUpdateStatus") as Promise<UpdateStatus>,
  installUpdate: () => ipcRenderer.invoke("app:installUpdate") as Promise<void>,
  onUpdateStatusChanged: (callback: (status: UpdateStatus) => void) => {
    const listener = (_event: unknown, status: UpdateStatus) => callback(status);
    ipcRenderer.on("app:updateStatusChanged", listener);
    return () => ipcRenderer.off("app:updateStatusChanged", listener);
  }
};

contextBridge.exposeInMainWorld("whatDidIMiss", api);

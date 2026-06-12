import path from "node:path";
import { existsSync, mkdirSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, safeStorage, screen, shell, Tray, type MenuItemConstructorOptions } from "electron";
import { AppStore } from "./store";
import { GmailConnector } from "./gmail";
import { TelegramConnector, type TelegramAuthState } from "./telegram";
import { CodexAppServerClient, WDIM_CODEX_MODEL } from "./codex";
import { createConnectorRegistry } from "./connectors/registry";
import { BirdTwitterConnector } from "./connectors/bird-twitter";
import type { SourceConnection, SourceConnector } from "./connectors/types";
import { makeSourceConnectionId } from "./connectors/types";
import { loadNativeOAuthConfigs, enabledNativeSources } from "./connectors/native-config";
import { NativeOAuthClient } from "./connectors/native-oauth-client";
import type { OAuthProvider } from "./oauth/types";
import { OAuthTokenStore } from "./oauth/token-store";
import { NativeGmailConnector } from "./connectors/native-gmail";
import { NativeTwitterConnector } from "./connectors/native-twitter";
import { MAX_YOUTUBE_CHANNEL_SOURCES, parseYouTubeSource, YouTubeChannelConnector } from "./connectors/youtube-channel";
import { formatHighPriorityNotification, formatScanFailureNotification, ScanService } from "./scanner";
import { importantCountFromState, renderTrayIconSvg } from "./tray-icon";
import { buildDiagnostics, buildLiveCheckCommand } from "./diagnostics";
import { assertAllowedSourceUrl, setupLinkUrl, type SetupLinkId } from "./external-links";
import { applyLaunchAtLoginSetting } from "./launch-settings";
import { trayScanNowItem, trayStatusLabel } from "./tray-status";
import { shouldDeferPopoverUntilReady, shouldHidePopoverOnBlur, shouldShowPopoverOnLaunch } from "./app-visibility";
import { bundledCodexPath, bundledYtDlpPath, codexHomeDirectory, codexWorkingDirectory } from "./app-paths";
import { hasScanNowArgument, hasShowWindowArgument } from "./app-arguments";
import { loadFirstEnvFile, loadNearestEnvLocal } from "./runtime-env";
import type { AppState, SetupCheckItem, SetupCheckResult } from "./types";

const appRoot = app.getAppPath();
if (process.env.WDIM_USER_DATA_DIR) {
  app.setPath("userData", process.env.WDIM_USER_DATA_DIR);
}
const distDir = path.join(appRoot, "dist");
const devRendererDir = process.env.WDIM_RENDERER_DIR;

let tray: Tray | null = null;
let popover: BrowserWindow | null = null;
let devRendererWatcher: FSWatcher | null = null;
let devRendererReloadTimer: NodeJS.Timeout | null = null;
let scanService: ScanService;
let store: AppStore;
let gmail: GmailConnector;
let telegram: TelegramConnector;
let nativeConnectors: Partial<Record<OAuthProvider, SourceConnector>> = {};
let youtubeChannelConnector: YouTubeChannelConnector;
let birdTwitterConnector: BirdTwitterConnector;
const activeNotifications = new Set<Notification>();
let pinPopoverUntilUserCloses = false;
let popoverPinnedMode: boolean | null = null;
let nativeDialogOpen = false;
let pendingScanNow = hasScanNowArgument(process.argv);
let pendingShowWindow = hasShowWindowArgument(process.argv);
const compactPopoverBounds = { width: 420, height: 640 };
const pinnedWindowBounds = { width: 1120, height: 760 };

async function bootstrap(): Promise<void> {
  configureAppMetadata();
  configureDock();
  loadFirstEnvFile([
    path.join(process.resourcesPath, "runtime.env"),
    path.join(appRoot, "runtime.env")
  ]);
  loadNearestEnvLocal([
    appRoot,
    process.resourcesPath,
    path.dirname(process.execPath),
    process.cwd()
  ].filter(Boolean));

  const userData = app.getPath("userData");
  store = new AppStore(path.join(userData, "state.json"));
  applyLaunchAtLoginSetting(app, await store.getSettings());
  gmail = new GmailConnector(path.join(userData, "gmail-tokens"));
  telegram = new TelegramConnector({
    sessionPath: path.join(userData, "telegram-session.json"),
    codec: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    }
  });
  const nativeOAuthConfigs = loadNativeOAuthConfigs();
  const nativeOAuth = new NativeOAuthClient(
    nativeOAuthConfigs,
    new OAuthTokenStore(path.join(userData, "oauth-tokens"), {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value)
    })
  );
  nativeConnectors = createNativeConnectors(store, nativeOAuth, nativeOAuthConfigs);
  youtubeChannelConnector = new YouTubeChannelConnector(
    store,
    undefined,
    undefined,
    bundledYtDlpPath({
      isPackaged: app.isPackaged,
      appPath: appRoot,
      resourcesPath: process.resourcesPath
    })
  );
  birdTwitterConnector = new BirdTwitterConnector(store, undefined, undefined, path.join(distDir, "bird.mjs"));
  const connectorRegistry = createConnectorRegistry(store, {
    telegram,
    localConnectors: { youtube: youtubeChannelConnector, twitter: birdTwitterConnector },
    nativeConnectors
  });
  const codexHome = codexHomeDirectory({ userDataPath: userData });
  const codexEnv = app.isPackaged
    ? {
      ...process.env,
      CODEX_HOME: codexHome
    }
    : process.env;
  if (app.isPackaged) ensureWdimCodexHome(codexHome);
  scanService = new ScanService(
    store,
    gmail,
    new CodexAppServerClient(
      codexWorkingDirectory({
        isPackaged: app.isPackaged,
        appPath: appRoot,
        userDataPath: userData
      }),
      undefined,
      codexEnv,
      bundledCodexPath({
        isPackaged: app.isPackaged,
        appPath: appRoot,
        resourcesPath: process.resourcesPath
      }),
      app.isPackaged
    ),
    notifyHighPriorityFindings,
    undefined,
    notifyScanFailure,
    telegram,
    connectorRegistry,
    enabledNativeSources(nativeOAuthConfigs)
  );

  createTray();
  registerIpc();
  registerPowerMonitor();

  const persistedState = await store.load();
  const persistedSourceConnectionCount = (await store.listSourceConnections())
    .filter((connection) => connection.enabled)
    .length;
  if (pendingShowWindow || shouldShowPopoverOnLaunch(app.getLoginItemSettings(), {
    gmailCredentialsPath: persistedState.settings.gmailCredentialsPath,
    accountCount: persistedState.accounts.length,
    sourceConnectionCount: persistedSourceConnectionCount
  }, { scanNowLaunch: pendingScanNow })) {
    showPopover({ pinUntilUserCloses: true });
    pendingShowWindow = false;
  }
  await scanService.start({ scanImmediately: shouldScanImmediatelyOnStartup() || pendingScanNow });
  if (pendingScanNow) {
    pendingScanNow = false;
    void scanService.scanNow().catch((error) => {
      console.error("Argument-triggered scan failed", error);
    });
  }
}

function ensureWdimCodexHome(codexHome: string): void {
  mkdirSync(codexHome, { recursive: true });
  const configPath = path.join(codexHome, "config.toml");
  if (existsSync(configPath)) return;
  writeFileSync(configPath, [
    "# Managed by WDIM. Keeps WDIM's bundled Codex runtime isolated from the user's main Codex config.",
    `model = "${WDIM_CODEX_MODEL}"`,
    'cli_auth_credentials_store = "file"',
    'mcp_oauth_credentials_store = "file"',
    ""
  ].join("\n"));
}

function shouldSkipInitialScan(): boolean {
  return process.env.WDIM_SKIP_INITIAL_SCAN === "1" || process.env.WDIM_SKIP_INITIAL_SCAN === "true";
}

function shouldScanImmediatelyOnStartup(): boolean {
  if (shouldSkipInitialScan()) return false;
  return true;
}

function createTray(): void {
  tray = new Tray(createTrayImage());
  tray.setTitle("wdim");
  tray.setToolTip("wdim");
  tray.setContextMenu(buildTrayContextMenu());
  tray.on("click", () => toggleAppWindow());
}

function buildTrayContextMenu(state?: AppState): Menu {
  const scanNowItem = trayScanNowItem(state);
  const template: MenuItemConstructorOptions[] = [
    {
      label: state ? trayStatusLabel(state) : "Status: starting",
      enabled: false
    },
    { type: "separator" },
    {
      label: "Open wdim",
      click: () => showPopover({ pinUntilUserCloses: true })
    }
  ];

  if (scanNowItem) {
    template.push({
      label: scanNowItem.label,
      enabled: scanNowItem.enabled,
      click: () => {
        void scanService.scanNow().catch((error) => {
          console.error("Manual tray scan failed", error);
        });
      }
    });
  }

  template.push(
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit()
    }
  );

  return Menu.buildFromTemplate(template);
}

function createTrayImage(count = 0) {
  const svg = renderTrayIconSvg(count);
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  image.setTemplateImage(false);
  return image;
}

function updateTrayFromState(state: AppState): void {
  if (!tray) return;

  const count = importantCountFromState(state);
  tray.setImage(createTrayImage(count));
  tray.setContextMenu(buildTrayContextMenu(state));
  tray.setToolTip(count > 0
    ? `wdim: ${count} important item${count === 1 ? "" : "s"}`
    : "wdim");
}

function toggleAppWindow(): void {
  if (popover?.isVisible()) {
    pinPopoverUntilUserCloses = false;
    popover.hide();
    return;
  }

  showPopover({ pinUntilUserCloses: true });
}

function showPopover(options: { pinUntilUserCloses?: boolean } = {}): void {
  pinPopoverUntilUserCloses = options.pinUntilUserCloses ?? false;

  if (popover && popoverPinnedMode !== pinPopoverUntilUserCloses) {
    popover.destroy();
    popover = null;
  }

  if (!popover) {
    const bounds = popoverBoundsForMode(pinPopoverUntilUserCloses);
    popoverPinnedMode = pinPopoverUntilUserCloses;
    popover = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      show: false,
      title: "wdim",
      frame: pinPopoverUntilUserCloses,
      ...(pinPopoverUntilUserCloses ? {
        titleBarStyle: "hidden" as const,
        trafficLightPosition: { x: 16, y: 16 }
      } : {}),
      backgroundColor: "#0b0f14",
      icon: appIconPath(),
      resizable: pinPopoverUntilUserCloses,
      fullscreenable: false,
      skipTaskbar: !pinPopoverUntilUserCloses,
      hiddenInMissionControl: !pinPopoverUntilUserCloses,
      webPreferences: {
        preload: path.join(distDir, "preload.cjs")
      }
    });
    void popover.loadFile(rendererIndexPath());
    watchDevRenderer();
    popover.on("blur", () => {
      if (shouldHidePopoverOnBlur({ pinUntilUserCloses: pinPopoverUntilUserCloses, nativeDialogOpen })) {
        popover?.hide();
      }
    });
    popover.on("closed", () => {
      popover = null;
      popoverPinnedMode = null;
      pinPopoverUntilUserCloses = false;
    });
  } else {
    const bounds = popoverBoundsForMode(pinPopoverUntilUserCloses);
    popover.setResizable(pinPopoverUntilUserCloses);
    popover.setSize(bounds.width, bounds.height);
  }

  const trayBounds = tray?.getBounds();
  const windowBounds = popover.getBounds();
  if (pinPopoverUntilUserCloses) {
    const display = screen.getPrimaryDisplay().workArea;
    popover.setPosition(
      Math.round(display.x + display.width / 2 - windowBounds.width / 2),
      Math.round(display.y + display.height / 2 - windowBounds.height / 2)
    );
  } else if (trayBounds) {
    popover.setPosition(
      Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2),
      Math.round(trayBounds.y + trayBounds.height + 6)
    );
  } else {
    const display = screen.getPrimaryDisplay().workArea;
    popover.setPosition(
      Math.round(display.x + display.width - windowBounds.width - 16),
      Math.round(display.y + 16)
    );
  }
  popover.show();
  popover.focus();
  app.focus({ steal: true });
}

function popoverBoundsForMode(pinned: boolean): { width: number; height: number } {
  return pinned ? pinnedWindowBounds : compactPopoverBounds;
}

function configureAppMetadata(): void {
  app.setName("wdim");
  app.setAboutPanelOptions({
    applicationName: "wdim",
    applicationVersion: app.getVersion()
  });
}

function configureDock(): void {
  const icon = nativeImage.createFromPath(appIconPath());
  if (!icon.isEmpty()) app.dock?.setIcon(icon);
  app.dock?.show();
}

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.icns")
    : path.join(appRoot, "build", "icon.png");
}

function rendererIndexPath(): string {
  return path.join(devRendererDir || path.join(distDir, "renderer"), "index.html");
}

function watchDevRenderer(): void {
  if (!devRendererDir || devRendererWatcher) return;

  try {
    devRendererWatcher = watch(devRendererDir, { recursive: true }, () => {
      if (devRendererReloadTimer) clearTimeout(devRendererReloadTimer);
      devRendererReloadTimer = setTimeout(() => {
        popover?.webContents.reloadIgnoringCache();
      }, 80);
    });
  } catch (error) {
    console.warn("Renderer live reload unavailable", error);
  }
}

function showPopoverAfterReady(options: { pinUntilUserCloses?: boolean } = {}): void {
  if (shouldDeferPopoverUntilReady(app.isReady())) {
    void app.whenReady().then(() => showPopover(options));
    return;
  }

  showPopover(options);
}

function notifyHighPriorityFindings(findings: Parameters<typeof formatHighPriorityNotification>[0]): void {
  showClickableNotification(formatHighPriorityNotification(findings));
}

function notifyScanFailure(result: Parameters<typeof formatScanFailureNotification>[0]): void {
  showClickableNotification(formatScanFailureNotification(result));
}

function showClickableNotification(options: { title: string; body: string }): void {
  if (!Notification.isSupported()) return;

  const notification = new Notification(options);
  activeNotifications.add(notification);
  notification.once("click", () => {
    activeNotifications.delete(notification);
    showPopover({ pinUntilUserCloses: true });
  });
  notification.once("close", () => {
    activeNotifications.delete(notification);
  });
  notification.show();
}

function registerIpc(): void {
  ipcMain.handle("app:getState", () => scanService.getState());
  ipcMain.handle("app:getDiagnostics", async () => getDiagnostics());
  ipcMain.handle("app:copyDiagnostics", async () => {
    clipboard.writeText(JSON.stringify(await getDiagnostics(), null, 2));
  });
  ipcMain.handle("app:copyLiveCheckCommand", async () => {
    const settings = await store.getSettings();
    clipboard.writeText(buildLiveCheckCommand(appRoot, settings.gmailCredentialsPath));
  });
  ipcMain.handle("app:copyCodexSignInCommand", async () => {
    const state = await scanService.getState();
    clipboard.writeText(state.codexStatus?.command ?? "https://openai.com/codex/");
  });
  ipcMain.handle("app:startCodexSignIn", async () => {
    const login = await scanService.startCodexSignIn();
    const url = login.authUrl ?? login.verificationUrl;
    if (url) await shell.openExternal(url);
    return login;
  });
  ipcMain.handle("app:logoutCodex", async () => {
    return scanService.logoutCodex();
  });
  ipcMain.handle("app:retryCodex", () => scanService.retryCodex());
  ipcMain.handle("app:runSetupCheck", async () => appendNotificationSetupCheck(await scanService.runSetupCheck()));
  ipcMain.handle("app:scanNow", () => scanService.scanNow());
  ipcMain.handle("app:chooseTelegramExport", async () => {
    const result = await showOpenFileDialog({
      title: "Choose Telegram Desktop result.json",
      filters: [{ name: "Telegram export", extensions: ["json"] }],
      properties: ["openFile"]
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const existing = new Map((await store.getTelegramChats()).map((chat) => [chat.id, chat]));
    const chats = (await telegram.listChats(result.filePaths[0])).map((chat) => ({
      ...chat,
      enabled: existing.get(chat.id)?.enabled ?? chat.enabled
    }));
    await store.updateSettings({ telegramExportPath: result.filePaths[0] });
    await store.replaceTelegramChats(chats);
    await scanService.scheduleNextScan();
    return scanService.getState();
  });
  ipcMain.handle("app:beginTelegramLogin", async () => {
    const authState = await telegram.beginAccountLogin();
    void waitForTelegramConnection().catch((error) => {
      console.error("Telegram connection finalization failed", error);
    });
    return authState;
  });
  ipcMain.handle("app:beginTelegramPhoneLogin", async () => {
    const authState = await telegram.beginPhoneLogin();
    void waitForTelegramConnection().catch((error) => {
      console.error("Telegram connection finalization failed", error);
    });
    return authState;
  });
  ipcMain.handle("app:getTelegramAuthState", async () => {
    const authState = telegram.getAuthState();
    if (authState.status === "connected") {
      await syncTelegramAccountChats();
    }
    return {
      authState,
      appState: await scanService.getState()
    };
  });
  ipcMain.handle("app:submitTelegramPhoneNumber", async (_event, phoneNumber: string) => {
    const authState = await telegram.submitPhoneNumber(phoneNumber);
    return {
      authState,
      appState: await scanService.getState()
    };
  });
  ipcMain.handle("app:submitTelegramPhoneCode", async (_event, code: string) => {
    const authState = await telegram.submitPhoneCode(code);
    if (authState.status === "connected") await syncTelegramAccountChats();
    return {
      authState,
      appState: await scanService.getState()
    };
  });
  ipcMain.handle("app:submitTelegramPassword", async (_event, password: string) => {
    const authState = await telegram.submitPassword(password);
    if (authState.status === "connected") await syncTelegramAccountChats();
    return {
      authState,
      appState: await scanService.getState()
    };
  });
  ipcMain.handle("app:setTelegramChatEnabled", async (_event, chatId: string, enabled: boolean) => {
    const chats = (await store.getTelegramChats()).map((chat) => chat.id === chatId ? { ...chat, enabled } : chat);
    await store.replaceTelegramChats(chats);
    await scanService.scheduleNextScan();
    return scanService.getState();
  });
  ipcMain.handle("app:refreshTelegramChats", async () => {
    await syncTelegramAccountChats();
    await scanService.scheduleNextScan();
    return scanService.getState();
  });
  ipcMain.handle("app:clearScanMemory", async () => {
    await store.clearScanMemory();
    return scanService.getState();
  });
  ipcMain.handle("app:updateImportantItemStatus", async (_event, itemId: string, status: "active" | "completed" | "dismissed") => {
    await store.updateImportantItemStatus(itemId, status);
    return scanService.getState();
  });
  ipcMain.handle("app:dismissSourceInsight", async (_event, insightId: string) => {
    await store.dismissSourceInsight(insightId);
    return scanService.getState();
  });
  ipcMain.handle("app:dismissDigestCard", async (_event, digestCardId: string) => {
    await store.dismissDigestCard(digestCardId);
    return scanService.getState();
  });
  ipcMain.handle("app:updateSettings", async (_event, update) => {
    const settings = await store.updateSettings(update);
    if (typeof update.launchAtLogin === "boolean") {
      applyLaunchAtLoginSetting(app, settings, { force: true });
    }
    await scanService.scheduleNextScan();
    return scanService.getState();
  });
  ipcMain.handle("app:openExternal", async (_event, url: string) => {
    assertAllowedSourceUrl(url);
    await shell.openExternal(url);
  });
  ipcMain.handle("app:openSetupLink", async (_event, linkId: SetupLinkId) => {
    await shell.openExternal(setupLinkUrl(linkId));
  });
  ipcMain.handle("app:sourcesStartConnection", async (_event, source: OAuthProvider, label: string) => {
    return startSourceConnection(source, label);
  });
  ipcMain.handle("app:sourcesCompleteConnection", async (_event, source: OAuthProvider, connectionRequestId: string) => {
    return completeSourceConnection(source, connectionRequestId);
  });
  ipcMain.handle("app:sourcesAddYouTubeChannel", async (_event, channelUrl: string) => {
    const source = parseYouTubeSource(channelUrl);
    if (source.kind === "channel") {
      const youtubeChannels = (await youtubeChannelConnector.listConnections())
        .filter((connection) => connection.enabled && connection.config?.kind === "channel")
        .length;
      if (youtubeChannels >= MAX_YOUTUBE_CHANNEL_SOURCES) {
        throw new Error(`You can monitor up to ${MAX_YOUTUBE_CHANNEL_SOURCES} YouTube channels.`);
      }
    }
    await youtubeChannelConnector.addChannel(channelUrl);
    await scanService.scheduleNextScan();
    return scanService.getState();
  });
  ipcMain.handle("app:sourcesConnectTwitterLocal", async () => {
    const { username } = await birdTwitterConnector.verifyAccount();
    const now = new Date().toISOString();
    const connection: SourceConnection = {
      id: makeSourceConnectionId("twitter", "local", "home"),
      source: "twitter",
      backend: "local",
      label: `X · @${username}`,
      accountIdentifier: username,
      externalAccountId: null,
      enabled: true,
      config: {},
      connectedAt: now,
      updatedAt: now
    };
    await store.saveSourceConnection(connection);
    // Replace any legacy OAuth (native) X connection so the feed is read once, via bird.
    for (const existing of await store.listSourceConnections()) {
      if (existing.source === "twitter" && existing.backend === "native") {
        await store.removeSourceConnection(existing.id);
      }
    }
    await scanService.scheduleNextScan();
    return scanService.getState();
  });
  ipcMain.handle("app:sourcesRemoveConnection", async (_event, connectionId: string) => {
    await store.removeSourceConnection(connectionId);
    await scanService.scheduleNextScan();
    return scanService.getState();
  });
  ipcMain.handle("app:sourcesSummarizeYouTubeVideo", async (_event, connectionId: string) => {
    const connection = await store.getSourceConnection(connectionId);
    if (!connection || connection.source !== "youtube" || connection.backend !== "local" || connection.config?.kind !== "video") {
      throw new Error("That YouTube video source is no longer available.");
    }
    return scanService.summarizeYouTubeVideoConnection(connectionId);
  });
  ipcMain.handle("app:sourcesUpdateConnectionConfig", async (_event, connectionId: string, config: Record<string, unknown>) => {
    const connection = await store.getSourceConnection(connectionId);
    if (!connection) throw new Error("That source connection is no longer available.");
    await store.updateSourceConnectionConfig(connectionId, config);
    await scanService.scheduleNextScan();
    return scanService.getState();
  });
  ipcMain.handle("app:sourcesRefreshConnectionMetadata", async (_event, connectionId: string) => {
    const connection = await store.getSourceConnection(connectionId);
    if (!connection) throw new Error("That source connection is no longer available.");
    return scanService.getState();
  });
  scanService.onChange((state) => {
    updateTrayFromState(state);
    popover?.webContents.send("app:stateChanged", state);
  });
}

async function waitForTelegramConnection(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (telegram.getAuthState().status === "connected") {
      await syncTelegramAccountChats();
      await scanService.scheduleNextScan();
      await publishState();
      return;
    }
    if (telegram.getAuthState().status === "error") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function syncTelegramAccountChats(): Promise<void> {
  const existing = existingTelegramChatSelection(await store.getTelegramChats());
  const chats = (await telegram.listAccountChats()).map((chat) => ({
    ...chat,
    enabled: telegramSelectionKeys(chat)
      .map((key) => existing.get(key)?.enabled)
      .find((enabled) => typeof enabled === "boolean") ?? chat.enabled
  }));
  await store.updateSettings({ telegramExportPath: null });
  await store.replaceTelegramChats(chats);
}

function existingTelegramChatSelection(chats: Awaited<ReturnType<AppStore["getTelegramChats"]>>): Map<string, { enabled: boolean }> {
  const existing = new Map<string, { enabled: boolean }>();
  for (const chat of chats) {
    for (const key of telegramSelectionKeys(chat)) {
      existing.set(key, { enabled: chat.enabled });
    }
  }
  return existing;
}

function telegramSelectionKeys(chat: Awaited<ReturnType<AppStore["getTelegramChats"]>>[number]): string[] {
  return [
    chat.id,
    chat.peerKey,
    chat.username ? `username:${chat.username.toLowerCase()}` : undefined,
    chat.title ? `title:${chat.kind}:${chat.title.trim().toLowerCase()}` : undefined
  ].filter((key): key is string => Boolean(key));
}

async function publishState(): Promise<void> {
  const state = await scanService.getState();
  updateTrayFromState(state);
  popover?.webContents.send("app:stateChanged", state);
}

async function showOpenFileDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  nativeDialogOpen = true;
  popover?.show();
  popover?.focus();
  try {
    return popover && !popover.isDestroyed()
      ? await dialog.showOpenDialog(popover, options)
      : await dialog.showOpenDialog(options);
  } finally {
    nativeDialogOpen = false;
  }
}

async function getDiagnostics() {
  return buildDiagnostics(await scanService.getState(), {
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    notificationSupported: Notification.isSupported()
  });
}

function appendNotificationSetupCheck(result: SetupCheckResult): SetupCheckResult {
  const notificationCheck: SetupCheckItem = Notification.isSupported()
    ? {
        id: "notifications",
        label: "Notifications",
        status: "ready",
        detail: "Supported; confirm macOS allows notifications"
      }
    : {
        id: "notifications",
        label: "Notifications",
        status: "error",
        detail: "Notifications are not supported in this runtime"
      };

  const checks = [...result.checks, notificationCheck];
  return {
    ...result,
    checks,
    ready: checks.every((check) => check.status === "ready")
  };
}

async function startSourceConnection(source: OAuthProvider, label: string): Promise<{ redirectUrl: string; connectionRequestId: string }> {
  const connector = nativeConnectors[source];
  if (!connector) throw new Error(`${sourceLabel(source)} is not available in this build.`);
  if (!("startConnection" in connector) || typeof connector.startConnection !== "function") {
    throw new Error(`${sourceLabel(source)} connection setup is not available in this build.`);
  }
  const request = await connector.startConnection(label);
  await shell.openExternal(request.redirectUrl);
  return request;
}

async function completeSourceConnection(source: OAuthProvider, connectionRequestId: string): Promise<AppState> {
  const connector = nativeConnectors[source];
  if (!connector) throw new Error(`${sourceLabel(source)} is not available in this build.`);
  if (!("completeConnection" in connector) || typeof connector.completeConnection !== "function") {
    throw new Error(`${sourceLabel(source)} connection completion is not available in this build.`);
  }
  await connector.completeConnection(connectionRequestId);
  await scanService.scheduleNextScan();
  return scanService.getState();
}

function createNativeConnectors(
  appStore: AppStore,
  oauth: NativeOAuthClient,
  configs: ReturnType<typeof loadNativeOAuthConfigs>
): Partial<Record<OAuthProvider, SourceConnector>> {
  const connectors: Partial<Record<OAuthProvider, SourceConnector>> = {};
  if (configs.gmail) connectors.gmail = new NativeGmailConnector(appStore, oauth);
  if (configs.twitter) connectors.twitter = new NativeTwitterConnector(appStore, oauth);
  return connectors;
}

function sourceLabel(source: OAuthProvider): string {
  switch (source) {
    case "gmail":
      return "Gmail";
    case "twitter":
      return "X / Twitter";
  }
}

function registerPowerMonitor(): void {
  powerMonitor.on("resume", () => {
    void scanService.scanIfDue().catch((error) => {
      console.error("Failed to run overdue scan after resume", error);
    });
  });
}

app.on("ready", () => {
  void bootstrap().catch((error) => {
    console.error("Bootstrap failed", error);
  });
});

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

app.on("second-instance", (_event, argv) => {
  if (hasShowWindowArgument(argv)) {
    showPopoverAfterReady({ pinUntilUserCloses: true });
    return;
  }

  if (!hasScanNowArgument(argv)) {
    showPopoverAfterReady({ pinUntilUserCloses: true });
    return;
  }

  if (!scanService) {
    pendingScanNow = true;
    return;
  }

  void scanService.scanNow().catch((error) => {
    console.error("Second-instance scan failed", error);
  });
});

app.on("activate", () => {
  showPopoverAfterReady({ pinUntilUserCloses: true });
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  if (devRendererReloadTimer) clearTimeout(devRendererReloadTimer);
  devRendererWatcher?.close();
  scanService?.stop();
  popover?.destroy();
});

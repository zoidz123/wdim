const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const rendererPath = path.join(root, "src", "renderer", "index.html");
const preloadPath = path.join(os.tmpdir(), `wdim-twitter-ui-preload-${process.pid}.cjs`);

const state = {
  settings: {
    scanIntervalMinutes: 60,
    gmailCredentialsPath: null,
    telegramExportPath: null,
    telegramIncludeDms: true,
    launchAtLogin: false,
    quietHours: { enabled: false, start: "22:00", end: "07:00" }
  },
  accounts: [],
  legacyLocalGmailAccounts: [],
  sourceConnections: [{
    id: "src_twitter",
    source: "twitter",
    backend: "native",
    label: "@maya",
    accountIdentifier: "1948208458337296384",
    externalAccountId: null,
    enabled: true,
    connectedAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
    config: { userId: "1948208458337296384", username: "maya", displayName: "Maya" }
  }],
  connectorHealth: [{
    connectionId: "src_twitter",
    status: "ready",
    detail: "Native connector ready",
    checkedAt: "2026-06-05T12:00:00.000Z"
  }],
  nativeConfiguredSources: ["gmail", "github", "twitter"],
  telegramChats: [],
  telegramConnected: false,
  codexReady: true,
  isScanning: false,
  nextScanAt: "2026-06-05T14:00:00.000Z",
  lastError: null,
  lastScan: {
    id: "scan_twitter",
    startedAt: "2026-06-05T13:00:00.000Z",
    completedAt: "2026-06-05T13:00:03.000Z",
    status: "completed",
    accountsScanned: 1,
    messagesFound: 1,
    messagesScanned: 1,
    messagesSkipped: 0,
    sourceSummaries: [{ source: "twitter", messagesFound: 1, messagesScanned: 1, messagesSkipped: 0 }],
    accountErrors: [],
    findings: []
  },
  lastCompletedScan: {
    id: "scan_twitter",
    startedAt: "2026-06-05T13:00:00.000Z",
    completedAt: "2026-06-05T13:00:03.000Z",
    status: "completed",
    accountsScanned: 1,
    messagesFound: 1,
    messagesScanned: 1,
    messagesSkipped: 0,
    sourceSummaries: [{ source: "twitter", messagesFound: 1, messagesScanned: 1, messagesSkipped: 0 }],
    accountErrors: [],
    findings: []
  },
  recentScans: [],
  importantItems: [{
    id: "item_twitter",
    status: "active",
    firstSeenAt: "2026-06-05T13:00:03.000Z",
    lastSeenAt: "2026-06-05T13:00:03.000Z",
    scanId: "scan_twitter",
    priority: "medium",
    source: "twitter",
    sourceId: "1801576800000000000",
    accountEmail: "X · @maya",
    title: "Market update worth noting",
    why: "Maya posted a high-signal thread about timeline monitoring and market context.",
    suggestedAction: "Read the post.",
    evidence: "WDIM shipped Twitter timeline monitoring with useful market context.",
    sourceUrl: "https://x.com/maya/status/1801576800000000000",
    receivedAt: "2026-06-05T12:54:00.000Z",
    sourceMetrics: { like_count: 42, repost_count: 7, reply_count: 3 }
  }]
};

fs.writeFileSync(preloadPath, `
  const state = ${JSON.stringify(state)};
  window.whatDidIMiss = {
    getState: async () => state,
    onStateChanged: () => {},
    scanNow: async () => state,
    retryCodex: async () => state,
    runSetupCheck: async () => ({ checkedAt: new Date().toISOString(), ready: true, checks: [] }),
    updateSettings: async () => state,
    updateImportantItemStatus: async () => state,
    copyCodexSignInCommand: async () => {},
    copyDiagnostics: async () => {},
    copyLiveCheck: async () => {},
    openDiagnosticsFolder: async () => {},
    openSetupLink: async () => {},
    openExternal: async (url) => { window.__lastOpenedUrl = url; },
    clearScanMemory: async () => state,
    sourcesStartConnection: async () => ({ redirectUrl: "https://example.com", connectionRequestId: "req" }),
    sourcesCompleteConnection: async () => state,
    sourcesRefreshConnectionMetadata: async () => state,
    sourcesSetConnectionEnabled: async () => state,
    sourcesRemoveConnection: async () => state,
    sourcesUpdateConnectionConfig: async () => state,
    refreshTelegramChats: async () => state,
    beginTelegramQrLogin: async () => ({ appState: state, authState: { status: "idle" } }),
    submitTelegramPhoneNumber: async () => ({ appState: state, authState: { status: "idle" } }),
    submitTelegramPhoneCode: async () => ({ appState: state, authState: { status: "idle" } }),
    submitTelegramPassword: async () => ({ appState: state, authState: { status: "idle" } }),
    getTelegramAuthState: async () => ({ appState: state, authState: { status: "idle" } }),
    cancelTelegramAuth: async () => ({ appState: state, authState: { status: "idle" } }),
    updateTelegramChat: async () => state
  };
`, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: false,
      nodeIntegration: false
    }
  });
  window.webContents.on("console-message", (_event, _level, message) => {
    if (message) console.error(`[renderer] ${message}`);
  });

  await window.loadURL(pathToFileURL(rendererPath).href);
  await window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (!document.body.innerText.includes("Loading...") || Date.now() - started > 3000) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  `);

  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const text = () => document.body.innerText;
      const click = (selector) => document.querySelector(selector)?.click();

      if (!text().includes("Market update worth noting")) throw new Error("Twitter finding did not render. Body: " + text().slice(0, 800));
      if (!text().includes("@maya")) throw new Error("Twitter author detail did not render");
      if (!text().includes("Open post")) throw new Error("Twitter CTA did not render");
      if (!text().includes("+1 post")) throw new Error("Twitter source overview count did not render");
      const twitterTile = [...document.querySelectorAll(".source-overview-tile")].find((item) => item.innerText.includes("X"));
      if (!twitterTile) throw new Error("Twitter source tile did not render");
      twitterTile.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const activeTwitterTile = [...document.querySelectorAll(".source-overview-tile.active")].find((item) => item.innerText.includes("X"));
      if (!activeTwitterTile) throw new Error("Twitter source tile did not become active");
      document.querySelector(".finding-details")?.setAttribute("open", "");
      if (!text().includes("42 likes") || !text().includes("7 reposts") || !text().includes("3 replies")) {
        throw new Error("Twitter metrics did not render");
      }
      document.querySelector('[data-source-url]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (window.__lastOpenedUrl !== "https://x.com/maya/status/1801576800000000000") {
        throw new Error("Twitter open post URL was not wired");
      }

      click('[data-view="integrations"]');
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!text().includes("X / Twitter")) throw new Error("Twitter integration row did not render");

      const twitterRow = [...document.querySelectorAll("[data-integration]")].find((row) => row.innerText.includes("X / Twitter"));
      if (!twitterRow) throw new Error("Twitter integration row is not clickable");
      twitterRow.click();
      await new Promise((resolve) => setTimeout(resolve, 0));

      if (!text().toLowerCase().includes("x / twitter timeline")) throw new Error("Twitter detail page did not render. Body: " + text().slice(0, 1200));
      if (!text().includes("Add X account")) throw new Error("Twitter add account CTA did not render");
      if (!text().includes("Maya · @maya")) throw new Error("Twitter connected account name did not render");

      return "ok";
    })();
  `);

  assert(result === "ok", "Unexpected smoke result");
  await window.close();
}

run()
  .then(() => {
    fs.rmSync(preloadPath, { force: true });
    app.quit();
  })
  .catch((error) => {
    fs.rmSync(preloadPath, { force: true });
    console.error(error);
    app.exit(1);
  });

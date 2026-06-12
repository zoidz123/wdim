import { codexOnboardingState, localContentVisibilityState, scanNowControlState } from "./control-state.js";

const api = window.whatDidIMiss;
const DIGEST_CARD_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const elements = {
  status: document.getElementById("status"),
  statusDescription: document.getElementById("statusDescription"),
  codexOnboarding: document.getElementById("codexOnboarding"),
  codexOnboardingTitle: document.getElementById("codexOnboardingTitle"),
  codexOnboardingDetail: document.getElementById("codexOnboardingDetail"),
  codexAccount: document.getElementById("codexAccount"),
  codexStatus: document.getElementById("codexStatus"),
  copyCodexSignIn: document.getElementById("copyCodexSignIn"),
  nextScan: document.getElementById("nextScan"),
  lastScanSummary: document.getElementById("lastScanSummary"),
  recentScanToggle: document.getElementById("recentScanToggle"),
  scanHistoryColumn: document.getElementById("scanHistoryColumn"),
  closeScanHistory: document.getElementById("closeScanHistory"),
  homeLayout: document.getElementById("homeLayout"),
  sourceOverview: document.getElementById("sourceOverview"),
  sourceInsightPanel: document.getElementById("sourceInsightPanel"),
  setupSummary: document.getElementById("setupSummary"),
  setupChecklist: document.getElementById("setupChecklist"),
  runSetupCheck: document.getElementById("runSetupCheck"),
  setupCheckResult: document.getElementById("setupCheckResult"),
  findings: document.getElementById("findings"),
  accounts: document.getElementById("accounts"),
  addIntegration: document.getElementById("addIntegration"),
  integrationTabs: document.getElementById("integrationTabs"),
  integrationTable: document.querySelector(".integration-table"),
  integrationTableHead: document.getElementById("integrationTableHead"),
  integrationSearch: document.getElementById("integrationSearch"),
  integrationRows: document.getElementById("integrationRows"),
  integrationsWorkspace: document.getElementById("integrationsWorkspace"),
  integrationDetail: document.querySelector(".integration-detail"),
  integrationBack: document.getElementById("integrationBack"),
  integrationDetailIcon: document.getElementById("integrationDetailIcon"),
  integrationDetailTitle: document.getElementById("integrationDetailTitle"),
  integrationDetailMeta: document.getElementById("integrationDetailMeta"),
  integrationDetailStatus: document.getElementById("integrationDetailStatus"),
  recentScans: document.getElementById("recentScans"),
  staleScanBanner: document.getElementById("staleScanBanner"),
  errorBanner: document.getElementById("errorBanner"),
  scanInterval: document.getElementById("scanInterval"),
  scanNow: document.getElementById("scanNow"),
  connectGmail: document.getElementById("connectGmail"),
  youtubeChannelForm: document.getElementById("youtubeChannelForm"),
  youtubeChannelUrl: document.getElementById("youtubeChannelUrl"),
  addYoutubeChannel: document.getElementById("addYoutubeChannel"),
  connectTwitter: document.getElementById("connectTwitter"),
  youtubeConnections: document.getElementById("youtubeConnections"),
  twitterConnections: document.getElementById("twitterConnections"),
  telegramStatus: document.getElementById("telegramStatus"),
  telegramChats: document.getElementById("telegramChats"),
  chooseTelegramExport: document.getElementById("chooseTelegramExport"),
  clearScanMemory: document.getElementById("clearScanMemory"),
  copyDiagnostics: document.getElementById("copyDiagnostics"),
  copyLiveCheck: document.getElementById("copyLiveCheck"),
  launchAtLogin: document.getElementById("launchAtLogin"),
  quietHoursEnabled: document.getElementById("quietHoursEnabled"),
  quietHoursStart: document.getElementById("quietHoursStart"),
  quietHoursEnd: document.getElementById("quietHoursEnd")
};

let currentState = null;
let lastSetupCheck = null;
let actionBusy = false;
let telegramAuthState = { status: "idle" };
let telegramAuthPoll = null;
let telegramChatQuery = "";
let telegramChatKind = "all";
let telegramFolderFilter = "all";
let telegramSelectionView = "all";
let activeIntegration = null;
let integrationQuery = "";
let integrationMode = "connected";
let gmailConnectBusy = false;
let pendingSourceConnections = {};
let sourceConnectionPolls = {};
let activeHomeSource = "all";
let sourceInsightPages = {};
let metadataRefreshes = new Set();
let telegramSearchRenderTimer = null;
let codexAuthPoll = null;
let codexAuthPollStartedAt = 0;

const MAX_YOUTUBE_CHANNEL_SOURCES = 10;

const SOURCE_INTEGRATION_CATALOG = [
  { id: "gmail", source: "gmail", name: "Gmail", description: "Email inbox monitoring", category: "Email", implemented: true },
  { id: "youtube", source: "youtube", name: "YouTube", description: "Channels, podcasts, transcripts, and videos worth watching", category: "Video", implemented: true },
  { id: "twitter", source: "twitter", name: "X / Twitter", description: "Timeline catch-up while you are away", category: "Social", implemented: true },
  { id: "telegram", source: "telegram", name: "Telegram", description: "DMs, groups, and channels", category: "Messaging", implemented: true }
];

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    const target = currentState && !currentState.codexReady ? "home" : button.dataset.view;
    if (target === "integrations") {
      activeIntegration = null;
      integrationMode = "connected";
      renderIntegrationRows(currentState);
    } else {
      resetGmailConnectState();
    }
    for (const item of document.querySelectorAll("[data-view]")) {
      item.classList.toggle("active", item.dataset.view === target);
    }
    for (const view of document.querySelectorAll(".app-view")) {
      view.classList.toggle("active", view.id === `${target}View`);
    }
  });
}

const sideRailToggle = document.getElementById("toggleSideRail");
sideRailToggle?.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  toggleSideRail();
});
sideRailToggle?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
});

function toggleSideRail() {
  const workspace = document.querySelector(".workspace");
  const isCollapsed = workspace?.classList.toggle("rail-collapsed") ?? false;
  const toggle = document.getElementById("toggleSideRail");
  if (toggle) {
    toggle.title = isCollapsed ? "Show sidebar" : "Hide sidebar";
    toggle.setAttribute("aria-label", isCollapsed ? "Show sidebar" : "Hide sidebar");
    toggle.classList.toggle("active", !isCollapsed);
  }
}

elements.recentScanToggle.addEventListener("click", () => {
  setScanHistoryOpen(!elements.homeLayout.classList.contains("history-open"));
});

elements.closeScanHistory.addEventListener("click", () => {
  setScanHistoryOpen(false);
});

elements.sourceOverview?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-home-source]");
  if (!button) return;
  setHomeSourceFilter(button.dataset.homeSource ?? "all");
});

elements.integrationSearch.addEventListener("input", () => {
  integrationQuery = elements.integrationSearch.value;
  renderIntegrationRows(currentState);
});

elements.integrationBack.addEventListener("click", () => {
  activeIntegration = null;
  resetGmailConnectState();
  renderIntegrationRows(currentState);
});

elements.addIntegration.addEventListener("click", () => {
  activeIntegration = null;
  integrationMode = "add";
  integrationQuery = "";
  elements.integrationSearch.value = "";
  resetGmailConnectState();
  renderIntegrationRows(currentState);
});

for (const button of document.querySelectorAll("[data-integration-tab]")) {
  button.addEventListener("click", () => {
    integrationMode = button.dataset.integrationTab === "all" ? "add" : "connected";
    activeIntegration = null;
    integrationQuery = "";
    elements.integrationSearch.value = "";
    resetGmailConnectState();
    renderIntegrationRows(currentState);
  });
}

for (const button of document.querySelectorAll("[data-setup-link]")) {
  button.addEventListener("click", async () => {
    await runAction("Opening setup link...", async () => {
      await api.openSetupLink(button.dataset.setupLink);
    });
  });
}

elements.scanNow.addEventListener("click", async () => {
  await runAction("Scanning...", async () => {
    await api.scanNow();
    await refresh();
  });
});

elements.copyCodexSignIn.addEventListener("click", async () => {
  await runAction("Starting ChatGPT sign-in...", async () => {
    const onboarding = codexOnboardingState(currentState);
    if (onboarding.action === "download") {
      await api.openExternal(onboarding.command);
      elements.status.textContent = "Codex download opened";
      return;
    }

    if (onboarding.action === "signin") {
      await api.startCodexSignIn();
      startCodexAuthPolling();
      elements.status.textContent = "ChatGPT sign-in opened";
      return;
    }

    await api.copyCodexSignInCommand();
    elements.status.textContent = onboarding.action === "copy" && currentState?.codexStatus?.state === "missing"
      ? "Codex install command copied"
      : "Codex command copied";
  });
});

elements.codexAccount.addEventListener("click", async () => {
  if (!currentState?.codexReady) {
    await runAction("Starting ChatGPT sign-in...", async () => {
      const onboarding = codexOnboardingState(currentState);
      if (onboarding.action === "download") {
        await api.openExternal(onboarding.command);
        elements.status.textContent = "Codex download opened";
        return;
      }

      await api.startCodexSignIn();
      startCodexAuthPolling();
      elements.status.textContent = "ChatGPT sign-in opened";
    });
    return;
  }

  await runAction("Logging out...", async () => {
    render(await api.logoutCodex());
    elements.status.textContent = "Signed out";
  });
});

elements.runSetupCheck.addEventListener("click", async () => {
  await runAction("Checking setup...", async () => {
    lastSetupCheck = await api.runSetupCheck();
    await refresh();
    renderSetupCheckResult(lastSetupCheck);
    elements.status.textContent = lastSetupCheck.ready ? "Setup ready" : "Setup needs attention";
  });
});

elements.connectGmail.addEventListener("click", async () => {
  await connectSource("gmail", "Gmail");
});

elements.youtubeChannelForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const sourceUrl = elements.youtubeChannelUrl.value.trim();
  if (!sourceUrl) return;
  await runAction("Adding YouTube source...", async () => {
    render(await api.sourcesAddYouTubeChannel(sourceUrl));
    elements.youtubeChannelUrl.value = "";
  });
});

elements.youtubeChannelUrl?.addEventListener("input", () => {
  applyYouTubeChannelFormState();
});

elements.connectTwitter.addEventListener("click", async () => {
  await runAction("Connecting X via your browser session...", async () => {
    render(await api.sourcesConnectTwitterLocal());
    elements.status.textContent = "X connected. It reads your For You feed using your browser login.";
  });
});

elements.chooseTelegramExport.addEventListener("click", async () => {
  if (currentState?.telegramConnected || currentState?.settings?.telegramExportPath) {
    await runAction("Refreshing Telegram chats...", async () => {
      render(await api.refreshTelegramChats());
    });
    return;
  }

  await runAction("Starting Telegram login...", async () => {
    telegramAuthState = { status: "connecting" };
    render(currentState);
    telegramAuthState = await api.beginTelegramPhoneLogin();
    render(currentState);
  });
});

elements.clearScanMemory.addEventListener("click", async () => {
  await runAction("Resetting scan memory...", async () => {
    render(await api.clearScanMemory());
  });
});

elements.copyDiagnostics.addEventListener("click", async () => {
  await runAction("Copying diagnostics...", async () => {
    await api.copyDiagnostics();
    await refresh();
    elements.status.textContent = "Diagnostics copied";
  });
});

elements.copyLiveCheck.addEventListener("click", async () => {
  await runAction("Copying live check...", async () => {
    await api.copyLiveCheckCommand();
    await refresh();
    elements.status.textContent = "Live check command copied";
  });
});

elements.scanInterval.addEventListener("change", async () => {
  await runAction("Updating schedule...", async () => {
    render(await api.updateSettings({ scanIntervalMinutes: Number(elements.scanInterval.value) }));
  });
});

elements.launchAtLogin.addEventListener("change", async () => {
  await runAction("Updating launch setting...", async () => {
    render(await api.updateSettings({ launchAtLogin: elements.launchAtLogin.checked }));
  });
});

elements.quietHoursEnabled.addEventListener("change", async () => {
  await runAction("Updating quiet hours...", async () => {
    render(await api.updateSettings({ quietHours: quietHoursUpdate() }));
  });
});

for (const element of [elements.quietHoursStart, elements.quietHoursEnd]) {
  element.addEventListener("change", async () => {
    await runAction("Updating quiet hours...", async () => {
      render(await api.updateSettings({ quietHours: quietHoursUpdate() }));
    });
  });
}

api.onStateChanged(render);
refresh();

const updateNowButton = document.getElementById("updateNow");
updateNowButton?.addEventListener("click", async () => {
  updateNowButton.disabled = true;
  updateNowButton.textContent = "Restarting...";
  try {
    await api.installUpdate();
  } catch {
    updateNowButton.disabled = false;
    updateNowButton.textContent = "Update now";
  }
});
api.onUpdateStatusChanged?.(applyUpdateStatus);
void api.getUpdateStatus?.().then(applyUpdateStatus).catch(() => {});

function applyUpdateStatus(status) {
  if (!updateNowButton) return;
  const ready = status?.state === "ready";
  if (ready && updateNowButton.hidden) {
    updateNowButton.disabled = false;
    updateNowButton.textContent = "Update now";
    updateNowButton.title = status.version
      ? `Update to ${status.version} and restart wdim`
      : "Install the downloaded update and restart wdim";
  }
  updateNowButton.hidden = !ready;
}

async function refresh() {
  render(await api.getState());
}

function render(state) {
  if (state.codexReady) stopCodexAuthPolling();
  currentState = state;
  elements.status.textContent = statusText(state);
  renderStatusDescription(state);
  elements.nextScan.textContent = state.nextScanAt ? relativeTime(state.nextScanAt) : "Not scheduled";
  elements.lastScanSummary.textContent = lastScannedLinkText(state);
  elements.scanInterval.value = String(state.settings.scanIntervalMinutes);
  elements.launchAtLogin.checked = Boolean(state.settings.launchAtLogin);
  elements.quietHoursEnabled.checked = Boolean(state.settings.quietHours.enabled);
  elements.quietHoursStart.value = state.settings.quietHours.start;
  elements.quietHoursEnd.value = state.settings.quietHours.end;
  elements.quietHoursStart.disabled = !state.settings.quietHours.enabled || state.isScanning;
  elements.quietHoursEnd.disabled = !state.settings.quietHours.enabled || state.isScanning;
  renderSetupChecklist(state);
  renderCodexOnboarding(state);
  renderCodexAccount(state);
  renderSetupCheckResult(lastSetupCheck);
  if (renderSignedOutLock(state)) {
    renderStaleScanWarning(state);
    renderError(null);
    applyControlState();
    return;
  }
  renderIntegrationRows(state);
  renderAccounts(state);
  renderTelegram(state);
  renderFindings(state);
  renderRecentScans(state);
  renderStaleScanWarning(state);
  renderError(displayLastError(state));
  applyControlState();
}

function renderSetupChecklist(state) {
  const items = setupChecklistItems(state);
  const readyCount = items.filter((item) => item.ready).length;
  const isReady = readyCount === items.length;

  elements.setupSummary.textContent = isReady ? "Ready" : `${readyCount}/${items.length}`;
  elements.setupSummary.className = `setup-summary ${isReady ? "ready" : "pending"}`;
  elements.setupChecklist.innerHTML = items
    .map((item) => `
      <div class="setup-item ${item.ready ? "ready" : "pending"}">
        <span class="setup-dot"></span>
        <div>
          <strong>${escapeHtml(item.label)}</strong>
          <span>${escapeHtml(item.detail)}</span>
        </div>
      </div>`)
    .join("");
}

function renderCodexOnboarding(state) {
  const onboarding = codexOnboardingState(state);
  elements.codexOnboarding.hidden = onboarding.hidden;
  elements.codexOnboardingTitle.textContent = onboarding.title;
  elements.codexOnboardingDetail.textContent = onboarding.detail;
  if (!state.codexReady) {
    elements.setupSummary.hidden = true;
    elements.setupSummary.textContent = "";
    elements.setupSummary.className = "setup-summary pending";
  }
  elements.codexStatus.hidden = true;
  elements.codexStatus.textContent = state.codexReady ? "Ready" : statusLabel(state.codexStatus?.state);
  elements.copyCodexSignIn.hidden = state.codexReady || (!onboarding.command && onboarding.action !== "signin");
  elements.copyCodexSignIn.textContent = onboarding.actionLabel ?? "Sign in with ChatGPT";
  elements.copyCodexSignIn.title = onboarding.command ?? "";
  elements.copyCodexSignIn.classList.toggle("primary", onboarding.action === "signin" || onboarding.action === "download");
  elements.setupChecklist.hidden = !state.codexReady;
  elements.runSetupCheck.hidden = !state.codexReady;
  elements.setupCheckResult.hidden = !state.codexReady || elements.setupCheckResult.hidden;
}

function renderCodexAccount(state) {
  elements.codexAccount.hidden = false;
  const onboarding = codexOnboardingState(state);
  elements.codexAccount.textContent = state.codexReady
    ? "Log Out"
    : onboarding.action === "download" ? "Install Codex" : "Sign in with ChatGPT";
  elements.codexAccount.title = state.codexReady
    ? "Sign out of WDIM"
    : onboarding.action === "download" ? "Download the Codex app" : "Sign in with ChatGPT";
  elements.codexAccount.classList.toggle("signed-in", Boolean(state.codexReady));
}

function renderSignedOutLock(state) {
  const visibility = localContentVisibilityState(state);
  setAuthLocked(visibility.locked);
  if (!visibility.locked) {
    elements.sourceOverview.hidden = false;
    elements.recentScanToggle.hidden = false;
    elements.scanNow.hidden = false;
    return false;
  }

  activeHomeSource = "all";
  activeIntegration = null;
  setScanHistoryOpen(false);
  showHomeView();
  elements.sourceOverview.hidden = true;
  elements.sourceOverview.innerHTML = "";
  elements.sourceInsightPanel.hidden = true;
  elements.sourceInsightPanel.innerHTML = "";
  elements.recentScanToggle.hidden = true;
  elements.scanNow.hidden = true;
  elements.lastScanSummary.textContent = "";
  elements.recentScans.innerHTML = "";
  elements.integrationRows.innerHTML = "";
  elements.accounts.innerHTML = "";
  elements.twitterConnections.innerHTML = "";
  elements.telegramChats.innerHTML = "";
  elements.findings.innerHTML = "";
  return true;
}

function renderStatusDescription(state) {
  elements.statusDescription.hidden = true;
  elements.statusDescription.textContent = "";
}

function setAuthLocked(isLocked) {
  document.querySelector(".workspace")?.classList.toggle("auth-locked", isLocked);
  document.getElementById("toggleSideRail")?.classList.toggle("auth-locked", isLocked);
}

function showHomeView() {
  for (const item of document.querySelectorAll("[data-view]")) {
    item.classList.toggle("active", item.dataset.view === "home");
  }
  for (const view of document.querySelectorAll(".app-view")) {
    view.classList.toggle("active", view.id === "homeView");
  }
}

function renderSetupCheckResult(result) {
  if (!result || !currentState?.codexReady) {
    elements.setupCheckResult.hidden = true;
    elements.setupCheckResult.innerHTML = "";
    return;
  }

  elements.setupCheckResult.hidden = false;
  elements.setupCheckResult.innerHTML = `
    <div class="setup-check-header ${result.ready ? "ready" : "pending"}">
      <strong>${result.ready ? "Ready for hourly scans" : "Setup needs attention"}</strong>
      <span>${escapeHtml(compactDateTime(result.checkedAt) || "Checked")}</span>
    </div>
    ${result.checks.map((check) => `
      <div class="setup-check-line ${escapeHtml(check.status)}">
        <span>${escapeHtml(check.label)}</span>
        <strong>${escapeHtml(check.detail)}</strong>
      </div>`).join("")}`;
}

function setupChecklistItems(state) {
  const sourceConnections = state.sourceConnections ?? [];
  const sourceCount = sourceConnections.filter((connection) => connection.enabled).length;
  return [
    {
      label: "Codex",
      detail: state.codexReady ? "Ready" : codexSetupDetail(state),
      ready: Boolean(state.codexReady)
    },
    {
      label: "Sources",
      detail: sourceCount ? sourceSummaryText(sourceConnections) : "None connected",
      ready: sourceCount > 0
    },
    {
      label: "Schedule",
      detail: state.nextScanAt ? `Next scan ${relativeTime(state.nextScanAt)}` : "Not scheduled",
      ready: Boolean(state.nextScanAt)
    }
  ];
}

function codexSetupDetail(state) {
  const status = state.codexStatus;
  if (status?.state === "missing") return "Install Codex";
  if (status?.state === "needs_auth") return "Sign in to WDIM";
  return "Check local app-server";
}

function statusLabel(status) {
  if (status === "missing") return "Missing";
  if (status === "needs_auth") return "Signed out";
  if (status === "ready") return "Ready";
  return "Needs attention";
}

function sourceSummaryText(connections) {
  const counts = new Map();
  for (const connection of connections) {
    if (!connection.enabled) continue;
    counts.set(connection.source, (counts.get(connection.source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => `${count} ${source}`)
    .join(", ");
}

function telegramSetupDetail(state) {
  if (!state.telegramConnected && !state.settings.telegramExportPath) return "Not connected";
  const { selected } = telegramStats(state);
  const dmText = state.settings.telegramIncludeDms ? "DMs on" : "DMs off";
  return selected ? `${selected} selected, ${dmText}` : dmText;
}

function renderIntegrationRows(state) {
  if (!state) return;

  const detailOpen = Boolean(activeIntegration);
  elements.addIntegration.hidden = integrationMode === "add" || detailOpen;
  elements.integrationTabs.hidden = integrationMode !== "add";
  elements.integrationTable.classList.toggle("catalog-mode", integrationMode === "add");
  elements.integrationSearch.placeholder = integrationMode === "add" ? "Search all sources" : "Search sources";
  updateIntegrationTabs();

  if (integrationMode === "add") {
    renderAddIntegrationCatalog(state);
    renderIntegrationDetail(null);
    return;
  }

  renderConnectedIntegrationTableHead();
  const integrations = integrationSummaries(state);
  const normalizedQuery = integrationQuery.trim().toLowerCase();
  const visibleIntegrations = integrations.filter((integration) => {
    if (!normalizedQuery) return true;
    return [
      integration.name,
      integration.id,
      integration.description,
      integration.connections,
      integration.meta
    ].join(" ").toLowerCase().includes(normalizedQuery);
  });

  if (activeIntegration && !integrations.some((integration) => integration.id === activeIntegration)) {
    activeIntegration = null;
  }

  elements.integrationRows.innerHTML = visibleIntegrations.length
    ? visibleIntegrations.map((integration) => `
      <button class="integration-row ${integration.id === activeIntegration ? "active" : ""}" type="button" data-integration="${escapeHtml(integration.id)}">
        <span class="integration-name-cell">
          <span class="integration-service-icon">${sourceIcon(integration.source)}</span>
          <span>
            <strong>${escapeHtml(integration.name)}</strong>
            <em>${escapeHtml(integration.description)}</em>
          </span>
        </span>
        <span>${escapeHtml(integration.connections)}</span>
      </button>`)
      .join("")
    : `<p class="hint integration-empty">No sources match that search.</p>`;

  for (const row of elements.integrationRows.querySelectorAll("[data-integration]")) {
    row.addEventListener("click", () => {
      if (row.dataset.integration !== "gmail") resetGmailConnectState();
      activeIntegration = row.dataset.integration ?? "gmail";
      renderIntegrationRows(currentState);
    });
  }

  renderIntegrationDetail(integrations.find((integration) => integration.id === activeIntegration) ?? null);
}

function renderAddIntegrationCatalog(state) {
  renderIntegrationTableHead(["Name", "Status"]);
  const normalizedQuery = integrationQuery.trim().toLowerCase();
  const summaries = integrationSummaries(state);
  const rows = SOURCE_INTEGRATION_CATALOG.filter((integration) => {
    if (!normalizedQuery) return true;
    return [
      integration.name,
      integration.id,
      integration.description,
      integration.category
    ].join(" ").toLowerCase().includes(normalizedQuery);
  });

  elements.integrationRows.innerHTML = rows.length
    ? rows.map((integration) => {
        const summary = summaries.find((item) => item.id === integration.id);
        const connected = summary && !/^0\b/.test(summary.connections) ? summary.connections : "";
        const enabled = integration.source === "telegram" || (integration.implemented && isSourceConfigured(state, integration.source));
        const status = connected
          ? `${connected} · ${integration.category}`
          : enabled
            ? `${integration.category} · ready`
            : `${integration.category} · unavailable`;
        return `
          <div class="integration-row catalog-row ${enabled ? "clickable" : ""}"${enabled ? ` data-catalog-open="${escapeHtml(integration.source)}"` : ""}>
            <span class="integration-name-cell">
              <span class="integration-service-icon">${sourceIcon(integration.source)}</span>
              <span>
                <strong>${escapeHtml(integration.name)}</strong>
                <em>${escapeHtml(integration.description)}</em>
              </span>
            </span>
            <span>${escapeHtml(status)}</span>
          </div>`;
      }).join("")
    : `<p class="hint integration-empty">No sources match that search.</p>`;

  for (const row of elements.integrationRows.querySelectorAll("[data-catalog-open]")) {
    row.addEventListener("click", () => {
      const integration = integrationSummaries(currentState).find((item) => item.id === row.dataset.catalogOpen);
      if (!integration) return;
      integrationMode = "connected";
      activeIntegration = integration.id;
      integrationQuery = "";
      elements.integrationSearch.value = "";
      renderIntegrationRows(currentState);
    });
  }

}

function renderConnectedIntegrationTableHead() {
  renderIntegrationTableHead(["Name", "Connections"]);
}

function renderIntegrationTableHead(columns) {
  elements.integrationTableHead.innerHTML = columns.map((column) => `<span>${escapeHtml(column)}</span>`).join("");
}

function updateIntegrationTabs() {
  for (const button of document.querySelectorAll("[data-integration-tab]")) {
    const active = button.dataset.integrationTab === (integrationMode === "add" ? "all" : "connected");
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function integrationSummaries(state) {
  const telegram = telegramStats(state);
  const telegramConnected = Boolean(state.telegramConnected || state.settings.telegramExportPath);
  const sourceConnections = state.sourceConnections ?? [];
  const legacyGmailCount = legacyGmailAccountsForDisplay(state).length;
  const sourceCount = (source) => sourceConnections.filter((connection) => connection.source === source && connection.enabled).length;
  const youtubeSourceCount = sourceConnections.filter((connection) =>
    connection.source === "youtube" && connection.backend === "local" && connection.enabled
  ).length;
  const isConfigured = (source) => isSourceConfigured(state, source);
  return [
    {
      id: "gmail",
      source: "gmail",
      name: "Gmail",
      description: "Gmail inbox monitoring",
      connections: `${sourceCount("gmail")} account${sourceCount("gmail") === 1 ? "" : "s"}`,
      status: sourceStatusText(state, "gmail", "Gmail"),
      meta: legacyGmailCount
        ? `${legacyGmailCount} legacy local inbox${legacyGmailCount === 1 ? "" : "es"} need reconnecting`
        : sourceCount("gmail")
          ? `${sourceCount("gmail")} Gmail account${sourceCount("gmail") === 1 ? "" : "s"} connected`
          : isConfigured("gmail") ? "Ready to connect" : "Unavailable"
    },
    {
      id: "twitter",
      source: "twitter",
      name: "X / Twitter",
      description: "For You timeline catch-up while you are away",
      connections: `${sourceCount("twitter")} account${sourceCount("twitter") === 1 ? "" : "s"}`,
      status: sourceStatusText(state, "twitter", "X / Twitter"),
      meta: sourceCount("twitter")
        ? `${sourceCount("twitter")} X account${sourceCount("twitter") === 1 ? "" : "s"} connected`
        : isConfigured("twitter") ? "Ready to connect" : "Unavailable"
    },
    {
      id: "youtube",
      source: "youtube",
      name: "YouTube",
      description: "Channels, videos, and podcasts worth watching",
      connections: `${youtubeSourceCount} source${youtubeSourceCount === 1 ? "" : "s"}`,
      status: "Ready",
      meta: youtubeSourceCount
        ? `${youtubeSourceCount} YouTube source${youtubeSourceCount === 1 ? "" : "s"} monitored`
        : "Add a YouTube channel or video URL"
    },
    {
      id: "telegram",
      source: "telegram",
      name: "Telegram",
      description: "DMs, groups, and channels",
      connections: telegramConnected ? "1 account" : "0 accounts",
      status: telegramConnected ? telegramSetupDetail(state) : telegramAuthStatusText(),
      meta: telegramMetaText(state, telegram)
    }
  ];
}

function sourceStatusText(state, source, label) {
  if (!isSourceConfigured(state, source)) return "Unavailable";
  const connections = sourceConnectionsFor(state, source);
  if (!connections.length) return sourceAddLabel(source, label);
  const active = connections.filter((connection) => connection.enabled).length;
  return active ? `${active} active` : "Not scanning";
}

function renderIntegrationDetail(integration) {
  elements.integrationsWorkspace.classList.toggle("detail-open", Boolean(integration));
  elements.integrationDetail.hidden = !integration;
  if (!integration) return;

  elements.integrationDetailIcon.innerHTML = sourceIcon(integration.source);
  elements.integrationDetailTitle.textContent = integration.name;
  elements.integrationDetailMeta.textContent = integration.meta;
  elements.integrationDetailStatus.textContent = "";
  elements.integrationDetailStatus.hidden = true;

  for (const panel of document.querySelectorAll("[data-integration-detail]")) {
    panel.classList.toggle("active", panel.dataset.integrationDetail === integration.id);
  }
}

function telegramStats(state) {
  const chats = state.telegramChats ?? [];
  const selectable = chats.filter((chat) => chat.kind !== "dm");
  return {
    selected: selectable.filter((chat) => chat.enabled).length,
    groups: selectable.filter((chat) => chat.kind === "group").length,
    channels: selectable.filter((chat) => chat.kind === "channel").length,
    dms: chats.filter((chat) => chat.kind === "dm").length
  };
}

function telegramMetaText(state, stats) {
  const dmState = state.settings.telegramIncludeDms ? "DMs on" : "DMs off";
  if (!state.telegramConnected && !state.settings.telegramExportPath) return "Connect Telegram to choose groups and channels";
  return `${stats.selected} selected · ${stats.groups} groups · ${stats.channels} channels · ${stats.dms} DMs · ${dmState}`;
}

function renderAccounts(state) {
  const gmailConnections = sourceConnectionsFor(state, "gmail");
  const legacyAccounts = legacyGmailAccountsForDisplay(state);
  const rows = [
    ...gmailConnections.map((connection) => renderSourceConnectionRow(state, connection)),
    ...legacyAccounts.map((account) => `
      <div class="account legacy-account">
        <div class="account-meta">
          <strong>${escapeHtml(account.email)}</strong>
          <span>Old local Gmail connection · not scanned</span>
          <span class="account-status pending">Add this email again to scan it.</span>
        </div>
      </div>`)
  ];

  elements.accounts.innerHTML = rows.length
    ? rows.join("")
    : `<p class="hint">${sourceUnavailableHint(state, "gmail", "Gmail")}</p>`;

  attachSourceConnectionHandlers(elements.accounts);
  renderGenericConnections(state, "youtube", elements.youtubeConnections, "YouTube");
  renderGenericConnections(state, "twitter", elements.twitterConnections, "X / Twitter");
}

function renderGenericConnections(state, source, element, label) {
  const connections = sourceConnectionsFor(state, source);
  element.innerHTML = connections.length
    ? connections.map((connection) => renderSourceConnectionRow(state, connection)).join("")
    : `<p class="hint">${sourceUnavailableHint(state, source, label)}</p>`;
  attachSourceConnectionHandlers(element);
  refreshGenericConnectionLabels(connections);
}

function sourceConnectionsFor(state, source) {
  return (state.sourceConnections ?? []).filter((connection) => {
    if (connection.source !== source) return false;
    return true;
  });
}

function legacyGmailAccountsForDisplay(state) {
  const connectedEmails = new Set(sourceConnectionsFor(state, "gmail")
    .map((connection) => String(connection.accountIdentifier || connection.label || "").toLowerCase())
    .filter((value) => value.includes("@")));
  return (state.legacyLocalGmailAccounts ?? state.accounts ?? [])
    .filter((account) => !connectedEmails.has(String(account.email ?? "").toLowerCase()));
}

function sourceUnavailableHint(state, source, label) {
  if (source === "youtube") {
    return "No YouTube sources yet. Add a channel or video URL.";
  }
  if (!isSourceConfigured(state, source)) {
    return `${label} is not available in this build.`;
  }
  return `No ${label} account connected yet.`;
}

function isSourceConfigured(state, source) {
  // YouTube and X both connect locally (yt-dlp / bird cookies), so they need no
  // OAuth provider configuration to be available.
  if (source === "youtube" || source === "twitter") return true;
  return isAccountSourceConfigured(state, source);
}

function isAccountSourceConfigured(state, source) {
  return (state?.nativeConfiguredSources ?? []).includes(source);
}

function renderSourceConnectionRow(state, connection) {
  const health = connectorHealthFor(state, connection.id);
  const status = connection.enabled
    ? health ? `${health.status.replace("_", " ")} · ${customerFacingHealthDetail(health.detail)}` : defaultConnectionStatus(connection)
    : "Not scanning";
  const summarizeAction = isYouTubeVideoConnection(connection)
    ? `<button data-summarize-youtube-video="${escapeHtml(connection.id)}"${state.isScanning ? " disabled" : ""}>Summarize</button>`
    : "";
  return `
    <div class="account">
      <div class="account-meta">
        <strong>${escapeHtml(connectionDisplayName(connection))}</strong>
        <span>${escapeHtml(connectedAtText(connection.connectedAt))}</span>
        <span class="account-status ${escapeHtml(healthStatusClass(health))}">${escapeHtml(status)}</span>
      </div>
      <div class="account-actions">
        ${summarizeAction}
        <button data-source-remove="${escapeHtml(connection.id)}"${state.isScanning ? " disabled" : ""}>Remove</button>
      </div>
    </div>`;
}

function defaultConnectionStatus(connection) {
  return isYouTubeVideoConnection(connection) ? "Ready to summarize" : "Ready for next scan";
}

function isYouTubeVideoConnection(connection) {
  return connection.source === "youtube" && connection.backend === "local" && connection.config?.kind === "video";
}

function connectionDisplayName(connection) {
  if (connection.source === "twitter") {
    const username = String(connection.config?.username ?? "").trim();
    const displayName = String(connection.config?.displayName ?? "").trim();
    if (username) return displayName ? `${displayName} · @${username}` : `@${username}`;
    const label = String(connection.label ?? "").trim();
    if (label && !/^ca_[A-Za-z0-9_-]+$/.test(label)) return label;
    return "X account";
  }
  const value = String(connection.accountIdentifier || connection.label || "").trim();
  if (connection.source === "youtube" && connection.backend === "local") return value || "YouTube source";
  if (value && !/^ca_[A-Za-z0-9_-]+$/.test(value)) return value;
  if (connection.source === "gmail") return "Gmail account";
  return value || "Connected account";
}

function refreshGenericConnectionLabels(connections) {
  for (const connection of connections) {
    const value = String(connection.accountIdentifier || connection.label || "");
    if (!/^ca_[A-Za-z0-9_-]+$/.test(value) || metadataRefreshes.has(connection.id)) continue;
    metadataRefreshes.add(connection.id);
    api.sourcesRefreshConnectionMetadata(connection.id)
      .then((state) => render(state))
      .catch(() => {
        metadataRefreshes.delete(connection.id);
      });
  }
}

function connectorHealthFor(state, connectionId) {
  const health = (state.connectorHealth ?? []).find((item) => item.connectionId === connectionId) ?? null;
  return health;
}

function customerFacingHealthDetail(detail) {
  return String(detail ?? "")
    .trim();
}

function healthStatusClass(health) {
  if (!health) return "pending";
  if (health.status === "ready") return "ok";
  if (health.status === "needs_auth") return "pending";
  return "error";
}

function attachSourceConnectionHandlers(root) {
  for (const button of root.querySelectorAll("[data-summarize-youtube-video]")) {
    button.addEventListener("click", async () => {
      await runAction("Summarizing video...", async () => {
        await api.sourcesSummarizeYouTubeVideo(button.dataset.summarizeYoutubeVideo);
      });
    });
  }

  for (const button of root.querySelectorAll("[data-source-remove]")) {
    button.addEventListener("click", async () => {
      await runAction("Removing source...", async () => {
        render(await api.sourcesRemoveConnection(button.dataset.sourceRemove));
      });
    });
  }
}

function renderTelegram(state, options = {}) {
  const chats = state.telegramChats ?? [];
  const connected = Boolean(state.telegramConnected || state.settings.telegramExportPath);
  elements.telegramStatus.textContent = connected ? telegramSetupDetail(state) : telegramAuthStatusText();
  elements.chooseTelegramExport.textContent = connected ? "Refresh chats" : "Connect Telegram";

  if (!connected) {
    elements.telegramChats.innerHTML = telegramAuthContent();
    wireTelegramPhoneForm();
    wireTelegramCodeForm();
    wireTelegramPasswordForm();
    return;
  }

  if (!chats.length) {
    elements.telegramChats.innerHTML = `<p class="hint">Connected. Loading chats...</p>`;
    return;
  }

  const selectableChats = chats.filter((chat) => chat.kind !== "dm");
  const selectedCount = selectableChats.filter((chat) => chat.enabled).length;
  const groupCount = selectableChats.filter((chat) => chat.kind === "group").length;
  const channelCount = selectableChats.filter((chat) => chat.kind === "channel").length;
  const dmCount = chats.filter((chat) => chat.kind === "dm").length;
  const folderNames = [...new Set(selectableChats.flatMap((chat) => chat.folders ?? []))].sort((a, b) => a.localeCompare(b));
  const normalizedQuery = telegramChatQuery.trim().toLowerCase();
  const visibleChats = selectableChats.filter((chat) => {
    const kindMatches = telegramChatKind === "all" || chat.kind === telegramChatKind;
    const folderMatches = telegramFolderFilter === "all" || (chat.folders ?? []).includes(telegramFolderFilter);
    const selectionMatches = telegramSelectionView === "all" || chat.enabled;
    const metadata = telegramChatMetadata(chat).join(" ").toLowerCase();
    const queryMatches = !normalizedQuery || `${chat.title} ${metadata}`.toLowerCase().includes(normalizedQuery);
    return kindMatches && folderMatches && selectionMatches && queryMatches;
  });

  elements.telegramChats.innerHTML = `
    <div class="telegram-controls">
      <section class="telegram-option">
        <label class="dm-toggle">
          <span>
            <strong>Monitor DMs</strong>
            <em>${dmCount} direct chats found. Toggle once to include or exclude all direct messages.</em>
          </span>
          <input id="telegramIncludeDms" type="checkbox"${state.settings.telegramIncludeDms ? " checked" : ""}${state.isScanning ? " disabled" : ""} />
        </label>
      </section>

      <section class="telegram-option">
        <div class="telegram-option-head">
          <span>
            <strong>Select groups and channels</strong>
            <em>${selectedCount} selected from ${groupCount} groups and ${channelCount} channels.</em>
          </span>
          <button id="telegramSelectVisible" type="button"${visibleChats.length ? "" : " disabled"}>Select visible</button>
        </div>
        <div class="chat-tools">
          <input id="telegramChatSearch" type="search" placeholder="Search groups and channels" value="${escapeHtml(telegramChatQuery)}" />
          <select id="telegramChatKind">
            <option value="all"${telegramChatKind === "all" ? " selected" : ""}>All</option>
            <option value="group"${telegramChatKind === "group" ? " selected" : ""}>Groups (${groupCount})</option>
            <option value="channel"${telegramChatKind === "channel" ? " selected" : ""}>Channels (${channelCount})</option>
          </select>
        </div>
        <div class="telegram-tabs" role="tablist" aria-label="Telegram source filter">
          <button type="button" role="tab" aria-selected="${telegramSelectionView === "all" ? "true" : "false"}" data-telegram-selection-view="all"${telegramSelectionView === "all" ? " class=\"active\"" : ""}>All (${selectableChats.length})</button>
          <button type="button" role="tab" aria-selected="${telegramSelectionView === "selected" ? "true" : "false"}" data-telegram-selection-view="selected"${telegramSelectionView === "selected" ? " class=\"active\"" : ""}>Selected (${selectedCount})</button>
        </div>
        ${folderNames.length ? `
          <div class="folder-filters">
            <button data-telegram-folder="all"${telegramFolderFilter === "all" ? " class=\"active\"" : ""}>All folders</button>
            ${folderNames.map((folder) => `<button data-telegram-folder="${escapeHtml(folder)}"${telegramFolderFilter === folder ? " class=\"active\"" : ""}>${escapeHtml(folder)}</button>`).join("")}
          </div>` : ""}
      </section>
    </div>
    <div class="chat-list">
      ${visibleChats.length ? visibleChats
    .map((chat) => `
      <label class="chat-toggle">
        <span>
          <strong>${escapeHtml(chat.title)}</strong>
          <em>${escapeHtml(telegramChatMetadata(chat).join(" · "))}</em>
        </span>
        <input type="checkbox" data-telegram-chat="${escapeHtml(chat.id)}"${chat.enabled ? " checked" : ""}${state.isScanning ? " disabled" : ""} />
      </label>`)
    .join("") : `<p class="hint">No matching groups or channels.</p>`}
    </div>`;

  if (options.focusSearch) {
    const focusedSearch = document.getElementById("telegramChatSearch");
    focusedSearch?.focus();
    if (typeof focusedSearch?.setSelectionRange === "function") {
      focusedSearch.setSelectionRange(focusedSearch.value.length, focusedSearch.value.length);
    }
  }
  if (typeof options.chatListScrollTop === "number") {
    const chatList = elements.telegramChats.querySelector(".chat-list");
    if (chatList) chatList.scrollTop = options.chatListScrollTop;
  }

  const dmToggle = document.getElementById("telegramIncludeDms");
  dmToggle?.addEventListener("change", async () => {
    await runAction("Updating Telegram DMs...", async () => {
      render(await api.updateSettings({ telegramIncludeDms: dmToggle.checked }));
    });
  });

  const search = document.getElementById("telegramChatSearch");
  search?.addEventListener("input", () => {
    telegramChatQuery = search.value;
    if (telegramSearchRenderTimer) clearTimeout(telegramSearchRenderTimer);
    telegramSearchRenderTimer = setTimeout(() => {
      telegramSearchRenderTimer = null;
      renderTelegram(currentState, { focusSearch: true });
    }, 150);
  });

  const kind = document.getElementById("telegramChatKind");
  kind?.addEventListener("change", () => {
    telegramChatKind = kind.value;
    renderTelegram(currentState);
  });

  for (const button of elements.telegramChats.querySelectorAll("[data-telegram-selection-view]")) {
    button.addEventListener("click", () => {
      telegramSelectionView = button.dataset.telegramSelectionView ?? "all";
      renderTelegram(currentState);
    });
  }

  for (const button of elements.telegramChats.querySelectorAll("[data-telegram-folder]")) {
    button.addEventListener("click", () => {
      telegramFolderFilter = button.dataset.telegramFolder ?? "all";
      renderTelegram(currentState);
    });
  }

  document.getElementById("telegramSelectVisible")?.addEventListener("click", async () => {
    const scrollTop = telegramChatListScrollTop();
    const ids = new Set(visibleChats.map((chat) => chat.id));
    const chatsToEnable = visibleChats.filter((chat) => !chat.enabled);
    const updated = {
      ...currentState,
      telegramChats: currentState.telegramChats.map((chat) => ids.has(chat.id) ? { ...chat, enabled: true } : chat)
    };
    currentState = updated;
    renderTelegram(updated, { chatListScrollTop: scrollTop });
    renderIntegrationDetail(integrationSummaries(updated).find((integration) => integration.id === activeIntegration) ?? null);

    try {
      let nextState = updated;
      for (const chat of chatsToEnable) {
        nextState = await api.setTelegramChatEnabled(chat.id, true);
      }
      currentState = nextState;
      renderTelegram(nextState, { chatListScrollTop: scrollTop });
      renderIntegrationDetail(integrationSummaries(nextState).find((integration) => integration.id === activeIntegration) ?? null);
    } catch (error) {
      renderError(error?.message ?? String(error));
      await refresh();
    }
  });

  for (const input of elements.telegramChats.querySelectorAll("[data-telegram-chat]")) {
    input.addEventListener("change", async () => {
      const chatId = input.dataset.telegramChat;
      const enabled = input.checked;
      const scrollTop = telegramChatListScrollTop();
      const optimistic = {
        ...currentState,
        telegramChats: currentState.telegramChats.map((chat) => chat.id === chatId ? { ...chat, enabled } : chat)
      };
      currentState = optimistic;
      renderTelegram(optimistic, { chatListScrollTop: scrollTop });
      renderIntegrationDetail(integrationSummaries(optimistic).find((integration) => integration.id === activeIntegration) ?? null);

      try {
        const nextState = await api.setTelegramChatEnabled(chatId, enabled);
        currentState = nextState;
        renderTelegram(nextState, { chatListScrollTop: scrollTop });
        renderIntegrationDetail(integrationSummaries(nextState).find((integration) => integration.id === activeIntegration) ?? null);
      } catch (error) {
        renderError(error?.message ?? String(error));
        await refresh();
      }
    });
  }
}

function telegramChatListScrollTop() {
  return elements.telegramChats.querySelector(".chat-list")?.scrollTop ?? 0;
}

function telegramAuthStatusText() {
  if (telegramAuthState.status === "connecting") return "Connecting";
  if (telegramAuthState.status === "phone_required") return "Phone";
  if (telegramAuthState.status === "code_required") return "Code";
  if (telegramAuthState.status === "pending") return "Scan QR";
  if (telegramAuthState.status === "password_required") return "Password required";
  if (isTelegramDeveloperCredentialError(telegramAuthState.error)) return "Not connected";
  if (telegramAuthState.status === "error") return "Connection failed";
  return "Not connected";
}

function telegramChatMetadata(chat) {
  return [
    chat.kind,
    chat.username ? `@${chat.username}` : null,
    chat.memberCount ? `${chat.memberCount.toLocaleString()} members` : null,
    ...(chat.folders ?? []).map((folder) => `Folder: ${folder}`),
    chat.peerKey ? `ID: ${chat.peerKey}` : null
  ].filter(Boolean);
}

function telegramAuthContent() {
  if (telegramAuthState.status === "pending") {
    return `
      <div class="telegram-auth">
        <img src="${escapeHtml(telegramAuthState.qrDataUrl)}" alt="Telegram login QR code" />
        <p class="hint">Open Telegram on your phone: Settings, Devices, Link Desktop Device.</p>
        <p class="hint">${escapeHtml(telegramQrExpiryText(telegramAuthState.expiresAt))}</p>
      </div>`;
  }
  if (telegramAuthState.status === "phone_required") {
    return `
      <form class="telegram-password" id="telegramPhoneForm">
        <p class="hint">Enter the phone number connected to your Telegram account.</p>
        <input id="telegramPhone" type="tel" placeholder="+1 555 123 4567" autocomplete="tel" />
        <button type="submit">Send code</button>
      </form>`;
  }
  if (telegramAuthState.status === "code_required") {
    const target = telegramAuthState.isCodeViaApp ? "Telegram app" : "SMS";
    return `
      <form class="telegram-password" id="telegramCodeForm">
        <p class="hint">Enter the login code Telegram sent to ${escapeHtml(telegramAuthState.phoneNumber || "your phone")} via ${target}.</p>
        <input id="telegramCode" type="text" inputmode="numeric" placeholder="Login code" autocomplete="one-time-code" />
        <button type="submit">Continue</button>
      </form>`;
  }
  if (telegramAuthState.status === "password_required") {
    return `
      <form class="telegram-password" id="telegramPasswordForm">
        <p class="hint">Enter your Telegram 2FA cloud password to finish connecting this device.</p>
        <input id="telegramPassword" type="password" placeholder="Telegram 2FA password" autocomplete="current-password" />
        <button type="submit">Continue</button>
      </form>`;
  }
  if (telegramAuthState.status === "error") {
    if (isTelegramDeveloperCredentialError(telegramAuthState.error)) {
      return `<p class="hint">Connect Telegram to scan DMs and selected groups every hour.</p>`;
    }
    return `<p class="hint">${escapeHtml(telegramAuthState.error)}</p>`;
  }
  if (telegramAuthState.status === "connecting") {
    return `<p class="hint">Opening a secure Telegram QR login...</p>`;
  }
  return `<p class="hint">Connect Telegram to scan DMs and selected groups every hour.</p>`;
}

function isTelegramDeveloperCredentialError(error) {
  return String(error ?? "").includes("TELEGRAM_API_ID") || String(error ?? "").includes("TELEGRAM_API_HASH");
}

function telegramQrExpiryText(expiresAt) {
  const seconds = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return "Refreshing QR code...";
  return `Expires in ${seconds}s. If Telegram says invalid, wait for the QR to refresh and scan again.`;
}

function wireTelegramPhoneForm() {
  const form = document.getElementById("telegramPhoneForm");
  const input = document.getElementById("telegramPhone");
  if (!form || !input) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction("Sending Telegram code...", async () => {
      const result = await api.submitTelegramPhoneNumber(input.value);
      telegramAuthState = result.authState;
      render(result.appState);
    });
  });
}

function wireTelegramCodeForm() {
  const form = document.getElementById("telegramCodeForm");
  const input = document.getElementById("telegramCode");
  if (!form || !input) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction("Checking Telegram code...", async () => {
      const result = await api.submitTelegramPhoneCode(input.value);
      telegramAuthState = result.authState;
      render(result.appState);
    });
  });
}

function wireTelegramPasswordForm() {
  const form = document.getElementById("telegramPasswordForm");
  const input = document.getElementById("telegramPassword");
  if (!form || !input) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction("Finishing Telegram login...", async () => {
      const result = await api.submitTelegramPassword(input.value);
      telegramAuthState = result.authState;
      render(result.appState);
    });
  });
}

function startTelegramAuthPolling() {
  if (telegramAuthPoll) clearInterval(telegramAuthPoll);
  telegramAuthPoll = setInterval(async () => {
    const result = await api.getTelegramAuthState();
    telegramAuthState = result.authState;
    render(result.appState);
    if (telegramAuthState.status === "connected" || telegramAuthState.status === "error") {
      clearInterval(telegramAuthPoll);
      telegramAuthPoll = null;
    }
  }, 1200);
}

function accountHealthText(state, account) {
  const scan = state.lastScan;
  if (!scan) return "Waiting for scan";
  if (scan.status === "failed" && !scan.accountErrors?.length) return "Latest scan failed";

  const error = accountScanError(scan, account);
  if (error) return `Skipped last scan: ${error.error}`;
  if (scan.status === "completed") {
    const summary = accountScanSummary(scan, account);
    return summary ? accountScanSummaryText(summary) : "Last scan OK";
  }
  return "Waiting for scan";
}

function accountHealthClass(state, account) {
  const scan = state.lastScan;
  if (!scan) return "pending";
  if (scan.status === "failed" && !scan.accountErrors?.length) return "error";
  return accountScanError(scan, account) ? "error" : "ok";
}

function accountScanError(scan, account) {
  const accountId = String(account.id ?? account.email ?? "").toLowerCase();
  return (scan.accountErrors ?? []).find((item) => String(item.accountEmail ?? "").toLowerCase() === accountId);
}

function accountScanSummary(scan, account) {
  const accountId = String(account.id ?? account.email ?? "").toLowerCase();
  return (scan.accountSummaries ?? []).find((item) => String(item.accountEmail ?? "").toLowerCase() === accountId);
}

function accountScanSummaryText(summary) {
  const scanned = summary.messagesScanned ?? 0;
  return `Last scan OK · ${scanned} new`;
}

function renderFindings(state) {
  const failedScan = displayFailedScan(state);
  if (activeHomeSource !== "all" && !homeSourceDefinitions().some((source) => source.id === activeHomeSource)) {
    activeHomeSource = "all";
  }
  const cards = recentDigestCards(state);
  const youtubeFindings = displayFindings(state).filter((finding) => finding.source === "youtube");
  const accountErrors = displayScan(state)?.accountErrors ?? [];

  renderHomeSourceOverview(homeCounts(cards, youtubeFindings), surfacedCount(cards, youtubeFindings));
  // The legacy source-insight pager is superseded by digest cards; keep it clear.
  if (elements.sourceInsightPanel) {
    elements.sourceInsightPanel.hidden = true;
    elements.sourceInsightPanel.innerHTML = "";
  }

  const visibleCards = activeHomeSource === "all" ? cards : cards.filter((card) => card.source === activeHomeSource);
  const visibleYouTube = activeHomeSource === "all" || activeHomeSource === "youtube" ? youtubeFindings : [];
  const visibleAccountErrors = activeHomeSource === "all" || activeHomeSource === "gmail" ? accountErrors : [];

  if (failedScan) {
    const previous = visibleCards.length || visibleYouTube.length
      ? renderDigestHome(visibleCards, visibleYouTube, visibleAccountErrors)
      : `<p class="hint">No previous successful scan to show yet.</p>`;
    elements.findings.innerHTML = `<div class="scan-failure-notice"><h3>Latest scan failed</h3><p>${escapeHtml(failedScan.error ?? "Unknown error")}</p></div>${previous}`;
    attachFindingActionHandlers();
    return;
  }

  if (!visibleCards.length && !visibleYouTube.length && !visibleAccountErrors.length) {
    elements.findings.innerHTML = `<p class="hint findings-empty">${escapeHtml(homeEmptyText(state))}</p>`;
    return;
  }

  elements.findings.innerHTML = renderDigestHome(visibleCards, visibleYouTube, visibleAccountErrors);
  attachFindingActionHandlers();
}

function recentDigestCards(state) {
  const dismissed = new Set(state.dismissedDigestCardIds ?? []);
  const order = ["twitter", "gmail", "telegram"];
  const seen = new Set();
  const scans = completedRecentScans(state);
  const cards = [];
  for (const scan of scans) {
    const bySource = new Map();
    for (const card of scan.digestCards ?? []) {
      const id = digestCardId(card);
      if (card.source === "youtube" || !normalizedDigestBullets(card).length) continue;
      if (dismissed.has(id) || seen.has(id)) continue;
      if (!bySource.has(card.source)) bySource.set(card.source, card);
    }
    for (const source of order) {
      const card = bySource.get(source);
      if (!card) continue;
      seen.add(digestCardId(card));
      cards.push(card);
    }
  }
  return cards;
}

function completedRecentScans(state) {
  const seen = new Set();
  const scans = [];
  for (const scan of [state.lastCompletedScan, ...(state.recentScans ?? [])]) {
    if (!scan || scan.status !== "completed") continue;
    const id = scan.id || `${scan.completedAt ?? ""}:${scan.startedAt ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    scans.push(scan);
  }
  const newestMs = Math.max(0, ...scans.map(scanTimeMs));
  const cutoffMs = newestMs ? newestMs - DIGEST_CARD_LOOKBACK_MS : 0;
  return scans
    .filter((scan) => scanTimeMs(scan) >= cutoffMs)
    .sort((a, b) => scanTimeMs(b) - scanTimeMs(a));
}

function scanTimeMs(scan) {
  const time = Date.parse(scan?.completedAt ?? scan?.startedAt ?? "");
  return Number.isFinite(time) ? time : 0;
}

function surfacedCount(cards, youtubeFindings) {
  return cards.reduce((sum, card) => sum + normalizedDigestBullets(card).length, 0) + youtubeFindings.length;
}

function homeCounts(cards, youtubeFindings) {
  const counts = {};
  for (const card of cards) counts[card.source] = (counts[card.source] ?? 0) + normalizedDigestBullets(card).length;
  if (youtubeFindings.length) counts.youtube = youtubeFindings.length;
  return counts;
}

// Card stack: one digest card per synthesis source, then YouTube video cards.
function renderDigestHome(cards, youtubeFindings, accountErrors) {
  const cardHtml = cards.map(renderDigestCard).join("");
  const youtubeHtml = youtubeFindings.length ? renderFindingCards(youtubeFindings, accountErrors) : (accountErrors.length ? renderFindingCards([], accountErrors) : "");
  return cardHtml + youtubeHtml;
}

function renderDigestCard(card) {
  const normalizedBullets = normalizedDigestBullets(card);
  const surfaced = normalizedBullets.length || card.surfacedCount || 0;
  const bullets = normalizedBullets.map((bullet) => {
    const detail = bullet.detail ? ` <span class="digest-bullet-detail">${escapeHtml(bullet.detail)}</span>` : "";
    const metaParts = digestBulletMetaParts(card.source, bullet);
    const link = bullet.sourceUrl
      ? `<a class="digest-bullet-link" href="${escapeHtml(bullet.sourceUrl)}" data-source-url="${escapeHtml(bullet.sourceUrl)}">${escapeHtml(digestSourceOpenLabel(card.source))}</a>`
      : "";
    const meta = metaParts || link
      ? `<p class="digest-bullet-meta">${metaParts ? `<span>${escapeHtml(metaParts)}</span>` : ""}${link}</p>`
      : "";
    return `
      <li>
        <div><span class="digest-bullet-title">${escapeHtml(bullet.title)}</span>${detail}</div>
        ${meta}
      </li>`;
  }).join("");
  return `
    <article class="finding digest-finding finding-${escapeHtml(card.source)}" data-source="${escapeHtml(card.source)}">
      <span class="finding-dot digest-dot" aria-hidden="true"></span>
      <div class="finding-icon" title="${escapeHtml(homeSourceLabel(card.source))}" aria-label="${escapeHtml(homeSourceLabel(card.source))}">
        ${sourceIcon(card.source)}
      </div>
      <div class="finding-main">
        <div class="finding-header">
          <div class="finding-title-block">
            <h3>${escapeHtml(homeSourceLabel(card.source))}</h3>
            <p>${escapeHtml(digestCardCountText(card.source, surfaced))}${card.generatedAt ? ` · Generated ${escapeHtml(compactDigestTimestamp(card.generatedAt))}` : ""}</p>
          </div>
        </div>
        <ul class="digest-card-bullets">${bullets}</ul>
      </div>
      <div class="finding-actions">
        <button class="review-button" data-dismiss-digest-card="${escapeHtml(digestCardId(card))}" title="Mark reviewed" aria-label="Mark ${escapeHtml(homeSourceLabel(card.source))} summary reviewed">✓</button>
      </div>
    </article>
  `;
}

function digestCardId(card) {
  return String(card.id || `${card.scanId ?? "scan"}:${card.source ?? "source"}`);
}

function digestCardCountText(source, count) {
  if (source === "gmail") return `${count} ${count === 1 ? "email" : "emails"}`;
  if (source === "telegram") return `${count} ${count === 1 ? "signal" : "signals"}`;
  if (source === "twitter") return `${count} ${count === 1 ? "highlight" : "highlights"}`;
  return `${count} ${count === 1 ? "update" : "updates"}`;
}

function digestSourceOpenLabel(source) {
  if (source === "gmail") return "View email";
  if (source === "telegram") return "View chat";
  if (source === "twitter") return "View post";
  return "View source";
}

function digestBulletMetaParts(source, bullet) {
  const who = bullet.attribution || "";
  const when = bullet.timestamp ? compactDigestTimestamp(bullet.timestamp) : "";
  if (source === "gmail") {
    const route = [
      who ? `From ${who}` : "",
      bullet.recipient ? `to ${bullet.recipient}` : ""
    ].filter(Boolean).join(" ");
    return [route, when].filter(Boolean).join(" · ");
  }
  return [who, when].filter(Boolean).join(" · ");
}

function normalizedDigestBullets(card) {
  return (card.bullets ?? [])
    .map(normalizeDigestBullet)
    .filter(Boolean);
}

function normalizeDigestBullet(bullet) {
  const rawTitle = firstText(bullet.title, bullet.label, bullet.text);
  const rawDetail = firstText(bullet.detail, bullet.summary, bullet.why, bullet.body);
  const parsedTitle = parseDigestBulletText(rawTitle);
  const parsedDetail = parseDigestBulletText(rawDetail);
  const sourceUrl = firstText(
    bullet.sourceUrl,
    bullet.url,
    markdownLinkUrl(rawTitle),
    markdownLinkUrl(rawDetail)
  );
  const title = cleanDigestText(parsedTitle.title || rawTitle);
  const detail = cleanDigestText(rawDetail || parsedTitle.detail || parsedDetail.detail);
  const isOnlyLink = sourceUrl && /^open(?: source| post| email)?$/i.test(title) && !detail;
  if ((!title && !detail) || isOnlyLink) return null;
  return {
    title: title || "Update",
    detail,
    attribution: firstText(bullet.attribution, bullet.author, bullet.who),
    recipient: firstText(bullet.recipient, bullet.to, bullet.accountEmail),
    timestamp: firstText(bullet.timestamp, bullet.receivedAt, bullet.sentAt, bullet.when),
    sourceUrl
  };
}

function parseDigestBulletText(value) {
  const text = String(value ?? "").trim();
  if (!text) return { title: "", detail: "" };
  const withoutLink = text.replace(/\s*\[open[^\]]*]\([^)]+\)\s*$/i, "").trim();
  const boldMatch = withoutLink.match(/^\*\*([^*]{1,180})\*\*:?\s*(.+)?$/);
  if (boldMatch) {
    return {
      title: boldMatch[1].trim(),
      detail: String(boldMatch[2] ?? "").trim()
    };
  }
  return { title: "", detail: "" };
}

function cleanDigestText(value) {
  return String(value ?? "")
    .replace(/\[open[^\]]*]\([^)]+\)/gi, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function markdownLinkUrl(value) {
  const match = String(value ?? "").match(/\[[^\]]+]\(([^)]+)\)/);
  return match?.[1]?.trim() ?? "";
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function setHomeSourceFilter(source) {
  activeHomeSource = source || "all";
  render(currentState);
}

function homeEmptyText(state) {
  if (activeHomeSource !== "all") {
    if (!hasSourceConnection(state, activeHomeSource)) {
      return `${homeSourceLabel(activeHomeSource)} isn't connected yet. Add it under Sources to start catching up.`;
    }
    return `Nothing notable from ${homeSourceLabel(activeHomeSource)} in recent scans.`;
  }
  const anyConnected = (state.sourceConnections ?? []).some((connection) => connection.enabled);
  return anyConnected
    ? "All caught up — nothing notable in recent scans."
    : "No sources connected yet. Add one under Sources and run a scan.";
}

function hasSourceConnection(state, source) {
  return (state.sourceConnections ?? []).some((connection) => connection.source === source && connection.enabled);
}

function renderHomeSourceOverview(counts, total) {
  if (!elements.sourceOverview) return;
  const sources = [
    { id: "all", label: "All", singular: "highlight", plural: "highlights", zeroNoun: "highlights", tone: "neutral", count: total },
    ...homeSourceDefinitions().map((source) => ({ ...source, count: counts[source.id] ?? 0 }))
  ];
  elements.sourceOverview.innerHTML = sources
    .map((source) => {
      const count = source.count ?? 0;
      const active = activeHomeSource === source.id;
      return `
        <button class="source-overview-tile ${active ? "active" : ""}" type="button" data-home-source="${escapeHtml(source.id)}" aria-pressed="${active ? "true" : "false"}">
          <span class="source-overview-icon">${source.id === "all" ? "∑" : sourceIcon(source.id)}</span>
          <span class="source-overview-name">${escapeHtml(source.label)}</span>
          <span class="source-overview-count ${count > 0 ? source.tone : "empty"}">${escapeHtml(sourceOverviewCountText(source, count))}</span>
        </button>
      `;
    })
    .join("");
}

function renderSourceInsightPanel(state) {
  if (!elements.sourceInsightPanel) return;
  const insights = sourceInsightsForActiveSource(state);
  if (!insights.length) {
    elements.sourceInsightPanel.hidden = true;
    elements.sourceInsightPanel.innerHTML = "";
    return;
  }

  const page = Math.min(Math.max(sourceInsightPages[activeHomeSource] ?? 0, 0), insights.length - 1);
  sourceInsightPages[activeHomeSource] = page;
  const current = insights[page];
  const currentId = sourceInsightId(current);
  const hasMultiple = insights.length > 1;
  const navLabel = hasMultiple ? `${page + 1}/${insights.length}` : "";
  elements.sourceInsightPanel.hidden = false;
  elements.sourceInsightPanel.innerHTML = `
    <details class="source-insight-current">
      <summary>
        <div>
          <div class="source-insight-meta">
            <span>${escapeHtml(homeSourceLabel(current.source))} insight · ${escapeHtml(relativePastTime(current.generatedAt))}</span>
            ${hasMultiple ? `
              <div class="source-insight-pager">
                <button type="button" data-source-insight-page="${page - 1}" ${page === 0 ? "disabled" : ""} title="Newer summary" aria-label="Newer summary">&#8249;</button>
                <span>${escapeHtml(navLabel)}</span>
                <button type="button" data-source-insight-page="${page + 1}" ${page === insights.length - 1 ? "disabled" : ""} title="Older summary" aria-label="Older summary">&#8250;</button>
              </div>
            ` : ""}
          </div>
          <h2>${escapeHtml(current.title)}</h2>
        </div>
        <span class="source-insight-read-more" aria-hidden="true"></span>
      </summary>
      <div class="source-insight-body">
        <p>${escapeHtml(current.summary)}</p>
        <button class="source-insight-dismiss" type="button" data-dismiss-source-insight="${escapeHtml(currentId)}" title="Dismiss summary" aria-label="Dismiss summary">Dismiss</button>
      </div>
    </details>
  `;

  for (const button of elements.sourceInsightPanel.querySelectorAll("[data-source-insight-page]")) {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextPage = Number(button.dataset.sourceInsightPage);
      if (!Number.isFinite(nextPage)) return;
      sourceInsightPages[activeHomeSource] = Math.min(Math.max(nextPage, 0), insights.length - 1);
      renderSourceInsightPanel(currentState);
    });
  }

  for (const button of elements.sourceInsightPanel.querySelectorAll("[data-dismiss-source-insight]")) {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const insightId = button.dataset.dismissSourceInsight;
      if (!insightId) return;
      const scrollTop = homeScrollTop();
      await runAction("Dismissing summary...", async () => {
        sourceInsightPages[activeHomeSource] = Math.min(sourceInsightPages[activeHomeSource] ?? 0, Math.max(insights.length - 2, 0));
        currentState = {
          ...currentState,
          dismissedSourceInsightIds: [...new Set([...(currentState?.dismissedSourceInsightIds ?? []), insightId])]
        };
        renderSourceInsightPanel(currentState);
        render(await api.dismissSourceInsight(insightId));
        setHomeScrollTop(scrollTop);
      });
    });
  }
}

function sourceInsightsForActiveSource(state) {
  if (activeHomeSource === "all") return [];
  const dismissed = new Set(state.dismissedSourceInsightIds ?? []);
  return (state.recentScans ?? [])
    .flatMap((scan) => scan.sourceInsights ?? [])
    .filter((insight) => insight.source === activeHomeSource && !dismissed.has(sourceInsightId(insight)))
    .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
    .slice(0, 6);
}

function sourceInsightId(insight) {
  const id = String(insight?.id ?? "").trim();
  if (id) return id;
  return `${insight?.source ?? "source"}:${insight?.generatedAt ?? insight?.title ?? ""}`;
}


function sourceOverviewCountText(source, count) {
  if (!count) return `0 ${source.zeroNoun}`;
  const prefix = source.id === "all" ? "" : "+";
  return `${prefix}${count} ${count === 1 ? source.singular : source.plural}`;
}

function homeSourceDefinitions() {
  return [
    { id: "twitter", label: "X", singular: "highlight", plural: "highlights", zeroNoun: "highlights", tone: "positive" },
    { id: "youtube", label: "YouTube", singular: "video", plural: "videos", zeroNoun: "videos", tone: "positive" },
    { id: "gmail", label: "Gmail", singular: "email", plural: "emails", zeroNoun: "emails", tone: "positive" },
    { id: "telegram", label: "Telegram", singular: "signal", plural: "signals", zeroNoun: "signals", tone: "positive" }
  ];
}

function renderRecentScans(state) {
  const scans = state.recentScans ?? [];
  if (!scans.length) {
    elements.recentScans.innerHTML = `<p class="hint">No scans have run yet.</p>`;
    return;
  }

  elements.recentScans.innerHTML = scans
    .map((scan) => {
      const status = scan.status === "completed" ? scanHistoryStatusText(scan) : "failed";
      return `
        <div class="scan-row ${escapeHtml(scan.status)}">
          <div class="scan-row-header">
            <strong>${escapeHtml(compactDateTime(scan.completedAt) || "Scan")}</strong>
            <span class="scan-pill">${escapeHtml(status)}</span>
          </div>
          ${scan.status === "completed" ? renderScanSources(scan) : `<p class="scan-total">${escapeHtml(scan.error ?? "Unknown error")}</p>`}
        </div>`;
    })
    .join("");
}

function scanHistoryStatusText(scan) {
  const surfaced = scanSurfacedDigestCount(scan) + (scan.findings ?? []).length;
  if (surfaced) return `${surfaced} surfaced`;
  return "0 surfaced";
}

function scanSurfacedDigestCount(scan) {
  return (scan.digestCards ?? [])
    .reduce((sum, card) => sum + normalizedDigestBullets(card).length, 0);
}

function renderScanSources(scan) {
  const sources = scan.sourceSummaries ?? [];
  if (!sources.length) return "";

  return `
    <details class="scan-details">
      <summary>Sources</summary>
      <div class="scan-sources">
        ${sources.map((summary) => renderScanSource(scan, summary)).join("")}
      </div>
    </details>`;
}

function renderScanSource(scan, summary) {
  const source = sourceLabel(summary.source);
  const accountRows = summary.source === "gmail" ? renderScanAccounts(scan) : "";
  const statusText = scanSourceStatusText(summary);
  return `
    <section class="scan-source">
      <div class="scan-source-header">
        <span class="scan-source-icon" title="${escapeHtml(source)}">${sourceIcon(summary.source)}</span>
        <strong>${escapeHtml(source)}</strong>
        <span>${escapeHtml(statusText)}</span>
      </div>
      ${accountRows}
    </section>`;
}

function renderScanAccounts(scan) {
  const summaries = scan.accountSummaries ?? [];
  if (!summaries.length) return "";

  return `
    <div class="scan-account-list">
      ${summaries.map((summary) => `
        <div class="scan-account-row">
          <span>${escapeHtml(summary.accountEmail)}</span>
          <strong>${escapeHtml(scanCountsText(summary))}</strong>
        </div>`).join("")}
    </div>`;
}

function renderStaleScanWarning(state) {
  const stale = staleScanState(state);
  if (!stale.isStale) {
    elements.staleScanBanner.hidden = true;
    elements.staleScanBanner.textContent = "";
    return;
  }

  elements.staleScanBanner.hidden = false;
  elements.staleScanBanner.textContent = stale.completedAt
    ? `Last successful scan was ${relativePastTime(stale.completedAt)}. Check Codex or connected sources, then run a scan now.`
    : "No successful scan yet. Connect a source and run a scan to start the hourly loop.";
}

function staleScanState(state) {
  if (state.isScanning) return { isStale: false, completedAt: null };
  if (!hasAnyScanSource(state)) return { isStale: false, completedAt: null };

  const scan = state.lastCompletedScan;
  if (!scan?.completedAt) return { isStale: true, completedAt: null };

  const completedMs = new Date(scan.completedAt).getTime();
  if (Number.isNaN(completedMs)) return { isStale: true, completedAt: null };

  const graceMs = 5 * 60 * 1000;
  const intervalMs = state.settings.scanIntervalMinutes * 60 * 1000;
  return {
    isStale: Date.now() - completedMs > intervalMs + graceMs,
    completedAt: scan.completedAt
  };
}

function hasAnyScanSource(state) {
  const hasConnector = Boolean((state.sourceConnections ?? []).some((connection) => connection.enabled));
  const hasLegacyGmail = Boolean(state.settings.gmailCredentialsPath && state.accounts?.length);
  const hasTelegram = Boolean(
    (state.telegramConnected || state.settings.telegramExportPath) &&
    (state.settings.telegramIncludeDms || state.telegramChats?.some((chat) => chat.enabled))
  );
  return hasConnector || hasLegacyGmail || hasTelegram;
}

function renderFindingCards(findings, accountErrors) {
  return findings
    .map(
      (finding) => {
        const action = finding.source === "youtube" ? "" : meaningfulAction(finding.suggestedAction);
        const sourceLink = renderFindingSourceButton(finding);
        return `
      <article class="finding finding-${escapeHtml(finding.source)}">
        <span class="finding-dot ${escapeHtml(finding.priority)}" aria-hidden="true"></span>
        <div class="finding-icon" title="${escapeHtml(sourceLabel(finding.source))}" aria-label="${escapeHtml(sourceLabel(finding.source))}">
          ${sourceIcon(finding.source)}
        </div>
        <div class="finding-main">
          <div class="finding-header">
            <div class="finding-title-block">
              <h3>${escapeHtml(finding.title)}</h3>
              <p>${renderFindingKindBadge(finding)}${escapeHtml(sourceDetail(finding))}${finding.receivedAt ? ` · ${escapeHtml(compactDateTime(finding.receivedAt))}` : ""}</p>
            </div>
          </div>
          ${renderFindingSummary(finding)}
          ${action ? `<p class="action-line"><strong>Action</strong><span>${escapeHtml(action)}</span></p>` : ""}
          ${renderFindingDetails(finding)}
        </div>
        <div class="finding-actions">
          ${sourceLink}
          <button class="review-button" data-complete-item="${escapeHtml(finding.id ?? "")}" title="Mark reviewed" aria-label="Mark reviewed">✓</button>
        </div>
      </article>`;
      }
    )
    .join("") + renderAccountErrors(accountErrors);
}

function renderFindingSummary(finding) {
  if (finding.source !== "youtube") {
    return `<p class="finding-summary">${escapeHtml(finding.why)}</p>`;
  }

  const bullets = markdownBulletItems(finding.why);
  if (!bullets.length) {
    return `<p class="finding-summary finding-summary-youtube">${escapeHtml(finding.why)}</p>`;
  }

  return `
    <ul class="finding-summary finding-summary-youtube-list">
      ${bullets.slice(0, 6).map((bullet, index) => `<li>${renderYouTubeBullet(bullet, finding.youtubeAnchors?.[index])}</li>`).join("")}
    </ul>`;
}

function renderYouTubeBullet(value, anchor) {
  const rendered = renderLabeledBullet(value);
  if (!anchor?.url || !Number.isFinite(anchor.startSec)) return rendered;
  const label = anchor.endSec && anchor.endSec - anchor.startSec > 45
    ? `${formatVideoTimestamp(anchor.startSec)}-${formatVideoTimestamp(anchor.endSec)}`
    : formatVideoTimestamp(anchor.startSec);
  return `${rendered} <a class="youtube-time-chip" href="${escapeHtml(anchor.url)}" data-source-url="${escapeHtml(anchor.url)}" aria-label="Open video at ${escapeHtml(label)}">${escapeHtml(label)}</a>`;
}

function renderLabeledBullet(value) {
  const text = String(value ?? "").trim();
  const labelMatch = text.match(/^\*\*([^*]{1,140}?:?)\*\*:?\s*(.+)$/);
  const colonMatch = !labelMatch ? text.match(/^([^:]{2,140}):\s+(.+)$/) : null;
  if (!labelMatch && !colonMatch) return escapeHtml(text);

  const label = (labelMatch?.[1] ?? colonMatch?.[1] ?? "").replace(/:+$/, "");
  const body = labelMatch?.[2] ?? colonMatch?.[2] ?? "";
  return `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(body)}`;
}

function markdownBulletItems(value) {
  const lines = String(value ?? "").split(/\r?\n/);
  const bullets = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const bulletMatch = line.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
    if (bulletMatch) {
      bullets.push(bulletMatch[1].trim());
      continue;
    }

    if (bullets.length) {
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${line}`.trim();
    } else {
      bullets.push(line);
    }
  }

  return bullets;
}

function renderFindingSourceButton(finding) {
  const sourceUrl = findingSourceUrl(finding);
  if (!sourceUrl) return "";
  return `<button class="link-button finding-source-button" data-source-url="${escapeHtml(sourceUrl)}">${escapeHtml(sourceOpenLabel(finding.source))}</button>`;
}

function renderFindingKindBadge(finding) {
  const label = findingKindLabel(finding);
  return label ? `<span class="finding-kind-badge">${escapeHtml(label)}</span>` : "";
}

function renderFindingDetails(finding) {
  if (finding.source === "youtube") return "";

  const excerpt = meaningfulEvidence(finding);
  const metrics = renderFindingMetrics(finding);

  if (!excerpt && !metrics) return "";
  return `
    <details class="finding-details">
      <summary>Context</summary>
      <div class="finding-detail-panel">
        ${metrics}
        ${excerpt ? `<div class="detail-wide">
          <span>Source excerpt</span>
          <blockquote>${escapeHtml(excerpt)}</blockquote>
        </div>` : ""}
      </div>
    </details>`;
}

function renderFindingMetrics(finding) {
  const entries = Object.entries(finding.sourceMetrics ?? {})
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .map(([key, value]) => [metricLabel(key), formatMetricValue(value)]);

  if (!entries.length) return "";

  return `
    <div class="detail-wide detail-metrics">
      <span>Metrics</span>
      <div class="metric-row">
        ${entries.map(([label, value]) => `<span>${escapeHtml(value)} ${escapeHtml(label)}</span>`).join("")}
      </div>
    </div>`;
}

function metricLabel(key) {
  const normalized = String(key).replace(/_/g, " ").replace(/\bcount\b/gi, "").trim().toLowerCase();
  if (normalized === "like") return "likes";
  if (normalized === "reply") return "replies";
  if (normalized === "retweet" || normalized === "repost") return "reposts";
  if (normalized === "quote") return "quotes";
  if (normalized === "bookmark") return "bookmarks";
  if (normalized === "impression") return "views";
  return normalized || "signals";
}

function formatMetricValue(value) {
  return Intl.NumberFormat([], { notation: value >= 10000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function attachFindingActionHandlers() {
  for (const button of elements.findings.querySelectorAll("[data-dismiss-digest-card]")) {
    button.addEventListener("click", async () => {
      const scrollTop = homeScrollTop();
      await runAction("Marking reviewed...", async () => {
        render(await api.dismissDigestCard(button.dataset.dismissDigestCard));
        setHomeScrollTop(scrollTop);
      });
    });
  }

  for (const button of elements.findings.querySelectorAll("[data-complete-item]")) {
    button.addEventListener("click", async () => {
      const scrollTop = homeScrollTop();
      await runAction("Marking reviewed...", async () => {
        render(await api.updateImportantItemStatus(button.dataset.completeItem, "completed"));
        setHomeScrollTop(scrollTop);
      });
    });
  }

  for (const sourceLink of elements.findings.querySelectorAll("[data-source-url]")) {
    sourceLink.addEventListener("click", async (event) => {
      event.preventDefault();
      await runAction("Opening source...", async () => {
        await api.openExternal(sourceLink.dataset.sourceUrl);
      });
    });
  }

}

function homeScrollTop() {
  return document.querySelector(".home-main")?.scrollTop ?? 0;
}

function setHomeScrollTop(scrollTop) {
  const homeMain = document.querySelector(".home-main");
  if (homeMain) homeMain.scrollTop = scrollTop;
}

function displayScan(state) {
  if (!state.codexReady) return null;
  return state.lastCompletedScan ?? (state.lastScan?.status === "completed" ? state.lastScan : null);
}

function displayFailedScan(state) {
  if (!state.codexReady || state.lastScan?.status !== "failed") return null;
  const failedAt = Date.parse(state.lastScan.completedAt ?? state.lastScan.startedAt ?? "");
  const completedAt = Date.parse(state.lastCompletedScan?.completedAt ?? "");
  if (Number.isFinite(failedAt) && Number.isFinite(completedAt) && completedAt > failedAt) return null;
  return isCodexReadinessMessage(state.lastScan.error) ? null : state.lastScan;
}

function displayFindings(state) {
  if (!state.codexReady) return [];
  const findings = state.importantItems ?? displayScan(state)?.findings ?? [];
  return findings.filter((finding) => findingMatchesCurrentSources(finding, state));
}

function findingMatchesCurrentSources(finding, state) {
  if (finding.source !== "telegram") return true;

  const chats = state.telegramChats ?? [];
  const chatId = telegramFindingChatId(finding.sourceId, chats);
  if (!chatId) return false;

  const chat = chats.find((item) => item.id === chatId);
  if (!chat) return false;
  if (chat.kind === "dm") return Boolean(state.settings.telegramIncludeDms);
  return Boolean(chat.enabled);
}

function telegramFindingChatId(sourceId, chats) {
  const source = String(sourceId ?? "");
  const withoutPrefix = source.startsWith("telegram:") ? source.slice("telegram:".length) : source;
  return chats
    .map((chat) => chat.id)
    .sort((a, b) => b.length - a.length)
    .find((id) => withoutPrefix === id || withoutPrefix.startsWith(`${id}:`));
}

function findingSourceUrl(finding) {
  if (finding.sourceUrl) return finding.sourceUrl;
  if (finding.source !== "telegram" || !currentState) return "";

  const chatId = telegramFindingChatId(finding.sourceId, currentState.telegramChats ?? []);
  const chat = (currentState.telegramChats ?? []).find((item) => item.id === chatId);
  if (!chat) return "";

  const username = String(chat.username ?? "").replace(/^@/, "").trim();
  if (username) return `tg://resolve?domain=${encodeURIComponent(username)}`;

  const messageId = telegramFindingMessageId(finding.sourceId);
  const privateChannelId = telegramPrivateLinkChannelId(chat.id);
  if (messageId && privateChannelId && chat.kind !== "dm") {
    return `tg://privatepost?channel=${encodeURIComponent(privateChannelId)}&post=${encodeURIComponent(messageId)}`;
  }

  return "";
}

function telegramFindingMessageId(sourceId) {
  const text = String(sourceId ?? "");
  const match = text.match(/:(\d+)$/);
  return match?.[1] ?? "";
}

function telegramPrivateLinkChannelId(chatId) {
  const match = String(chatId ?? "").match(/^(?:chat|channel):(-?\d+)$/);
  if (!match?.[1]) return "";
  return match[1].replace(/^-100/, "").replace(/^-/, "");
}

function renderAccountErrors(accountErrors) {
  if (!accountErrors.length) return "";

  return accountErrors
    .map(
      (accountError) => `
      <article class="finding account-error">
        <span class="badge">inbox error · ${escapeHtml(accountError.accountEmail)}</span>
        <h3>Inbox skipped</h3>
        <p>${escapeHtml(accountError.error)}</p>
        <p class="muted">Reconnect this inbox from Sources.</p>
      </article>`
    )
    .join("");
}

async function connectSource(source, label) {
  if (pendingSourceConnections[source]) {
    elements.status.textContent = `${label} is connecting. Complete sign-in in the browser.`;
    return;
  }

  await runAction(`Opening ${label} sign-in...`, async () => {
    const request = await api.sourcesStartConnection(source, label);
    pendingSourceConnections[source] = { ...request, label, startedAt: Date.now() };
    elements.status.textContent = `${label} sign-in opened. Complete it in the browser.`;
    render(currentState);
    startSourceConnectionPolling(source, label, request.connectionRequestId);
  });
}

function startSourceConnectionPolling(source, label, connectionRequestId) {
  clearTimeout(sourceConnectionPolls[source]);
  const startedAt = Date.now();
  const poll = async () => {
    if (!pendingSourceConnections[source]) return;
    try {
      const state = await api.sourcesCompleteConnection(source, connectionRequestId);
      delete pendingSourceConnections[source];
      clearTimeout(sourceConnectionPolls[source]);
      delete sourceConnectionPolls[source];
      elements.status.textContent = `${label} connected`;
      render(state);
    } catch (error) {
      const message = errorMessage(error);
      if (!message.includes("still pending")) {
        delete pendingSourceConnections[source];
        delete sourceConnectionPolls[source];
        renderError(message || `${label} connection failed. Try connecting again.`);
        render(currentState);
        return;
      }
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        delete pendingSourceConnections[source];
        delete sourceConnectionPolls[source];
        renderError(`${label} connection was not completed. Try connecting again.`);
        render(currentState);
        return;
      }
      sourceConnectionPolls[source] = setTimeout(poll, 2500);
      applyControlState();
    }
  };
  sourceConnectionPolls[source] = setTimeout(poll, 1500);
}

function lastScanText(state) {
  const failedScan = displayFailedScan(state);
  const scan = displayScan(state);
  if (failedScan) return "Last scan failed";
  if (!scan) return "Ready";
  const surfaced = scanSurfacedDigestCount(scan) + (scan.findings ?? []).length;
  return `Last scan surfaced ${surfaced} item${surfaced === 1 ? "" : "s"}`;
}

function homeCountText(state) {
  const visibility = localContentVisibilityState(state);
  if (visibility.locked) return "";
  const cards = recentDigestCards(state);
  const youtube = displayFindings(state).filter((finding) => finding.source === "youtube");
  const count = surfacedCount(cards, youtube);
  if (!count) return "All caught up";
  return `${count} to catch up on`;
}

function lastScanSummaryText(state) {
  if (!localContentVisibilityState(state).showLastScan) return "";
  const failedScan = displayFailedScan(state);
  const scan = displayScan(state);
  if (failedScan) return "Failed";
  if (!scan) return "None yet";

  const sourceCount = scan.sourceSummaries?.length ?? 0;
  const inboxText = sourceCount
    ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}`
    : `${scan.accountsScanned} inbox${scan.accountsScanned === 1 ? "" : "es"}`;
  const messageText = `${scan.messagesScanned} new message${scan.messagesScanned === 1 ? "" : "s"}`;
  return `${inboxText}, ${messageText}`;
}

function lastScannedLinkText(state) {
  if (!localContentVisibilityState(state).showLastScan) return "";
  const failedScan = displayFailedScan(state);
  const scan = displayScan(state);
  if (failedScan) return "Last scan failed";
  if (!scan) return "Last scanned never";
  return `Last scanned ${relativePastTime(scan.completedAt)}`;
}

function displayLastError(state) {
  if (!state?.lastError) return null;
  if (state.codexReady && isCodexReadinessMessage(state.lastError)) return null;
  return state.lastError;
}

function isCodexReadinessMessage(message) {
  const normalized = String(message ?? "").toLowerCase();
  return normalized.includes("codex app server is not ready")
    || normalized.includes("codex is not signed in")
    || normalized.includes("needs chatgpt sign-in");
}

function scanTotalText(scan, duration) {
  const sourceCount = scan.sourceSummaries?.length ?? 0;
  const accounts = sourceCount
    ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}`
    : `${scan.accountsScanned} inbox${scan.accountsScanned === 1 ? "" : "es"}`;
  const counts = scanCountsText(scan);
  return [accounts, counts, duration].filter(Boolean).join(" · ");
}

function scanCountsText(summary) {
  const scanned = summary.messagesScanned ?? 0;
  return `${scanned} new`;
}

function scanSourceStatusText(summary) {
  if (summary.status && summary.status !== "ready") {
    const label = summary.status === "needs_auth" ? "Needs sign-in" : "Scan error";
    const detail = customerFacingHealthDetail(summary.detail ?? "");
    return detail ? `${label} · ${detail}` : label;
  }
  return scanCountsText(summary);
}

function setScanHistoryOpen(isOpen) {
  elements.homeLayout.classList.toggle("history-open", isOpen);
  elements.scanHistoryColumn.hidden = !isOpen;
  elements.recentScanToggle.setAttribute("aria-expanded", String(isOpen));
}

function shortEmail(email) {
  const value = String(email ?? "");
  const [local, domain] = value.split("@");
  if (!local || !domain) return value;
  const root = domain.split(".")[0] || domain;
  return `${local}@${root}`;
}

function sourceDetail(finding) {
  if (finding.source === "telegram") {
    return String(finding.accountEmail ?? "").replace(/^Telegram\s*·\s*/i, "") || "Telegram";
  }
  if (finding.source === "youtube") {
    return String(finding.accountEmail ?? "").replace(/^YouTube\s*·\s*/i, "") || "YouTube";
  }
  if (finding.source === "twitter") {
    return String(finding.accountEmail ?? "").replace(/^X\s*·\s*/i, "") || "X / Twitter";
  }
  return shortEmail(finding.accountEmail);
}

function findingKindLabel(finding) {
  if (finding.source !== "youtube") return "";
  switch (finding.sourceKind) {
    case "youtube_video": return "Video";
    default: return "";
  }
}

function meaningfulAction(value) {
  const action = String(value ?? "").trim();
  if (!action) return "";
  if (/^no action (needed|required)/i.test(action)) return "";
  if (/^review the summary\.?$/i.test(action)) return "";
  return action;
}

function meaningfulEvidence(finding) {
  const text = String(finding.evidence ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/^no evidence provided\.?$/i.test(text)) return "";

  const summary = String(finding.why ?? "").replace(/\s+/g, " ").trim();
  const title = String(finding.title ?? "").replace(/\s+/g, " ").trim();
  if (summary && text.toLowerCase() === summary.toLowerCase()) return "";
  if (title && text.toLowerCase() === title.toLowerCase()) return "";

  return text;
}

function sourceIcon(source) {
  if (source === "telegram") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.7 4.4 3.8 10.9c-1.1.4-1.1 1.1-.2 1.4l4.3 1.3 1.7 5.2c.2.6.3.8.7.8.3 0 .5-.1.8-.4l2.4-2.3 4.9 3.6c.9.5 1.5.2 1.7-.8l3.1-14.4c.3-1.2-.5-1.7-1.5-1.3Zm-12 8.9 9.7-6.1c.5-.3.9-.1.5.2l-8.3 7.5-.3 3.2-1.6-4.8Z" fill="currentColor"/></svg>`;
  }

  if (source === "twitter") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.1 3.5h4.7l3.4 4.8 4.2-4.8h1.8l-5.2 6 5.8 8.1h-4.7l-3.7-5.2-4.5 5.2H5.1l5.5-6.4-5.5-7.7Zm2.8 1.4 8 11.3h1.1L9 4.9H7.9Z" fill="currentColor"/></svg>`;
  }

  if (source === "youtube") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 7.1a3 3 0 0 0-2.1-2.1C17.5 4.5 12 4.5 12 4.5s-5.5 0-7.3.5a3 3 0 0 0-2.1 2.1A31 31 0 0 0 2 12a31 31 0 0 0 .6 4.9 3 3 0 0 0 2.1 2.1c1.8.5 7.3.5 7.3.5s5.5 0 7.3-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.6-4.9ZM10 15.3V8.7l5.7 3.3L10 15.3Z" fill="currentColor"/></svg>`;
  }

  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.5h15A1.5 1.5 0 0 1 21 8v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16V8a1.5 1.5 0 0 1 1.5-1.5Zm.6 1.7 6.5 4.5c.2.1.5.1.7 0l6.5-4.5H5.1Zm14.2 1.3-6 4.1a2.2 2.2 0 0 1-2.6 0l-6-4.1V16c0 .2.1.3.3.3h14c.2 0 .3-.1.3-.3V9.5Z" fill="currentColor"/></svg>`;
}

function connectedAtText(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Connected";
  return `Connected ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function findingBadgeText(finding) {
  const parts = [finding.priority, finding.accountEmail || sourceLabel(finding.source)];
  const receivedAt = compactDateTime(finding.receivedAt);
  if (receivedAt) parts.push(receivedAt);
  return parts.filter(Boolean).join(" · ");
}

function sourceLabel(source) {
  if (source === "telegram") return "Telegram";
  if (source === "youtube") return "YouTube";
  if (source === "twitter") return "X / Twitter";
  return "Gmail";
}

function homeSourceLabel(source) {
  if (source === "all") return "All";
  return sourceLabel(source);
}

function sourceOpenLabel(source) {
  if (source === "gmail") return "Open email";
  if (source === "telegram") return "Open Telegram";
  if (source === "youtube") return "Open video";
  if (source === "twitter") return "Open post";
  return "Open source";
}

function compactDigestTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^\d{10}$/.test(text)) return compactDateTime(new Date(Number(text) * 1000).toISOString());
  if (/^\d{13}$/.test(text)) return compactDateTime(new Date(Number(text)).toISOString());
  return compactDateTime(text) || text;
}

function compactDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatVideoTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function scanDurationText(scan) {
  const durationMs = scan.durationMs ?? scanDurationFromTimestamps(scan.startedAt, scan.completedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  if (durationMs < 1000) return "<1s";

  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function scanDurationFromTimestamps(startedAt, completedAt) {
  const startedMs = new Date(startedAt).getTime();
  const completedMs = new Date(completedAt).getTime();
  if (Number.isNaN(startedMs) || Number.isNaN(completedMs)) return Number.NaN;
  return completedMs - startedMs;
}

async function runAction(message, action) {
  actionBusy = true;
  applyControlState();
  elements.status.textContent = message;
  renderError(null);

  try {
    await action();
  } catch (error) {
    renderError(error?.message ?? String(error));
    await refresh();
  } finally {
    actionBusy = false;
    if (currentState) elements.status.textContent = statusText(currentState);
    applyControlState();
  }
}

function statusText(state) {
  return state.isScanning
    ? scanProgressText(state)
    : homeCountText(state);
}

// "Summarizing video 3/7: ... · 2m 41s" — live agent step plus elapsed time, so
// multi-minute scans read as working instead of frozen.
function scanProgressText(state) {
  const label = state.scanProgress?.label || "Scanning";
  const elapsed = scanElapsedText(state.scanProgress?.startedAt);
  return elapsed ? `${label}... · ${elapsed}` : `${label}...`;
}

function scanElapsedText(startedAt) {
  const startedMs = Date.parse(startedAt ?? "");
  if (!Number.isFinite(startedMs)) return "";
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

// Keep the elapsed counter ticking between progress events.
setInterval(() => {
  if (!currentState?.isScanning) return;
  elements.status.textContent = scanProgressText(currentState);
}, 1000);

function resetGmailConnectState() {
  if (!gmailConnectBusy) return;
  gmailConnectBusy = false;
  applyControlState();
}

function startCodexAuthPolling() {
  stopCodexAuthPolling();
  codexAuthPollStartedAt = Date.now();
  codexAuthPoll = setInterval(async () => {
    if (actionBusy) return;
    if (Date.now() - codexAuthPollStartedAt > 2 * 60 * 1000) {
      stopCodexAuthPolling();
      render(currentState);
      return;
    }

    try {
      const state = await api.retryCodex();
      render(state);
      if (state.codexReady) {
        stopCodexAuthPolling();
        elements.status.textContent = "Signed in with ChatGPT";
      }
    } catch {
      render(currentState);
    }
  }, 2500);
  if (currentState) render(currentState);
}

function stopCodexAuthPolling() {
  if (!codexAuthPoll) return;
  clearInterval(codexAuthPoll);
  codexAuthPoll = null;
}

function applyControlState() {
  const isScanning = Boolean(currentState?.isScanning);
  const setupLocked = actionBusy || isScanning;
  const quietHoursEnabled = Boolean(currentState?.settings?.quietHours?.enabled);

  const scanNow = scanNowControlState({ actionBusy, state: currentState });
  elements.scanNow.disabled = scanNow.disabled;
  elements.scanNow.title = scanNow.title;
  elements.scanNow.setAttribute("aria-label", scanNow.ariaLabel);

  for (const element of [
    elements.runSetupCheck,
    elements.chooseTelegramExport,
    elements.addIntegration,
    elements.clearScanMemory,
    elements.scanInterval,
    elements.launchAtLogin,
    elements.quietHoursEnabled
  ]) {
    element.disabled = setupLocked;
  }

  applySourceButtonState(elements.connectGmail, "gmail", "Gmail", setupLocked);
  applySourceButtonState(elements.connectTwitter, "twitter", "X / Twitter", setupLocked);
  applyYouTubeChannelFormState(setupLocked);

  elements.quietHoursStart.disabled = setupLocked || !quietHoursEnabled;
  elements.quietHoursEnd.disabled = setupLocked || !quietHoursEnabled;

  for (const element of [
    elements.copyCodexSignIn,
    elements.copyDiagnostics,
    elements.copyLiveCheck
  ]) {
    element.disabled = actionBusy;
  }

  for (const element of document.querySelectorAll("[data-setup-link]")) {
    element.disabled = actionBusy;
  }
  for (const element of document.querySelectorAll("[data-source-remove]")) {
    element.disabled = setupLocked;
  }
  for (const element of document.querySelectorAll("[data-summarize-youtube-video]")) {
    element.disabled = setupLocked;
  }
  for (const element of document.querySelectorAll("[data-complete-item], [data-dismiss-digest-card], [data-dismiss-source-insight], [data-source-insight-page]")) {
    element.disabled = setupLocked;
  }
  for (const element of document.querySelectorAll("[data-telegram-chat]")) {
    element.disabled = setupLocked;
  }
}

function applySourceButtonState(button, source, label, setupLocked) {
  if (!button) return;
  const configured = isSourceConfigured(currentState, source);
  const pending = pendingSourceConnections[source];
  button.disabled = setupLocked || !configured || Boolean(pending);
  button.textContent = pending ? "Connecting..." : sourceAddLabel(source, label);
  button.title = configured
    ? pending ? `Complete ${label} sign-in in the browser` : sourceAddLabel(source, label)
    : `${label} is not available in this build`;
}

function applyYouTubeChannelFormState(setupLocked = actionBusy || Boolean(currentState?.isScanning)) {
  if (!elements.youtubeChannelUrl || !elements.addYoutubeChannel) return;
  const value = elements.youtubeChannelUrl.value.trim();
  const channelCount = youtubeChannelCount(currentState);
  const inputIsVideo = isYouTubeVideoUrl(value);
  const channelLimitReached = Boolean(value) && channelCount >= MAX_YOUTUBE_CHANNEL_SOURCES && !inputIsVideo;
  elements.youtubeChannelUrl.disabled = setupLocked;
  elements.addYoutubeChannel.disabled = setupLocked || !value || channelLimitReached;
  elements.addYoutubeChannel.textContent = actionBusy ? "Adding..." : "Add source";
  elements.addYoutubeChannel.title = channelLimitReached
    ? `You can monitor up to ${MAX_YOUTUBE_CHANNEL_SOURCES} YouTube channels.`
    : "Add YouTube channel or video";
}

function youtubeChannelCount(state) {
  return sourceConnectionsFor(state, "youtube")
    .filter((connection) => connection.enabled && connection.backend === "local" && connection.config?.kind === "channel")
    .length;
}

function isYouTubeVideoUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(value.startsWith("http") ? value : `https://www.youtube.com/watch?v=${value}`);
    return url.hostname === "youtu.be"
      || (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname) && url.pathname === "/watch");
  } catch {
    return false;
  }
}

function sourceAddLabel(source, label) {
  if (source === "gmail") return "Add email";
  if (source === "twitter") return "Add X account";
  return `Add ${label}`;
}

function quietHoursUpdate() {
  return {
    enabled: elements.quietHoursEnabled.checked,
    start: elements.quietHoursStart.value,
    end: elements.quietHoursEnd.value
  };
}

function renderError(message) {
  if (!message) {
    elements.errorBanner.hidden = true;
    elements.errorBanner.textContent = "";
    return;
  }

  elements.errorBanner.hidden = false;
  elements.errorBanner.textContent = message;
}

function errorMessage(error) {
  return error?.message ?? String(error ?? "");
}

function relativeTime(iso) {
  const deltaMs = new Date(iso).getTime() - Date.now();
  const minutes = Math.max(0, Math.round(deltaMs / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function relativePastTime(iso) {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.round(deltaMs / 60000));
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m ago` : `${hours}h ago`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value ?? ""));
  return String(value ?? "").replace(/["\\]/g, "\\$&");
}

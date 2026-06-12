export function scanNowControlState({ actionBusy, state }) {
  const isScanning = Boolean(state?.isScanning);
  if (isScanning) {
    return { disabled: true, title: "Scan running", ariaLabel: "Scan running" };
  }

  if (actionBusy) {
    return { disabled: true, title: "Action in progress", ariaLabel: "Action in progress" };
  }

  if (!state?.codexReady) {
    return {
      disabled: true,
      title: "Sign in to WDIM first",
      ariaLabel: "Sign in to WDIM first"
    };
  }

  if (!hasAnySource(state)) {
    return {
      disabled: true,
      title: "Connect a source first",
      ariaLabel: "Connect a source first"
    };
  }

  return { disabled: false, title: "Scan now", ariaLabel: "Scan now" };
}

export function codexOnboardingState(state) {
  if (state?.codexReady) {
    return {
      hidden: true,
      title: "Codex ready",
      detail: "Codex is installed, signed in, and reachable.",
      actionLabel: null,
      action: null,
      command: null
    };
  }

  const status = state?.codexStatus;
  if (status?.state === "missing") {
    return {
      hidden: false,
      title: "Install Codex",
      detail: "WDIM uses your ChatGPT account through the local Codex app. Install Codex to continue.",
      actionLabel: status.actionLabel ?? "Download Codex",
      action: "download",
      command: status.command ?? "https://openai.com/codex/"
    };
  }

  if (status?.state === "needs_auth") {
    return {
      hidden: false,
      title: "Sign in to WDIM",
      detail: "Use your ChatGPT account.",
      actionLabel: "Sign in with ChatGPT",
      action: "signin",
      command: status.command
    };
  }

  if (status?.state === "error" && !status.actionLabel) {
    return {
      hidden: false,
      title: "Check WDIM",
      detail: status.detail ?? "WDIM needs to be reinstalled.",
      actionLabel: null,
      action: null,
      command: null
    };
  }

  return {
    hidden: false,
    title: "Check Codex",
    detail: status?.detail ?? "Codex app-server is not reachable yet.",
    actionLabel: status?.actionLabel ?? "Sign in with ChatGPT",
    action: "signin",
    command: status?.command ?? null
  };
}

export function localContentVisibilityState(state) {
  if (state?.codexReady) {
    return {
      locked: false,
      statusText: null,
      emptyText: null,
      showLastScan: true
    };
  }

  return {
    locked: true,
    statusText: "Sign in to WDIM",
    emptyText: "Sign in to WDIM to view your saved items and sources.",
    showLastScan: false
  };
}

function hasAnySource(state) {
  const hasConnector = Boolean(state?.sourceConnections?.some((connection) => connection.enabled));
  const hasGmail = Boolean(state?.settings?.gmailCredentialsPath && state.accounts?.length);
  const hasTelegram = Boolean(
    (state?.telegramConnected || state?.settings?.telegramExportPath) &&
    (state.settings.telegramIncludeDms || state.telegramChats?.some((chat) => chat.enabled))
  );
  return hasConnector || hasGmail || hasTelegram;
}

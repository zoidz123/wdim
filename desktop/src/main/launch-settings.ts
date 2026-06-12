import type { AppSettings } from "./types";

type LoginItemApp = {
  setLoginItemSettings: (settings: { openAtLogin: boolean; openAsHidden: boolean }) => void;
};

type ApplyLaunchAtLoginOptions = {
  force?: boolean;
};

export function applyLaunchAtLoginSetting(app: LoginItemApp, settings: AppSettings, options: ApplyLaunchAtLoginOptions = {}): void {
  if (!settings.launchAtLogin && !options.force) return;

  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    openAsHidden: true
  });
}

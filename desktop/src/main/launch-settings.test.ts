import { describe, expect, test } from "bun:test";
import { applyLaunchAtLoginSetting } from "./launch-settings";
import type { AppSettings } from "./types";

describe("launch settings", () => {
  test("applies enabled launch-at-login setting on startup", () => {
    const calls: Array<{ openAtLogin: boolean; openAsHidden: boolean }> = [];
    const app = {
      setLoginItemSettings: (settings: { openAtLogin: boolean; openAsHidden: boolean }) => {
        calls.push(settings);
      }
    };

    applyLaunchAtLoginSetting(app, settings(true));

    expect(calls).toEqual([
      { openAtLogin: true, openAsHidden: true }
    ]);
  });

  test("skips disabled launch-at-login setting on startup", () => {
    const calls: Array<{ openAtLogin: boolean; openAsHidden: boolean }> = [];
    const app = {
      setLoginItemSettings: (settings: { openAtLogin: boolean; openAsHidden: boolean }) => {
        calls.push(settings);
      }
    };

    applyLaunchAtLoginSetting(app, settings(false));

    expect(calls).toEqual([]);
  });

  test("applies disabled launch-at-login setting when forced by a user update", () => {
    const calls: Array<{ openAtLogin: boolean; openAsHidden: boolean }> = [];
    const app = {
      setLoginItemSettings: (settings: { openAtLogin: boolean; openAsHidden: boolean }) => {
        calls.push(settings);
      }
    };

    applyLaunchAtLoginSetting(app, settings(false), { force: true });

    expect(calls).toEqual([
      { openAtLogin: false, openAsHidden: true }
    ]);
  });
});

function settings(launchAtLogin: boolean): AppSettings {
  return {
    scanIntervalMinutes: 60,
    gmailCredentialsPath: null,
    telegramExportPath: null,
    telegramIncludeDms: true,
    launchAtLogin,
    quietHours: { enabled: false, start: "22:00", end: "07:00" }
  };
}

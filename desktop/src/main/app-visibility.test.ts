import { describe, expect, test } from "bun:test";
import {
  hasCompletedFirstRunSetup,
  shouldDeferPopoverUntilReady,
  shouldHidePopoverOnBlur,
  shouldOpenStartupPopoverBeforeServices,
  shouldShowPopoverOnLaunch,
  shouldShowPopoverOnStartup
} from "./app-visibility";

describe("app startup visibility", () => {
  test("defers popover creation when Electron is not ready yet", () => {
    expect(shouldDeferPopoverUntilReady(false)).toBe(true);
    expect(shouldDeferPopoverUntilReady(true)).toBe(false);
  });

  test("detects completed first-run setup after credentials and an inbox exist", () => {
    expect(hasCompletedFirstRunSetup({ gmailCredentialsPath: null, accountCount: 1 })).toBe(false);
    expect(hasCompletedFirstRunSetup({ gmailCredentialsPath: "/tmp/credentials.json", accountCount: 0 })).toBe(false);
    expect(hasCompletedFirstRunSetup({ gmailCredentialsPath: "/tmp/credentials.json", accountCount: 1 })).toBe(true);
  });

  test("detects completed first-run setup after any source connection exists", () => {
    expect(hasCompletedFirstRunSetup({
      gmailCredentialsPath: null,
      accountCount: 0,
      sourceConnectionCount: 1
    })).toBe(true);
  });

  test("opens the setup popover when setup is still missing", () => {
    expect(shouldShowPopoverOnStartup(
      { wasOpenedAsHidden: false },
      { gmailCredentialsPath: null, accountCount: 0 }
    )).toBe(true);
  });

  test("stays quiet in the menu bar after first-run setup is complete", () => {
    expect(shouldShowPopoverOnStartup(
      { wasOpenedAsHidden: false },
      { gmailCredentialsPath: "/tmp/credentials.json", accountCount: 1 }
    )).toBe(false);
  });

  test("opens manual-launch UI before background services can block startup", () => {
    expect(shouldOpenStartupPopoverBeforeServices(
      { wasOpenedAsHidden: false },
      { gmailCredentialsPath: null, accountCount: 0 }
    )).toBe(true);
  });

  test("does not open setup when macOS reports a hidden launch after setup is complete", () => {
    expect(shouldShowPopoverOnStartup(
      { wasOpenedAsHidden: true },
      { gmailCredentialsPath: "/tmp/credentials.json", accountCount: 1 }
    )).toBe(false);
  });

  test("opens the interface on a normal app launch even after setup is complete", () => {
    expect(shouldShowPopoverOnLaunch(
      { wasOpenedAsHidden: false },
      { gmailCredentialsPath: "/tmp/credentials.json", accountCount: 1 }
    )).toBe(true);
  });

  test("keeps completed hidden launches quiet", () => {
    expect(shouldShowPopoverOnLaunch(
      { wasOpenedAsHidden: true },
      { gmailCredentialsPath: "/tmp/credentials.json", accountCount: 1 }
    )).toBe(false);
  });

  test("keeps completed command-line scan launches quiet", () => {
    expect(shouldShowPopoverOnLaunch(
      { wasOpenedAsHidden: false },
      { gmailCredentialsPath: "/tmp/credentials.json", accountCount: 1 },
      { scanNowLaunch: true }
    )).toBe(false);
  });

  test("keeps source-connected command-line scan launches quiet", () => {
    expect(shouldShowPopoverOnLaunch(
      { wasOpenedAsHidden: false },
      { gmailCredentialsPath: null, accountCount: 0, sourceConnectionCount: 1 },
      { scanNowLaunch: true }
    )).toBe(false);
  });

  test("keeps the startup setup popover visible after focus changes", () => {
    expect(shouldHidePopoverOnBlur({ pinUntilUserCloses: true })).toBe(false);
  });

  test("hides normal tray popovers on blur", () => {
    expect(shouldHidePopoverOnBlur({ pinUntilUserCloses: false })).toBe(true);
  });

  test("keeps tray popovers visible while a native dialog is open", () => {
    expect(shouldHidePopoverOnBlur({ pinUntilUserCloses: false, nativeDialogOpen: true })).toBe(false);
  });
});

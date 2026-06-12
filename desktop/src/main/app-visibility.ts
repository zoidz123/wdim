type SetupVisibilityState = {
  gmailCredentialsPath: string | null;
  accountCount: number;
  sourceConnectionCount?: number;
};

export function hasCompletedFirstRunSetup(setup: SetupVisibilityState): boolean {
  return (setup.sourceConnectionCount ?? 0) > 0
    || (Boolean(setup.gmailCredentialsPath) && setup.accountCount > 0);
}

export function shouldDeferPopoverUntilReady(appReady: boolean): boolean {
  return !appReady;
}

export function shouldShowPopoverOnStartup(
  _loginItemSettings: { wasOpenedAsHidden?: boolean },
  setup: SetupVisibilityState
): boolean {
  return !hasCompletedFirstRunSetup(setup);
}

export function shouldOpenStartupPopoverBeforeServices(
  loginItemSettings: { wasOpenedAsHidden?: boolean },
  setup: SetupVisibilityState
): boolean {
  return shouldShowPopoverOnStartup(loginItemSettings, setup);
}

export function shouldShowPopoverOnLaunch(
  loginItemSettings: { wasOpenedAsHidden?: boolean },
  setup: SetupVisibilityState,
  options: { scanNowLaunch?: boolean } = {}
): boolean {
  if (options.scanNowLaunch) return !hasCompletedFirstRunSetup(setup);
  if (loginItemSettings.wasOpenedAsHidden) return !hasCompletedFirstRunSetup(setup);
  return true;
}

export function shouldHidePopoverOnBlur(options: { pinUntilUserCloses: boolean; nativeDialogOpen?: boolean }): boolean {
  if (options.nativeDialogOpen) return false;
  return !options.pinUntilUserCloses;
}

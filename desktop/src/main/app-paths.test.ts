import { describe, expect, test } from "bun:test";
import { bundledCodexPath, bundledYtDlpPath, codexHomeDirectory, codexPlatformDirectory, codexWorkingDirectory } from "./app-paths";

describe("app paths", () => {
  test("uses the source app path as Codex cwd in development", () => {
    expect(codexWorkingDirectory({
      isPackaged: false,
      appPath: "/repo/desktop",
      userDataPath: "/Users/me/Library/Application Support/what-did-i-miss"
    })).toBe("/repo/desktop");
  });

  test("uses userData as Codex cwd in packaged builds because app.asar is not a directory", () => {
    expect(codexWorkingDirectory({
      isPackaged: true,
      appPath: "/Applications/What Did I Miss.app/Contents/Resources/app.asar",
      userDataPath: "/Users/me/Library/Application Support/what-did-i-miss"
    })).toBe("/Users/me/Library/Application Support/what-did-i-miss");
  });

  test("stores WDIM's Codex home under app userData", () => {
    expect(codexHomeDirectory({
      userDataPath: "/Users/me/Library/Application Support/what-did-i-miss"
    })).toBe("/Users/me/Library/Application Support/what-did-i-miss/codex-home");
  });

  test("points packaged builds at the bundled Codex resource", () => {
    expect(bundledCodexPath({
      isPackaged: true,
      appPath: "/Applications/wdim.app/Contents/Resources/app.asar",
      resourcesPath: "/Applications/wdim.app/Contents/Resources",
      arch: "arm64"
    })).toBe("/Applications/wdim.app/Contents/Resources/codex/darwin-arm64/codex");
  });

  test("points development builds at the local vendor Codex runtime", () => {
    expect(bundledCodexPath({
      isPackaged: false,
      appPath: "/repo/desktop",
      resourcesPath: "/repo/desktop/dist",
      arch: "x64"
    })).toBe("/repo/desktop/.local-vendor/codex/darwin-x64/codex");
  });

  test("points builds at the bundled yt-dlp resource", () => {
    expect(bundledYtDlpPath({
      isPackaged: true,
      appPath: "/Applications/wdim.app/Contents/Resources/app.asar",
      resourcesPath: "/Applications/wdim.app/Contents/Resources"
    })).toBe("/Applications/wdim.app/Contents/Resources/yt-dlp/yt-dlp");

    expect(bundledYtDlpPath({
      isPackaged: false,
      appPath: "/repo/desktop",
      resourcesPath: "/repo/desktop/dist"
    })).toBe("/repo/desktop/.local-vendor/yt-dlp/yt-dlp");
  });

  test("maps supported macOS Codex architectures", () => {
    expect(codexPlatformDirectory("arm64")).toBe("darwin-arm64");
    expect(codexPlatformDirectory("x64")).toBe("darwin-x64");
    expect(() => codexPlatformDirectory("ia32")).toThrow("Unsupported macOS Codex architecture");
  });
});

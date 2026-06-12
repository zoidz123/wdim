import path from "node:path";

export function codexWorkingDirectory(paths: { isPackaged: boolean; appPath: string; userDataPath: string }): string {
  return paths.isPackaged ? paths.userDataPath : paths.appPath;
}

export function codexHomeDirectory(paths: { userDataPath: string }): string {
  return path.join(paths.userDataPath, "codex-home");
}

export function bundledCodexPath(paths: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
  arch?: NodeJS.Architecture;
}): string {
  const platform = codexPlatformDirectory(paths.arch ?? process.arch);
  const base = paths.isPackaged
    ? paths.resourcesPath
    : `${paths.appPath}/.local-vendor`;
  return `${base}/codex/${platform}/codex`;
}

export function bundledYtDlpPath(paths: {
  isPackaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string {
  const base = paths.isPackaged
    ? paths.resourcesPath
    : `${paths.appPath}/.local-vendor`;
  return `${base}/yt-dlp/yt-dlp`;
}

export function codexPlatformDirectory(arch: NodeJS.Architecture): "darwin-arm64" | "darwin-x64" {
  if (arch === "arm64") return "darwin-arm64";
  if (arch === "x64") return "darwin-x64";
  throw new Error(`Unsupported macOS Codex architecture: ${arch}`);
}

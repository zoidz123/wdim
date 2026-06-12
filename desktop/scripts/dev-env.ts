import { readFile } from "node:fs/promises";

export async function loadDevEnv(filePath: string): Promise<Record<string, string>> {
  try {
    const contents = await readFile(filePath, "utf8");
    const env: Record<string, string> = {};
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      env[key] = rawValue.replace(/^['"]|['"]$/g, "");
    }
    return env;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function mergeDevEnv(fileEnv: Record<string, string>, shellEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...fileEnv,
    ...shellEnv,
    WDIM_SKIP_INITIAL_SCAN: shellEnv.WDIM_SKIP_INITIAL_SCAN ?? fileEnv.WDIM_SKIP_INITIAL_SCAN ?? "1"
  };
}

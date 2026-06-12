import fs from "node:fs";
import path from "node:path";

export function loadNearestEnvLocal(startPaths: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const visited = new Set<string>();

  for (const startPath of startPaths) {
    for (const dir of ancestorDirs(startPath)) {
      const envPath = path.join(dir, ".env.local");
      if (visited.has(envPath)) continue;
      visited.add(envPath);

      if (!fs.existsSync(envPath)) continue;
      const values = parseEnvLocal(fs.readFileSync(envPath, "utf8"));
      for (const [key, value] of Object.entries(values)) {
        if (env[key] === undefined || env[key] === "") env[key] = value;
      }
      return envPath;
    }
  }

  return null;
}

export function loadEnvFile(envPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!fs.existsSync(envPath)) return null;
  const values = parseEnvLocal(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
  return envPath;
}

export function loadFirstEnvFile(envPaths: string[], env: NodeJS.ProcessEnv = process.env): string | null {
  for (const envPath of envPaths) {
    const loaded = loadEnvFile(envPath, env);
    if (loaded) return loaded;
  }
  return null;
}

export function parseEnvLocal(contents: string): Record<string, string> {
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
}

function* ancestorDirs(startPath: string): Generator<string> {
  let current = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  while (true) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

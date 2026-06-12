import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { buildBirdCliBundle } from "./bird-bundle";
import { loadDevEnv, mergeDevEnv } from "./dev-env";

const root = path.resolve(import.meta.dir, "..");
const workspaceRoot = path.resolve(root, "..");
const dist = path.join(root, "dist");
const rendererDir = path.join(root, "src/renderer");
const watchDirs = [
  path.join(root, "src/main"),
  path.join(root, "src/preload"),
  path.join(workspaceRoot, "shared/src")
];
const devEnv = await loadDevEnv(path.join(root, ".env.local"));

let electronProcess: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let restarting = false;

await rebuild();
await buildBirdCliOnce();
startElectron();
watchForMainChanges();

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function rebuild(): Promise<void> {
  await mkdir(dist, { recursive: true });
  await Promise.all([
    build({
      entryPoints: [path.join(root, "src/main/main.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: path.join(dist, "main.cjs"),
      external: ["electron", "bun:sqlite", "node:sqlite"],
      sourcemap: true
    }),
    build({
      entryPoints: [path.join(root, "src/preload/preload.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: path.join(dist, "preload.cjs"),
      external: ["electron"],
      sourcemap: true
    })
  ]);
}

// The Twitter connector runs dist/bird.mjs as a Node child. Bundle it once per
// dev session; it only changes when the @steipete/bird dependency does.
async function buildBirdCliOnce(): Promise<void> {
  await buildBirdCliBundle(root, dist);
}

function startElectron(): void {
  electronProcess = spawn("electron", ["."], {
    cwd: root,
    env: {
      ...mergeDevEnv(devEnv, process.env),
      WDIM_DEV: "1",
      WDIM_RENDERER_DIR: rendererDir
    },
    stdio: "inherit"
  });

  electronProcess.once("exit", (code, signal) => {
    electronProcess = null;
    if (!restarting && code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      console.error(`Electron exited with ${signal ?? code}.`);
    }
  });
}

function watchForMainChanges(): void {
  const watchers: FSWatcher[] = [];
  for (const dir of watchDirs) {
    watchers.push(watch(dir, { recursive: true }, (_event, fileName) => {
      if (fileName && !/\.(ts|tsx|js|json)$/.test(String(fileName))) return;
      scheduleRestart();
    }));
  }

  const closeWatchers = () => {
    for (const watcher of watchers) watcher.close();
  };
  process.once("SIGINT", closeWatchers);
  process.once("SIGTERM", closeWatchers);
}

function scheduleRestart(): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void restartElectron();
  }, 160);
}

async function restartElectron(): Promise<void> {
  restarting = true;
  try {
    console.log("Rebuilding main process...");
    await rebuild();
    await stopElectron();
    startElectron();
  } catch (error) {
    console.error("Rebuild failed; keeping current Electron process running.", error);
  } finally {
    restarting = false;
  }
}

async function stopElectron(): Promise<void> {
  const child = electronProcess;
  if (!child) return;

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 1500).unref();
  });
}

function shutdown(code: number): void {
  if (restartTimer) clearTimeout(restartTimer);
  void stopElectron().finally(() => process.exit(code));
}

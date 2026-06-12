import { spawn } from "node:child_process";
import path from "node:path";
import { loadDevEnv, mergeDevEnv } from "./dev-env";

const root = path.resolve(import.meta.dir, "..");
const rendererDir = path.join(root, "src/renderer");

await run("bun", ["run", "build"], {
  cwd: root,
  env: process.env
});

const devEnv = await loadDevEnv(path.join(root, ".env.local"));
await run("electron", ["."], {
  cwd: root,
  env: {
    ...mergeDevEnv(devEnv, process.env),
    WDIM_DEV: "1",
    WDIM_RENDERER_DIR: rendererDir
  }
});

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv | Record<string, string> }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit"
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

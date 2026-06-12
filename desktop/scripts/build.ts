import { mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { buildBirdCliBundle } from "./bird-bundle";

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");

await mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/main/main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(dist, "main.cjs"),
  external: ["electron", "bun:sqlite", "node:sqlite"],
  sourcemap: true
});

// Bundle the bird CLI (pure-JS deps) into a single ESM file the packaged app
// can run via `process.execPath` with ELECTRON_RUN_AS_NODE. node_modules is not
// shipped, so resolving the package at runtime is not an option.
await buildBirdCliBundle(root, dist);

await build({
  entryPoints: [path.join(root, "src/preload/preload.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: path.join(dist, "preload.cjs"),
  external: ["electron"],
  sourcemap: true
});

await cp(path.join(root, "src/renderer"), path.join(dist, "renderer"), {
  recursive: true
});

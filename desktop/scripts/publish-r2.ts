import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import desktopPackage from "../package.json";

// Publish release artifacts to the R2 bucket behind download.wdim.app.
// Upload order matters: latest-mac.yml goes last so the auto-updater never
// sees a manifest that points at a zip that has not finished uploading.
const bucket = process.env.WDIM_R2_BUCKET ?? "wdim-downloads";
const root = path.resolve(import.meta.dir, "..");
const releaseDir = path.join(root, "release");
const version = desktopPackage.version;
const arch = process.arch === "arm64" ? "arm64" : "x64";

type Artifact = { file: string; contentType: string; required: boolean };

const artifacts: Artifact[] = [
  { file: `wdim-${version}-${arch}.dmg`, contentType: "application/x-apple-diskimage", required: true },
  { file: `wdim-${version}-${arch}.zip`, contentType: "application/zip", required: true },
  { file: `wdim-${version}-${arch}.zip.blockmap`, contentType: "application/octet-stream", required: false },
  { file: `wdim-${version}-${arch}.dmg.blockmap`, contentType: "application/octet-stream", required: false },
  { file: "latest-mac.yml", contentType: "text/yaml", required: true }
];

const missingRequired = artifacts.filter((artifact) => artifact.required && !existsSync(path.join(releaseDir, artifact.file)));
if (missingRequired.length) {
  console.error(`Missing release artifacts in ${releaseDir}:`);
  for (const artifact of missingRequired) console.error(`  - ${artifact.file}`);
  console.error("Run `bun run dist:signed` first.");
  process.exit(1);
}

// Refuse to publish unsigned/unnotarized artifacts (e.g. leftovers from
// dist:unsigned). A stapled DMG implies the whole build went through
// Developer ID signing and notarization.
const stapled = spawnSync("xcrun", ["stapler", "validate", path.join(releaseDir, `wdim-${version}-${arch}.dmg`)], { stdio: "pipe" });
if (stapled.status !== 0) {
  console.error(`wdim-${version}-${arch}.dmg is not notarized/stapled. Run \`bun run dist:signed\` with Apple credentials before publishing.`);
  process.exit(1);
}

for (const artifact of artifacts) {
  const filePath = path.join(releaseDir, artifact.file);
  if (!existsSync(filePath)) {
    console.warn(`Skipping ${artifact.file} (not found)`);
    continue;
  }
  console.log(`Uploading ${artifact.file} -> r2://${bucket}/releases/${artifact.file}`);
  const result = spawnSync("npx", [
    "wrangler", "r2", "object", "put",
    `${bucket}/releases/${artifact.file}`,
    "--file", filePath,
    "--content-type", artifact.contentType,
    "--remote"
  ], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Upload failed for ${artifact.file}; latest-mac.yml was NOT updated unless it already uploaded.`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nPublished wdim ${version}. Auto-update feed: https://download.wdim.app/releases/latest-mac.yml`);
console.log(`Site download URL: https://download.wdim.app/releases/wdim-${version}-${arch}.dmg`);

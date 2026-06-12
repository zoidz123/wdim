import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_YTDLP_RELEASE = "2026.03.17";
const release = process.env.WDIM_YTDLP_RELEASE ?? DEFAULT_YTDLP_RELEASE;
const root = path.resolve(import.meta.dir, "..");
const targetDir = path.join(root, ".local-vendor", "yt-dlp");
const targetBinary = path.join(targetDir, "yt-dlp");
const binaryUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${release}/yt-dlp_macos`;
const licenseUrl = `https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release}/LICENSE`;

await mkdir(targetDir, { recursive: true });

console.log(`Downloading yt-dlp ${release} for macOS...`);
await downloadFile(binaryUrl, targetBinary);
await chmod(targetBinary, 0o755);
await writeFile(path.join(targetDir, "VERSION"), `${release}\n`);
await writeFile(path.join(targetDir, "SOURCE"), `${binaryUrl}\n`);
await writeTextFromUrl(licenseUrl, path.join(targetDir, "LICENSE.yt-dlp"));
console.log(`Vendored yt-dlp at ${targetBinary}`);

async function downloadFile(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);
}

async function writeTextFromUrl(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    console.warn(`Could not download yt-dlp license from ${url}: ${response.status} ${response.statusText}`);
    return;
  }
  await writeFile(outputPath, await response.text());
}

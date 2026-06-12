import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { codexPlatformDirectory } from "../src/main/app-paths";

const DEFAULT_CODEX_RELEASE = "rust-v0.137.0";
const release = process.env.WDIM_CODEX_RELEASE ?? DEFAULT_CODEX_RELEASE;
const root = path.resolve(import.meta.dir, "..");
const platform = codexPlatformDirectory(process.arch);
const targetDir = path.join(root, ".local-vendor", "codex", platform);
const targetBinary = path.join(targetDir, "codex");
const archiveName = codexArchiveName(platform);
const archiveUrl = `https://github.com/openai/codex/releases/download/${release}/${archiveName}`;
const licenseUrl = `https://raw.githubusercontent.com/openai/codex/${release}/LICENSE`;

await mkdir(targetDir, { recursive: true });

const tempDir = await mkdtemp(path.join(os.tmpdir(), "wdim-codex-"));
const archivePath = path.join(tempDir, archiveName);

try {
  console.log(`Downloading Codex ${release} for ${platform}...`);
  await downloadFile(archiveUrl, archivePath);
  await run("tar", ["-xzf", archivePath, "-C", tempDir]);

  const extractedBinary = await findExtractedCodex(tempDir);
  await run("cp", [extractedBinary, targetBinary]);
  await chmod(targetBinary, 0o755);

  await writeFile(path.join(targetDir, "VERSION"), `${release}\n`);
  await writeFile(path.join(targetDir, "SOURCE"), `${archiveUrl}\n`);
  await writeTextFromUrl(licenseUrl, path.join(targetDir, "LICENSE.openai-codex"));
  console.log(`Vendored Codex runtime at ${targetBinary}`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function codexArchiveName(platformName: ReturnType<typeof codexPlatformDirectory>): string {
  if (platformName === "darwin-arm64") return "codex-aarch64-apple-darwin.tar.gz";
  return "codex-x86_64-apple-darwin.tar.gz";
}

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
    console.warn(`Could not download Codex license from ${url}: ${response.status} ${response.statusText}`);
    return;
  }
  await writeFile(outputPath, await response.text());
}

async function findExtractedCodex(directory: string): Promise<string> {
  const output = await capture("find", [directory, "-maxdepth", "4", "-type", "f", "(", "-name", "codex", "-o", "-name", "codex-*-apple-darwin", ")"]);
  const first = output.split("\n").map((line) => line.trim()).find(Boolean);
  if (!first) throw new Error("Downloaded Codex archive did not contain a codex binary.");

  const file = await open(first, "r");
  const head = Buffer.alloc(64);
  try {
    await file.read(head, 0, head.length, 0);
  } finally {
    await file.close();
  }

  const prefix = head.toString("utf8");
  if (prefix.startsWith("#!/") || prefix.includes("node")) {
    throw new Error(`Expected native Codex binary, got script-like file at ${first}`);
  }
  return first;
}

async function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${stderr}`));
    });
  });
}

async function run(command: string, args: string[]): Promise<void> {
  await capture(command, args);
}

import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadEnvFile, loadFirstEnvFile, loadNearestEnvLocal, parseEnvLocal } from "./runtime-env";

describe("runtime env", () => {
  test("parses .env.local values like the dev launcher", () => {
    expect(parseEnvLocal([
      "# local config",
      "TELEGRAM_API_ID=123",
      "TELEGRAM_API_HASH=\"hash\"",
      "WDIM_TWITTER_CLIENT_ID='twitter-client'",
      "IGNORED_LINE",
      ""
    ].join("\n"))).toEqual({
      TELEGRAM_API_ID: "123",
      TELEGRAM_API_HASH: "hash",
      WDIM_TWITTER_CLIENT_ID: "twitter-client"
    });
  });

  test("loads the nearest env file from an ancestor directory without overriding shell env", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wdim-runtime-env-"));
    const appDir = path.join(dir, "release/mac-arm64/What Did I Miss.app/Contents/MacOS");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(dir, ".env.local"), [
      "TELEGRAM_API_ID=123",
      "TELEGRAM_API_HASH=file_hash",
      "WDIM_GITHUB_CLIENT_SECRET=file_secret"
    ].join("\n"));

    const env: NodeJS.ProcessEnv = { TELEGRAM_API_HASH: "shell_hash" };
    const loadedPath = loadNearestEnvLocal([appDir], env);

    expect(loadedPath).toBe(path.join(dir, ".env.local"));
    expect(env).toMatchObject({
      TELEGRAM_API_ID: "123",
      TELEGRAM_API_HASH: "shell_hash",
      WDIM_GITHUB_CLIENT_SECRET: "file_secret"
    });

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("treats blank shell env values as unset when loading .env.local", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wdim-runtime-env-"));
    const appDir = path.join(dir, "desktop");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(dir, ".env.local"), [
      "WDIM_TWITTER_CLIENT_ID=client_123"
    ].join("\n"));

    const env: NodeJS.ProcessEnv = { WDIM_TWITTER_CLIENT_ID: "" };
    const loadedPath = loadNearestEnvLocal([appDir], env);

    expect(loadedPath).toBe(path.join(dir, ".env.local"));
    expect(env.WDIM_TWITTER_CLIENT_ID).toBe("client_123");

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("loads an exact packaged runtime env file without overriding shell env", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wdim-runtime-env-"));
    const envPath = path.join(dir, "runtime.env");
    await fs.writeFile(envPath, [
      "TELEGRAM_API_ID=123",
      "TELEGRAM_API_HASH=runtime_hash"
    ].join("\n"));

    const env: NodeJS.ProcessEnv = { TELEGRAM_API_HASH: "shell_hash" };
    const loadedPath = loadEnvFile(envPath, env);

    expect(loadedPath).toBe(envPath);
    expect(env).toMatchObject({
      TELEGRAM_API_ID: "123",
      TELEGRAM_API_HASH: "shell_hash"
    });

    await fs.rm(dir, { recursive: true, force: true });
  });

  test("loads the first existing runtime env candidate", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wdim-runtime-env-"));
    const envPath = path.join(dir, "runtime.env");
    await fs.writeFile(envPath, "TELEGRAM_API_ID=456");

    const env: NodeJS.ProcessEnv = {};
    const loadedPath = loadFirstEnvFile([
      path.join(dir, "missing.env"),
      envPath
    ], env);

    expect(loadedPath).toBe(envPath);
    expect(env.TELEGRAM_API_ID).toBe("456");

    await fs.rm(dir, { recursive: true, force: true });
  });
});

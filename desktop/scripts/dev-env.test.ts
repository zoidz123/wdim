import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { loadDevEnv, mergeDevEnv } from "./dev-env";

describe("loadDevEnv", () => {
  test("loads .env.local style key value pairs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wdim-dev-env-"));
    const filePath = path.join(dir, ".env.local");
    await fs.writeFile(filePath, [
      "# local native OAuth config",
      "WDIM_GMAIL_CLIENT_ID=gmail_client",
      "WDIM_GITHUB_CLIENT_ID=\"github_client\"",
      "WDIM_TWITTER_REDIRECT_URI='http://127.0.0.1:53145/oauth/callback/twitter'",
      "IGNORED_LINE",
      ""
    ].join("\n"));

    await expect(loadDevEnv(filePath)).resolves.toEqual({
      WDIM_GMAIL_CLIENT_ID: "gmail_client",
      WDIM_GITHUB_CLIENT_ID: "github_client",
      WDIM_TWITTER_REDIRECT_URI: "http://127.0.0.1:53145/oauth/callback/twitter"
    });
  });

  test("returns an empty object when the file is missing", async () => {
    await expect(loadDevEnv("/tmp/wdim-missing-env-local")).resolves.toEqual({});
  });

  test("merges .env.local with shell env taking precedence", () => {
    expect(mergeDevEnv(
      {
        WDIM_GMAIL_CLIENT_ID: "file_gmail",
        WDIM_GITHUB_CLIENT_ID: "file_github",
        WDIM_SKIP_INITIAL_SCAN: "1"
      },
      {
        WDIM_GMAIL_CLIENT_ID: "shell_gmail",
        WDIM_TWITTER_CLIENT_ID: "shell_twitter",
        WDIM_SKIP_INITIAL_SCAN: "0"
      }
    )).toMatchObject({
      WDIM_GMAIL_CLIENT_ID: "shell_gmail",
      WDIM_GITHUB_CLIENT_ID: "file_github",
      WDIM_TWITTER_CLIENT_ID: "shell_twitter",
      WDIM_SKIP_INITIAL_SCAN: "0"
    });
  });
});

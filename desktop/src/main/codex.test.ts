import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAppServerClient, WDIM_CODEX_MODEL, classifyCodexReadinessError, codexAppServerArgs, codexCliEnv, codexCliPath, codexExecutablePath, codexProcessError, codexClientInfo, parseFindings, parseTriageResult, withTimeout } from "./codex";
import desktopPackage from "../../package.json";

describe("parseFindings", () => {
  test("parses fenced JSON from Codex", () => {
    const findings = parseFindings(`
      Here is the digest:
      \`\`\`json
      {
        "findings": [
          {
            "priority": "high",
            "source": "gmail",
            "sourceId": "gm_1",
            "accountEmail": "user@example.com",
            "title": "Approval needed",
            "why": "Someone is blocked.",
            "suggestedAction": "Approve or delegate.",
            "evidence": "Can you approve today?",
            "sourceUrl": "https://mail.google.com/mail/u/?authuser=user%40example.com#search/rfc822msgid%3Agm_1%40example.com"
          }
        ]
      }
      \`\`\`
    `);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.priority).toBe("high");
    expect(findings[0]?.sourceId).toBe("gm_1");
    expect(findings[0]?.sourceUrl).toContain("mail.google.com");
  });

  test("keeps Telegram findings as Telegram findings", () => {
    const findings = parseFindings(JSON.stringify({
      findings: [
        {
          priority: "high",
          source: "telegram",
          sourceId: "telegram:dm:42",
          accountEmail: "telegram",
          title: "Missed DM",
          why: "Someone asked for a decision.",
          suggestedAction: "Reply this morning.",
          evidence: "Can you confirm?"
        }
      ]
    }));

    expect(findings[0]?.source).toBe("telegram");
    expect(findings[0]?.sourceId).toBe("telegram:dm:42");
  });

  test("keeps YouTube and Twitter findings on their source", () => {
    const findings = parseFindings(JSON.stringify({
      findings: [
        {
          priority: "medium",
          source: "youtube",
          sourceId: "abc123",
          accountEmail: "YouTube · Lex Fridman",
          title: "Episode summary",
          why: "A dense episode worth catching up on.",
          suggestedAction: "No action needed.",
          evidence: "Key claim at 12:30.",
          sourceUrl: "https://www.youtube.com/watch?v=abc123"
        },
        {
          priority: "high",
          source: "twitter",
          sourceId: "1800000000000000000",
          accountEmail: "X · @alerts",
          title: "Production alert thread",
          why: "An incident thread needs attention.",
          suggestedAction: "Read the post.",
          evidence: "Error rate is elevated.",
          sourceUrl: "https://x.com/alerts/status/1800000000000000000"
        }
      ]
    }));

    expect(findings.map((finding) => finding.source)).toEqual(["youtube", "twitter"]);
    expect(findings[0]?.sourceUrl).toContain("youtube.com");
    expect(findings[1]?.sourceUrl).toContain("x.com");
  });

  test("parses source insights from Codex JSON", () => {
    const result = parseTriageResult(JSON.stringify({
      findings: [],
      sourceInsights: [
        {
          id: "twitter:2026-06-08T16:00:00.000Z",
          source: "twitter",
          title: "Codex development pulse",
          summary: "Recent repo activity clusters around auth recovery, app-server lifecycle work, and model-catalog mismatch reports.",
          generatedAt: "2026-06-08T16:00:00.000Z"
        }
      ]
    }));

    expect(result.findings).toEqual([]);
    expect(result.sourceInsights).toEqual([
      {
        id: "twitter:2026-06-08T16:00:00.000Z",
        source: "twitter",
        title: "Codex development pulse",
        summary: "Recent repo activity clusters around auth recovery, app-server lifecycle work, and model-catalog mismatch reports.",
        generatedAt: "2026-06-08T16:00:00.000Z"
      }
    ]);
  });

  test("sanitizes malformed finding fields from Codex JSON", () => {
    const findings = parseFindings(JSON.stringify({
      findings: [
        {
          priority: "urgent",
          source: "calendar",
          sourceId: 123,
          accountEmail: null,
          title: "",
          why: "",
          suggestedAction: "",
          evidence: "",
          sourceUrl: 42
        }
      ]
    }));

    expect(findings).toEqual([
      {
        priority: "medium",
        source: "gmail",
        sourceId: "123",
        accountEmail: "all accounts",
        title: "Untitled finding",
        why: "No rationale provided.",
        suggestedAction: "Review the source message.",
        evidence: "No evidence provided."
      }
    ]);
  });
});

describe("withTimeout", () => {
  test("returns the wrapped promise when it resolves before the timeout", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "Codex request")).resolves.toBe("ok");
  });

  test("rejects when the wrapped promise does not resolve before the timeout", async () => {
    await expect(withTimeout(new Promise(() => {}), 1, "Codex request")).rejects.toThrow("Codex request timed out");
  });
});

describe("codexProcessError", () => {
  test("formats a missing Codex runtime error with app install guidance", () => {
    const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";

    expect(codexProcessError(error).message).toContain("Codex was not found");
    expect(codexProcessError(error).message).toContain("Install the Codex app");
    expect(codexProcessError(error).message).toContain("sign in with ChatGPT");
  });

  test("formats a missing bundled Codex runtime as a WDIM reinstall issue", () => {
    const error = new Error("spawn bundled codex ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    error.path = "/Applications/wdim.app/Contents/Resources/codex/darwin-arm64/codex";

    expect(codexProcessError(error).message).toBe("WDIM's bundled Codex runtime is missing. Reinstall WDIM.");
  });

  test("formats generic Codex app-server startup failures", () => {
    const error = new Error("permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";

    expect(codexProcessError(error).message).toBe("Failed to start codex app-server: permission denied");
  });
});

describe("classifyCodexReadinessError", () => {
  test("classifies missing Codex runtime as an app install step", () => {
    const error = new Error("Codex was not found. Install the Codex app from OpenAI.");

    expect(classifyCodexReadinessError(error)).toEqual({
      state: "missing",
      detail: "WDIM uses your ChatGPT account through the local Codex app. Install Codex to continue.",
      command: "https://openai.com/codex/",
      actionLabel: "Download Codex"
    });
  });

  test("classifies Codex auth failures as a sign-in step", () => {
    const error = new Error("Codex is not signed in.");

    expect(classifyCodexReadinessError(error)).toEqual({
      state: "needs_auth",
      detail: "Codex is installed but needs ChatGPT sign-in.",
      command: null,
      actionLabel: "Sign in with ChatGPT"
    });
  });

  test("classifies missing bundled Codex runtime as a WDIM install error", () => {
    const error = new Error("WDIM's bundled Codex runtime is missing. Reinstall WDIM.");

    expect(classifyCodexReadinessError(error)).toEqual({
      state: "error",
      detail: "WDIM's bundled Codex runtime is missing. Reinstall WDIM.",
      command: null,
      actionLabel: null
    });
  });
});

describe("codex CLI environment", () => {
  test("keeps the existing PATH and adds Homebrew paths for Finder-launched apps", () => {
    const cliPath = codexCliPath({ PATH: "/custom/bin:/opt/homebrew/bin:/custom/bin" });

    expect(cliPath.split(":").slice(0, 2)).toEqual(["/custom/bin", "/opt/homebrew/bin"]);
    expect(cliPath).toContain("/usr/local/bin");
    expect(cliPath).toContain("/Applications/Codex.app/Contents/Resources");
    expect(cliPath.match(/\/custom\/bin/g)).toHaveLength(1);
  });

  test("returns spawn env with the hardened Codex CLI PATH", () => {
    const env = codexCliEnv({ PATH: "/custom/bin", OTHER: "keep" });

    expect(env.OTHER).toBe("keep");
    expect(env.PATH).toContain("/custom/bin");
    expect(env.PATH).toContain("/opt/homebrew/bin");
  });

  test("prefers an existing bundled Codex executable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wdim-codex-test-"));
    const binary = path.join(dir, "codex");
    await writeFile(binary, "");
    try {
      expect(codexExecutablePath(binary)).toBe(binary);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("falls back to system Codex when optional bundled runtime is absent", () => {
    expect(codexExecutablePath("/missing/wdim/codex")).toBe("codex");
  });

  test("uses the required bundled runtime path even before spawn reports it missing", () => {
    expect(codexExecutablePath("/missing/wdim/codex", true)).toBe("/missing/wdim/codex");
  });
});

describe("CodexAppServerClient process lifecycle", () => {
  test("starts app-server with WDIM's explicit scan model", () => {
    expect(codexAppServerArgs()).toContain(`model=${WDIM_CODEX_MODEL}`);
  });

  test("does not start app-server until a request is made", () => {
    let spawnCount = 0;
    const client = new CodexAppServerClient("/tmp", () => {
      spawnCount += 1;
      return new FakeChild() as never;
    });

    expect(spawnCount).toBe(0);
    client.close();
  });

  test("starts a fresh app-server process after the previous process exits", async () => {
    const children: FakeChild[] = [];
    const client = new CodexAppServerClient("/tmp", () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    });

    await client.initialize();
    children[0]?.emit("exit", 1);
    await client.initialize();

    expect(children).toHaveLength(2);
    client.close();
  });

  test("passes the provided Codex env to the app-server process", async () => {
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const client = new CodexAppServerClient(
      "/tmp",
      (_cwd, _executablePath, _requireExecutablePath, env) => {
        spawnedEnv = env;
        return new FakeChild() as never;
      },
      { CODEX_HOME: "/tmp/wdim-codex-home" }
    );

    await client.initialize();

    expect(spawnedEnv?.CODEX_HOME).toBe("/tmp/wdim-codex-home");
    client.close();
  });

  test("can simulate missing Codex for onboarding QA without spawning the CLI", async () => {
    let spawnCount = 0;
    const client = new CodexAppServerClient(
      "/tmp",
      () => {
        spawnCount += 1;
        return new FakeChild() as never;
      },
      { WDIM_SIMULATE_CODEX_STATUS: "missing" }
    );

    await expect(client.initialize()).rejects.toThrow("Codex was not found");
    expect(spawnCount).toBe(0);
    client.close();
  });

  test("can simulate Codex sign-in needed for onboarding QA without spawning the CLI", async () => {
    let spawnCount = 0;
    const client = new CodexAppServerClient(
      "/tmp",
      () => {
        spawnCount += 1;
        return new FakeChild() as never;
      },
      { WDIM_SIMULATE_CODEX_STATUS: "needs_auth" }
    );

    await expect(client.initialize()).rejects.toThrow("Codex is not signed in");
    expect(spawnCount).toBe(0);
    client.close();
  });
});

describe("codexClientInfo", () => {
  test("uses the package version for the app-server client handshake", () => {
    expect(codexClientInfo()).toEqual({
      name: "what-did-i-miss-desktop",
      version: desktopPackage.version
    });
  });
});

describe("CodexAppServerClient account auth", () => {
  test("requires ChatGPT auth when account/read has no account", async () => {
    const child = new TriageFakeChild(({ id, method }, fakeChild) => {
      if (method === "account/read") fakeChild.respond(id, { account: null, requiresOpenaiAuth: true });
    });
    const client = new CodexAppServerClient("/tmp", () => child as never);

    await expect(client.initialize()).rejects.toThrow("needs ChatGPT sign-in");
    client.close();
  });

  test("starts managed ChatGPT login through app-server", async () => {
    const child = new TriageFakeChild(({ id, method }, fakeChild) => {
      if (method === "account/read") fakeChild.respond(id, { account: null, requiresOpenaiAuth: true });
      if (method === "account/login/start") fakeChild.respond(id, {
        type: "chatgpt",
        loginId: "login_1",
        authUrl: "https://chatgpt.com/auth"
      });
    });
    const client = new CodexAppServerClient("/tmp", () => child as never);

    await expect(client.startChatGptLogin()).resolves.toEqual({
      type: "chatgpt",
      loginId: "login_1",
      authUrl: "https://chatgpt.com/auth"
    });
    client.close();
  });

  test("logs out through app-server account/logout", async () => {
    const calls: string[] = [];
    const child = new TriageFakeChild(({ id, method }, fakeChild) => {
      if (method) calls.push(method);
      if (method === "account/read") fakeChild.respond(id, { account: { type: "chatgpt", email: "user@example.com" }, requiresOpenaiAuth: true });
      if (method === "account/logout") fakeChild.respond(id, {});
    });
    const client = new CodexAppServerClient("/tmp", () => child as never);

    await expect(client.logoutAccount()).resolves.toBeUndefined();
    expect(calls).toContain("account/logout");
    client.close();
  });
});

describe("CodexAppServerClient triage", () => {
  test("rejects when app-server sends an error notification for the turn", async () => {
    const child = new TriageFakeChild(({ id, method }, fakeChild) => {
      if (method === "account/read") {
        fakeChild.respond(id, { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
      }
      if (method === "turn/start") {
        fakeChild.respond(id, {});
        queueMicrotask(() => {
          fakeChild.notify("error", {
            error: {
              message: "model unavailable",
              codexErrorInfo: null,
              additionalDetails: null
            },
            willRetry: false,
            threadId: "thread_1",
            turnId: "turn_1"
          });
        });
      }
    });
    const client = new CodexAppServerClient("/tmp", () => child as never);

    await client.initialize();
    const result = await Promise.race([
      client.triage(sampleEvents()).then(
        () => "resolved",
        (error) => error instanceof Error ? error.message : String(error)
      ),
      sleep(25).then(() => "timed out")
    ]);

    expect(result).toContain("model unavailable");
    client.close();
  });

  test("resolves with accumulated agent text when the turn completes", async () => {
    const child = new TriageFakeChild(({ id, method }, fakeChild) => {
      if (method === "account/read") {
        fakeChild.respond(id, { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
      }
      if (method === "turn/start") {
        fakeChild.respond(id, {});
        queueMicrotask(() => {
          fakeChild.notify("item/agentMessage/delta", { delta: "{\"findings\":" });
          fakeChild.notify("item/agentMessage/delta", { text: "[]}" });
          fakeChild.notify("turn/completed", {
            threadId: "thread_1",
            turn: { id: "turn_1" }
          });
        });
      }
    });
    const client = new CodexAppServerClient("/tmp", () => child as never);

    await client.initialize();
    await expect(client.triage(sampleEvents())).resolves.toBe("{\"findings\":[]}");
    client.close();
  });

  test("derives YouTube anchors when JSON summary omits cue ids", async () => {
    let turnCount = 0;
    const child = new TriageFakeChild(({ id, method }, fakeChild) => {
      if (method === "account/read") {
        fakeChild.respond(id, { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
      }
      if (method === "turn/start") {
        fakeChild.respond(id, {});
        turnCount += 1;
        queueMicrotask(() => {
          if (turnCount === 1) {
            fakeChild.notify("item/agentMessage/delta", {
              delta: "- AI takeoff: Enterprise adoption is under 1%, leaving room for growth. cues: c1,c2"
            });
          } else {
            fakeChild.notify("item/agentMessage/delta", {
              delta: JSON.stringify({
                bullets: [{
                  label: "AI takeoff",
                  summary: "Enterprise adoption remains below 1%, leaving room for usage among knowledge workers to rise."
                }]
              })
            });
          }
          fakeChild.notify("turn/completed", {
            threadId: "thread_1",
            turn: { id: `turn_${turnCount}` }
          });
        });
      }
    });
    const client = new CodexAppServerClient("/tmp", () => child as never);

    await client.initialize();
    const result = await client.summarizeYouTubeTranscript({
      id: "youtube:ai-boom",
      title: "Why the AI Boom Is Just Getting Started",
      body: "",
      url: "https://www.youtube.com/watch?v=DZt1DDmMNGk",
      receivedAt: "2026-06-09T12:00:00.000Z",
      transcript: "Enterprise adoption is under 1%. Knowledge workers usage can rise.",
      transcriptCues: [
        { id: "c1", startSec: 122, endSec: 132, text: "Enterprise adoption is under 1 percent." },
        { id: "c2", startSec: 132, endSec: 144, text: "Knowledge workers usage can rise over the next four years." }
      ]
    });

    expect(result.summary).toContain("AI takeoff");
    expect(result.anchors).toEqual([{
      label: "AI takeoff",
      startSec: 119,
      url: "https://www.youtube.com/watch?v=DZt1DDmMNGk&t=119s"
    }]);
    client.close();
  });
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      const message = JSON.parse(chunk.toString()) as { id?: number; method?: string };
      if (message.id && message.method === "initialize") {
        this.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
      if (message.id && message.method === "account/read") {
        this.stdout.write(`${JSON.stringify({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } })}\n`);
      }
    });
  }

  kill(): boolean {
    this.emit("exit", 0);
    return true;
  }
}

type TriageMessage = {
  id?: number;
  method?: string;
};

class TriageFakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor(private readonly onMessage: (message: TriageMessage, child: TriageFakeChild) => void) {
    super();
    this.stdin.on("data", (chunk) => {
      const message = JSON.parse(chunk.toString()) as TriageMessage;

      if (message.id && message.method === "initialize") {
        this.respond(message.id, {});
        return;
      }

      if (message.id && message.method === "thread/start") {
        this.respond(message.id, { thread: { id: "thread_1" } });
        return;
      }

      this.onMessage(message, this);
    });
  }

  respond(id: number | undefined, result: unknown): void {
    if (!id) return;
    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  notify(method: string, params?: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  kill(): boolean {
    this.emit("exit", 0);
    return true;
  }
}

function sampleEvents() {
  return {
    gmail: [
      {
        id: "msg_1",
        from: "sender@example.com",
        subject: "Important",
        body: "Please review this.",
        receivedAt: "2026-06-02T10:00:00.000Z"
      }
    ],
    telegram: []
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

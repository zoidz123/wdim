import { describe, expect, test } from "bun:test";
import {
  MAX_DIGEST_BULLETS,
  buildDigestCardPrompt,
  capDigestBullets,
  parseDigestResponse,
  type DigestBullet
} from "./digest";

describe("digest card prompt", () => {
  const window = { start: "2026-06-10T00:00:00.000Z", end: "2026-06-10T12:00:00.000Z" };

  test("builds a Twitter digest prompt with the events and window", () => {
    const prompt = buildDigestCardPrompt("twitter", [
      { id: "1", text: "OpenAI ships a thing", author: "@sama", url: "https://x.com/sama/status/1" },
      { id: "2", text: "Anthropic ships a thing", author: "@dario", url: "https://x.com/dario/status/2" }
    ], window);

    expect(prompt).toContain("What Did I Miss?");
    expect(prompt).toContain("OpenAI ships a thing");
    expect(prompt).toContain("@sama");
    expect(prompt).toContain("2026-06-10T00:00:00.000Z");
  });

  test("caps the prompt at five bullets", () => {
    const prompt = buildDigestCardPrompt("twitter", [{ id: "1", text: "x", author: "@a" }], window);
    expect(prompt).toContain(`at most ${MAX_DIGEST_BULLETS}`);
  });

  test("asks for a bold title + detail and who/when attribution", () => {
    const prompt = buildDigestCardPrompt("twitter", [{ id: "1", text: "x", author: "@a" }], window);
    expect(prompt).toContain("title");
    expect(prompt).toContain("detail");
    expect(prompt).toContain("attribution");
    expect(prompt).toContain("timestamp");
  });

  test("tells the model not to lead with head-count framing", () => {
    const prompt = buildDigestCardPrompt("twitter", [{ id: "1", text: "x", author: "@a" }], window);
    expect(prompt).toContain("Do NOT frame bullets as");
  });

  test("asks for a skipped summary and counts", () => {
    const prompt = buildDigestCardPrompt("gmail", [{ id: "1", text: "hi", author: "boss@co.com" }], window);
    expect(prompt).toContain("skippedSummary");
    expect(prompt).toContain("bullets");
  });

  test("tailors guidance to the source", () => {
    const twitter = buildDigestCardPrompt("twitter", [], window);
    const gmail = buildDigestCardPrompt("gmail", [], window);
    expect(twitter).toContain("accounts");
    expect(gmail.toLowerCase()).toContain("email");
  });
});

describe("parseDigestResponse", () => {
  test("parses title/detail/attribution/timestamp and skippedSummary", () => {
    const result = parseDigestResponse(JSON.stringify({
      bullets: [
        { title: "Iran de-escalation moves markets", detail: "Stocks spiked, oil fell.", attribution: "@markets", timestamp: "2026-06-10T09:00:00.000Z", sourceUrl: "https://x.com/a/status/1" },
        { title: "Coinbase ships agent trading", detail: "Agents can trade under guardrails." }
      ],
      skippedSummary: "memes, promos, ~80 routine posts"
    }));
    expect(result.bullets).toHaveLength(2);
    expect(result.bullets[0]?.title).toContain("Iran");
    expect(result.bullets[0]?.detail).toContain("Stocks");
    expect(result.bullets[0]?.attribution).toBe("@markets");
    expect(result.bullets[0]?.timestamp).toBe("2026-06-10T09:00:00.000Z");
    expect(result.skippedSummary).toContain("memes");
  });

  test("caps bullets at the max and tolerates fenced/extra text", () => {
    const many = JSON.stringify({ bullets: Array.from({ length: 9 }, (_, i) => ({ title: `b${i}`, detail: "d" })) });
    const result = parseDigestResponse("```json\n" + many + "\n```");
    expect(result.bullets).toHaveLength(MAX_DIGEST_BULLETS);
  });

  test("returns empty bullets for empty or malformed input", () => {
    expect(parseDigestResponse("not json").bullets).toEqual([]);
    expect(parseDigestResponse(JSON.stringify({ bullets: [] })).bullets).toEqual([]);
    expect(parseDigestResponse(JSON.stringify({})).bullets).toEqual([]);
  });

  test("drops bullets without a title and promotes legacy text", () => {
    const result = parseDigestResponse(JSON.stringify({ bullets: [{ detail: "no title" }, { text: "legacy" }, { title: "keep", detail: "d" }] }));
    expect(result.bullets.map((b) => b.title)).toEqual(["legacy", "keep"]);
  });
});

describe("capDigestBullets", () => {
  const make = (n: number): DigestBullet[] =>
    Array.from({ length: n }, (_, i) => ({ title: `bullet ${i}`, detail: "" }));

  test("truncates to the max", () => {
    expect(capDigestBullets(make(9))).toHaveLength(MAX_DIGEST_BULLETS);
  });

  test("leaves short lists untouched", () => {
    expect(capDigestBullets(make(3))).toHaveLength(3);
  });

  test("handles empty and missing input", () => {
    expect(capDigestBullets([])).toEqual([]);
    expect(capDigestBullets(undefined)).toEqual([]);
  });
});

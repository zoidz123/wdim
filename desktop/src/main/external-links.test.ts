import { describe, expect, test } from "bun:test";
import { assertAllowedSourceUrl, setupLinkUrl } from "./external-links";

describe("external links", () => {
  test("returns known Google setup links", () => {
    expect(setupLinkUrl("gmail-api")).toBe("https://console.cloud.google.com/apis/library/gmail.googleapis.com");
    expect(setupLinkUrl("oauth-clients")).toBe("https://console.cloud.google.com/apis/credentials");
  });

  test("allows Gmail message links from findings", () => {
    expect(assertAllowedSourceUrl("https://mail.google.com/mail/u/?authuser=work%40example.com#search/rfc822msgid%3Aabc").hostname).toBe("mail.google.com");
  });

  test("allows Telegram finding links", () => {
    expect(assertAllowedSourceUrl("tg://resolve?domain=maya").protocol).toBe("tg:");
    expect(assertAllowedSourceUrl("tg://privatepost?channel=4725061802&post=41866").protocol).toBe("tg:");
  });

  test("allows X and YouTube finding links", () => {
    expect(assertAllowedSourceUrl("https://x.com/zoidz123/status/1800000000000000000").hostname).toBe("x.com");
    expect(assertAllowedSourceUrl("https://twitter.com/zoidz123/status/1800000000000000000").hostname).toBe("twitter.com");
    expect(assertAllowedSourceUrl("https://www.youtube.com/watch?v=abc123").hostname).toBe("www.youtube.com");
    expect(assertAllowedSourceUrl("https://youtu.be/abc123").hostname).toBe("youtu.be");
  });

  test("rejects unsupported finding links", () => {
    expect(() => assertAllowedSourceUrl("https://github.com/org/repo/pull/1")).toThrow("Only Gmail, X/Twitter, YouTube, and Telegram links");
    expect(() => assertAllowedSourceUrl("https://example.com")).toThrow("Only Gmail, X/Twitter, YouTube, and Telegram links");
  });
});

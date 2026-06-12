import { describe, expect, test } from "bun:test";
import { GMAIL_AUTH_PROMPT, GMAIL_SCOPES } from "./gmail-oauth";

describe("Gmail OAuth options", () => {
  test("uses read-only Gmail scope", () => {
    expect(GMAIL_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });

  test("asks Google to show account selection for multi-inbox setup", () => {
    expect(GMAIL_AUTH_PROMPT.split(" ")).toContain("select_account");
    expect(GMAIL_AUTH_PROMPT.split(" ")).toContain("consent");
  });
});

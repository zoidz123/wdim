import { describe, expect, test } from "bun:test";
import { makeSourceConnectionId } from "./types";

describe("source connector IDs", () => {
  test("builds stable local and native connection IDs", () => {
    expect(makeSourceConnectionId("gmail", "native", "work@example.com")).toBe("gmail:native:work@example.com");
    expect(makeSourceConnectionId("twitter", "native", "kevin")).toBe("twitter:native:kevin");
    expect(makeSourceConnectionId("telegram", "local", "chat_789")).toBe("telegram:local:chat_789");
  });
});

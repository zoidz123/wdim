import { describe, expect, test } from "bun:test";
import { hasScanNowArgument, hasShowWindowArgument } from "./app-arguments";

describe("app arguments", () => {
  test("detects manual scan requests", () => {
    expect(hasScanNowArgument(["/Applications/What Did I Miss.app/Contents/MacOS/What Did I Miss", "--scan-now"])).toBe(true);
  });

  test("ignores regular launches", () => {
    expect(hasScanNowArgument(["/Applications/What Did I Miss.app/Contents/MacOS/What Did I Miss"])).toBe(false);
  });

  test("detects explicit window requests", () => {
    expect(hasShowWindowArgument(["/Applications/What Did I Miss.app/Contents/MacOS/What Did I Miss", "--show-window"])).toBe(true);
  });
});

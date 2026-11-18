import { describe, expect, it } from "vitest";
import { isCopyShortcut } from "./terminalKeys";

const base = { type: "keydown", key: "c", ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };

describe("isCopyShortcut", () => {
  it("copies when text is selected", () => {
    expect(isCopyShortcut(base, "ls -l")).toBe(true);
  });

  it("sends interrupt when nothing is selected", () => {
    expect(isCopyShortcut(base, "")).toBe(false);
  });

  it("ignores keyup and keypress", () => {
    expect(isCopyShortcut({ ...base, type: "keyup" }, "text")).toBe(false);
    expect(isCopyShortcut({ ...base, type: "keypress" }, "text")).toBe(false);
  });

  it("keeps terminal default for other modifiers", () => {
    expect(isCopyShortcut({ ...base, shiftKey: true }, "text")).toBe(false);
    expect(isCopyShortcut({ ...base, altKey: true }, "text")).toBe(false);
    expect(isCopyShortcut({ ...base, metaKey: true }, "text")).toBe(false);
  });

  it("ignores other keys", () => {
    expect(isCopyShortcut({ ...base, key: "v" }, "text")).toBe(false);
    expect(isCopyShortcut({ ...base, key: "Enter" }, "text")).toBe(false);
    expect(isCopyShortcut({ ...base, ctrlKey: false }, "text")).toBe(false);
  });

  it("accepts uppercase C", () => {
    expect(isCopyShortcut({ ...base, key: "C" }, "text")).toBe(true);
  });
});

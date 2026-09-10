import { describe, expect, it } from "vitest";
import { formatGr0k, GR0K_DEFAULT, GR0K_SCALE, normalizeHandleSegment, normalizeHandleValue, parseGr0kSegment, parseGr0kValue, validateRenderHandle } from "./input.js";

describe("formal v1.0.0 inputs", () => {
  it.each([
    ["%40Alice", "alice"],
    ["Alice", "alice"],
    ["alice_7", "alice_7"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeHandleSegment(input).normalized).toBe(expected);
  });

  it("preserves artwork case while matching the X account case-insensitively", () => {
    expect(normalizeHandleSegment("Alice")).toEqual({ normalized: "alice", renderHandle: "Alice", canonicalSegment: "Alice", isCanonical: true });
    expect(normalizeHandleSegment("%40Alice")).toEqual({ normalized: "alice", renderHandle: "Alice", canonicalSegment: "Alice", isCanonical: false });
    expect(validateRenderHandle("@ALIce_7")).toBe("ALIce_7");
    expect(normalizeHandleValue("@ALIce_7")).toBe("alice_7");
  });

  it.each(["alice%2Fbob", "%2540alice", "аlice", "../alice", "@@alice", "alice%", "Alice\n", "Alice\r", "Alice%0A", "Alice%0D%0A"])("rejects hostile handle %s", (input) => {
    expect(() => normalizeHandleSegment(input)).toThrow();
  });

  it.each([
    ["1", 1, "1"],
    ["22", 22, "22"],
    ["37", 37, "37"],
    ["99", 99, "99"],
    ["100", 100, "100"],
  ])("parses unscaled integer seed %s", (input, raw, canonical) => {
    expect(parseGr0kValue(input)).toEqual({ raw, canonical });
    expect(formatGr0k(raw)).toBe(canonical);
  });

  it.each(["0", "101", "01", "001", "22.0", "0.5", "0.371924", "1.000000", "-1", "+1", "1e1", " 22", "22 ", "22\n", "22\r", "22%0A", "22%0D%0A", "NaN", "Infinity", ""])("rejects invalid gr0k %s", (input) => {
    expect(() => parseGr0kSegment(input)).toThrow();
  });

  it.each([0, 101, 1.1, NaN, Infinity])("rejects invalid raw seed %s", (raw) => {
    expect(() => formatGr0k(raw)).toThrow();
  });

  it("uses the frozen default and redirects percent-encoded integer spellings", () => {
    expect(GR0K_DEFAULT).toBe(22);
    expect(GR0K_SCALE).toBe(1);
    expect(parseGr0kSegment("%32%32")).toEqual({ raw: 22, canonical: "22", isCanonical: false });
  });
});

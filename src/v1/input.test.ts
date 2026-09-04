import { describe, expect, it } from "vitest";
import { formatGr0k, normalizeHandleSegment, parseGr0kSegment, parseGr0kValue } from "./input.js";

describe("V1 input normalization", () => {
  it.each([
    ["%40Alice", "alice"],
    ["Alice", "alice"],
    ["alice_7", "alice_7"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeHandleSegment(input).normalized).toBe(expected);
  });

  it.each(["alice%2Fbob", "%2540alice", "аlice", "../alice", "@@alice", "alice%"])("rejects hostile handle %s", (input) => {
    expect(() => normalizeHandleSegment(input)).toThrow();
  });

  it.each([
    ["0", 0, "0.000000"],
    ["0.5", 500000, "0.500000"],
    ["0.371924", 371924, "0.371924"],
    ["1", 1000000, "1.000000"],
    ["1.0000", 1000000, "1.000000"],
  ])("parses %s with decimal-string arithmetic", (input, raw, canonical) => {
    expect(parseGr0kValue(input)).toEqual({ raw, canonical });
    expect(formatGr0k(raw)).toBe(canonical);
  });

  it.each(["-0.1", "+0.1", "1.000001", "0.1234567", "1e-3", " 0.5", "0,5", "NaN", "Infinity"])("rejects invalid gr0k %s", (input) => {
    expect(() => parseGr0kSegment(input)).toThrow();
  });
});

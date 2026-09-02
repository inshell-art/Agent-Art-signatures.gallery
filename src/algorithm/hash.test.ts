import { describe, expect, it } from "vitest";
import { canonicalJson, hashToUnitFloat, mapRange } from "./hash.js";

describe("canonicalJson", () => {
  it("sorts object keys regardless of insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("recurses into nested objects and arrays", () => {
    expect(canonicalJson({ z: [{ b: 1, a: 1 }], a: 1 })).toBe('{"a":1,"z":[{"a":1,"b":1}]}');
  });

  it("matches JSON.stringify for primitives", () => {
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
  });
});

describe("mapRange", () => {
  it("maps 0 and 1 to the range endpoints", () => {
    expect(mapRange(0, 10, 20)).toBe(10);
    expect(mapRange(1, 10, 20)).toBe(20);
  });

  it("maps 0.5 to the midpoint", () => {
    expect(mapRange(0.5, 0, 100)).toBe(50);
  });

  it("supports inverted (descending) ranges", () => {
    expect(mapRange(0.5, 100, 0)).toBe(50);
  });
});

describe("hashToUnitFloat", () => {
  it("is deterministic for the same scope/parameter", () => {
    const scope = { kind: "character", value: "a" };
    expect(hashToUnitFloat(scope, "handle-angle")).toBe(hashToUnitFloat(scope, "handle-angle"));
  });

  it("differs across parameters for the same scope", () => {
    const scope = { kind: "character", value: "a" };
    expect(hashToUnitFloat(scope, "handle-angle")).not.toBe(hashToUnitFloat(scope, "incoming-handle-length"));
  });

  it("differs across scopes for the same parameter", () => {
    expect(hashToUnitFloat({ kind: "character", value: "a" }, "handle-angle")).not.toBe(
      hashToUnitFloat({ kind: "character", value: "b" }, "handle-angle"),
    );
  });

  it("stays within [0, 1) across many samples", () => {
    for (let i = 0; i < 200; i++) {
      const value = hashToUnitFloat({ kind: "character", value: String(i) }, "handle-angle");
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

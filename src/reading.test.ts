import { describe, expect, it } from "vitest";
import {
  CANONICAL_CODE,
  decodeReading,
  encodeReading,
  InvalidReadingCodeError,
  isCanonicalCode,
  isValidReadingCode,
  parseReadingCode,
} from "./reading.js";

describe("reading codec", () => {
  it("round-trips example from the handoff: hfwo -> hurried, firm, wavering, open", () => {
    const code = parseReadingCode("hfwo");
    expect(decodeReading(code)).toEqual({
      tempo: "hurried",
      weight: "firm",
      steadiness: "wavering",
      reach: "open",
    });
    expect(encodeReading(decodeReading(code))).toBe(code);
  });

  it("treats xxxx as the canonical code", () => {
    const code = parseReadingCode("xxxx");
    expect(isCanonicalCode(code)).toBe(true);
    expect(decodeReading(code)).toEqual({
      tempo: "insufficient",
      weight: "insufficient",
      steadiness: "insufficient",
      reach: "insufficient",
    });
    expect(code).toBe(CANONICAL_CODE);
  });

  it("accepts all 256 valid combinations", () => {
    const chars = { tempo: "hsmx", weight: "lefx", steadiness: "uwbx", reach: "cnox" };
    let count = 0;
    for (const t of chars.tempo) {
      for (const w of chars.weight) {
        for (const s of chars.steadiness) {
          for (const r of chars.reach) {
            const code = `${t}${w}${s}${r}`;
            expect(isValidReadingCode(code)).toBe(true);
            count++;
          }
        }
      }
    }
    expect(count).toBe(256);
  });

  it.each([
    "abcd", // wrong alphabet entirely
    "hfw", // too short
    "hfwoo", // too long
    "HFWO", // wrong case
    "xfwc".slice(0, 0) + "yfwc", // invalid tempo char
    "",
  ])("rejects out-of-vocabulary code %j as a failed read, not a novel value (§4.4)", (bad) => {
    expect(isValidReadingCode(bad)).toBe(false);
    expect(() => parseReadingCode(bad)).toThrow(InvalidReadingCodeError);
  });
});

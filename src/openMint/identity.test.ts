import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { MBTI_TYPES as UPSTREAM_MBTI_TYPES } from "../algorithmV2/index.js";
import { canonicalHandle, preservedHandle, handleDigest, MBTI_TYPES, LEGACY_MBTI_TYPES, seedForMbti, RENDERER_VERSION, LEGACY_RENDERER_VERSION } from "./identity.js";

describe("open mint handle identity", () => {
  it("canonicalizes optional @ and case while selecting the new renderer separately from legacy artwork", () => {
    expect(preservedHandle("@Alice_Bob_Key")).toBe("Alice_Bob_Key");
    expect(preservedHandle("Alice_Bob_Key")).toBe("Alice_Bob_Key");
    expect(canonicalHandle("@Some_User123")).toBe("some_user123");
    expect(canonicalHandle("a".repeat(15))).toBe("a".repeat(15));
    expect(RENDERER_VERSION).toBe("sg-renderer-2.0.0");
    expect(LEGACY_RENDERER_VERSION).toBe("sg-renderer-1.0.0");
    expect(MBTI_TYPES).toEqual(UPSTREAM_MBTI_TYPES);
    expect(new Set(MBTI_TYPES)).toEqual(new Set(LEGACY_MBTI_TYPES));
  });
  it.each([null, undefined, 42, {}, ["foo"], "", "@", "@@foo", "a".repeat(16), "foo-bar", "föö", "ｆoo", "foo bar", " foo", "foo\n", "foo/bar", "a?b"])("rejects malformed handle %j", (value) => {
    expect(() => canonicalHandle(value)).toThrow();
    expect(() => preservedHandle(value)).toThrow();
  });
  it("uses only the handle with the Solidity ABI domain convention", () => {
    const expected = keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], ["signatures.gallery/open-handle/v1", "alice"]));
    expect(handleDigest("@ALICE")).toBe(expected);
    expect(handleDigest("alice")).toBe(expected);
    expect(handleDigest("bob")).not.toBe(expected);
  });
  it("keeps a renamed handle distinct while case-only edits keep the same mint identity", () => {
    // X account IDs are provenance only: even when one account used both names,
    // the contract protects the literal name, not the account behind that name.
    expect(handleDigest("@OldName")).toBe(handleDigest("OLDNAME"));
    expect(handleDigest("@NewName")).toBe(handleDigest("newname"));
    expect(handleDigest("@OldName")).not.toBe(handleDigest("@NewName"));
  });
  it("locks all sixteen explicit enum-to-seed mappings", () => {
    expect(LEGACY_MBTI_TYPES.map(seedForMbti)).toEqual([1, 7, 14, 20, 27, 34, 40, 47, 53, 60, 67, 73, 80, 86, 93, 100]);
    expect(new Set(LEGACY_MBTI_TYPES.map(seedForMbti)).size).toBe(16);
    expect(() => seedForMbti("INFJ\n" as never)).toThrow();
    expect(() => seedForMbti("toString" as never)).toThrow();
  });
});

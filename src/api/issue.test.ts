import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import { canonicalAssetKey, instanceAssetKey, validateIssueParams } from "./issue.js";

describe("validateIssueParams", () => {
  it("accepts a well-formed handle/code/postId", () => {
    const result = validateIssueParams({ handle: "alice_1", code: "hfwo", postId: "123" });
    expect(result).toEqual({ handle: "alice_1", code: "hfwo", postId: "123" });
  });

  it("accepts a handle at the 15-character boundary", () => {
    const handle = "a".repeat(15);
    expect(() => validateIssueParams({ handle, code: "xxxx", postId: "1" })).not.toThrow();
  });

  it("rejects a handle over 15 characters", () => {
    const handle = "a".repeat(16);
    expect(() => validateIssueParams({ handle, code: "xxxx", postId: "1" })).toThrow(ValidationError);
  });

  it("rejects an empty handle", () => {
    expect(() => validateIssueParams({ handle: "", code: "xxxx", postId: "1" })).toThrow(ValidationError);
  });

  it("rejects a handle with characters outside [A-Za-z0-9_]", () => {
    for (const handle of ["alice bob", "alice-bob", "@alice", "alice.bob", "alice/bob"]) {
      expect(() => validateIssueParams({ handle, code: "xxxx", postId: "1" })).toThrow(ValidationError);
    }
  });

  it("rejects a non-digit post_id", () => {
    for (const postId of ["", "abc", "12a", "-1", "1.5"]) {
      expect(() => validateIssueParams({ handle: "alice", code: "xxxx", postId })).toThrow(ValidationError);
    }
  });

  it("accepts a post_id with leading zeros (it's an opaque id string, not a number)", () => {
    expect(() => validateIssueParams({ handle: "alice", code: "xxxx", postId: "007" })).not.toThrow();
  });

  it("rejects an out-of-vocabulary reading code, including near-misses", () => {
    for (const code of ["hfw", "hfwoo", "HFWO", "zzzz", ""]) {
      expect(() => validateIssueParams({ handle: "alice", code, postId: "1" })).toThrow(ValidationError);
    }
  });

  it("error messages name the offending value", () => {
    expect(() => validateIssueParams({ handle: "bad handle", code: "xxxx", postId: "1" })).toThrow(/bad handle/);
    expect(() => validateIssueParams({ handle: "alice", code: "xxxx", postId: "abc" })).toThrow(/abc/);
    expect(() => validateIssueParams({ handle: "alice", code: "zzzz", postId: "1" })).toThrow(/zzzz/);
  });
});

describe("asset key helpers", () => {
  it("namespace instance and canonical keys distinctly, even for the same string", () => {
    expect(instanceAssetKey("alice")).toBe("instance:alice");
    expect(canonicalAssetKey("alice")).toBe("canonical:alice");
    expect(instanceAssetKey("alice")).not.toBe(canonicalAssetKey("alice"));
  });
});

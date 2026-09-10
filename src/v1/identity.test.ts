import { describe, expect, it } from "vitest";
import { deriveSignatureId, signatureIdentityPayload } from "./identity.js";

const vector = {
  xUserId: "1234567890123456789",
  handleAtClaim: "Alice",
  gr0kRaw: 22,
  rendererVersion: "sg-renderer-1.0.0",
};

describe("signature identity", () => {
  it("matches the V1 typed-encoding golden vector", () => {
    expect(signatureIdentityPayload(vector).toString("hex")).toBe("01001c7369676e6174757265732e67616c6c6572792f7369676e61747572650013313233343536373839303132333435363738390005416c6963650000001600000001001173672d72656e64657265722d312e302e30");
    expect(deriveSignatureId(vector)).toBe("sg1_i4p2ewy4lkbui2v65y5moarzjrgph6vaeunf7pxzvm5cbeatsida");
  });

  it("keeps X IDs exact beyond JavaScript's safe integer range", () => {
    expect(deriveSignatureId(vector)).not.toBe(deriveSignatureId({ ...vector, xUserId: "1234567890123456790" }));
  });

  it("treats case variants as distinct immutable artworks", () => {
    expect(deriveSignatureId(vector)).not.toBe(deriveSignatureId({ ...vector, handleAtClaim: "alice" }));
    expect(deriveSignatureId(vector)).not.toBe(deriveSignatureId({ ...vector, handleAtClaim: "ALICE" }));
  });

  it.each([0, 101, 371924, 22.5])("rejects seeds outside the formal range: %s", (gr0kRaw) => {
    expect(() => deriveSignatureId({ ...vector, gr0kRaw })).toThrow(/gr0k_raw/);
  });

  it("rejects obsolete fractional scales and display-prefixed handles", () => {
    expect(() => deriveSignatureId({ ...vector, gr0kScale: 1_000_000 as never })).toThrow(/gr0k_scale/);
    expect(() => deriveSignatureId({ ...vector, handleAtClaim: "@Alice" })).toThrow(/handleAtClaim/);
    expect(() => deriveSignatureId({ ...vector, handleAtClaim: "Alice\n" })).toThrow(/handleAtClaim/);
    expect(() => deriveSignatureId({ ...vector, xUserId: "123\n" })).toThrow(/x_user_id/);
  });
});

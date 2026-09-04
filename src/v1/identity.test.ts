import { describe, expect, it } from "vitest";
import { deriveSignatureId, signatureIdentityPayload } from "./identity.js";

const vector = {
  xUserId: "1234567890123456789",
  handleNormalized: "alice",
  gr0kRaw: 371924,
  rendererVersion: "sg-renderer-1.0.0",
};

describe("signature identity", () => {
  it("matches the V1 typed-encoding golden vector", () => {
    expect(signatureIdentityPayload(vector).toString("hex")).toBe("01001c7369676e6174757265732e67616c6c6572792f7369676e61747572650013313233343536373839303132333435363738390005616c6963650005acd4000f4240001173672d72656e64657265722d312e302e30");
    expect(deriveSignatureId(vector)).toBe("sg1_j5ii32jw5ccljacrqivzj3pmdoxp5mvka6avgv3izzfmvcunspva");
  });

  it("keeps X IDs exact beyond JavaScript's safe integer range", () => {
    expect(deriveSignatureId(vector)).not.toBe(deriveSignatureId({ ...vector, xUserId: "1234567890123456790" }));
  });
});

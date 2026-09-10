import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureIdentityPayload } from "../../v1/identity.js";
import {
  SIGNATURE_ID_GOLDEN_VECTOR,
  decodeBase32Rfc4648Lower,
  encodeBase32Rfc4648Lower,
  signatureDigestFromId,
  signatureDigestHex,
  signatureIdFromDigest,
  signatureTokenId,
  verifySignatureIdPayload,
} from "./signatureId.js";

const identity = {
  xUserId: "1234567890123456789",
  handleNormalized: "alice",
  gr0kRaw: 371924,
  rendererVersion: "sg-renderer-1.0.0",
};

describe("V1 signature identity bridge", () => {
  it("matches the mandatory digest and big-endian token ID vector", () => {
    const digest = signatureDigestFromId(SIGNATURE_ID_GOLDEN_VECTOR.signatureId);

    expect(digest).toHaveLength(32);
    expect(signatureDigestHex(SIGNATURE_ID_GOLDEN_VECTOR.signatureId)).toBe(SIGNATURE_ID_GOLDEN_VECTOR.signatureDigest);
    expect(signatureTokenId(SIGNATURE_ID_GOLDEN_VECTOR.signatureId).toString()).toBe(SIGNATURE_ID_GOLDEN_VECTOR.tokenId);
    expect(signatureIdFromDigest(digest)).toBe(SIGNATURE_ID_GOLDEN_VECTOR.signatureId);
  });

  it("recomputes SHA-256 from the immutable V1 payload", () => {
    const payload = signatureIdentityPayload(identity);
    expect(Buffer.from(verifySignatureIdPayload(SIGNATURE_ID_GOLDEN_VECTOR.signatureId, payload)).toString("hex"))
      .toBe(SIGNATURE_ID_GOLDEN_VECTOR.signatureDigest.slice(2));
  });

  it("does not hash the displayed signature ID string", () => {
    const wrongDigest = createHash("sha256").update(SIGNATURE_ID_GOLDEN_VECTOR.signatureId, "utf8").digest();
    expect(`0x${wrongDigest.toString("hex")}`).not.toBe(SIGNATURE_ID_GOLDEN_VECTOR.signatureDigest);
    expect(() => verifySignatureIdPayload(SIGNATURE_ID_GOLDEN_VECTOR.signatureId, Buffer.from(SIGNATURE_ID_GOLDEN_VECTOR.signatureId)))
      .toThrow(/immutable V1 identity payload/);
  });

  it("rejects noncanonical prefixes, alphabet, casing, lengths, and padding bits", () => {
    const id = SIGNATURE_ID_GOLDEN_VECTOR.signatureId;
    expect(() => signatureDigestFromId(`SG1_${id.slice(4)}`)).toThrow(/exact sg1_/);
    expect(() => signatureDigestFromId(`${id.slice(0, -1)}A`)).toThrow(/lowercase/);
    expect(() => signatureDigestFromId(`${id}a`)).toThrow(/52/);
    expect(() => signatureDigestFromId(id.slice(0, -1))).toThrow(/52/);
    expect(() => signatureDigestFromId(`${id.slice(0, -1)}b`)).toThrow(/padding/);
    expect(() => decodeBase32Rfc4648Lower("a=")).toThrow(/lowercase unpadded/);
  });

  it("round-trips arbitrary byte lengths without padding", () => {
    for (let length = 1; length <= 64; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length) & 0xff);
      const encoded = encodeBase32Rfc4648Lower(bytes);
      expect(Buffer.from(decodeBase32Rfc4648Lower(encoded))).toEqual(Buffer.from(bytes));
      expect(encoded).not.toContain("=");
    }
  });
});

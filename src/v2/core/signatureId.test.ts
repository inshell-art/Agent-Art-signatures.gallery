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
  handleAtClaim: "Alice",
  gr0kRaw: 22,
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

  it("recomputes SHA-256 from the case-sensitive formal algorithm payload", () => {
    const payload = signatureIdentityPayload(identity);
    const formalId = "sg1_i4p2ewy4lkbui2v65y5moarzjrgph6vaeunf7pxzvm5cbeatsida";
    expect(Buffer.from(verifySignatureIdPayload(formalId, payload)).toString("hex"))
      .toBe(createHash("sha256").update(payload).digest("hex"));
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

describe("signature ID digest boundaries", () => {
  it("refuses to mint an identifier from anything but a 32-byte digest", () => {
    for (const length of [0, 31, 33, 64]) {
      expect(() => signatureIdFromDigest(new Uint8Array(length))).toThrow(/exactly 32 bytes/);
    }
    expect(signatureIdFromDigest(new Uint8Array(32))).toBe(`sg1_${"a".repeat(52)}`);
  });

  it("rejects an identifier whose Base32 body is the wrong length or prefix before decoding it", () => {
    const valid = SIGNATURE_ID_GOLDEN_VECTOR.signatureId;
    expect(() => signatureDigestFromId(valid.slice(4))).toThrow(/exact sg1_ prefix/);
    expect(() => signatureDigestFromId(`sg2_${valid.slice(4)}`)).toThrow(/exact sg1_ prefix/);
    expect(() => signatureDigestFromId(`sg1_${valid.slice(4, -1)}`)).toThrow(/exactly 52 unpadded/);
    expect(() => signatureDigestFromId(`${valid}a`)).toThrow(/exactly 52 unpadded/);
  });

  it("rejects a 52-character body that carries nonzero padding bits", () => {
    const body = SIGNATURE_ID_GOLDEN_VECTOR.signatureId.slice(4);
    // The final character holds one digest bit plus four padding bits that must be zero.
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const last = alphabet.indexOf(body[body.length - 1]!);
    const polluted = alphabet[(last & 0b10000) | 0b00001]!;
    expect(polluted).not.toBe(body[body.length - 1]);
    expect(() => signatureDigestFromId(`sg1_${body.slice(0, -1)}${polluted}`)).toThrow(/nonzero padding bits/);
  });
});

import { createHash, timingSafeEqual } from "node:crypto";

const SIGNATURE_ID_PREFIX = "sg1_";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SHA256_BYTES = 32;
const SHA256_BASE32_LENGTH = 52;

export const SIGNATURE_ID_GOLDEN_VECTOR = Object.freeze({
  signatureId: "sg1_j5ii32jw5ccljacrqivzj3pmdoxp5mvka6avgv3izzfmvcunspva",
  signatureDigest: "0x4f508de936e884b48051822b94edec1baefeb2aa0781535768ce4aca8a8d93ea",
  tokenId: "35875042236945302606725603330365055819023759584116837117696243259715701543914",
});

function assertDigestBytes(bytes: Uint8Array): void {
  if (bytes.byteLength !== SHA256_BYTES) {
    throw new Error("signature digest must be exactly 32 bytes.");
  }
}

export function encodeBase32Rfc4648Lower(bytes: Uint8Array): string {
  let bitBuffer = 0;
  let bitCount = 0;
  let result = "";

  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;

    while (bitCount >= 5) {
      result += BASE32_ALPHABET[(bitBuffer >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }

    // Keeping only the unconsumed bits prevents JavaScript's bitwise operators
    // from overflowing as the next byte is appended.
    bitBuffer &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
  }

  if (bitCount > 0) {
    result += BASE32_ALPHABET[(bitBuffer << (5 - bitCount)) & 31];
  }

  return result;
}

export function decodeBase32Rfc4648Lower(value: string): Uint8Array {
  if (!/^[a-z2-7]+$/.test(value)) {
    throw new Error("Base32 value must use lowercase unpadded RFC 4648 alphabet.");
  }

  let bitBuffer = 0;
  let bitCount = 0;
  const decoded: number[] = [];

  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    bitBuffer = (bitBuffer << 5) | digit;
    bitCount += 5;

    if (bitCount >= 8) {
      decoded.push((bitBuffer >>> (bitCount - 8)) & 0xff);
      bitCount -= 8;
      bitBuffer &= bitCount === 0 ? 0 : (1 << bitCount) - 1;
    }
  }

  // Unpadded RFC 4648 encodings may end in zero padding bits only. An exact
  // re-encode below is still required to reject alternate encodings.
  if (bitCount > 0 && bitBuffer !== 0) {
    throw new Error("Base32 value has nonzero padding bits.");
  }

  return Uint8Array.from(decoded);
}

export function signatureDigestFromId(signatureId: string): Uint8Array {
  if (!signatureId.startsWith(SIGNATURE_ID_PREFIX)) {
    throw new Error("signature_id must have the exact sg1_ prefix.");
  }

  const encoded = signatureId.slice(SIGNATURE_ID_PREFIX.length);
  if (encoded.length !== SHA256_BASE32_LENGTH) {
    throw new Error("signature_id must contain exactly 52 unpadded Base32 characters.");
  }

  const digest = decodeBase32Rfc4648Lower(encoded);
  assertDigestBytes(digest);

  if (encodeBase32Rfc4648Lower(digest) !== encoded) {
    throw new Error("signature_id is not a canonical lowercase RFC 4648 Base32 encoding.");
  }

  return digest;
}

export function signatureIdFromDigest(digest: Uint8Array): string {
  assertDigestBytes(digest);
  return `${SIGNATURE_ID_PREFIX}${encodeBase32Rfc4648Lower(digest)}`;
}

export function signatureDigestHex(signatureId: string): `0x${string}` {
  return `0x${Buffer.from(signatureDigestFromId(signatureId)).toString("hex")}`;
}

export function signatureTokenId(signatureId: string): bigint {
  return BigInt(signatureDigestHex(signatureId));
}

export function verifySignatureIdPayload(signatureId: string, immutableV1Payload: Uint8Array): Uint8Array {
  const decoded = signatureDigestFromId(signatureId);
  const recomputed = createHash("sha256").update(immutableV1Payload).digest();

  if (!timingSafeEqual(Buffer.from(decoded), recomputed)) {
    throw new Error("signature_id does not match the immutable V1 identity payload.");
  }

  return decoded;
}

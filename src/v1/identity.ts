import { createHash, randomBytes } from "node:crypto";
import { GR0K_MAX, GR0K_MIN, GR0K_SCALE } from "./input.js";

const SIGNATURE_DOMAIN = Buffer.from("signatures.gallery/signature", "utf8");
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function u16be(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function u32be(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function sizedText(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 0xffff) throw new Error("Identity field is too long.");
  return Buffer.concat([u16be(bytes.length), bytes]);
}

export function base32Rfc4648(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

export interface SignatureIdentityInput {
  xUserId: string;
  /** Exact, case-sensitive artwork input, without the display @ prefix. */
  handleAtClaim: string;
  gr0kRaw: number;
  gr0kScale?: typeof GR0K_SCALE;
  rendererVersion: string;
}

export function signatureIdentityPayload(input: SignatureIdentityInput): Buffer {
  if (typeof input.xUserId !== "string" || !/^(?:0|[1-9]\d*)$(?![\s\S])/.test(input.xUserId)) throw new Error("x_user_id must be a canonical decimal string.");
  if (typeof input.handleAtClaim !== "string" || !/^[A-Za-z0-9_]{1,15}$(?![\s\S])/.test(input.handleAtClaim)) throw new Error("handleAtClaim must be the exact valid artwork handle.");
  const scale = input.gr0kScale ?? GR0K_SCALE;
  if (!Number.isInteger(input.gr0kRaw) || input.gr0kRaw < GR0K_MIN || input.gr0kRaw > GR0K_MAX) throw new Error("invalid gr0k_raw.");
  if (scale !== GR0K_SCALE) throw new Error("invalid gr0k_scale.");
  return Buffer.concat([
    Buffer.from([0x01]),
    sizedText(SIGNATURE_DOMAIN.toString("utf8")),
    sizedText(input.xUserId),
    sizedText(input.handleAtClaim),
    u32be(input.gr0kRaw),
    u32be(scale),
    sizedText(input.rendererVersion),
  ]);
}

export function deriveSignatureId(input: SignatureIdentityInput): string {
  const digest = createHash("sha256").update(signatureIdentityPayload(input)).digest();
  return `sg1_${base32Rfc4648(digest).toLowerCase()}`;
}

export function createPublicAccountId(): string {
  return `xa1_${base32Rfc4648(randomBytes(16)).toLowerCase()}`;
}

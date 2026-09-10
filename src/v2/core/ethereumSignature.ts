import { getAddress, recoverAddress, type Address, type Hex } from "viem";

const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

export interface CanonicalEcdsaSignature {
  hex: Hex;
  r: bigint;
  s: bigint;
  v: 27 | 28;
}

function parseScalar(hex: string, name: "r" | "s"): bigint {
  const value = BigInt(`0x${hex}`);
  if (value === 0n || value >= SECP256K1_ORDER) {
    throw new Error(`ECDSA ${name} scalar is outside the secp256k1 range.`);
  }
  return value;
}

export function parseCanonicalEcdsaSignature(value: string): CanonicalEcdsaSignature {
  if (!/^0x[0-9a-f]{130}$/.test(value)) {
    throw new Error("signature must be canonical 65-byte lowercase 0x-prefixed r || s || v.");
  }

  const r = parseScalar(value.slice(2, 66), "r");
  const s = parseScalar(value.slice(66, 130), "s");
  if (s > SECP256K1_HALF_ORDER) {
    throw new Error("signature must use a low-s secp256k1 scalar.");
  }

  const vByte = Number.parseInt(value.slice(130, 132), 16);
  if (vByte !== 27 && vByte !== 28) {
    throw new Error("signature recovery byte v must be exactly 27 or 28.");
  }

  return { hex: value as Hex, r, s, v: vByte };
}

export async function recoverCanonicalAddress(digest: Hex, signature: string): Promise<Address> {
  if (!/^0x[0-9a-f]{64}$/.test(digest)) {
    throw new Error("signed digest must be exactly 32 lowercase hexadecimal bytes.");
  }

  const parsed = parseCanonicalEcdsaSignature(signature);
  return getAddress(await recoverAddress({ hash: digest, signature: parsed.hex }));
}

export async function requireCanonicalSignatureFrom(
  digest: Hex,
  signature: string,
  expectedSigner: string,
): Promise<CanonicalEcdsaSignature> {
  const parsed = parseCanonicalEcdsaSignature(signature);
  const expected = getAddress(expectedSigner);
  const recovered = await recoverCanonicalAddress(digest, parsed.hex);
  if (recovered !== expected) {
    throw new Error("signature signer does not match the expected address.");
  }
  return parsed;
}

export const SECP256K1 = Object.freeze({
  order: SECP256K1_ORDER,
  halfOrder: SECP256K1_HALF_ORDER,
});

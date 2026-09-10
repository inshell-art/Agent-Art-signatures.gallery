import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { SECP256K1, parseCanonicalEcdsaSignature, recoverCanonicalAddress } from "./ethereumSignature.js";
import {
  buildExactSiweMessage,
  generateSiweNonce,
  parseExactSiweMessage,
  requireCurrentSiweWindow,
  siweChallengeExpiry,
  siweMessageHash,
  verifyExactSiweProof,
  type ExactSiweMessageFields,
} from "./siwe.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/siwe-golden.json", import.meta.url), "utf8")) as {
  fields: ExactSiweMessageFields;
  message: string;
  digest: `0x${string}`;
  walletProof: string;
};
const fixture = golden.fields;
const exactMessage = golden.message;
const exactDigest = golden.digest;
const exactProof = golden.walletProof;

describe("exact signatures.gallery SIWE", () => {
  it("locks the complete LF/no-trailing-newline golden fixture", async () => {
    const message = buildExactSiweMessage(fixture);
    expect(message).toBe(exactMessage);
    expect(Buffer.from(message, "utf8")).not.toContain(0x0d);
    expect(message.endsWith("\n")).toBe(false);
    expect(siweMessageHash(message)).toBe(exactDigest);
    expect(await recoverCanonicalAddress(exactDigest, exactProof)).toBe(getAddress(fixture.walletAddress));
    expect(await verifyExactSiweProof(message, exactProof, fixture)).toBe(getAddress(fixture.walletAddress));
  });

  it("round-trips every frozen field and local non-default ports", () => {
    expect(parseExactSiweMessage(exactMessage)).toEqual({
      ...fixture,
      walletAddress: getAddress(fixture.walletAddress),
      chainId: "1",
    });
    const local = { ...fixture, appHost: "127.0.0.1:3000", appOrigin: "http://127.0.0.1:3000" };
    expect(parseExactSiweMessage(buildExactSiweMessage(local)).appHost).toBe("127.0.0.1:3000");
  });

  it("rejects altered, cross-origin, cross-chain, and noncanonical messages", async () => {
    await expect(verifyExactSiweProof(exactMessage, exactProof, { ...fixture, chainId: "11155111" })).rejects.toThrow(/server-issued/);
    await expect(verifyExactSiweProof(exactMessage, exactProof, { ...fixture, appOrigin: "https://staging.signatures.gallery", appHost: "staging.signatures.gallery" })).rejects.toThrow(/server-issued/);
    await expect(verifyExactSiweProof(exactMessage.replace("account-ref/xa1", "account-ref/xa2"), exactProof, fixture)).rejects.toThrow(/server-issued/);
    expect(() => parseExactSiweMessage(`${exactMessage}\n`)).toThrow(/no trailing newline/);
    expect(() => parseExactSiweMessage(exactMessage.replaceAll("\n", "\r\n"))).toThrow(/LF line endings/);
    expect(() => parseExactSiweMessage(exactMessage.replace(fixture.walletAddress, fixture.walletAddress.toLowerCase()))).toThrow(/EIP-55/);
    expect(() => parseExactSiweMessage(exactMessage.replace(".789Z", "Z"))).toThrow(/millisecond/);
  });

  it("accepts only 65-byte lowercase low-s r || s || v with v 27/28", () => {
    expect(parseCanonicalEcdsaSignature(exactProof).v).toBe(28);
    expect(() => parseCanonicalEcdsaSignature(exactProof.slice(0, -2))).toThrow(/65-byte/);
    expect(() => parseCanonicalEcdsaSignature(exactProof.toUpperCase().replace("0X", "0x"))).toThrow(/lowercase/);
    expect(() => parseCanonicalEcdsaSignature(`${exactProof.slice(0, -2)}00`)).toThrow(/27 or 28/);
    expect(() => parseCanonicalEcdsaSignature(`${exactProof.slice(0, -2)}01`)).toThrow(/27 or 28/);

    const parsed = parseCanonicalEcdsaSignature(exactProof);
    const highS = (SECP256K1.order - parsed.s).toString(16).padStart(64, "0");
    const highSProof = `${exactProof.slice(0, 66)}${highS}${exactProof.slice(-2)}`;
    expect(() => parseCanonicalEcdsaSignature(highSProof)).toThrow(/low-s/);
    expect(() => parseCanonicalEcdsaSignature(`0x${"0".repeat(64)}${exactProof.slice(66)}`)).toThrow(/r scalar/);
  });

  it("generates exactly 22 unbiased alphanumeric nonce characters", () => {
    let calls = 0;
    const nonce = generateSiweNonce((length) => {
      calls += 1;
      return calls === 1
        ? Uint8Array.from([248, 249, 250, 251, 252, 253, 254, 255])
        : Uint8Array.from({ length }, (_, index) => index);
    });
    expect(nonce).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(nonce).toBe("ABCDEFGHIJKLMNOPQRSTUV");
    expect(calls).toBeGreaterThan(1);
  });

  it("caps challenge expiry at both ten minutes and X freshness", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(siweChallengeExpiry(now, new Date("2026-09-04T11:58:00.000Z")).toISOString()).toBe("2026-09-04T12:10:00.000Z");
    expect(siweChallengeExpiry(now, new Date("2026-09-04T11:46:00.000Z")).toISOString()).toBe("2026-09-04T12:01:00.000Z");
  });

  it("rejects an early or expired challenge at confirmation time", () => {
    expect(() => requireCurrentSiweWindow(exactMessage, new Date("2026-09-04T12:34:56.788Z"))).toThrow(/not active/);
    expect(() => requireCurrentSiweWindow(exactMessage, new Date("2026-09-04T12:44:56.789Z"))).toThrow(/expired/);
    expect(requireCurrentSiweWindow(exactMessage, new Date("2026-09-04T12:40:00.000Z")).challengeId).toBe(fixture.challengeId);
  });
});

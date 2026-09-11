import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
  it("scopes new recipient proof to an exact work and claim while retaining the legacy proof format", async () => {
    const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const fields = { ...fixture, walletAddress: signer.address, mintTarget: { signatureId: "sg1_exact-work", claimInstanceId: "exact-claim" } };
    const message = buildExactSiweMessage(fields);
    expect(message).toContain("Prove control of this recipient for this signature's mint.");
    expect(message).not.toContain("Link this wallet");
    expect(parseExactSiweMessage(message).mintTarget).toEqual(fields.mintTarget);
    const proof = await signer.signMessage({ message });
    expect(await verifyExactSiweProof(message, proof, fields)).toBe(signer.address);
    await expect(verifyExactSiweProof(message, proof, { ...fields, mintTarget: { ...fields.mintTarget, claimInstanceId: "other-claim" } })).rejects.toThrow(/server-issued/);
    await expect(verifyExactSiweProof(message, proof, { ...fields, mintTarget: undefined })).rejects.toThrow(/server-issued/);
    expect(buildExactSiweMessage(fixture)).toBe(exactMessage);
  });
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

  it("expires the wallet proof challenge independently ten minutes after issuance", () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(siweChallengeExpiry(now).toISOString()).toBe("2026-09-04T12:10:00.000Z");
    expect(() => siweChallengeExpiry(new Date(NaN))).toThrow("valid instant");
  });

  it("rejects an early or expired challenge at confirmation time", () => {
    expect(() => requireCurrentSiweWindow(exactMessage, new Date("2026-09-04T12:34:56.788Z"))).toThrow(/not active/);
    expect(() => requireCurrentSiweWindow(exactMessage, new Date("2026-09-04T12:44:56.789Z"))).toThrow(/expired/);
    expect(requireCurrentSiweWindow(exactMessage, new Date("2026-09-04T12:40:00.000Z")).challengeId).toBe(fixture.challengeId);
  });
});

describe("SIWE field and layout rejections", () => {
  const build = (overrides: Partial<ExactSiweMessageFields>) => () => buildExactSiweMessage({ ...fixture, ...overrides });

  it("requires appOrigin to be the exact scheme-and-host origin for appHost", () => {
    expect(build({ appOrigin: "signatures.gallery" })).toThrow(/absolute origin URL/);
    expect(build({ appOrigin: "https://signatures.gallery/app" })).toThrow(/exact origin for appHost/);
    expect(build({ appOrigin: "https://signatures.gallery?x=1" })).toThrow(/exact origin for appHost/);
    expect(build({ appOrigin: "https://other.example", appHost: "signatures.gallery" })).toThrow(/exact origin for appHost/);
    expect(build({ appOrigin: "https://signatures.gallery/" })).toThrow(/trailing slash/);
    expect(build({ appHost: "Signatures.Gallery" })).toThrow(/lowercase/);
  });

  it("allows plaintext HTTP only on loopback", () => {
    expect(build({ appOrigin: "http://signatures.gallery", appHost: "signatures.gallery" })).toThrow(/HTTPS outside local development/);
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(build({ appOrigin: `http://${host}`, appHost: host })).not.toThrow();
    }
  });

  it("rejects a nonce that is not exactly 22 ASCII alphanumerics", () => {
    for (const nonce of ["", "short", "A1b2C3d4E5f6G7h8I9j0K", "A1b2C3d4E5f6G7h8I9j0K12", "A1b2C3d4E5f6G7h8I9j0K-", "A1b2C3d4E5f6G7h8I9j0K "]) {
      expect(build({ nonce })).toThrow(/exactly 22 ASCII alphanumeric/);
    }
  });

  it("requires a canonical decimal chain ID", () => {
    for (const chainId of ["0", "01", "1.0", "-1", "0x1", "", " 1"]) {
      expect(build({ chainId })).toThrow(/positive canonical decimal/);
    }
    expect(buildExactSiweMessage({ ...fixture, chainId: 11155111n })).toContain("Chain ID: 11155111");
  });

  it("requires millisecond UTC timestamps that expire after they are issued", () => {
    expect(build({ issuedAt: "2026-09-04T12:34:56Z" })).toThrow(/millisecond precision/);
    expect(build({ expirationTime: "2026-09-04T12:44:56.789+00:00" })).toThrow(/millisecond precision/);
    expect(build({ expirationTime: fixture.issuedAt })).toThrow(/later than issuedAt/);
    expect(build({ expirationTime: "2026-09-04T12:24:56.789Z" })).toThrow(/later than issuedAt/);
  });

  it("keeps every identifier an opaque URI-path-safe value", () => {
    for (const bad of ["", "with space", "slash/inside", "question?mark", "hash#mark", "percent%20"]) {
      expect(build({ challengeId: bad })).toThrow(/opaque URI-path-safe/);
      expect(build({ publicAccountId: bad })).toThrow(/opaque URI-path-safe/);
      expect(build({ mintTarget: { signatureId: bad, claimInstanceId: "exact-claim" } })).toThrow(/opaque URI-path-safe/);
      expect(build({ mintTarget: { signatureId: "sg1_exact-work", claimInstanceId: bad } })).toThrow(/opaque URI-path-safe/);
    }
  });

  it("rejects a damaged domain line before trusting any parsed field", () => {
    const lines = exactMessage.split("\n");
    const damaged = [...lines];
    damaged[0] = "signatures.gallery wants you to sign in:";
    expect(() => parseExactSiweMessage(damaged.join("\n"))).toThrow(/invalid domain line/);
  });

  it("rejects CR line endings, a trailing newline, and any layout that is not the frozen shape", () => {
    expect(() => parseExactSiweMessage(exactMessage.replace(/\n/g, "\r\n"))).toThrow(/LF line endings/);
    expect(() => parseExactSiweMessage(`${exactMessage}\n`)).toThrow(/LF line endings/);
    expect(() => parseExactSiweMessage(exactMessage.split("\n").slice(0, 13).join("\n"))).toThrow(/frozen signatures.gallery layout/);
    expect(() => parseExactSiweMessage(`${exactMessage}\n- https://signatures.gallery/extra/x`)).toThrow(/frozen signatures.gallery layout/);
  });

  it("recovers only from a 32-byte lowercase hexadecimal digest", async () => {
    await expect(recoverCanonicalAddress(exactDigest.toUpperCase() as `0x${string}`, exactProof)).rejects.toThrow(/32 lowercase hexadecimal bytes/);
    await expect(recoverCanonicalAddress("0xabc" as `0x${string}`, exactProof)).rejects.toThrow(/32 lowercase hexadecimal bytes/);
    expect(await recoverCanonicalAddress(exactDigest, exactProof)).toBe(getAddress(fixture.walletAddress));
  });
});

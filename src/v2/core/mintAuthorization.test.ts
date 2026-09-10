import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePacked, hashTypedData, keccak256 } from "viem";
import {
  MINT_AUTHORIZATION_PRIMARY_TYPE,
  MINT_AUTHORIZATION_TYPE_STRING,
  MINT_AUTHORIZATION_TYPEHASH,
  MINT_AUTHORIZATION_TYPES,
  backendAuthorizationTimes,
  mintAuthorizationDigest,
  mintAuthorizationDomain,
  mintAuthorizationDomainSeparator,
  mintAuthorizationStructHash,
  mintAuthorizationTypedData,
  normalizeMintAuthorization,
  normalizeBackendMintAuthorization,
  randomNonzeroBytes32,
  requireBackendAuthorizationWindow,
  tokenUriHash,
  verifyGalleryAttestation,
  type MintAuthorizationInput,
} from "./mintAuthorization.js";

const golden = JSON.parse(readFileSync(new URL("../../../contracts/fixtures/mint-authorization-golden.json", import.meta.url), "utf8")) as {
  domain: { name: string; version: string; chainId: string; verifyingContract: string };
  primaryType: string;
  typeString: string;
  authorization: MintAuthorizationInput;
  tokenURI: string;
  typeHash: `0x${string}`;
  structHash: `0x${string}`;
  domainSeparator: `0x${string}`;
  digest: `0x${string}`;
  authorizer: string;
  galleryAttestation: string;
};
const metadataGolden = JSON.parse(readFileSync(new URL("./fixtures/metadata-golden.json", import.meta.url), "utf8")) as {
  source: { svgSha256: string; pngSha256: string };
  metadataSha256: string;
  tokenURI: string;
  tokenURIHash: string;
};
const domain = { chainId: golden.domain.chainId, verifyingContract: golden.domain.verifyingContract };
const authorization = golden.authorization;
const expected = {
  typeHash: golden.typeHash,
  structHash: golden.structHash,
  domainSeparator: golden.domainSeparator,
  digest: golden.digest,
  authorizer: golden.authorizer,
  signature: golden.galleryAttestation,
};

describe("MintAuthorization EIP-712", () => {
  it("locks the exact type, struct, domain, digest, and canonical signature vector", async () => {
    expect(MINT_AUTHORIZATION_PRIMARY_TYPE).toBe("MintAuthorization");
    expect(golden.primaryType).toBe(MINT_AUTHORIZATION_PRIMARY_TYPE);
    expect(golden.typeString).toBe(MINT_AUTHORIZATION_TYPE_STRING);
    expect(golden.domain.name).toBe("signatures.gallery");
    expect(golden.domain.version).toBe("2");
    expect(MINT_AUTHORIZATION_TYPEHASH).toBe(expected.typeHash);
    expect(mintAuthorizationStructHash(authorization)).toBe(expected.structHash);
    expect(mintAuthorizationDomainSeparator(domain)).toBe(expected.domainSeparator);
    expect(mintAuthorizationDigest(domain, authorization)).toBe(expected.digest);
    await expect(verifyGalleryAttestation(domain, authorization, expected.signature, expected.authorizer)).resolves.toBeUndefined();
  });

  it("shares the exact frozen artifact and metadata commitments", () => {
    expect(authorization.svgSha256).toBe(`0x${metadataGolden.source.svgSha256}`);
    expect(authorization.pngSha256).toBe(`0x${metadataGolden.source.pngSha256}`);
    expect(authorization.metadataSha256).toBe(`0x${metadataGolden.metadataSha256}`);
    expect(golden.tokenURI).toBe(metadataGolden.tokenURI);
    expect(authorization.tokenURIHash).toBe(metadataGolden.tokenURIHash);
  });

  it("matches viem's independent typed-data implementation", () => {
    const typedData = mintAuthorizationTypedData(domain, authorization);
    expect(typedData.domain).toEqual({
      name: "signatures.gallery",
      version: "2",
      chainId: 11155111n,
      verifyingContract: domain.verifyingContract,
    });
    expect(typedData.types).toEqual(MINT_AUTHORIZATION_TYPES);
    expect(hashTypedData(typedData)).toBe(expected.digest);
  });

  it("does not use abi.encodePacked", () => {
    const packed = keccak256(encodePacked(
      ["bytes32", "bytes32", "bytes32", "address", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint64", "uint64", "uint32"],
      [
        MINT_AUTHORIZATION_TYPEHASH,
        authorization.signatureDigest,
        authorization.walletBindingId,
        authorization.mintWallet as `0x${string}`,
        authorization.svgSha256,
        authorization.pngSha256,
        authorization.metadataSha256,
        authorization.tokenURIHash,
        authorization.authorizationId,
        BigInt(authorization.validAfter),
        BigInt(authorization.deadline),
        authorization.authorizerEpoch,
      ],
    ));
    expect(packed).not.toBe(expected.structHash);
  });

  it("invalidates the attestation when every signed field is mutated", async () => {
    const mutations: MintAuthorizationInput[] = [
      { ...authorization, signatureDigest: `0x${"01".repeat(32)}` },
      { ...authorization, walletBindingId: `0x${"02".repeat(32)}` },
      { ...authorization, mintWallet: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
      { ...authorization, svgSha256: `0x${"03".repeat(32)}` },
      { ...authorization, pngSha256: `0x${"04".repeat(32)}` },
      { ...authorization, metadataSha256: `0x${"05".repeat(32)}` },
      { ...authorization, tokenURIHash: `0x${"06".repeat(32)}` },
      { ...authorization, authorizationId: `0x${"07".repeat(32)}` },
      { ...authorization, validAfter: BigInt(authorization.validAfter) - 1n },
      { ...authorization, deadline: BigInt(authorization.deadline) + 1n },
      { ...authorization, authorizerEpoch: 2 },
    ];
    for (const mutation of mutations) {
      await expect(verifyGalleryAttestation(domain, mutation, expected.signature, expected.authorizer)).rejects.toThrow(/signer/);
    }
  });

  it("binds the signature to chain and contract", async () => {
    await expect(verifyGalleryAttestation({ ...domain, chainId: "1" }, authorization, expected.signature, expected.authorizer)).rejects.toThrow(/signer/);
    await expect(verifyGalleryAttestation({ ...domain, verifyingContract: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" }, authorization, expected.signature, expected.authorizer)).rejects.toThrow(/signer/);
  });

  it("enforces the exact backend window and Solidity widths", () => {
    const normalized = normalizeMintAuthorization(authorization);
    expect(() => requireBackendAuthorizationWindow(normalized)).not.toThrow();
    expect(normalizeBackendMintAuthorization(authorization)).toEqual(normalized);
    expect(() => requireBackendAuthorizationWindow({ ...normalized, deadline: normalized.deadline + 1n })).toThrow(/900 seconds/);
    expect(backendAuthorizationTimes(1788534060n)).toEqual({ validAfter: 1788534000n, deadline: 1788534900n });
    expect(() => normalizeMintAuthorization({ ...authorization, validAfter: -1n })).toThrow(/outside/);
    expect(() => normalizeMintAuthorization({ ...authorization, deadline: 1n << 64n })).toThrow(/outside/);
    expect(() => normalizeMintAuthorization({ ...authorization, authorizerEpoch: 0 })).toThrow(/nonzero/);
  });

  it("permits token ID zero but rejects zero replay and binding IDs", () => {
    expect(() => normalizeMintAuthorization({ ...authorization, signatureDigest: `0x${"0".repeat(64)}` })).not.toThrow();
    expect(() => normalizeMintAuthorization({ ...authorization, walletBindingId: `0x${"0".repeat(64)}` })).toThrow(/nonzero/);
    expect(() => normalizeMintAuthorization({ ...authorization, authorizationId: `0x${"0".repeat(64)}` })).toThrow(/nonzero/);
    expect(() => normalizeMintAuthorization({ ...authorization, mintWallet: "0x0000000000000000000000000000000000000000" })).toThrow(/nonzero/);
  });

  it("hashes the exact UTF-8 token URI", () => {
    const uri = golden.tokenURI;
    expect(tokenUriHash(uri)).toBe(authorization.tokenURIHash);
    expect(tokenUriHash(uri.replace("puld", "pvld"))).not.toBe(authorization.tokenURIHash);
    expect(() => tokenUriHash(`${uri}/`)).toThrow(/lowercase Base32 CIDv1/);
  });

  it("generates random nonzero bytes32 values and rejects a broken entropy source", () => {
    let calls = 0;
    expect(randomNonzeroBytes32(() => {
      calls += 1;
      return calls === 1 ? new Uint8Array(32) : Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    })).toBe("0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
    expect(calls).toBe(2);
    expect(() => randomNonzeroBytes32(() => new Uint8Array(31))).toThrow(/exactly 32/);
  });
});

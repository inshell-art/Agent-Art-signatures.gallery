import { describe, expect, it } from "vitest";
import { encodePacked, hashTypedData, keccak256, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  OPEN_MINT_ABI,
  OPEN_MINT_TYPES,
  OPEN_MINT_TYPEHASH,
  normalizeOpenMintAuthorization,
  openMintDigest,
  openMintDomain,
  openMintDomainSeparator,
  openMintHandleKey,
  openMintStructHash,
  openMintTokenURIHash,
  openMintTypedData,
  signOpenMintAuthorization,
  verifyOpenMintAuthorization,
  type OpenMintAuthorizationInput,
} from "./authorization.js";

// Shared literal vector with contracts/test/OpenSignatures.t.sol.
const domain = { chainId: 31337n, verifyingContract: "0x1111111111111111111111111111111111111111" };
const tokenURI = "ipfs://open-mint-vector/metadata.json";
const bytes32 = (byte: string): Hex => `0x${byte.repeat(32)}`;
const authorization: OpenMintAuthorizationInput = {
  handleKey: "0x868ed0b8beee76cb794e5642c5cd60cb76853f3261693b545dd9d0b9aa50a91a",
  assessmentDigest: bytes32("22"), artifactDigest: bytes32("33"),
  recipient: "0x2222222222222222222222222222222222222222",
  tokenURIHash: "0xcbf99d2dad083e24eb59437b752eda77fda8ecbc663f77e3bba0e8e8b6df330b",
  nonce: bytes32("44"), issuedAt: 1800000000n, deadline: 1800000900n,
};
const account = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const vector = {
  typeHash: "0xdf5eec9a2dd3968e15e1ae75f106d12759ce0ad98cb3267ed82e5278ec92744c",
  structHash: "0x5489ab50c98c6929ff61839ed2ef625eabd73f3bb7db7c159339f47ee8224528",
  domainSeparator: "0x6a47ef8e2658e9d9b079e752cdef595b53bbb025c60ab15353e375dffc07d614",
  digest: "0xb769ac25cc7374bc4aa474bd64acb1a1aed5e6324215012928f0a05c02c72a31",
  signature: "0x194368c98343eaf582ae494b38d5b6780c27398241b4902b8902485689c11ddc25ed91130926c61bef760d6685c4b3e5baef5a8c738742d8a02dce8fd4fd75851b",
};

describe("open mint authorization", () => {
  it("locks the exact Solidity/TypeScript canonical handle and signing vector", async () => {
    expect(openMintHandleKey("bigu")).toBe(authorization.handleKey);
    expect(openMintTokenURIHash(tokenURI)).toBe(authorization.tokenURIHash);
    expect(OPEN_MINT_TYPEHASH).toBe(vector.typeHash);
    expect(openMintStructHash(authorization)).toBe(vector.structHash);
    expect(openMintDomainSeparator(domain)).toBe(vector.domainSeparator);
    expect(openMintDigest(domain, authorization)).toBe(vector.digest);
    expect(hashTypedData(openMintTypedData(domain, authorization))).toBe(vector.digest);
    expect(await signOpenMintAuthorization(domain, authorization, account)).toBe(vector.signature);
    expect(await verifyOpenMintAuthorization(domain, authorization, vector.signature, account.address)).toBe(true);
  });

  it("uses abi.encode for the handle key", () => {
    expect(keccak256(encodePacked(["string", "string"], ["signatures.gallery/open-handle/v1", "bigu"])))
      .not.toBe(authorization.handleKey);
  });

  it.each(["", "Bigu", "@bigu", " bigu", "bigu ", "bigu\n", "abc.def", "abc-def", "a/b", "é", "ｂigu", "a".repeat(16)])(
    "rejects noncanonical handle %j before hashing", (handle) => {
      expect(() => openMintHandleKey(handle)).toThrow(/Handle/);
    },
  );

  it.each(["a", "_", "0", "a_b0", "a".repeat(15)])("accepts canonical handle %j", (handle) => {
    expect(openMintHandleKey(handle)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps MBTI outside the handle identity and authorization fields", () => {
    const before = { handle: "bigu", mbti: "INTJ" };
    const after = { handle: "bigu", mbti: "ENFP" };
    expect(openMintHandleKey(before.handle)).toBe(openMintHandleKey(after.handle));
    expect(OPEN_MINT_TYPES.OpenMintAuthorization.some((field) => String(field.name) === "mbti")).toBe(false);
    expect(normalizeOpenMintAuthorization({ ...authorization, mbti: "INTJ" } as OpenMintAuthorizationInput)).toEqual(normalizeOpenMintAuthorization(authorization));
  });

  it("invalidates the signature for every changed signed field", async () => {
    const mutations: OpenMintAuthorizationInput[] = [
      { ...authorization, handleKey: openMintHandleKey("other") },
      { ...authorization, assessmentDigest: bytes32("55") },
      { ...authorization, artifactDigest: bytes32("55") },
      { ...authorization, recipient: "0x3333333333333333333333333333333333333333" },
      { ...authorization, tokenURIHash: openMintTokenURIHash(`${tokenURI}?other`) },
      { ...authorization, nonce: bytes32("55") },
      { ...authorization, issuedAt: 1800000001n },
      { ...authorization, deadline: 1800000899n },
    ];
    for (const mutation of mutations) {
      expect(await verifyOpenMintAuthorization(domain, mutation, vector.signature, account.address)).toBe(false);
    }
  });

  it("rejects another chain, contract, EIP712 name/version, or signer", async () => {
    expect(await verifyOpenMintAuthorization({ ...domain, chainId: 1n }, authorization, vector.signature, account.address)).toBe(false);
    expect(await verifyOpenMintAuthorization({ ...domain, verifyingContract: authorization.recipient }, authorization, vector.signature, account.address)).toBe(false);
    expect(await verifyOpenMintAuthorization(domain, authorization, vector.signature, authorization.recipient)).toBe(false);
    for (const changed of [{ name: "signatures.gallery" }, { version: "2" }]) {
      const data = openMintTypedData(domain, authorization);
      const signature = await account.signTypedData({ ...data, domain: { ...data.domain, ...changed } });
      expect(await verifyOpenMintAuthorization(domain, authorization, signature, account.address)).toBe(false);
    }
  });

  it("rejects malformed and malleable signatures as Solidity does", async () => {
    for (const signature of ["0x", "garbage", vector.signature.slice(0, -2), `${vector.signature.slice(0, -2)}00`, `${vector.signature}00`]) {
      expect(await verifyOpenMintAuthorization(domain, authorization, signature, account.address)).toBe(false);
    }
    const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = (order - BigInt(`0x${vector.signature.slice(66, 130)}`)).toString(16).padStart(64, "0");
    expect(await verifyOpenMintAuthorization(domain, authorization, `${vector.signature.slice(0, 66)}${highS}1c`, account.address)).toBe(false);
  });

  it.each(["handleKey", "assessmentDigest", "artifactDigest", "tokenURIHash", "nonce"] as const)("rejects zero or malformed %s", (field) => {
    for (const value of [bytes32("00"), "0x01", `0x${"AB".repeat(32)}`]) {
      expect(() => normalizeOpenMintAuthorization({ ...authorization, [field]: value })).toThrow(/32 lowercase/);
    }
  });

  it("enforces nonzero addresses and Solidity integer bounds", () => {
    const zero = "0x0000000000000000000000000000000000000000";
    expect(() => normalizeOpenMintAuthorization({ ...authorization, recipient: zero })).toThrow(/nonzero/);
    expect(() => openMintDomain({ ...domain, verifyingContract: zero })).toThrow(/nonzero/);
    for (const chainId of [0n, -1n, 1n << 256n, 1.5, "01"]) expect(() => openMintDomain({ ...domain, chainId })).toThrow();
    for (const issuedAt of [0n, -1n, 1n << 64n, Number.MAX_SAFE_INTEGER + 1, "01"]) {
      expect(() => normalizeOpenMintAuthorization({ ...authorization, issuedAt })).toThrow();
    }
    expect(() => normalizeOpenMintAuthorization({ ...authorization, deadline: 1n << 64n })).toThrow(/uint64/);
  });

  it("accepts exactly 900 seconds and rejects invalid windows", () => {
    expect(normalizeOpenMintAuthorization(authorization).deadline).toBe(1800000900n);
    for (const deadline of [1800000000n, 1799999999n, 1800000901n]) {
      expect(() => normalizeOpenMintAuthorization({ ...authorization, deadline })).toThrow(/900 seconds/);
    }
  });

  it("commits to exact URI bytes, and ABI mint is nonpayable", () => {
    expect(openMintTokenURIHash(tokenURI)).toBe(keccak256(stringToHex(tokenURI)));
    expect(openMintTokenURIHash(`${tokenURI}/`)).not.toBe(authorization.tokenURIHash);
    expect(() => openMintTokenURIHash("")).toThrow(/nonempty/);
    const mint = OPEN_MINT_ABI.find((item) => item.type === "function" && item.name === "mint");
    expect(mint).toMatchObject({ stateMutability: "nonpayable" });
    expect(OPEN_MINT_ABI.some((item) => item.type === "function" && ["burn", "adminMint", "setTokenURI", "upgradeTo"].includes(item.name))).toBe(false);
  });
});

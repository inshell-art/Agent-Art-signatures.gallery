import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deterministicUnixfsCid, IPFS_IMPORTER_PROFILE, parseCanonicalCidV1 } from "./ipfsCid.js";
import {
  buildTokenMetadata,
  canonicalMetadataBytes,
  formatGr0k,
  prepareTokenMetadata,
  sha256Hex,
  verifyImmutableV1Artifacts,
  type TokenMetadataInput,
  type SignatureTokenMetadata,
} from "./metadata.js";

const golden = JSON.parse(readFileSync(new URL("./fixtures/metadata-golden.json", import.meta.url), "utf8")) as {
  source: {
    svgUtf8: string;
    pngBase64: string;
    svgSha256: string;
    pngSha256: string;
    svgCid: string;
    pngCid: string;
  };
  input: TokenMetadataInput;
  metadata: SignatureTokenMetadata;
  canonicalJson: string;
  metadataSha256: string;
  metadataCid: string;
  tokenURI: string;
  tokenURIHash: `0x${string}`;
};
const svgBytes = Buffer.from(golden.source.svgUtf8, "utf8");
const pngBytes = Buffer.from(golden.source.pngBase64, "base64");
const { svgSha256, pngSha256, svgCid, pngCid } = golden.source;
const metadataCid = golden.metadataCid;
const metadataSha256 = golden.metadataSha256;
const tokenUriHash = golden.tokenURIHash;
const exactCanonicalJson = golden.canonicalJson;
const metadataInput = golden.input;

describe("frozen UnixFS profile", () => {
  it("locks the exact profile and golden source-object CIDs", async () => {
    expect(IPFS_IMPORTER_PROFILE).toEqual({
      name: "sg-ipfs-unixfs-1.0.0",
      cidVersion: 1,
      multihash: "sha2-256",
      rawLeaves: true,
      chunkSize: 262144,
      wrapWithDirectory: false,
      mode: undefined,
      mtime: undefined,
    });
    expect(await deterministicUnixfsCid(svgBytes)).toBe(svgCid);
    expect(await deterministicUnixfsCid(pngBytes)).toBe(pngCid);
    expect(await deterministicUnixfsCid(svgBytes)).toBe(svgCid);
  });

  it("locks behavior across the 262144-byte chunk boundary", async () => {
    const bytes = Uint8Array.from({ length: 262145 }, (_, index) => index % 251);
    expect(await deterministicUnixfsCid(bytes)).toBe("bafybeiexg2oqkfnj56l7fcmawswqbijt5shq4b5rg6a546uwpkqqzwjioi");
  });

  it("rejects non-v1, uppercase, and noncanonical CID spellings", () => {
    expect(parseCanonicalCidV1(svgCid).version).toBe(1);
    expect(() => parseCanonicalCidV1(svgCid.toUpperCase())).toThrow(/lowercase/);
    expect(() => parseCanonicalCidV1("QmYwAPJzv5CZsnAzt8auVZRnGmTQfL7wJtP1xFmqw3cvdL")).toThrow(/lowercase Base32 CIDv1/);
  });
});

describe("immutable V2 metadata", () => {
  it("locks the complete object, RFC 8785 bytes, SHA-256, CID, URI, and URI Keccak hash", async () => {
    const prepared = await prepareTokenMetadata(metadataInput);
    expect(prepared.metadata.name).toBe("@alice — Signature — gr0k 0.371924");
    expect(prepared.metadata).toEqual(golden.metadata);
    expect(prepared.metadata.attributes.map(({ trait_type }) => trait_type)).toEqual([
      "Handle at Claim",
      "gr0k",
      "Renderer",
      "Claim Method",
    ]);
    expect(prepared.metadata.properties.claimed_at).toBe("2026-08-26T16:12:00.123Z");
    expect(prepared.canonicalJson).toBe(exactCanonicalJson);
    expect(Buffer.from(prepared.bytes).toString("utf8")).toBe(exactCanonicalJson);
    expect(prepared.sha256).toBe(metadataSha256);
    expect(prepared.cid).toBe(metadataCid);
    expect(prepared.tokenUri).toBe(`ipfs://${metadataCid}`);
    expect(prepared.tokenUriHash).toBe(tokenUriHash);
  });

  it("contains no raw X ID or mutable owner and keeps integer gr0k fields", () => {
    const metadata = buildTokenMetadata(metadataInput);
    const json = Buffer.from(canonicalMetadataBytes(metadata)).toString("utf8");
    expect(json).not.toContain("1234567890123456789");
    expect(json).not.toMatch(/owner|current_handle|wallet/i);
    expect(metadata.properties.gr0k_raw).toBe(371924);
    expect(Number.isInteger(metadata.properties.gr0k_raw)).toBe(true);
    expect(metadata.attributes[1].value).toBe("0.371924");
    expect(formatGr0k(1_000_000)).toBe("1.000000");
    expect(formatGr0k(1)).toBe("0.000001");
  });

  it("changes both SHA-256 and CID after a one-byte metadata change", async () => {
    const original = await prepareTokenMetadata(metadataInput);
    const changed = await prepareTokenMetadata({ ...metadataInput, handleAtClaim: "alica" });
    expect(changed.sha256).not.toBe(original.sha256);
    expect(changed.cid).not.toBe(original.cid);
  });

  it("verifies exact V1 bytes and rejects missing integrity or external SVG resources", () => {
    expect(() => verifyImmutableV1Artifacts({ svgBytes, pngBytes, svgSha256, pngSha256 })).not.toThrow();
    expect(() => verifyImmutableV1Artifacts({ svgBytes: Buffer.from(`${svgBytes.toString()} `), pngBytes, svgSha256, pngSha256 })).toThrow(/SVG bytes/);
    expect(() => verifyImmutableV1Artifacts({ svgBytes, pngBytes: Buffer.from([0]), svgSha256, pngSha256 })).toThrow(/PNG bytes/);

    const externalSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>');
    expect(() => verifyImmutableV1Artifacts({
      svgBytes: externalSvg,
      pngBytes,
      svgSha256: sha256Hex(externalSvg),
      pngSha256,
    })).toThrow(/external resource/);
  });

  it("fails closed on non-frozen schema inputs", () => {
    expect(() => buildTokenMetadata({ ...metadataInput, svgSha256: svgSha256.toUpperCase() })).toThrow(/lowercase/);
    expect(() => buildTokenMetadata({ ...metadataInput, publicArtifactOrigin: "https://signatures.gallery/" })).toThrow(/trailing slash/);
    expect(() => buildTokenMetadata({ ...metadataInput, gr0kRaw: 371924.1 })).toThrow(/integer raw value/);
    expect(() => buildTokenMetadata({ ...metadataInput, publicAccountId: "1234567890123456789" })).toThrow(/opaque V1/);
  });
});

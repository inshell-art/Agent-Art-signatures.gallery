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
    expect(prepared.metadata.name).toBe("@Alice — Signature — gr0k 22");
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
    expect(metadata.properties.gr0k_raw).toBe(22);
    expect(Number.isInteger(metadata.properties.gr0k_raw)).toBe(true);
    expect(metadata.properties.gr0k_scale).toBe(1);
    expect(metadata.attributes[1].value).toBe("22");
    expect(formatGr0k(100)).toBe("100");
    expect(formatGr0k(1)).toBe("1");
  });

  it("changes both SHA-256 and CID after a one-byte metadata change", async () => {
    const original = await prepareTokenMetadata(metadataInput);
    const changed = await prepareTokenMetadata({ ...metadataInput, handleAtClaim: "alica" });
    expect(changed.sha256).not.toBe(original.sha256);
    expect(changed.cid).not.toBe(original.cid);
  });

  it("preserves case in the frozen handle, artwork name, and metadata bytes", async () => {
    const original = await prepareTokenMetadata(metadataInput);
    const lowercase = await prepareTokenMetadata({ ...metadataInput, handleAtClaim: "alice" });
    expect(original.metadata.properties.handle_at_claim).toBe("Alice");
    expect(original.metadata.attributes[0].value).toBe("@Alice");
    expect(original.sha256).not.toBe(lowercase.sha256);
    expect(original.cid).not.toBe(lowercase.cid);
  });

  it.each([0, 101, 371924])("rejects obsolete/out-of-range integer seed %s", (gr0kRaw) => {
    expect(() => buildTokenMetadata({ ...metadataInput, gr0kRaw })).toThrow(/integer raw value/);
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
    expect(() => buildTokenMetadata({ ...metadataInput, handleAtClaim: "Alice\n" })).toThrow(/case-sensitive/);
  });
});

describe("metadata input boundaries", () => {
  const build = (overrides: Partial<TokenMetadataInput>) => () => buildTokenMetadata({ ...metadataInput, ...overrides });

  it("requires the artifact origin to be an exact HTTPS origin", () => {
    expect(build({ publicArtifactOrigin: "signatures.gallery" })).toThrow(/absolute HTTPS origin/);
    expect(build({ publicArtifactOrigin: "http://signatures.gallery" })).toThrow(/exact HTTPS origin/);
    expect(build({ publicArtifactOrigin: "https://signatures.gallery/artifacts" })).toThrow(/exact HTTPS origin/);
    expect(build({ publicArtifactOrigin: "https://signatures.gallery?v=1" })).toThrow(/exact HTTPS origin/);
    expect(build({ publicArtifactOrigin: "https://signatures.gallery#a" })).toThrow(/exact HTTPS origin/);
  });

  it("refuses a renderer version that is not the frozen V2 pair", () => {
    // The literal types stop this in review; the runtime guard stops it when the
    // value arrives from a database row or a request instead.
    const untyped = (overrides: Record<string, unknown>) => () =>
      buildTokenMetadata({ ...metadataInput, ...overrides } as unknown as TokenMetadataInput);
    expect(untyped({ rendererVersion: "sg-renderer-0.9.0" })).toThrow(/frozen V2 renderer version/);
    expect(untyped({ cardRendererVersion: "sg-card-0.9.0" })).toThrow(/frozen V2 renderer version/);
  });

  it("accepts RFC 3339 claim instants and truncates them to whole milliseconds", () => {
    const at = (claimedAt: TokenMetadataInput["claimedAt"]) =>
      buildTokenMetadata({ ...metadataInput, claimedAt }).properties.claimed_at;
    const baseline = at(metadataInput.claimedAt);
    expect(at("2026-09-04T12:34:56.789123Z")).toBe("2026-09-04T12:34:56.789Z");
    expect(at("2026-09-04T12:34:56Z")).toBe("2026-09-04T12:34:56.000Z");
    expect(at("2026-09-04T12:34:56.7Z")).toBe("2026-09-04T12:34:56.700Z");
    expect(at("2026-09-04T20:34:56.789+08:00")).toBe("2026-09-04T12:34:56.789Z");
    expect(at(new Date("2026-09-04T12:34:56.789Z"))).toBe("2026-09-04T12:34:56.789Z");
    expect(baseline).toBeTruthy();
  });

  it("refuses a claim instant that is not a valid RFC 3339 value", () => {
    expect(build({ claimedAt: new Date("not a date") })).toThrow(/valid instant/);
    for (const claimedAt of ["2026-09-04", "2026-09-04 12:34:56Z", "2026-09-04T12:34:56", "yesterday", ""]) {
      expect(build({ claimedAt })).toThrow(/RFC 3339 instant/);
    }
    expect(build({ claimedAt: "2026-13-04T12:34:56.789Z" })).toThrow(/valid instant/);
  });

  it("keeps gr0k an unscaled integer seed from 1 to 100", () => {
    expect(formatGr0k(1)).toBe("1");
    expect(formatGr0k(100)).toBe("100");
    for (const raw of [0, 101, -1, 1.5, Number.NaN]) {
      expect(() => formatGr0k(raw)).toThrow(/integer raw value from 1 to 100/);
    }
    expect(() => formatGr0k(22, 100)).toThrow(/at scale 1/);
  });
});

describe("self-contained SVG boundary", () => {
  const verify = (svg: string) => () => {
    const bytes = Buffer.from(svg, "utf8");
    verifyImmutableV1Artifacts({ svgBytes: bytes, pngBytes, svgSha256: sha256Hex(bytes), pngSha256 });
  };
  const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

  it("accepts artwork that resolves nothing outside its own bytes", () => {
    expect(verify(wrap('<path d="M0 0 L1 1"/>'))).not.toThrow();
    expect(verify(wrap('<use href="#glyph"/>'))).not.toThrow();
    expect(verify(wrap('<image href="data:image/png;base64,AAAA"/>'))).not.toThrow();
    expect(verify(wrap('<rect fill="url(#grad)"/>'))).not.toThrow();
    expect(verify(wrap('<a href="">empty</a>'))).not.toThrow();
  });

  it("rejects bytes that are not valid UTF-8 or carry no SVG root", () => {
    const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
    expect(() => verifyImmutableV1Artifacts({ svgBytes: invalid, pngBytes, svgSha256: sha256Hex(invalid), pngSha256 }))
      .toThrow(/not valid UTF-8/);
    expect(verify("<html><body>not artwork</body></html>")).toThrow(/no SVG root element/);
  });

  it("rejects active or externally resolvable constructs", () => {
    expect(verify(`<!DOCTYPE svg>${wrap("")}`)).toThrow(/active or externally resolvable/);
    expect(verify(`<!ENTITY x "y">${wrap("")}`)).toThrow(/active or externally resolvable/);
    expect(verify(`<?xml-stylesheet href="a.css"?>${wrap("")}`)).toThrow(/active or externally resolvable/);
    expect(verify(wrap("<script>alert(1)</script>"))).toThrow(/active or externally resolvable/);
    expect(verify(wrap("<style>@import url(a.css);</style>"))).toThrow(/external CSS import/);
  });

  it("rejects unquoted and external resource references", () => {
    expect(verify(wrap("<image href=a.png/>"))).toThrow(/malformed or unquoted resource reference/);
    expect(verify(wrap('<image xlink:href="https://example.com/a.png"/>'))).toThrow(/external resource reference/);
    expect(verify(wrap('<image src="/a.png"/>'))).toThrow(/external resource reference/);
    expect(verify(wrap('<image href="../a.png"/>'))).toThrow(/external resource reference/);
  });

  it("rejects external CSS url() targets while allowing fragment and data targets", () => {
    expect(verify(wrap('<rect fill="url(https://example.com/a.png)"/>'))).toThrow(/external CSS resource reference/);
    expect(verify(wrap("<style>rect { fill: url('a.png') }</style>"))).toThrow(/external CSS resource reference/);
    expect(verify(wrap('<rect fill="url(data:image/png;base64,AAAA)"/>'))).not.toThrow();
  });
});

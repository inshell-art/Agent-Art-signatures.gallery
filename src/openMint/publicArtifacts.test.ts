import { beforeAll, describe, expect, it, vi } from "vitest";
import canonicalize from "canonicalize";
import { assessmentDigest } from "./assessment.js";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";
import { deterministicUnixfsCid } from "../v2/core/ipfsCid.js";
import { sha256Hex } from "../v1/renderer.js";
import { openMintTokenURIHash } from "./authorization.js";
import { preparePublicArtifact, publicArtifactDigest, publicArtworkOrigin, PUBLIC_ARTIFACT_DOMAIN,
  PUBLIC_METADATA_VERSION, verifyPreparedPublicArtifact, verifyPublicObject, type PreparedPublicArtifact } from "./publicArtifacts.js";

// Serializer goldens must not depend on OS font rasterization/libvips. The SVG is
// real; freeze a tiny PNG byte fixture here. artifactRendering.test.ts and the
// publication suite exercise the actual SVG -> PNG pipeline separately.
vi.mock("../v1/renderer.js", async importOriginal => ({
  ...await importOriginal<typeof import("../v1/renderer.js")>(),
  renderCardPng: async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a53sAAAAASUVORK5CYII=", "base64"),
}));

describe("new public artifact profile (offline only)", () => {
  let artifact: PreparedPublicArtifact;
  beforeAll(async () => { artifact = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://gallery.example" }); });
  it("builds canonical, case-sensitive metadata with no private assessment fields", async () => {
    const json = Buffer.from(artifact.metadata.bytes).toString("utf8"), metadata = JSON.parse(json);
    expect(json).toBe(canonicalize(metadata));
    expect(metadata.name).toBe("@Alice_Bob_Key × INTJ");
    expect(metadata.external_url).toBe("https://gallery.example/signatures/alice_bob_key");
    expect(metadata.image).toBe(artifact.png.object.uri);
    expect(metadata.animation_url).toBe(artifact.svg.object.uri);
    expect(metadata.properties.metadata_version).toBe(PUBLIC_METADATA_VERSION);
    expect(metadata.properties.assessment.source_urls).toEqual(["https://x.com/Alice_Bob_Key/status/123"]);
    expect(metadata.properties.assessment.digest).toBe(artifact.assessment.digest);
    for (const privateValue of ["private-response-id", artifact.assessment.id, "providerResponseId", "private-reference", "tracking", "secret", "artifact_digest", "tokenURIHash"]) expect(json).not.toContain(privateValue);
    expect(Buffer.from(artifact.svg.bytes).toString()).toContain(">@Alice_Bob_Key</text>");
    expect(artifact.commitment.tokenURIHash).toBe(openMintTokenURIHash(artifact.metadata.object.uri));
    expect(artifact.commitment.domain).toBe(PUBLIC_ARTIFACT_DOMAIN);
    expect(artifact.digest).toBe(publicArtifactDigest(artifact.commitment));
    await expect(verifyPreparedPublicArtifact(artifact)).resolves.toBeUndefined();
  });
  it("is deterministic and changes binding, not assessment or old data, when origin changes", async () => {
    const again = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://gallery.example" });
    expect(again).toEqual(artifact);
    const changed = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://other.example" });
    expect(changed.assessment.digest).toBe(artifact.assessment.digest);
    expect(changed.svg).toEqual(artifact.svg); expect(changed.png).toEqual(artifact.png);
    expect(changed.digest).not.toBe(artifact.digest); expect(changed.metadata.object.cid).not.toBe(artifact.metadata.object.cid);
  });
  it.each([null, "http://gallery.example", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://foo.internal", "https://host.local", "https://gallery.example/", "https://gallery.example:8443", "https://user:pass@gallery.example", "https://gallery.example/path", "not a url"])("rejects invalid/public-unsafe origin %s", origin => {
    expect(() => publicArtworkOrigin(origin)).toThrow();
  });
  it("refuses fixture or unverified assessments without importing old local artifacts", async () => {
    const { digest: _, ...unsigned } = syntheticPublicAssessment();
    const fixture = { ...unsigned, provenance: "development-fixture" as const, model: "development-fixture-v1", providerResponseId: "development-fixture:test", xIdentity: { ...unsigned.xIdentity!, provenance: "development-fixture" as const } };
    await expect(preparePublicArtifact({ assessment: { ...fixture, digest: assessmentDigest(fixture) }, origin: "https://gallery.example" })).rejects.toThrow("X-verified Grok");
    const { xIdentity: _identity, ...unverified } = unsigned;
    await expect(preparePublicArtifact({ assessment: { ...unverified, digest: assessmentDigest(unverified) }, origin: "https://gallery.example" })).rejects.toThrow("X-verified Grok");
  });
  it.each(["svg", "png", "metadata"] as const)("detects tampered %s bytes and descriptors", async key => {
    const changed = structuredClone(artifact); changed[key].bytes[0] ^= 1;
    await expect(verifyPreparedPublicArtifact(changed)).rejects.toThrow();
    const wrongType = structuredClone(artifact);
    Object.assign(wrongType[key].object, { mediaType: "text/html" });
    await expect(verifyPreparedPublicArtifact(wrongType)).rejects.toThrow();
  });
  it("detects a valid but wrong CID and mismatched public binding", async () => {
    const changed = structuredClone(artifact), cid = await deterministicUnixfsCid(Buffer.from("different"));
    Object.assign(changed.svg.object, { cid, uri: `ipfs://${cid}` });
    await expect(verifyPublicObject(changed.svg, "image/svg+xml")).rejects.toThrow("CID");
    const swapped = structuredClone(artifact); Object.assign(swapped, { origin: "https://other.example" });
    await expect(verifyPreparedPublicArtifact(swapped)).rejects.toThrow("binding");
  });
  it("rejects a self-consistent forged SVG even when all hashes, CIDs, metadata and the artifact digest are rebuilt", async () => {
    const changed = structuredClone(artifact);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Unrelated artwork</text></svg>');
    const svgCid = await deterministicUnixfsCid(svg);
    Object.assign(changed.svg, { bytes: svg });
    Object.assign(changed.svg.object, { byteLength: svg.length, sha256: sha256Hex(svg), cid: svgCid, uri: `ipfs://${svgCid}` });
    const metadata = JSON.parse(Buffer.from(changed.metadata.bytes).toString("utf8"));
    metadata.animation_url = changed.svg.object.uri;
    metadata.properties.svg_uri = changed.svg.object.uri;
    metadata.properties.svg_sha256 = changed.svg.object.sha256;
    const metadataBytes = Buffer.from(canonicalize(metadata)!);
    const metadataCid = await deterministicUnixfsCid(metadataBytes);
    Object.assign(changed.metadata, { bytes: metadataBytes });
    Object.assign(changed.metadata.object, { byteLength: metadataBytes.length, sha256: sha256Hex(metadataBytes), cid: metadataCid, uri: `ipfs://${metadataCid}` });
    Object.assign(changed.commitment, { svgSha256: changed.svg.object.sha256, metadataSha256: changed.metadata.object.sha256,
      tokenURIHash: openMintTokenURIHash(changed.metadata.object.uri) });
    Object.assign(changed, { digest: publicArtifactDigest(changed.commitment) });
    for (const key of ["svg", "png", "metadata"] as const) await expect(verifyPublicObject(changed[key], changed[key].object.mediaType)).resolves.toBeUndefined();
    await expect(verifyPreparedPublicArtifact(changed)).rejects.toThrow("frozen assessment rendering");
  });
  it.each([
    { domain: "local-v1" }, { metadataVersion: "new" }, { rendererVersion: "sg-renderer-2.0.1" },
    { canonicalHandle: "Alice_Bob_Key" }, { renderHandle: "bob" }, { svgSha256: "0" },
    { assessmentDigest: "bad" }, { tokenURIHash: "bad" }, { extra: "not allowed" },
  ])("rejects malformed artifact commitment %j", patch => {
    expect(() => publicArtifactDigest({ ...artifact.commitment, ...patch } as never)).toThrow();
  });
  it("locks the independent public metadata/commitment golden", () => {
    expect({ metadataSha256: artifact.metadata.object.sha256, metadataCID: artifact.metadata.object.cid,
      svgSha256: artifact.svg.object.sha256, pngSha256: artifact.png.object.sha256, digest: artifact.digest }).toMatchInlineSnapshot(`
        {
          "digest": "0x8a256268be81a99f27e7985fcb92eb43f104e98bf401bc0581a24bff6bae9427",
          "metadataCID": "bafkreigdvcl7mxtxyl7yz6pycj3ahkpebg3ghhtj3g6tnjn6pbbscr277q",
          "metadataSha256": "c3a897f65e77c2ff8cf9f8127603a9e409b6639e69d9bd36a5be784321475ffc",
          "pngSha256": "7bf7b40c3477737575d1788eb8ec2c0149fdc23261c4467d4f9786246c3b6a30",
          "svgSha256": "a1b7b713d80b8f7040b67782b69ae7a0e779cebacc20f4abd48f5ce324f70ea8",
        }
      `);
  });
});

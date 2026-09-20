import { beforeAll, describe, expect, it, vi } from "vitest";
import { openMintHandleKey } from "./authorization.js";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";
import { RENDERER_VERSION } from "./identity.js";
import { preparePublicArtifact, type PreparedPublicArtifact } from "./publicArtifacts.js";
import { LOCAL_ROBOTS_TXT, PRIVATE_ROBOTS, openMintSharing, type ConfirmedSharingInput, type SharingProfile } from "./sharing.js";

vi.mock("../v1/renderer.js", async importOriginal => ({
  ...await importOriginal<typeof import("../v1/renderer.js")>(),
  renderCardPng: async () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a53sAAAAASUVORK5CYII=", "base64"),
}));
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const deployment = { id: "11111111-1111-4111-8111-111111111111", namespaceId: "22222222-2222-4222-8222-222222222222", chainId: "31337",
  contractAddress: `0x${"11".repeat(20)}`, manifestHash: hash("22"), deploymentBlock: "2", deploymentBlockHash: hash("33"),
  policy: { id: "explicit-policy", rollbackBlocks: 32, snapshotRetentionBlocks: 128 } };
const profile = (): Extract<SharingProfile, { environment: "public-approved" }> => ({ environment: "public-approved", origin: "https://gallery.example", deployment: structuredClone(deployment), indexConfirmedWorks: true });
const preview = { handle: "Alice_Bob_Key", mbti: "INTJ", rendererVersion: RENDERER_VERSION };
const previewPath = "/p/Alice_Bob_Key/INTJ", mintedPath = "/signatures/alice_bob_key";
let artifact: PreparedPublicArtifact;
beforeAll(async () => { artifact = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: profile().origin }); });
function minted(): ConfirmedSharingInput {
  return { deployment: structuredClone(deployment), artifact: structuredClone(artifact), projection: { state: "confirmed", item: {
    tokenId: BigInt(openMintHandleKey("alice_bob_key")).toString(), handle: "alice_bob_key", mbti: "INTJ", availability: "available",
    originalRecipient: `0x${"22".repeat(20)}`, currentOwner: `0x${"33".repeat(20)}`,
    assessmentDigest: artifact.assessment.digest, artifactDigest: artifact.digest, tokenURIHash: artifact.commitment.tokenURIHash,
  } } };
}
const denied = { robots: PRIVATE_ROBOTS, cacheControl: "no-store", head: `<meta name="robots" content="${PRIVATE_ROBOTS}">` };

describe("environment-aware sharing policy (unwired, offline)", () => {
  it.each(["local", "staging", "production", "public", undefined])("never emits canonical/card metadata for %s", async environment => {
    for (const path of [previewPath, mintedPath, "/", "/INTJ/"]) {
      expect(await openMintSharing({ profile: { ...profile(), environment } as SharingProfile, path, preview, minted: minted() })).toEqual(denied);
    }
  });
  it("requires an explicit, validated public origin and indexing choice", async () => {
    for (const origin of ["", "http://gallery.example", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://rpc.internal", "https://rpc.test", "https://rpc.onion", "https://rpc.invalid", "https://user:secret@gallery.example", "https://gallery.example/", "https://gallery.example/path", 'https://gallery.example/?token="<secret>']) {
      expect(await openMintSharing({ profile: { ...profile(), origin }, path: previewPath, preview })).toEqual(denied);
    }
    expect(await openMintSharing({ profile: { ...profile(), indexConfirmedWorks: undefined } as never, path: previewPath, preview })).toEqual(denied);
  });
  it.each(["/mint", "/mint?handle=alice", `/mint/${"A".repeat(43)}`, `/requests/${"A".repeat(43)}`, "/me", "/me?wallet=0x123", "/api/session", "/api/assessments/private", "/api/mints/status/private", "/pending", "/", "/INTJ/", "/about", "/s/Alice/INTJ", "/p/Alice_Bob_Key/variations", "/signatures/Alice_Bob_Key", `${mintedPath}?code=secret`, `${mintedPath}#secret`, `${previewPath}?token=secret`, `https://gallery.example${mintedPath}`, "//gallery.example/signatures/alice_bob_key", "/signatures/%61lice_bob_key", "/p/<script>/INTJ"])("fails closed without canonical/image data on private or unknown route %s", async path => {
    const request = { profile: profile(), path, preview, get minted(): ConfirmedSharingInput { throw new Error("Private path must not inspect artifacts."); } };
    expect(await openMintSharing(request)).toEqual(denied);
  });
  it("builds a free-preview card only from exact validated public inputs, without indexing it", async () => {
    const result = await openMintSharing({ profile: profile(), path: previewPath, preview, get minted(): never { throw new Error("Preview must not read a paid result."); } });
    expect(result).toMatchObject({ robots: "noindex, follow", cacheControl: "no-store", canonical: `https://gallery.example${previewPath}`,
      image: `https://gallery.example/sharing/previews/Alice_Bob_Key/INTJ/${RENDERER_VERSION}.png` });
    expect(result.head).toContain('property="og:title" content="@Alice_Bob_Key × INTJ — free preview"');
    expect(result.head).toContain('name="twitter:card" content="summary_large_image"');
    expect(result.head).toContain('property="og:image:type" content="image/png"');
    expect(result.head).toContain("This is not a Grok assessment or a minted artwork.");
    expect(result.head).not.toContain("private-response-id"); expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([{ handle: "alice_bob_key" }, { handle: 'Alice\" onload="bad' }, { mbti: "intj" }, { mbti: "XXXX" }, { rendererVersion: "legacy" }])("rejects nonmatching or invalid free-preview input %j", async change => {
    expect(await openMintSharing({ profile: profile(), path: previewPath, preview: { ...preview, ...change } })).toEqual(denied);
  });
  it("does not invent a preview model for a valid-looking path", async () => {
    expect(await openMintSharing({ profile: profile(), path: previewPath })).toEqual(denied);
  });
  it("uses the exact verified saved PNG and canonical lowercase handle for a confirmed work", async () => {
    const result = await openMintSharing({ profile: profile(), path: mintedPath, minted: minted() });
    expect(result).toMatchObject({ robots: "index, follow", cacheControl: "no-store", canonical: `https://gallery.example${mintedPath}`,
      image: `https://gallery.example/artifacts/${artifact.png.object.sha256}.png` });
    expect(result.head).toContain('property="og:title" content="@Alice_Bob_Key × INTJ — signatures.gallery"');
    expect(result.head).toContain('property="og:url" content="https://gallery.example/signatures/alice_bob_key"');
    expect(result.head).toContain('name="twitter:image"');
    for (const privateValue of [artifact.assessment.id, "private-response-id", "private-reference", "tracking", "secret", "providerResponseId", "wallet", "csrf", "nonce", "assessmentDigest"]) expect(result.head).not.toContain(privateValue);
    expect(result.head).not.toContain("/sharing/previews/");
  });
  it("can share a confirmed work while the explicit public indexing choice remains disabled", async () => {
    const result = await openMintSharing({ profile: { ...profile(), indexConfirmedWorks: false }, path: mintedPath, minted: minted() });
    expect(result.robots).toBe("noindex, follow"); expect(result.canonical).toBe(`https://gallery.example${mintedPath}`);
  });
  it.each(["confirming", "pending", "unknown", "safety-halted"] as const)("never shares a %s projection even with valid saved artwork", async state => {
    const record = minted(); Object.assign(record.projection, { state });
    expect(await openMintSharing({ profile: profile(), path: mintedPath, minted: record })).toEqual(denied);
  });
  it.each(["unavailable", "quarantined"] as const)("never shares an %s artifact", async availability => {
    const record = minted(); Object.assign(record.projection.item!, { availability });
    expect(await openMintSharing({ profile: profile(), path: mintedPath, minted: record })).toEqual(denied);
  });
  it.each(["tokenId", "handle", "mbti", "assessmentDigest", "artifactDigest", "tokenURIHash", "originalRecipient", "currentOwner"] as const)("rejects mismatched or missing projection field %s", async field => {
    const record = minted(); Object.assign(record.projection.item!, { [field]: field === "handle" ? "other" : field === "mbti" ? "ENFP" : "wrong" });
    expect(await openMintSharing({ profile: profile(), path: mintedPath, minted: record })).toEqual(denied);
    Object.assign(record.projection.item!, { [field]: undefined });
    expect(await openMintSharing({ profile: profile(), path: mintedPath, minted: record })).toEqual(denied);
  });
  it.each(["id", "namespaceId", "chainId", "contractAddress", "manifestHash", "deploymentBlockHash"] as const)("rejects cross-deployment projection %s", async field => {
    const record = minted(); Object.assign(record.deployment, { [field]: field === "chainId" ? "1" : field === "contractAddress" ? `0x${"44".repeat(20)}` : field.endsWith("Hash") ? hash("44") : "44444444-4444-4444-8444-444444444444" });
    expect(await openMintSharing({ profile: profile(), path: mintedPath, minted: record })).toEqual(denied);
  });
  it.each(["svg", "png", "metadata"] as const)("rejects corrupted saved %s without falling back to a regenerated preview", async key => {
    const record = minted(); record.artifact[key].bytes[0] ^= 1;
    expect(await openMintSharing({ profile: profile(), path: mintedPath, minted: record, preview })).toEqual(denied);
  });
  it("rejects another artifact origin and missing confirmed projection", async () => {
    const record = minted(); Object.assign(record.artifact, { origin: "https://other.example" });
    expect(await openMintSharing({ profile: profile(), path: mintedPath, minted: record })).toEqual(denied);
    expect(await openMintSharing({ profile: profile(), path: mintedPath })).toEqual(denied);
  });
  it("snapshots projection, artifact bytes and profile before asynchronous verification", async () => {
    const record = minted(), config = profile(), result = openMintSharing({ profile: config, path: mintedPath, minted: record });
    Object.assign(record.projection, { state: "pending" }); record.artifact.png.bytes[0] ^= 1; Object.assign(config, { origin: "https://other.example" });
    expect((await result).image).toBe(`https://gallery.example/artifacts/${artifact.png.object.sha256}.png`);
  });
  it("contains no sitemap or indexing allow rule in the active local robots policy", () => {
    expect(LOCAL_ROBOTS_TXT).toBe("User-agent: *\nDisallow: /\n"); expect(LOCAL_ROBOTS_TXT).not.toMatch(/Sitemap|Allow:/);
  });
});

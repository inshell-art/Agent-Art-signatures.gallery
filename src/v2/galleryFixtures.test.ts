import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState } from "../v1/authState.js";
import type { ClaimRuntime } from "../v1/claim.js";
import { fixtureIdentity, seedDevelopmentFixtures } from "../v1/fixtures.js";
import { DEV_CARD_RENDERER_VERSION, developmentFixtureRenderer, RendererRegistry, sha256Hex } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { loadMintConfig } from "./config.js";
import { seedV2DevelopmentFixtures } from "./fixtures.js";
import { GALLERY_DEVELOPMENT_FIXTURES, seedGalleryDevelopmentFixtures } from "./galleryFixtures.js";
import { MemoryMintStore } from "./memoryStore.js";
import { V2MintService } from "./service.js";

function runtime(options: { fixtureMode?: boolean; enabled?: boolean } = {}) {
  const signatures = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const claimRuntime: ClaimRuntime = {
    store: signatures,
    artifacts,
    renderers: new RendererRegistry([developmentFixtureRenderer]),
    cardRendererVersion: DEV_CARD_RENDERER_VERSION,
  };
  const state = new MemoryMintStore();
  const config = { ...loadMintConfig({}, true, "http://localhost:3000"), ...options };
  const adapters = !config.fixtureMode && config.enabled ? {
    eoaVerifier: { async verify(): Promise<never> { throw new Error("Fixture seeding must not verify a production wallet."); } },
    signer: {
      address: config.authorizer,
      async sign(): Promise<never> { throw new Error("Fixture seeding must not request a production signature."); },
    },
  } : {};
  const service = new V2MintService(config, state, signatures, artifacts, adapters);
  return { signatures, artifacts, auth, claimRuntime, state, service };
}

async function seededRuntime() {
  const app = runtime();
  await seedDevelopmentFixtures(app.claimRuntime, app.auth);
  await seedV2DevelopmentFixtures(app.service, app.signatures);
  return app;
}

describe("rich development gallery fixtures", () => {
  it("covers eleven source-linked public handles with fictional gr0k values without replacing Alice", () => {
    expect(GALLERY_DEVELOPMENT_FIXTURES).toHaveLength(11);
    expect(new Set(GALLERY_DEVELOPMENT_FIXTURES.map(({ handle }) => handle)).size).toBe(11);
    expect(new Set(GALLERY_DEVELOPMENT_FIXTURES.map(({ gr0kRaw }) => gr0kRaw)).size).toBe(11);
    expect(GALLERY_DEVELOPMENT_FIXTURES.map(({ handle }) => handle)).not.toContain("alice");
    expect(GALLERY_DEVELOPMENT_FIXTURES.map(({ gr0kRaw }) => gr0kRaw)).toEqual(expect.arrayContaining([0, 1_000_000]));
    for (const fixture of GALLERY_DEVELOPMENT_FIXTURES) {
      expect(fixture.handle).toMatch(/^[a-z0-9_]{1,15}$/);
      expect(new URL(fixture.sourceUrl).protocol).toBe("https:");
      expect(Number.isSafeInteger(fixture.gr0kRaw)).toBe(true);
      expect(fixture.gr0kRaw).toBeGreaterThanOrEqual(0);
      expect(fixture.gr0kRaw).toBeLessThanOrEqual(1_000_000);
    }
  });

  it("uses the same stored claims in both tabs, with Minted a finalized subset of Claimed", async () => {
    const app = await seededRuntime();
    await seedGalleryDevelopmentFixtures(app.claimRuntime, app.auth, app.service);
    const claimed = await app.signatures.listClaimedSignatures(100);
    const minted = app.state.listGallery();
    expect(claimed).toHaveLength(14);
    expect(minted).toHaveLength(12);
    const claimedIds = new Set(claimed.map(({ signatureId }) => signatureId));
    for (const entry of minted) expect(claimedIds.has(entry.signatureId)).toBe(true);
    for (const fixture of GALLERY_DEVELOPMENT_FIXTURES) {
      const matches = claimed.filter(({ handleNormalized }) => handleNormalized === fixture.handle);
      expect(matches).toHaveLength(1);
      expect(matches[0].xUserId).toBe(fixtureIdentity(fixture.handle).xUserId);
      expect(minted.filter(({ signatureId }) => signatureId === matches[0].signatureId)).toHaveLength(1);
    }
  });

  it("populates twelve finalized cards backed by distinct, decodable artifacts and matching frozen metadata", async () => {
    const app = await seededRuntime();
    await seedGalleryDevelopmentFixtures(app.claimRuntime, app.auth, app.service);
    const gallery = app.state.listGallery();
    expect(gallery).toHaveLength(12);
    const svgHashes = new Set<string>();
    const pngHashes = new Set<string>();
    const metadataHashes = new Set<string>();
    const handles = new Set<string>();

    for (const entry of gallery) {
      const signature = await app.signatures.getSignature(entry.signatureId);
      expect(signature).not.toBeNull();
      if (!signature) throw new Error("Gallery entry has no stored signature.");
      const account = await app.signatures.getAccount(signature.xUserId);
      const svg = await app.artifacts.get(signature.svgStorageKey);
      const png = await app.artifacts.get(signature.cardStorageKey);
      const metadata = app.state.getMetadata(signature.signatureId);
      if (!account || !svg || !png || !metadata) throw new Error("Gallery entry has incomplete persisted content.");

      expect(entry.state).toBe("finalized");
      expect(svg.toString("utf8")).toContain("<svg");
      expect(svg.toString("utf8")).toContain("<path");
      expect(sha256Hex(svg)).toBe(signature.svgSha256);
      expect(sha256Hex(png)).toBe(signature.pngSha256);
      const image = await sharp(png).metadata();
      expect(image.format).toBe("png");
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(metadata.svgSha256).toBe(`0x${signature.svgSha256}`);
      expect(metadata.pngSha256).toBe(`0x${signature.pngSha256}`);
      expect(metadata.metadataSha256).toBe(`0x${sha256Hex(Buffer.from(metadata.canonicalJson))}`);
      expect(metadata.tokenUri).toBe(`ipfs://${metadata.metadataCid}`);
      expect(JSON.parse(metadata.canonicalJson)).toMatchObject({
        image: `ipfs://${metadata.svgCid}`,
        external_url: `http://localhost:3000/signatures/${signature.signatureId}`,
        properties: {
          signature_id: signature.signatureId,
          account_ref: account.publicAccountId,
          handle_at_claim: signature.handleNormalized,
          gr0k_raw: signature.gr0kRaw,
          svg_sha256: signature.svgSha256,
          png_sha256: signature.pngSha256,
          svg_uri: `ipfs://${metadata.svgCid}`,
          png_uri: `ipfs://${metadata.pngCid}`,
          fixture: true,
        },
      });
      handles.add(signature.handleNormalized);
      svgHashes.add(signature.svgSha256);
      pngHashes.add(signature.pngSha256);
      metadataHashes.add(metadata.metadataSha256);
    }

    expect(handles).toEqual(new Set(["alice", ...GALLERY_DEVELOPMENT_FIXTURES.map(({ handle }) => handle)]));
    expect(svgHashes.size).toBe(12);
    expect(pngHashes.size).toBe(12);
    expect(metadataHashes.size).toBe(12);
    for (const fixture of GALLERY_DEVELOPMENT_FIXTURES) {
      const claims = await app.signatures.listSignaturesForAccount(fixtureIdentity(fixture.handle).xUserId);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({ handleNormalized: fixture.handle, gr0kRaw: fixture.gr0kRaw });
    }
  });

  it("preserves Alice's three existing claims and their distinct rehearsal states", async () => {
    const app = await seededRuntime();
    const xUserId = fixtureIdentity("alice").xUserId;
    const claimsBefore = structuredClone(await app.signatures.listSignaturesForAccount(xUserId));
    const projectionsBefore = structuredClone(claimsBefore.map(({ signatureId }) => app.state.getProjection(signatureId)));
    const accountBefore = structuredClone(await app.signatures.getAccount(xUserId));
    expect(projectionsBefore.map(({ state }) => state)).toEqual(["unminted", "included_unfinalized", "finalized"]);

    await seedGalleryDevelopmentFixtures(app.claimRuntime, app.auth, app.service);

    expect(await app.signatures.listSignaturesForAccount(xUserId)).toEqual(claimsBefore);
    expect(await app.signatures.getAccount(xUserId)).toEqual(accountBefore);
    expect(claimsBefore.map(({ signatureId }) => app.state.getProjection(signatureId))).toEqual(projectionsBefore);
  });

  it("can be repeated without duplicating claims, mints, metadata or overwriting later holder changes", async () => {
    const app = await seededRuntime();
    await seedGalleryDevelopmentFixtures(app.claimRuntime, app.auth, app.service);
    const xUserId = fixtureIdentity(GALLERY_DEVELOPMENT_FIXTURES[0].handle).xUserId;
    const [transferred] = await app.signatures.listSignaturesForAccount(xUserId);
    app.state.updateFinalizedHolder(transferred.signatureId, "0x1111111111111111111111111111111111111111");
    const galleryBefore = structuredClone(app.state.listGallery());
    const metadataBefore = structuredClone(galleryBefore.map(({ signatureId }) => app.state.getMetadata(signatureId)));
    const claimsBefore = await Promise.all(["alice", ...GALLERY_DEVELOPMENT_FIXTURES.map(({ handle }) => handle)].map(
      async (handle) => structuredClone(await app.signatures.listSignaturesForAccount(fixtureIdentity(handle).xUserId)),
    ));

    await seedGalleryDevelopmentFixtures(app.claimRuntime, app.auth, app.service);

    expect(app.state.listGallery()).toEqual(galleryBefore);
    expect(galleryBefore.map(({ signatureId }) => app.state.getMetadata(signatureId))).toEqual(metadataBefore);
    for (const claims of claimsBefore) {
      expect(await app.signatures.listSignaturesForAccount(claims[0].xUserId)).toEqual(claims);
    }
  });

  it.each([
    { fixtureMode: false, enabled: true },
    { fixtureMode: true, enabled: false },
  ])("creates no fixture claims or mints when mode is $fixtureMode and enabled is $enabled", async (options) => {
    const app = runtime(options);
    await seedGalleryDevelopmentFixtures(app.claimRuntime, app.auth, app.service);
    expect(app.state.listGallery()).toEqual([]);
    for (const fixture of GALLERY_DEVELOPMENT_FIXTURES) {
      const xUserId = fixtureIdentity(fixture.handle).xUserId;
      expect(await app.signatures.getAccount(xUserId)).toBeNull();
      expect(await app.signatures.listSignaturesForAccount(xUserId)).toEqual([]);
      expect(app.state.getActiveBinding(xUserId, app.service.config.chainId)).toBeNull();
    }
  });
});

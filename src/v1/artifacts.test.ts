import { describe, expect, it } from "vitest";
import { ContentCoordinationError, MemoryContentCoordinator } from "../v2/content/index.js";
import type { OAuthFlow } from "./authState.js";
import { MemoryArtifactStore } from "./artifacts.js";
import { finalizeClaim } from "./claim.js";
import { DEV_CARD_RENDERER_VERSION, DEV_RENDERER_VERSION, developmentFixtureRenderer, RendererRegistry } from "./renderer.js";
import type { SignatureStore } from "./store.js";

class ManualClock {
  value = 1_788_516_000_000;
  readonly now = () => this.value;
}

const signatureA = `sg1_${"a".repeat(52)}`;
const signatureB = `sg1_${"b".repeat(52)}`;

describe("V1 artifact storage fencing", () => {
  it("retains one content-addressed object until every signature reference is released", async () => {
    const clock = new ManualClock();
    const content = new MemoryContentCoordinator({ now: clock.now, minimumPinReplicas: 1 });
    const artifacts = new MemoryArtifactStore(content);
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');

    const first = await artifacts.putVerified("svg", bytes, { signatureId: signatureA });
    const second = await artifacts.putVerified("svg", bytes, { signatureId: signatureB });
    expect(second.key).toBe(first.key);
    expect(content.listReferences(MemoryArtifactStore.STORAGE_TARGET_ID, first.key)).toHaveLength(2);
    await expect(artifacts.delete(first.key)).rejects.toThrow("Direct artifact deletion is disabled");

    artifacts.releaseReference("svg", first.key, signatureA);
    expect(() => artifacts.beginGarbageCollection(first.key, 1_000)).toThrowError(
      expect.objectContaining<Partial<ContentCoordinationError>>({ code: "REFERENCES_REMAIN" }),
    );
    artifacts.releaseReference("svg", first.key, signatureB);
    const fence = artifacts.beginGarbageCollection(first.key, 1_000);
    clock.value += 1_000;
    artifacts.deleteGarbage(fence);
    expect(await artifacts.get(first.key)).toBeNull();
    content.assertInvariants();
  });

  it("prevents a blocked signature from starting another V1 artifact write", async () => {
    const content = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const artifacts = new MemoryArtifactStore(content);
    const bytes = Buffer.from("png fixture");
    await artifacts.putVerified("png", bytes, { signatureId: signatureA });
    content.blockSignature(signatureA, "legal_suppression");

    await expect(artifacts.putVerified("png", bytes, { signatureId: signatureA }))
      .rejects.toMatchObject({ code: "CONTROL_NOT_ENABLED" });
  });

  it("releases newly written artifact references when the owning V1 claim fails", async () => {
    const content = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const artifacts = new MemoryArtifactStore(content);
    const store: SignatureStore = {
      async withdraw() { return false; },
      async claim() { throw new Error("simulated claim commit failure"); },
      async getSignature() { return null; },
      async listSignaturesForAccount() { return []; },
      async listClaimedSignatures() { return []; },
      async getAccount() { return null; },
      async updateExistingAccountLogin() {},
    };
    const flow: OAuthFlow = {
      id: "flow",
      purpose: "claim",
      stateDigest: "state",
      boundSessionIdDigest: "session",
      pkceVerifier: "",
      handleNormalized: "alice",
      gr0kRaw: 371_924,
      rendererVersion: DEV_RENDERER_VERSION,
      previewSvgSha256: null,
      status: "authenticated",
      identity: null,
      createdAt: new Date("2026-09-04T12:00:00.000Z"),
      expiresAt: new Date("2026-09-04T12:15:00.000Z"),
    };

    await expect(finalizeClaim(
      { store, artifacts, renderers: new RendererRegistry([developmentFixtureRenderer]), cardRendererVersion: DEV_CARD_RENDERER_VERSION },
      flow,
      { xUserId: "1234567890123456789", username: "alice", handleNormalized: "alice", authenticatedAt: new Date("2026-09-04T12:00:00.000Z") },
    )).rejects.toThrow("simulated claim commit failure");

    expect(content.listReferences()).toEqual([]);
    content.assertInvariants();
  });
});

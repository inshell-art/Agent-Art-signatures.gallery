import type { AuthenticatedIdentity, OAuthFlow } from "./authState.js";
import type { ArtifactStore, StoredArtifact } from "./artifacts.js";
import { DEV_CARD_RENDERER_VERSION, type RendererRegistry, renderCardPng, sha256Hex } from "./renderer.js";
import type { SignatureStore } from "./store.js";
import { GR0K_SCALE } from "./input.js";
import { deriveSignatureId } from "./identity.js";

export interface ClaimRuntime {
  store: SignatureStore;
  artifacts: ArtifactStore;
  renderers: RendererRegistry;
  cardRendererVersion: string;
}

export async function finalizeClaim(runtime: ClaimRuntime, flow: OAuthFlow, identity: AuthenticatedIdentity, claimedAt?: Date) {
  if (
    flow.status !== "authenticated" ||
    flow.purpose !== "claim" ||
    flow.handleNormalized === null ||
    flow.gr0kRaw === null ||
    flow.rendererVersion === null
  ) {
    throw new Error("Claim flow is not ready.");
  }
  const gr0kRaw = flow.gr0kRaw;
  const rendererVersion = flow.rendererVersion;
  if (identity.handleNormalized !== flow.handleNormalized) throw new Error("Authenticated handle does not match claim flow.");

  const renderer = runtime.renderers.get(rendererVersion);
  const rendered = renderer.render({
    handleNormalized: flow.handleNormalized,
    gr0kRaw,
    gr0kScale: GR0K_SCALE,
    rendererVersion,
  });
  const svgSha256 = sha256Hex(rendered.svgUtf8);
  if (flow.previewSvgSha256 && flow.previewSvgSha256 !== svgSha256) {
    throw new Error("Preview renderer integrity mismatch.");
  }
  const png = await renderCardPng(rendered.svgUtf8);
  const signatureId = deriveSignatureId({
    xUserId: identity.xUserId,
    handleNormalized: identity.handleNormalized,
    gr0kRaw,
    rendererVersion,
  });
  const persist = async () => {
    const writeContext = { signatureId };
    let svgObject: StoredArtifact | undefined;
    let pngObject: StoredArtifact | undefined;
    try {
      svgObject = await runtime.artifacts.putVerified("svg", rendered.svgUtf8, writeContext);
      pngObject = await runtime.artifacts.putVerified("png", png, writeContext);

      return await runtime.store.claim({
        xUserId: identity.xUserId,
        handleAtClaim: identity.username,
        handleNormalized: identity.handleNormalized,
        gr0kRaw,
        rendererVersion,
        svgSha256,
        svgStorageKey: svgObject.key,
        cardRendererVersion: runtime.cardRendererVersion || DEV_CARD_RENDERER_VERSION,
        pngSha256: pngObject.sha256,
        cardStorageKey: pngObject.key,
        xAuthenticatedAt: identity.authenticatedAt,
        claimedAt,
      });
    } catch (error) {
      // A database write can commit before its acknowledgement is lost.
      // Never detach artwork from a committed claim, or when its status is
      // unknown because this read also fails. The return page checks storage.
      const committed = await runtime.store.getSignature(signatureId);
      if (!committed) {
        if (pngObject?.referenceCreated) await runtime.artifacts.releaseReference("png", pngObject.key, signatureId);
        if (svgObject?.referenceCreated) await runtime.artifacts.releaseReference("svg", svgObject.key, signatureId);
      }
      throw error;
    }
  };
  return runtime.store.withClaimLock
    ? runtime.store.withClaimLock(signatureId, persist)
    : persist();
}

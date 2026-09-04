import type { AuthenticatedIdentity, OAuthFlow } from "./authState.js";
import type { ArtifactStore } from "./artifacts.js";
import { DEV_CARD_RENDERER_VERSION, type RendererRegistry, renderCardPng, sha256Hex } from "./renderer.js";
import type { SignatureStore } from "./store.js";
import { GR0K_SCALE } from "./input.js";

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
  if (identity.handleNormalized !== flow.handleNormalized) throw new Error("Authenticated handle does not match claim flow.");

  const renderer = runtime.renderers.get(flow.rendererVersion);
  const rendered = renderer.render({
    handleNormalized: flow.handleNormalized,
    gr0kRaw: flow.gr0kRaw,
    gr0kScale: GR0K_SCALE,
    rendererVersion: flow.rendererVersion,
  });
  const svgSha256 = sha256Hex(rendered.svgUtf8);
  if (flow.previewSvgSha256 && flow.previewSvgSha256 !== svgSha256) {
    throw new Error("Preview renderer integrity mismatch.");
  }
  const png = await renderCardPng(rendered.svgUtf8);
  const svgObject = await runtime.artifacts.putVerified("svg", rendered.svgUtf8);
  const pngObject = await runtime.artifacts.putVerified("png", png);

  return runtime.store.claim({
    xUserId: identity.xUserId,
    handleAtClaim: identity.username,
    handleNormalized: identity.handleNormalized,
    gr0kRaw: flow.gr0kRaw,
    rendererVersion: flow.rendererVersion,
    svgSha256,
    svgStorageKey: svgObject.key,
    cardRendererVersion: runtime.cardRendererVersion || DEV_CARD_RENDERER_VERSION,
    pngSha256: pngObject.sha256,
    cardStorageKey: pngObject.key,
    xAuthenticatedAt: identity.authenticatedAt,
    claimedAt,
  });
}

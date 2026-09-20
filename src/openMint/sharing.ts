import { getAddress } from "viem";
import { openMintHandleKey } from "./authorization.js";
import { canonicalHandle, isMbti, preservedHandle, RENDERER_VERSION } from "./identity.js";
import { PUBLIC_ARTWORK_DESCRIPTION, PUBLIC_ARTIFACT_MAX_BYTES, publicArtworkOrigin, verifyPreparedPublicArtifact, type PreparedPublicArtifact } from "./publicArtifacts.js";
import { stable, validateDeployment, type ProjectionDeployment } from "./projection/model.js";
import type { ProjectedMint } from "./projection/postgres.js";

export const PRIVATE_ROBOTS = "noindex, nofollow, noarchive, nosnippet";
export const LOCAL_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
export type SharingProfile = { readonly environment: "local" | "staging" } | {
  /** A trusted server configuration choice, never a query/body field. This pure
   * policy is not proof of operational approval and does not activate a server. */
  readonly environment: "public-approved"; readonly origin: string;
  readonly deployment: ProjectionDeployment; readonly indexConfirmedWorks: boolean;
};
export interface SharingMetadata {
  readonly robots: string; readonly cacheControl: "no-store"; readonly head: string;
  readonly canonical?: string; readonly image?: string;
}
export interface ConfirmedSharingInput {
  /** Trusted coordinator/repository output, not a browser claim. The caller
   * authenticates canonicality/finality and invalidates it on unknown/reorg. */
  readonly deployment: ProjectionDeployment;
  readonly projection: { readonly state: "confirmed" | "confirming" | "pending" | "unknown" | "safety-halted"; readonly item?: ProjectedMint };
  readonly artifact: PreparedPublicArtifact;
}
const privateMetadata: SharingMetadata = Object.freeze({ robots: PRIVATE_ROBOTS, cacheControl: "no-store", head: `<meta name="robots" content="${PRIVATE_ROBOTS}">` });
const escaped = (value: string): string => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
function metadata(input: { canonical: string; image: string; title: string; description: string; alt: string; index: boolean }): SharingMetadata {
  const robots = input.index ? "index, follow" : "noindex, follow";
  const property = (name: string, value: string) => `<meta property="${name}" content="${escaped(value)}">`;
  const name = (name: string, value: string) => `<meta name="${name}" content="${escaped(value)}">`;
  return Object.freeze({ robots, cacheControl: "no-store", canonical: input.canonical, image: input.image, head: [
    name("robots", robots), `<link rel="canonical" href="${escaped(input.canonical)}">`,
    property("og:type", "website"), property("og:site_name", "signatures.gallery"), property("og:title", input.title),
    property("og:description", input.description), property("og:url", input.canonical), property("og:image", input.image),
    property("og:image:secure_url", input.image), property("og:image:type", "image/png"), property("og:image:alt", input.alt),
    name("twitter:card", "summary_large_image"), name("twitter:title", input.title), name("twitter:description", input.description),
    name("twitter:image", input.image), name("twitter:image:alt", input.alt),
  ].join("\n") });
}
function publicProfile(value: SharingProfile): Extract<SharingProfile, { environment: "public-approved" }> {
  if (value.environment !== "public-approved" || typeof value.indexConfirmedWorks !== "boolean") throw new Error("Public sharing is not configured.");
  const origin = publicArtworkOrigin(value.origin);
  if (/(?:^|\.)(?:test|invalid)$/.test(new URL(origin).hostname)) throw new Error("Nonpublic sharing origin.");
  return { environment: "public-approved", origin, deployment: validateDeployment(value.deployment), indexConfirmedWorks: value.indexConfirmedWorks };
}

/** Pure future policy. Unknown/private paths are rejected before inspecting
 * supplied projection/artifact data. No provider, RPC, render, pin, or signer. */
export async function openMintSharing(input: {
  profile: SharingProfile; path: string;
  preview?: { readonly handle: string; readonly mbti: string; readonly rendererVersion: string };
  minted?: ConfirmedSharingInput;
}): Promise<SharingMetadata> {
  try {
    if (!input.profile || input.profile.environment !== "public-approved" || typeof input.path !== "string") return privateMetadata;
    // Never strip query/fragment credentials into an apparently public route.
    const previewRoute = /^\/p\/([A-Za-z0-9_]{1,15})\/([A-Z]{4})$/.exec(input.path);
    const mintedRoute = /^\/signatures\/([a-z0-9_]{1,15})$/.exec(input.path);
    if (!previewRoute && !mintedRoute) return privateMetadata;
    const profile = publicProfile(input.profile);
    if (previewRoute) {
      const preview = input.preview;
      if (!preview || preservedHandle(preview.handle) !== preview.handle || !isMbti(preview.mbti)
        || preview.rendererVersion !== RENDERER_VERSION || previewRoute[1] !== preview.handle || previewRoute[2] !== preview.mbti) return privateMetadata;
      // This future PNG route is derived only from free public preview inputs.
      // Serving those bytes is deliberately not wired into the active server.
      const image = `${profile.origin}/sharing/previews/${preview.handle}/${preview.mbti}/${RENDERER_VERSION}.png`;
      return metadata({ canonical: `${profile.origin}${input.path}`, image,
        title: `@${preview.handle} × ${preview.mbti} — free preview`,
        description: "A free signature preview using a chosen MBTI artistic input. This is not a Grok assessment or a minted artwork.",
        alt: `Free @${preview.handle} signature preview with chosen ${preview.mbti} input`, index: false });
    }
    const supplied = input.minted;
    if (!supplied || supplied.projection.state !== "confirmed" || supplied.projection.item?.availability !== "available") return privateMetadata;
    // Bound copies before snapshotting the trusted saved artifact for async CID
    // checks. No regeneration from mutable current renderer/settings occurs.
    for (const object of [supplied.artifact.svg, supplied.artifact.png, supplied.artifact.metadata]) {
      if (!(object.bytes instanceof Uint8Array) || object.bytes.byteLength < 1 || object.bytes.byteLength > PUBLIC_ARTIFACT_MAX_BYTES) return privateMetadata;
    }
    const saved = structuredClone(supplied), item = saved.projection.item!, artifact = saved.artifact;
    if (stable(validateDeployment(saved.deployment)) !== stable(profile.deployment)) return privateMetadata;
    await verifyPreparedPublicArtifact(artifact);
    const handle = mintedRoute![1];
    if (canonicalHandle(handle) !== handle || item.handle !== handle || artifact.commitment.canonicalHandle !== handle || artifact.origin !== profile.origin
      || item.tokenId !== BigInt(openMintHandleKey(handle)).toString() || item.mbti !== artifact.assessment.mbti
      || item.assessmentDigest !== artifact.assessment.digest || item.artifactDigest !== artifact.digest || item.tokenURIHash !== artifact.commitment.tokenURIHash
      || !item.originalRecipient || !item.currentOwner) return privateMetadata;
    for (const owner of [item.originalRecipient, item.currentOwner]) if (/^0x0{40}$/i.test(getAddress(owner))) return privateMetadata;
    const spelling = artifact.commitment.renderHandle, mbti = artifact.assessment.mbti;
    return metadata({ canonical: `${profile.origin}/signatures/${handle}`, image: `${profile.origin}/artifacts/${artifact.png.object.sha256}.png`,
      title: `@${spelling} × ${mbti} — signatures.gallery`, description: PUBLIC_ARTWORK_DESCRIPTION,
      alt: `Minted @${spelling} signature, ${mbti}`, index: profile.indexConfirmedWorks });
  } catch { return privateMetadata; }
}

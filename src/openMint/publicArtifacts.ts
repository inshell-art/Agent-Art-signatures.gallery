import { isIP } from "node:net";
import canonicalize from "canonicalize";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { renderSignatureSvg } from "../algorithmV2/index.js";
import { renderCardPng, sha256Hex } from "../v1/renderer.js";
import { deterministicUnixfsCid, IPFS_IMPORTER_PROFILE, parseCanonicalCidV1 } from "../v2/core/ipfsCid.js";
import { isXSource, validateAssessment, type Assessment } from "./assessment.js";
import { openMintTokenURIHash } from "./authorization.js";
import { canonicalHandle, preservedHandle, RENDERER_VERSION } from "./identity.js";

/** New public-only formats; never applied to the existing local artifact digest. */
export const PUBLIC_METADATA_VERSION = "sg-open-mint-metadata-1.0.0" as const;
export const PUBLIC_ARTIFACT_DOMAIN = "signatures.gallery/open-artifact/v2" as const;
export const PUBLIC_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const PUBLIC_ARTWORK_DESCRIPTION = "A signature interpreted by Grok from public X research. MBTI is an artistic input, not a psychological diagnosis. Owning this token does not imply ownership or control of the X account.";
export type PublicMediaType = "image/svg+xml" | "image/png" | "application/json";
export interface PublicObject {
  readonly mediaType: PublicMediaType;
  readonly sha256: string;
  readonly byteLength: number;
  readonly cid: string;
  readonly uri: string;
  readonly importerProfile: typeof IPFS_IMPORTER_PROFILE.name;
}
export interface PublicObjectBytes { readonly object: PublicObject; readonly bytes: Uint8Array }
export interface PublicArtifactCommitment {
  readonly domain: typeof PUBLIC_ARTIFACT_DOMAIN;
  readonly assessmentDigest: Hex;
  readonly canonicalHandle: string;
  readonly renderHandle: string;
  readonly rendererVersion: typeof RENDERER_VERSION;
  readonly metadataVersion: typeof PUBLIC_METADATA_VERSION;
  readonly svgSha256: string;
  readonly pngSha256: string;
  readonly metadataSha256: string;
  readonly tokenURIHash: Hex;
}
export interface PreparedPublicArtifact {
  /** Private validation input. Never serialize this complete object as public metadata. */
  readonly assessment: Assessment;
  readonly origin: string;
  readonly commitment: PublicArtifactCommitment;
  readonly digest: Hex;
  readonly svg: PublicObjectBytes;
  readonly png: PublicObjectBytes;
  readonly metadata: PublicObjectBytes;
}

/** Syntactic validation only, not DNS/ownership approval or permission to deploy. */
export function publicArtworkOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("An explicit public HTTPS origin is required.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid public artwork origin."); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.port
    || isIP(host.replace(/^\[|\]$/g, "")) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|onion)$/.test(host)) throw new Error("Invalid public artwork origin.");
  return value;
}

function publicAssessment(value: unknown): Assessment {
  const assessment = validateAssessment(value);
  if (assessment.provenance !== "grok" || assessment.rendererVersion !== RENDERER_VERSION
    || assessment.xIdentity?.provenance !== "x-api") throw new Error("Public artwork requires a native, X-verified Grok assessment.");
  return assessment;
}

export function publicArtifactDigest(value: PublicArtifactCommitment): Hex {
  const fields = ["domain", "assessmentDigest", "canonicalHandle", "renderHandle", "rendererVersion", "metadataVersion", "svgSha256", "pngSha256", "metadataSha256", "tokenURIHash"];
  if (!value || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))
    || value.domain !== PUBLIC_ARTIFACT_DOMAIN || value.rendererVersion !== RENDERER_VERSION || value.metadataVersion !== PUBLIC_METADATA_VERSION
    || canonicalHandle(value.canonicalHandle) !== value.canonicalHandle || preservedHandle(value.renderHandle) !== value.renderHandle
    || canonicalHandle(value.renderHandle) !== value.canonicalHandle
    || !/^0x[0-9a-f]{64}$/.test(value.assessmentDigest) || !/^0x[0-9a-f]{64}$/.test(value.tokenURIHash)
    || [value.svgSha256, value.pngSha256, value.metadataSha256].some(hash => !/^[0-9a-f]{64}$/.test(hash))) throw new Error("Invalid public artifact commitment.");
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "bytes32" }, ...Array.from({ length: 4 }, () => ({ type: "string" as const })),
      ...Array.from({ length: 4 }, () => ({ type: "bytes32" as const }))],
    [value.domain, value.assessmentDigest, value.canonicalHandle, value.renderHandle, value.rendererVersion,
      value.metadataVersion, `0x${value.svgSha256}`, `0x${value.pngSha256}`, `0x${value.metadataSha256}`, value.tokenURIHash],
  ));
}

async function prepareObject(mediaType: PublicMediaType, input: Uint8Array): Promise<PublicObjectBytes> {
  const bytes = Uint8Array.from(input);
  if (bytes.byteLength < 1 || bytes.byteLength > PUBLIC_ARTIFACT_MAX_BYTES) throw new Error("Invalid public artifact byte length.");
  const cid = await deterministicUnixfsCid(bytes);
  return { object: Object.freeze({ mediaType, sha256: sha256Hex(bytes), byteLength: bytes.byteLength, cid,
    uri: `ipfs://${cid}`, importerProfile: IPFS_IMPORTER_PROFILE.name }), bytes };
}

function metadataBytes(assessment: Assessment, origin: string, svg: PublicObject, png: PublicObject): Uint8Array {
  // Explicit projection, never spread a private assessment. Query/fragment data and non-X URLs are excluded.
  const sources = [...new Set(assessment.sourceUrls.filter(isXSource).map(source => {
    const url = new URL(source); url.search = ""; url.hash = ""; return url.href;
  }))].sort();
  const renderHandle = assessment.xIdentity!.username;
  const metadata = {
    name: `@${renderHandle} × ${assessment.mbti}`,
    description: PUBLIC_ARTWORK_DESCRIPTION,
    image: png.uri, animation_url: svg.uri, external_url: `${origin}/signatures/${assessment.handle}`,
    attributes: [{ trait_type: "Handle", value: renderHandle }, { trait_type: "MBTI", value: assessment.mbti },
      { trait_type: "Renderer", value: assessment.rendererVersion }],
    properties: {
      metadata_version: PUBLIC_METADATA_VERSION, canonical_handle: assessment.handle, render_handle: renderHandle,
      mbti: assessment.mbti, renderer_version: assessment.rendererVersion,
      assessment: { digest: assessment.digest, assessor: "Grok", model: assessment.model,
        policy_version: assessment.policyVersion, assessed_at: assessment.createdAt, source_urls: sources,
        identity: { username: renderHandle, user_id: assessment.xIdentity!.userId,
          verified_at: assessment.xIdentity!.verifiedAt, freshness: assessment.xIdentity!.freshness } },
      svg_sha256: svg.sha256, png_sha256: png.sha256, svg_uri: svg.uri, png_uri: png.uri,
      importer_profile: IPFS_IMPORTER_PROFILE.name,
    },
  };
  return Buffer.from(canonicalize(metadata)!, "utf8");
}

/** Pure preparation: no provider, publisher, signer, database, old-artifact import or network access. */
export async function preparePublicArtifact(input: { assessment: Assessment; origin: string }): Promise<PreparedPublicArtifact> {
  const assessment = publicAssessment(input.assessment), origin = publicArtworkOrigin(input.origin);
  const svg = await prepareObject("image/svg+xml", Buffer.from(renderSignatureSvg(assessment.xIdentity!.username, assessment.mbti)));
  const png = await prepareObject("image/png", await renderCardPng(Buffer.from(svg.bytes)));
  const metadata = await prepareObject("application/json", metadataBytes(assessment, origin, svg.object, png.object));
  const commitment: PublicArtifactCommitment = Object.freeze({ domain: PUBLIC_ARTIFACT_DOMAIN, assessmentDigest: assessment.digest,
    canonicalHandle: assessment.handle, renderHandle: assessment.xIdentity!.username, rendererVersion: RENDERER_VERSION,
    metadataVersion: PUBLIC_METADATA_VERSION, svgSha256: svg.object.sha256, pngSha256: png.object.sha256,
    metadataSha256: metadata.object.sha256, tokenURIHash: openMintTokenURIHash(metadata.object.uri) });
  return { assessment, origin, commitment, digest: publicArtifactDigest(commitment), svg, png, metadata };
}

export async function verifyPublicObject(value: PublicObjectBytes, mediaType: PublicMediaType): Promise<void> {
  const { object, bytes } = value;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PUBLIC_ARTIFACT_MAX_BYTES
    || Object.keys(object).length !== 6 || object.mediaType !== mediaType || object.importerProfile !== IPFS_IMPORTER_PROFILE.name
    || object.byteLength !== bytes.byteLength || object.sha256 !== sha256Hex(bytes)
    || object.uri !== `ipfs://${object.cid}`) throw new Error("Public artifact bytes do not match their descriptor.");
  parseCanonicalCidV1(object.cid);
  if (await deterministicUnixfsCid(bytes) !== object.cid) throw new Error("Public artifact CID does not match its bytes.");
}

/** Validates persisted bytes against the pinned deterministic SVG renderer. PNG
 * encoding is a trusted preparation boundary; historical PNGs are not rerendered. */
export async function verifyPreparedPublicArtifact(value: PreparedPublicArtifact): Promise<void> {
  const assessment = publicAssessment(value.assessment), origin = publicArtworkOrigin(value.origin);
  await verifyPublicObject(value.svg, "image/svg+xml");
  await verifyPublicObject(value.png, "image/png");
  await verifyPublicObject(value.metadata, "application/json");
  if (!Buffer.from(value.svg.bytes).equals(Buffer.from(renderSignatureSvg(assessment.xIdentity!.username, assessment.mbti)))) {
    throw new Error("Public artifact SVG does not match its frozen assessment rendering.");
  }
  const c = value.commitment;
  if (publicArtifactDigest(c) !== value.digest || c.assessmentDigest !== assessment.digest || c.canonicalHandle !== assessment.handle
    || c.renderHandle !== assessment.xIdentity!.username || c.svgSha256 !== value.svg.object.sha256
    || c.pngSha256 !== value.png.object.sha256 || c.metadataSha256 !== value.metadata.object.sha256
    || c.tokenURIHash !== openMintTokenURIHash(value.metadata.object.uri)
    || !Buffer.from(value.metadata.bytes).equals(metadataBytes(assessment, origin, value.svg.object, value.png.object))) throw new Error("Public artifact binding mismatch.");
}

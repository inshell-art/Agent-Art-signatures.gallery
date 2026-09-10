import { createHash, timingSafeEqual } from "node:crypto";
import canonicalize from "canonicalize";
import { tokenUriHash, type Bytes32Hex } from "./mintAuthorization.js";
import { deterministicUnixfsCid, parseCanonicalCidV1 } from "./ipfsCid.js";
import { signatureDigestFromId } from "./signatureId.js";
import { GR0K_MAX, GR0K_MIN, GR0K_SCALE } from "../../v1/input.js";
export { GR0K_SCALE } from "../../v1/input.js";

export const METADATA_VERSION = "sg-nft-metadata-1.0.0" as const;
export const CLAIM_METHOD = "x_oauth_v1" as const;
export const CLAIM_METHOD_DISPLAY = "X OAuth" as const;
export const TOKEN_DESCRIPTION = "A signature claimed through X authentication and minted in the Gallery of Signatures collection. In the intended workflow, gr0k is selected in a private Grok conversation; that private step is not independently verified.";
export const V2_RENDERER_VERSION = "sg-renderer-1.0.0" as const;
export const V2_CARD_RENDERER_VERSION = "sg-card-1.0.0" as const;

const HASH_HEX = /^[0-9a-f]{64}$(?![\s\S])/;
const ARTWORK_HANDLE = /^[A-Za-z0-9_]{1,15}$(?![\s\S])/;
const PUBLIC_ACCOUNT_REF = /^xa1_[a-z2-7]+$(?![\s\S])/;

export interface TokenMetadataInput {
  signatureId: string;
  publicAccountId: string;
  handleAtClaim: string;
  gr0kRaw: number;
  gr0kScale: typeof GR0K_SCALE;
  rendererVersion: typeof V2_RENDERER_VERSION;
  cardRendererVersion: typeof V2_CARD_RENDERER_VERSION;
  svgSha256: string;
  pngSha256: string;
  svgCid: string;
  pngCid: string;
  claimedAt: Date | string;
  publicArtifactOrigin: string;
}

export interface SignatureTokenMetadata {
  name: string;
  description: typeof TOKEN_DESCRIPTION;
  image: string;
  external_url: string;
  attributes: [
    { trait_type: "Handle at Claim"; value: string },
    { trait_type: "gr0k"; value: string },
    { trait_type: "Renderer"; value: typeof V2_RENDERER_VERSION },
    { trait_type: "Claim Method"; value: typeof CLAIM_METHOD_DISPLAY },
  ];
  properties: {
    metadata_version: typeof METADATA_VERSION;
    signature_id: string;
    account_ref: string;
    handle_at_claim: string;
    gr0k_raw: number;
    gr0k_scale: typeof GR0K_SCALE;
    renderer_version: typeof V2_RENDERER_VERSION;
    card_renderer_version: typeof V2_CARD_RENDERER_VERSION;
    svg_sha256: string;
    png_sha256: string;
    svg_uri: string;
    png_uri: string;
    claim_method: typeof CLAIM_METHOD;
    claimed_at: string;
  };
}

export interface PreparedTokenMetadata {
  metadata: SignatureTokenMetadata;
  canonicalJson: string;
  bytes: Uint8Array;
  sha256: string;
  cid: string;
  tokenUri: string;
  tokenUriHash: Bytes32Hex;
}

function requireHash(value: string, field: string): string {
  if (!HASH_HEX.test(value)) throw new Error(`${field} must be exactly 64 lowercase hexadecimal characters without 0x.`);
  return value;
}

function requireOrigin(value: string): string {
  if (value.endsWith("/")) throw new Error("publicArtifactOrigin must not have a trailing slash.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("publicArtifactOrigin must be an absolute HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error("publicArtifactOrigin must be an exact HTTPS origin with no path, query, or fragment.");
  }
  return value;
}

function truncateUtcMilliseconds(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("claimedAt must be a valid instant.");
    return value.toISOString();
  }

  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (match === null) throw new Error("claimedAt must be an RFC 3339 instant.");
  const milliseconds = (match[2] ?? "").slice(0, 3).padEnd(3, "0");
  const truncated = `${match[1]}.${milliseconds}${match[3]}`;
  const instant = new Date(truncated);
  if (Number.isNaN(instant.getTime())) throw new Error("claimedAt must be a valid instant.");
  return instant.toISOString();
}

export function formatGr0k(raw: number, scale: number = GR0K_SCALE): string {
  if (!Number.isSafeInteger(raw) || raw < GR0K_MIN || raw > GR0K_MAX || scale !== GR0K_SCALE) {
    throw new Error("gr0k must use an integer raw value from 1 to 100 at scale 1 (an unscaled seed).");
  }
  return String(raw);
}

export function buildTokenMetadata(input: TokenMetadataInput): SignatureTokenMetadata {
  signatureDigestFromId(input.signatureId);
  if (!PUBLIC_ACCOUNT_REF.test(input.publicAccountId)) throw new Error("publicAccountId must be an opaque V1 xa1_ Base32 reference.");
  if (!ARTWORK_HANDLE.test(input.handleAtClaim)) throw new Error("handleAtClaim must be the frozen case-sensitive artwork handle.");
  if (input.rendererVersion !== V2_RENDERER_VERSION || input.cardRendererVersion !== V2_CARD_RENDERER_VERSION) {
    throw new Error("metadata requires the frozen V2 renderer version constants.");
  }
  const gr0k = formatGr0k(input.gr0kRaw, input.gr0kScale);
  const svgSha256 = requireHash(input.svgSha256, "svgSha256");
  const pngSha256 = requireHash(input.pngSha256, "pngSha256");
  parseCanonicalCidV1(input.svgCid);
  parseCanonicalCidV1(input.pngCid);
  const origin = requireOrigin(input.publicArtifactOrigin);
  const claimedAt = truncateUtcMilliseconds(input.claimedAt);
  const svgUri = `ipfs://${input.svgCid}`;
  const pngUri = `ipfs://${input.pngCid}`;

  return {
    name: `@${input.handleAtClaim} — Signature — gr0k ${gr0k}`,
    description: TOKEN_DESCRIPTION,
    image: svgUri,
    external_url: `${origin}/signatures/${input.signatureId}`,
    attributes: [
      { trait_type: "Handle at Claim", value: `@${input.handleAtClaim}` },
      { trait_type: "gr0k", value: gr0k },
      { trait_type: "Renderer", value: V2_RENDERER_VERSION },
      { trait_type: "Claim Method", value: CLAIM_METHOD_DISPLAY },
    ],
    properties: {
      metadata_version: METADATA_VERSION,
      signature_id: input.signatureId,
      account_ref: input.publicAccountId,
      handle_at_claim: input.handleAtClaim,
      gr0k_raw: input.gr0kRaw,
      gr0k_scale: GR0K_SCALE,
      renderer_version: V2_RENDERER_VERSION,
      card_renderer_version: V2_CARD_RENDERER_VERSION,
      svg_sha256: svgSha256,
      png_sha256: pngSha256,
      svg_uri: svgUri,
      png_uri: pngUri,
      claim_method: CLAIM_METHOD,
      claimed_at: claimedAt,
    },
  };
}

export function canonicalMetadataBytes(metadata: SignatureTokenMetadata): Uint8Array {
  const serialized = canonicalize(metadata);
  if (serialized === undefined) throw new Error("metadata cannot be represented by RFC 8785 JSON canonicalization.");
  return Buffer.from(serialized, "utf8");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function prepareTokenMetadata(input: TokenMetadataInput): Promise<PreparedTokenMetadata> {
  const metadata = buildTokenMetadata(input);
  const bytes = canonicalMetadataBytes(metadata);
  const canonicalJson = Buffer.from(bytes).toString("utf8");
  const sha256 = sha256Hex(bytes);
  const cid = await deterministicUnixfsCid(bytes);
  const tokenUri = `ipfs://${cid}`;
  return { metadata, canonicalJson, bytes, sha256, cid, tokenUri, tokenUriHash: tokenUriHash(tokenUri) as Bytes32Hex };
}

function assertSelfContainedSvg(bytes: Uint8Array): void {
  let svg: string;
  try {
    svg = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("SVG object is not valid UTF-8.");
  }
  if (!/<svg(?:\s|>)/i.test(svg)) throw new Error("SVG object has no SVG root element.");
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<script(?:\s|>)/i.test(svg)) {
    throw new Error("SVG object contains an active or externally resolvable construct.");
  }
  if (/@import\b/i.test(svg)) throw new Error("SVG object contains an external CSS import.");

  if (/(?:\bhref|\bxlink:href|\bsrc)\s*=\s*(?!["'])/i.test(svg)) {
    throw new Error("SVG object contains a malformed or unquoted resource reference.");
  }
  for (const match of svg.matchAll(/(?:\bhref|\bxlink:href|\bsrc)\s*=\s*(["'])(.*?)\1/gi)) {
    const reference = match[2].trim();
    if (reference !== "" && !reference.startsWith("#") && !reference.startsWith("data:")) {
      throw new Error("SVG object contains an external resource reference.");
    }
  }
  for (const match of svg.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const reference = match[2].trim();
    if (!reference.startsWith("#") && !reference.startsWith("data:")) {
      throw new Error("SVG object contains an external CSS resource reference.");
    }
  }
}

export function verifyImmutableArtifact(
  bytes: Uint8Array,
  expectedSha256: string,
  kind: "svg" | "png",
): void {
  const expected = Buffer.from(requireHash(expectedSha256, `${kind}Sha256`), "hex");
  const actual = createHash("sha256").update(bytes).digest();
  if (!timingSafeEqual(actual, expected)) throw new Error(`${kind.toUpperCase()} bytes do not match the immutable V1 SHA-256.`);
  if (kind === "svg") assertSelfContainedSvg(bytes);
}

export function verifyImmutableV1Artifacts(input: {
  svgBytes: Uint8Array;
  pngBytes: Uint8Array;
  svgSha256: string;
  pngSha256: string;
}): void {
  verifyImmutableArtifact(input.svgBytes, input.svgSha256, "svg");
  verifyImmutableArtifact(input.pngBytes, input.pngSha256, "png");
}

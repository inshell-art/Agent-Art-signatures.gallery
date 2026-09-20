import { performance } from "node:perf_hooks";
import { isXSource } from "../assessment.js";
import { handleDigest } from "../identity.js";
import type { AssessmentPageModel } from "../pages.js";
import type { PostgresPublicationJournal } from "../persistence/publication.js";
import { publicArtworkOrigin, PUBLIC_ARTIFACT_MAX_BYTES, verifyPreparedPublicArtifact } from "../publicArtifacts.js";
import { stable } from "./model.js";
import type { ProjectionReads } from "./http.js";

export type ArtworkKind = "svg" | "png" | "metadata";
export class ArtworkReadUnavailableError extends Error {
  constructor() { super("The verified artwork is unavailable right now."); }
}
/** Public projection of a private immutable backup, not an uploader, a rerender
 * fallback or a private assessment endpoint. Both ends of the bounded read must
 * see the same fresh inclusion/finality and exact on-chain commitments. */
export function createVerifiedArtworkReads(options: {
  projection: Pick<ProjectionReads, "lookup">;
  journal: Pick<PostgresPublicationJournal, "load" | "origin" | "namespaceId">;
  namespaceId: string; origin: string; timeoutMs: number;
}) {
  const { timeoutMs, namespaceId } = options, origin = publicArtworkOrigin(options.origin);
  if (options.journal.origin !== origin || options.journal.namespaceId !== namespaceId || !namespaceId
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new ArtworkReadUnavailableError();
  const lookup = options.projection.lookup.bind(options.projection), load = options.journal.load.bind(options.journal);
  async function read(handle: string, signal: AbortSignal) {
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new ArtworkReadUnavailableError();
    const end = performance.now() + timeoutMs, controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const check = () => { if (signal.aborted || controller.signal.aborted || performance.now() >= end) throw new ArtworkReadUnavailableError(); };
    const stop = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new ArtworkReadUnavailableError()); };
      signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, timeoutMs);
    });
    try {
      const work = async () => {
        check(); const before = await lookup(handle); check(); const mint = before.item;
        if ((before.state !== "confirming" && before.state !== "confirmed") || !mint || mint.availability === "quarantined"
          || mint.handle !== handle || mint.tokenId !== BigInt(handleDigest(handle)).toString() || !mint.transactionHash) throw new ArtworkReadUnavailableError();
        const raw = await load(handle, true); check();
        if (!raw || [raw.svg, raw.png, raw.metadata].some(o => !(o?.bytes instanceof Uint8Array) || !o.bytes.byteLength || o.bytes.byteLength > PUBLIC_ARTIFACT_MAX_BYTES)) throw new ArtworkReadUnavailableError();
        const artifact = structuredClone(raw); await verifyPreparedPublicArtifact(artifact); check();
        if (artifact.origin !== origin || artifact.assessment.handle !== handle || artifact.assessment.mbti !== mint.mbti
          || artifact.assessment.digest !== mint.assessmentDigest || artifact.digest !== mint.artifactDigest
          || artifact.commitment.tokenURIHash !== mint.tokenURIHash) throw new ArtworkReadUnavailableError();
        const after = await lookup(handle); check();
        if (stable(before) !== stable(after)) throw new ArtworkReadUnavailableError();
        return { artifact, mint, state: before.state === "confirmed" ? "minted" as const : "confirming" as const };
      };
      return await Promise.race([work(), stop]);
    } catch { throw new ArtworkReadUnavailableError(); }
    finally { clearTimeout(timer); controller.abort(); if (abort) signal.removeEventListener("abort", abort); }
  }
  return Object.freeze({
    async detail(handle: string, signal: AbortSignal): Promise<AssessmentPageModel> {
      const { artifact: a, mint, state } = await read(handle, signal), assessment = a.assessment;
      const base = `/api/signatures/${handle}/artwork/${a.digest}`;
      const sources = [...new Set(assessment.sourceUrls.filter(isXSource).map(source => { const url = new URL(source); url.search = ""; url.hash = ""; return url.href; }))].sort();
      // No private code, attempt, provider response ID, reservation, signature,
      // receipt, budget or session field is spread into this public page model.
      return { handle, renderHandle: a.commitment.renderHandle, code: "", status: "ready", canMint: false,
        mbti: assessment.mbti, tokenId: mint.tokenId, imageUrl: `${base}/png`, svgUrl: `${base}/svg`,
        rendererVersion: a.commitment.rendererVersion, svgSha256: a.svg.object.sha256, pngSha256: a.png.object.sha256, artifactDigest: a.digest,
        assessedAt: assessment.createdAt, assessmentProvenance: assessment.provenance, assessmentModel: assessment.model,
        assessmentSourceUrls: sources, verifiedXUserId: assessment.xIdentity!.userId, identityVerifiedAt: assessment.xIdentity!.verifiedAt,
        mint: { state, tokenId: mint.tokenId, transactionHash: mint.transactionHash, wallet: mint.originalRecipient } };
    },
    async media(handle: string, digest: string, kind: ArtworkKind, signal: AbortSignal) {
      if (!/^0x[0-9a-f]{64}$/.test(digest) || !["svg", "png", "metadata"].includes(kind)) throw new ArtworkReadUnavailableError();
      const { artifact } = await read(handle, signal);
      if (artifact.digest !== digest) throw new ArtworkReadUnavailableError();
      return { mediaType: artifact[kind].object.mediaType, bytes: Uint8Array.from(artifact[kind].bytes) };
    },
  });
}

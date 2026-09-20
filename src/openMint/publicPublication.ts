import { performance } from "node:perf_hooks";
import type { Hex } from "viem";
import { PUBLIC_ARTIFACT_MAX_BYTES, verifyPreparedPublicArtifact, verifyPublicObject,
  type PreparedPublicArtifact, type PublicObject } from "./publicArtifacts.js";

/** Production adapters must honor AbortSignal and reject oversized streams before buffering. */
export interface PublicArtifactUploader {
  readonly id: string;
  /** Content-addressed, idempotent upload of these exact bytes only. No URL fallback. */
  upload(object: PublicObject, bytes: Uint8Array, signal: AbortSignal): Promise<void>;
}
export interface PublicArtifactReader {
  readonly id: string;
  /** Independent retrieval path, not an echo of the uploaded buffer/response. */
  retrieve(object: PublicObject, options: { signal: AbortSignal; maxBytes: number }): Promise<Uint8Array>;
}
/** Transactional persistence/ownership is supplied by E17; no permissive default store exists. */
export interface PublicPublicationJournal {
  /** Insert-only exact bundle and backups; a different existing binding must throw. */
  stage(artifact: PreparedPublicArtifact): Promise<void>;
  /** Recheck writer ownership and the exact staged object before external upload. */
  beforeUpload(digest: Hex, object: PublicObject): Promise<void>;
  uploaded(digest: Hex, object: PublicObject, destination: string): Promise<void>;
  retrieved(digest: Hex, object: PublicObject, source: string): Promise<void>;
  /** Commit only if all required exact object observations exist; authority reads this durable state. */
  complete(digest: Hex): Promise<void>;
}

async function bounded<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), expires = performance.now() + milliseconds;
  const check = () => { if (performance.now() >= expires) throw new Error("Public artifact operation timed out."); };
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error("Public artifact operation timed out.")); controller.abort(); }, milliseconds);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { check(); return work(controller.signal); }), deadline]);
    check(); return result;
  } finally { clearTimeout(timer!); controller.abort(); }
}

/**
 * One explicit publication pass. No provider/signing call, automatic retry or active app wiring.
 * A retry may only replay the same saved bytes; verified authority is a separate durable decision.
 */
export async function publishPublicArtifact(input: {
  artifact: PreparedPublicArtifact; uploader: PublicArtifactUploader; reader: PublicArtifactReader;
  journal: PublicPublicationJournal; timeoutMs: number;
}): Promise<{ artifactDigest: Hex; tokenURI: string }> {
  const { uploader, reader, journal, timeoutMs } = input;
  const destination = uploader.id, source = reader.id;
  const upload = uploader.upload.bind(uploader), retrieve = reader.retrieve.bind(reader);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid publication deadline.");
  const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  if (!id.test(destination) || !id.test(source) || destination === source) throw new Error("Distinct upload and independent retrieval identities are required.");
  // Snapshot before the first await; neither callers nor adapters can change in-flight commitments.
  const artifact = structuredClone(input.artifact);
  await verifyPreparedPublicArtifact(artifact);
  await journal.stage(structuredClone(artifact));
  for (const { object, bytes } of [artifact.svg, artifact.png, artifact.metadata]) {
    await journal.beforeUpload(artifact.digest, structuredClone(object));
    await bounded(timeoutMs, signal => upload(structuredClone(object), Uint8Array.from(bytes), signal));
    await journal.uploaded(artifact.digest, structuredClone(object), destination);
    const retrieved = await bounded(timeoutMs, signal => retrieve(structuredClone(object), { signal, maxBytes: PUBLIC_ARTIFACT_MAX_BYTES }));
    await verifyPublicObject({ object, bytes: retrieved }, object.mediaType);
    await journal.retrieved(artifact.digest, structuredClone(object), source);
  }
  await journal.complete(artifact.digest);
  return { artifactDigest: artifact.digest, tokenURI: artifact.metadata.object.uri };
}

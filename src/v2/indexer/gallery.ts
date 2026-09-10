import type { GalleryCursor, GalleryEntryProjection, IndexerState } from "./types.js";

function compareDescending(a: GalleryCursor, b: GalleryCursor): number {
  const blockA = BigInt(a.blockNumber);
  const blockB = BigInt(b.blockNumber);
  if (blockA !== blockB) return blockA > blockB ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex) return b.transactionIndex - a.transactionIndex;
  if (a.logIndex !== b.logIndex) return b.logIndex - a.logIndex;
  return a.signatureId < b.signatureId ? -1 : a.signatureId > b.signatureId ? 1 : 0;
}

export function galleryCursor(entry: GalleryEntryProjection): GalleryCursor {
  return {
    blockNumber: entry.blockNumber,
    transactionIndex: entry.transactionIndex,
    logIndex: entry.logIndex,
    signatureId: entry.signatureId,
  };
}

export function galleryPage(
  state: IndexerState,
  options: { limit: number; after?: GalleryCursor; suppressedSignatureIds?: ReadonlySet<string> },
): { entries: GalleryEntryProjection[]; nextCursor: GalleryCursor | null } {
  if (!Number.isSafeInteger(options.limit) || options.limit <= 0) throw new Error("Gallery page limit must be a positive safe integer.");
  const visible = state.galleryEntries
    .filter((entry) => entry.chainState === "finalized" && !options.suppressedSignatureIds?.has(entry.signatureId))
    .sort((a, b) => compareDescending(galleryCursor(a), galleryCursor(b)));
  const after = options.after;
  const eligible = after ? visible.filter((entry) => compareDescending(galleryCursor(entry), after) > 0) : visible;
  const entries = eligible.slice(0, options.limit).map((entry) => structuredClone(entry));
  const nextCursor = eligible.length > options.limit && entries.length > 0 ? galleryCursor(entries.at(-1)!) : null;
  return { entries, nextCursor };
}

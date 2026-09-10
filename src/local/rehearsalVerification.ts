import { getAddress, type Address, type Hex } from "viem";
import type { IndexerState } from "../v2/indexer/types.js";
import type { MemoryMintStore } from "../v2/memoryStore.js";

/** Inspect the accepted checkpoint, not the moving chain head or initial owner. */
export function rehearsalMintVerificationPlan(
  store: MemoryMintStore,
  indexer: IndexerState | null,
  seededSignatureId: string,
): { blockNumber: bigint; blockHash: Hex; tokens: { tokenId: bigint; currentHolder: Address }[] } {
  if (!indexer || indexer.health !== "running") {
    throw new Error("The durable local indexer is missing or halted; investigate before resuming, without resetting the saved state.");
  }
  const { promotedFinalizedHeight, promotedFinalizedHash } = indexer.checkpoint;
  if (promotedFinalizedHeight === null || promotedFinalizedHash === null) {
    throw new Error("The durable local indexer has no promoted checkpoint.");
  }
  const seeded = indexer.galleryEntries.find((entry) => entry.signatureId === seededSignatureId);
  if (!seeded || seeded.chainState !== "finalized" || store.getProjection(seededSignatureId).state !== "finalized") {
    throw new Error("The durable seeded mint is missing from the accepted Gallery projection.");
  }
  const tokens = indexer.galleryEntries.filter((entry) => entry.chainState === "finalized").map((entry) => {
    const projection = store.getProjection(entry.signatureId);
    const holder = indexer.tokenHolders.find((item) => item.signatureId === entry.signatureId);
    if (projection.state !== "finalized" || projection.tokenId !== BigInt(entry.tokenId)
      || projection.txHash?.toLowerCase() !== entry.txHash.toLowerCase()
      || !projection.currentTokenHolder || !holder?.currentHolder
      || getAddress(projection.currentTokenHolder) !== getAddress(holder.currentHolder)) {
      throw new Error(`Durable mint and indexer projections disagree for ${entry.signatureId}; preserve the state for reconciliation.`);
    }
    return { tokenId: BigInt(entry.tokenId), currentHolder: getAddress(holder.currentHolder) };
  });
  return { blockNumber: BigInt(promotedFinalizedHeight), blockHash: promotedFinalizedHash, tokens };
}

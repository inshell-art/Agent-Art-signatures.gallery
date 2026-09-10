import { describe, expect, it } from "vitest";
import { createIndexerState, type IndexerState } from "../v2/indexer/index.js";
import { MemoryMintStore } from "../v2/memoryStore.js";
import { unmintedProjection, type GalleryEntry } from "../v2/model.js";
import { rehearsalMintVerificationPlan } from "./rehearsalVerification.js";

const originalWallet = `0x${"11".repeat(20)}` as const;
const newHolder = `0x${"22".repeat(20)}` as const;
const contract = `0x${"33".repeat(20)}` as const;
const blockHash = `0x${"44".repeat(32)}` as const;
const txHash = `0x${"55".repeat(32)}` as const;

function fixture() {
  const snapshot = new MemoryMintStore().exportSnapshot();
  const indexer = createIndexerState({ deploymentId: "local", chainId: "31337", contract,
    deploymentBlockNumber: "1", abiVersion: "test", mintTopic: blockHash, transferTopic: txHash });
  indexer.checkpoint = { scannedHeight: "25", scannedHash: blockHash, promotedFinalizedHeight: "24", promotedFinalizedHash: blockHash };
  for (const [signatureId, tokenId] of [["seeded", 1n], ["interactive", 2n]] as const) {
    const entry: GalleryEntry = {
      ...unmintedProjection(signatureId), state: "finalized", contract, chainId: 31337n,
      tokenId, mintWallet: originalWallet, currentTokenHolder: newHolder,
      txHash, blockNumber: 2n, transactionIndex: 0, logIndex: 0,
      finalizedAt: new Date("2026-09-06T00:00:00Z"),
    };
    snapshot.projections.push([signatureId, entry]);
    snapshot.gallery.push([signatureId, entry]);
    indexer.galleryEntries.push({
      signatureId, deploymentId: "local", canonicalEventId: signatureId, tokenId: tokenId.toString(),
      mintWallet: originalWallet, txHash, blockNumber: "2", blockHash, transactionIndex: 0,
      logIndex: 0, mintedAt: "1000", finalizedAt: entry.finalizedAt.toISOString(), chainState: "finalized",
    });
    indexer.tokenHolders.push({
      deploymentId: "local", tokenId: tokenId.toString(), signatureId,
      currentHolder: newHolder, provisionalHolder: originalWallet,
      lastTransferBlockNumber: "24", lastTransferBlockHash: blockHash, lastTransferTxHash: txHash, lastTransferLogIndex: 0,
    });
  }
  return { store: MemoryMintStore.fromSnapshot(snapshot), indexer };
}

describe("local CLI verification after interactive minting", () => {
  it("allows multiple mints and transferred holders without assuming the original wallet", () => {
    const { store, indexer } = fixture();
    expect(rehearsalMintVerificationPlan(store, indexer, "seeded")).toEqual({
      blockNumber: 24n, blockHash,
      tokens: [{ tokenId: 1n, currentHolder: newHolder }, { tokenId: 2n, currentHolder: newHolder }],
    });
  });

  it("uses promoted history instead of newer provisional transfers or unscanned head", () => {
    const { store, indexer } = fixture();
    indexer.checkpoint.scannedHeight = "100";
    const plan = rehearsalMintVerificationPlan(store, indexer, "seeded");
    expect(plan.blockNumber).toBe(24n);
    expect(plan.tokens[0]!.currentHolder).toBe(newHolder);
  });

  it("requires the seeded entry, even when other valid mints exist", () => {
    const { store, indexer } = fixture();
    indexer.galleryEntries = indexer.galleryEntries.filter((entry) => entry.signatureId !== "seeded");
    expect(() => rehearsalMintVerificationPlan(store, indexer, "seeded")).toThrow("seeded mint is missing");
  });

  it.each([null, { health: "chain_safety_halt" } as IndexerState])("refuses missing or halted indexing without advising destructive reset", (indexer) => {
    expect(() => rehearsalMintVerificationPlan(fixture().store, indexer, "seeded")).toThrow("without resetting");
  });

  it("refuses a holder mismatch between the two durable projections", () => {
    const { store, indexer } = fixture();
    indexer.tokenHolders[0]!.currentHolder = originalWallet;
    expect(() => rehearsalMintVerificationPlan(store, indexer, "seeded")).toThrow("projections disagree");
  });
});

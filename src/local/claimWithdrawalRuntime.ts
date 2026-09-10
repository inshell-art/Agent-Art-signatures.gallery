import type { MemoryMintStore } from "../v2/memoryStore.js";
import type { LocalMintRuntime } from "./mintRuntime.js";

/**
 * A never-authorized claim is database-only. Signing authority is checkpointed
 * before release, so its absence can be checked under the same single-writer
 * queue without contacting Anvil. Any authority history still requires a fresh
 * successful reconciliation, including previously reconciled expiry.
 */
export function createLocalClaimWithdrawalRunner(adapters: {
  queue: LocalMintRuntime;
  mintState: MemoryMintStore;
  requireChainReady: () => Promise<void>;
}) {
  return <T>(signatureId: string, operation: () => Promise<T> | T): Promise<T> => adapters.queue.run(async () => {
    // Check inside the queue: an authorization may have been created while waiting.
    if (adapters.mintState.hasMintAuthorizationHistory(signatureId)) await adapters.requireChainReady();
    // The operation still checks owner, claim instance, projection/suppression,
    // all authorization states, and the guarded transactional database deletion.
    return operation();
  });
}

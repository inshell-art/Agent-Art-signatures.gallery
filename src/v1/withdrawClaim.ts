import type { ArtifactStore } from "./artifacts.js";
import type { SignatureStore } from "./store.js";
import type { MemoryMintStore } from "../v2/memoryStore.js";
import { V2Error } from "../v2/errors.js";

/** Run inside the same durable operation boundary as minting and reconciliation. */
export async function withdrawClaim(
  runtime: { store: SignatureStore; artifacts: ArtifactStore; mintState?: MemoryMintStore; authorize?: () => void },
  input: { signatureId: string; xUserId: string; claimInstanceId: string },
): Promise<void> {
  if (!runtime.store.withClaimLock) throw new V2Error(503, "CLAIM_WITHDRAWAL_BLOCKED", "Claim withdrawal is not available for this storage adapter.");
  await runtime.store.withClaimLock(input.signatureId, async () => {
    const signature = await runtime.store.getSignature(input.signatureId);
    if (!signature || signature.claimInstanceId !== input.claimInstanceId) throw new V2Error(409, "CLAIM_CHANGED", "This claim has changed or was already removed. Reload the page.");
    if (signature.xUserId !== input.xUserId) throw new V2Error(403, "NOT_CLAIMANT", "Only the X account that claimed this signature can withdraw it.");
    if (runtime.mintState && !runtime.mintState.canWithdrawClaim(input.signatureId)) {
      throw new V2Error(409, "CLAIM_WITHDRAWAL_BLOCKED", "A minted signature or unresolved mint authorization cannot be withdrawn. Wait for any pending mint to resolve.");
    }
    // Revalidate and consume action consent after waiting for the claim lock,
    // immediately before deletion, not before an asynchronous queue or lookup.
    runtime.authorize?.();
    if (!await runtime.store.withdraw(input.signatureId, input.xUserId, input.claimInstanceId)) throw new V2Error(409, "CLAIM_CHANGED", "This claim has changed. Reload the page.");
    runtime.mintState?.forgetWithdrawnClaim(input.signatureId);
    // Detach only this claim's references. Shared content-addressed bytes are
    // retained for other claims and cleaned by the existing fenced GC policy.
    for (const [kind, key] of [["svg", signature.svgStorageKey], ["png", signature.cardStorageKey]] as const) {
      try { await runtime.artifacts.releaseReference(kind, key, input.signatureId); }
      catch { console.error("Withdrawn claim artifact reference cleanup requires retry."); }
    }
  });
}

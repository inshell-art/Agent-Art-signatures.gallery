/**
 * Mint progress transition contract, in priority order:
 * confirmed -> reveal; submitted/unknown -> reconcile; wallet approval -> wait;
 * request expiry -> explicit return; failed/abstained -> stop; read failure ->
 * read-only recovery; pending assessment -> monitor; ready + stale proof/wallet
 * -> explicit reconnect; ready + intent -> consume once; ready -> Continue mint.
 * Reservation/voucher rejection never repeats authorization: release the busy
 * phase and require explicit continuation. A verified revert re-enters this
 * table, so an expired request cannot become mintable again.
 * This function is serialized into the client. Keep it free of module closures.
 */
export interface MintUiInput {
  assessmentStatus: string;
  mintState: string;
  requestExpired?: boolean;
  canMint?: boolean;
  walletVerified?: boolean;
  submitted?: boolean;
  uncertain?: boolean;
  awaitingApproval?: boolean;
  booting?: boolean;
  walletBusy?: boolean;
  mintBusy?: boolean;
  hasIntent?: boolean;
  readUnavailable?: boolean;
}

export function mintUiState(input: MintUiInput) {
  let phase = "ready", status = "Ready to continue";
  if (input.mintState === "minted") { phase = "confirmed"; status = "Your signature is minted."; }
  else if (input.submitted || input.mintState === "pending") { phase = "submitted"; status = "Mint submitted. Waiting to reveal your signature…"; }
  else if (input.awaitingApproval) { phase = "wallet-approval"; status = "Approve in your wallet"; }
  else if (input.uncertain) { phase = "uncertain"; status = "Checking your mint. Check wallet activity before any retry."; }
  else if (input.requestExpired) { phase = "expired"; status = "This mint request has expired."; }
  else if (input.assessmentStatus === "failed") { phase = "failed"; status = "The assessment could not be completed."; }
  else if (input.assessmentStatus === "abstained") { phase = "abstained"; status = "Grok could not choose a signature from the available evidence."; }
  else if (input.readUnavailable) { phase = "read-unavailable"; status = "Progress is temporarily unavailable. Checking again…"; }
  else if (input.assessmentStatus === "pending") { phase = "preparing"; status = "Preparing your signature…"; }
  else if (input.booting || input.mintBusy || input.hasIntent) { phase = "mint-preparing"; status = "Preparing your mint…"; }
  else if (input.walletBusy) { phase = "wallet-verifying"; status = "Verify your wallet to continue"; }
  else if (!input.canMint) { phase = "unavailable"; status = "This mint request is not available in this browser."; }
  else if (!input.walletVerified) { phase = "wallet-required"; status = "Connect your wallet to continue"; }
  return {
    phase, status,
    canSubmit: phase === "ready",
    canConnect: phase === "wallet-required" || phase === "ready",
    showReturn: phase === "expired" || phase === "unavailable",
    monitorMint: phase === "submitted" || phase === "uncertain",
    clearIntent: ["confirmed", "submitted", "uncertain", "expired", "failed", "abstained", "unavailable", "wallet-required", "read-unavailable"].includes(phase),
  };
}

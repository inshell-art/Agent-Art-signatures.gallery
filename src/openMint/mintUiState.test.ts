import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { mintUiState, type MintUiInput } from "./mintUiState.js";

const ready: MintUiInput = { assessmentStatus: "ready", mintState: "unminted", canMint: true, walletVerified: true };

describe("shared mint progress state contract", () => {
  it.each([
    [{}, "ready", true, false],
    [{ walletVerified: false }, "wallet-required", false, false],
    [{ canMint: false }, "unavailable", false, true],
    [{ assessmentStatus: "pending" }, "preparing", false, false],
    [{ assessmentStatus: "failed" }, "failed", false, false],
    [{ assessmentStatus: "abstained" }, "abstained", false, false],
    [{ booting: true }, "mint-preparing", false, false],
    [{ mintBusy: true }, "mint-preparing", false, false],
    [{ hasIntent: true }, "mint-preparing", false, false],
    [{ walletBusy: true }, "wallet-verifying", false, false],
    [{ readUnavailable: true }, "read-unavailable", false, false],
    [{ requestExpired: true }, "expired", false, true],
    [{ mintState: "pending", requestExpired: true }, "submitted", false, false],
    [{ submitted: true, requestExpired: true, readUnavailable: true }, "submitted", false, false],
    [{ uncertain: true, requestExpired: true, readUnavailable: true }, "uncertain", false, false],
    [{ awaitingApproval: true, requestExpired: true }, "wallet-approval", false, false],
    [{ mintState: "minted", uncertain: true, requestExpired: true }, "confirmed", false, false],
  ] as const)("projects %# consistently on the server and serialized client", (overrides, phase, canSubmit, showReturn) => {
    const input = { ...ready, ...overrides };
    const result = mintUiState(input);
    expect(result).toMatchObject({ phase, canSubmit, showReturn });
    expect(runInNewContext(`(${mintUiState.toString()})(input)`, { input })).toEqual(result);
  });

  it("does not revive intent after a terminal state or a read failure", () => {
    for (const state of ["failed", "abstained"]) expect(mintUiState({ ...ready, hasIntent: true, assessmentStatus: state }).clearIntent).toBe(true);
    for (const flags of [{ requestExpired: true }, { uncertain: true }, { submitted: true }, { readUnavailable: true }]) {
      expect(mintUiState({ ...ready, hasIntent: true, ...flags }).clearIntent).toBe(true);
    }
  });

  it("returns a reverted submission to expiry or explicit continuation", () => {
    expect(mintUiState({ ...ready, requestExpired: true }).canSubmit).toBe(false);
    expect(mintUiState(ready).canSubmit).toBe(true);
    expect(mintUiState({ ...ready, requestExpired: true }).showReturn).toBe(true);
  });
});

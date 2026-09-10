import { describe, expect, it } from "vitest";
import {
  acknowledgeStagedCleanup,
  activatePublicationLease,
  addDeployment,
  authorizationIssuanceMayBeEnabled,
  backfillEligibleMintControls,
  beginErasure,
  beginPublicationLease,
  completeControlledErasure,
  createPublicationControlState,
  cutoverBlockers,
  drainPublicationLeases,
  isPubliclyVisible,
  markPublicationReady,
  observeChainProjection,
  reconcileErasure,
  suppressSignatureGlobally,
} from "./control.js";
import type { CutoverReadiness, ErasureReconciliationSnapshot, PublicationControlState } from "./types.js";

const signatureId = "sg1_j5ii32jw5ccljacrqivzj3pmdoxp5mvka6avgv3izzfmvcunspva";
const deploymentA = "sepolia-v2";
const deploymentB = "mainnet-v2";
const t0 = "2026-09-04T12:00:00.000Z";
const t1 = "2026-09-04T12:01:00.000Z";
const t2 = "2026-09-04T12:02:00.000Z";
const authorizationId = "0x1111111111111111111111111111111111111111111111111111111111111111";

function seeded(deployments = [deploymentA, deploymentB]): PublicationControlState {
  return backfillEligibleMintControls(createPublicationControlState(deployments), [signatureId]);
}

function observe(state: PublicationControlState, deploymentId: string, chainState: "unminted" | "authorized" | "submitted" | "included_unfinalized" | "finalized" | "validation_pending" | "quarantined" | "finality_revoked", at = t0) {
  return observeChainProjection(state, {
    signatureId,
    deploymentId,
    state: chainState,
    canonicalEventId: chainState === "finalized" || chainState === "finality_revoked" ? "event-1" : null,
  }, at);
}

function startLease(state: PublicationControlState, id = "lease-1", now = t0): PublicationControlState {
  return beginPublicationLease(state, {
    publicationLeaseId: id,
    signatureId,
    deploymentId: deploymentA,
    expectedControlVersion: state.controls[0].version,
    now,
  });
}

function safeSnapshot(authorizations: ErasureReconciliationSnapshot["authorizations"] = []): ErasureReconciliationSnapshot {
  return {
    publicationLeasesDrained: true,
    metadataPreparationsDrained: true,
    contentWriterLeasesDrained: true,
    reorgsResolved: true,
    contiguousFinalizedCoveragePastAllDeadlines: true,
    pinnedMintedSignature: false,
    pinnedAuthorizationStates: authorizations.map((authorization) => ({ authorizationId: authorization.authorizationId, state: "unused" })),
    authorizations,
  };
}

describe("two-phase Gallery publication fencing", () => {
  it("keeps staging private until a current ready lease activates atomically", () => {
    let state = observe(seeded(), deploymentA, "finalized");
    state = startLease(state);
    expect(state.leases[0]).toMatchObject({ state: "staging", controlVersion: 1, fencingToken: 1 });
    expect(state.leases[0].stagedObjectKey).toContain("staging/sepolia-v2/");
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);

    state = markPublicationReady(state, "lease-1", "2026-09-04T12:00:30.000Z");
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);
    state = activatePublicationLease(state, "lease-1", "2026-09-04T12:00:31.000Z");
    expect(state.leases[0].state).toBe("activated");
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(true);
  });

  it("uses a monotonic fence so a superseded publisher cannot activate", () => {
    let state = observe(seeded(), deploymentA, "finalized");
    state = startLease(state, "lease-old");
    state = markPublicationReady(state, "lease-old", "2026-09-04T12:00:10.000Z");
    state = startLease(state, "lease-new", "2026-09-04T12:00:20.000Z");
    state = markPublicationReady(state, "lease-new", "2026-09-04T12:00:21.000Z");

    state = activatePublicationLease(state, "lease-old", "2026-09-04T12:00:22.000Z");
    expect(state.leases.find((lease) => lease.publicationLeaseId === "lease-old")).toMatchObject({ state: "aborted", cleanupRequired: true });
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);

    state = activatePublicationLease(state, "lease-new", "2026-09-04T12:00:23.000Z");
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(true);
    expect(state.pointers[0].fencingToken).toBe(2);
  });

  it("expires a crashed lease without exposing its staged object", () => {
    let state = observe(seeded(), deploymentA, "finalized");
    state = beginPublicationLease(state, {
      publicationLeaseId: "short",
      signatureId,
      deploymentId: deploymentA,
      expectedControlVersion: 1,
      now: t0,
      ttlMs: 1_000,
    });
    state = markPublicationReady(state, "short", "2026-09-04T12:00:01.000Z");
    expect(state.leases[0]).toMatchObject({ state: "expired", cleanupRequired: true });
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);
  });
});

describe("erasure and suppression races", () => {
  it("atomically gates every deployment before a racing promotion can activate", () => {
    let state = observe(seeded(), deploymentA, "finalized");
    state = startLease(state);
    state = markPublicationReady(state, "lease-1", "2026-09-04T12:00:10.000Z");
    const staleVersion = state.controls[0].version;

    state = beginErasure(state, { signatureId, broadReasonClass: "privacy_request", now: t1 });
    expect(state.controls[0]).toMatchObject({ issuanceState: "erasure_pending", version: staleVersion + 1, originServingEnabled: false });
    expect(state.suppressions.map((item) => item.deploymentId).sort()).toEqual([deploymentA, deploymentB].sort());
    expect(state.purgeRequests).toHaveLength(2);
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);

    state = activatePublicationLease(state, "lease-1", "2026-09-04T12:01:01.000Z");
    expect(state.leases[0]).toMatchObject({ state: "aborted", cleanupRequired: true });
    expect(() => beginPublicationLease(state, {
      publicationLeaseId: "too-late",
      signatureId,
      deploymentId: deploymentA,
      expectedControlVersion: staleVersion,
      now: t2,
    })).toThrow(/stale control version/);
  });

  it("copies an active global erasure gate into deployments added later", () => {
    let state = beginErasure(seeded([deploymentA]), { signatureId, broadReasonClass: "privacy_request", now: t0 });
    state = addDeployment(state, deploymentB, t1);
    expect(state.suppressions).toEqual(expect.arrayContaining([
      expect.objectContaining({ deploymentId: deploymentA }),
      expect.objectContaining({ deploymentId: deploymentB }),
    ]));
    expect(() => startLease(observe(state, deploymentB, "finalized"))).toThrow(/unknown deployment|disabled/);
  });

  it("requires fenced staging cleanup before unminted erasure can reconcile", () => {
    let state = observe(seeded(), deploymentA, "finalized");
    state = startLease(state);
    state = markPublicationReady(state, "lease-1", "2026-09-04T12:00:10.000Z");
    // The test models an apparently unminted replacement view after a shallow
    // reorg; the prior staged publication remains the race that must be drained.
    state = observe(state, deploymentA, "unminted", "2026-09-04T12:00:20.000Z");
    state = beginErasure(state, { signatureId, broadReasonClass: "privacy_request", now: t1 });
    state = drainPublicationLeases(state, signatureId, "2026-09-04T12:01:01.000Z");
    expect(state.leases[0]).toMatchObject({ state: "aborted", cleanupRequired: true });

    state = reconcileErasure(state, signatureId, safeSnapshot(), "2026-09-04T12:01:10.000Z");
    expect(state.erasureCases[0]).toMatchObject({ state: "pending", blockers: ["PUBLICATION_LEASES_NOT_DRAINED"] });
    state = acknowledgeStagedCleanup(state, "lease-1");
    state = reconcileErasure(state, signatureId, safeSnapshot(), "2026-09-04T12:01:20.000Z");
    expect(state.erasureCases[0]).toMatchObject({ state: "ready_for_controlled_delete", blockers: [] });
  });

  it("leaves erasure permanently when a mint finalizes during reconciliation", () => {
    let state = observe(seeded(), deploymentA, "included_unfinalized");
    state = beginErasure(state, { signatureId, broadReasonClass: "privacy_request", now: t0 });
    state = drainPublicationLeases(state, signatureId, "2026-09-04T12:00:01.000Z");
    state = observe(state, deploymentA, "finalized", t1);
    state = reconcileErasure(state, signatureId, safeSnapshot(), t2);

    expect(state.controls[0]).toMatchObject({ issuanceState: "blocked", broadReasonClass: "minted_record", originServingEnabled: false });
    expect(state.erasureCases[0].state).toBe("minted_suppressed");
    expect(state.inventories[0].v1PersonalRecordPresent).toBe(true);
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);
    expect(() => beginErasure(state, { signatureId, broadReasonClass: "again", now: "2026-09-04T12:03:00.000Z" })).toThrow(/cannot enter the erasable path/);
  });

  it("suppresses a finality_revoked entry and fences pending publication", () => {
    let state = observe(seeded(), deploymentA, "finalized");
    state = startLease(state);
    state = markPublicationReady(state, "lease-1", "2026-09-04T12:00:10.000Z");
    state = activatePublicationLease(state, "lease-1", "2026-09-04T12:00:11.000Z");
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(true);

    state = observe(state, deploymentA, "finality_revoked", t1);
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);
    expect(state.pointers[0].active).toBe(false);
    expect(state.purgeRequests).toEqual([expect.objectContaining({ reason: "finality_revoked", priority: "high" })]);
    expect(() => startLease(state, "after-revocation", t2)).toThrow(/only a finalized/);
  });

  it("keeps durable legal suppression separate from chain projection", () => {
    let state = observe(seeded(), deploymentA, "finalized");
    state = startLease(state);
    state = markPublicationReady(state, "lease-1", "2026-09-04T12:00:10.000Z");
    state = activatePublicationLease(state, "lease-1", "2026-09-04T12:00:11.000Z");
    state = suppressSignatureGlobally(state, { signatureId, broadReasonClass: "legal_request", now: t1 });
    expect(state.chainProjections[0].state).toBe("finalized");
    expect(state.suppressions).toHaveLength(2);
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);
  });
});

describe("safely-unminted controlled deletion", () => {
  it("blocks active/uncertain authority and pinned-state uncertainty", () => {
    let state = beginErasure(seeded(), { signatureId, broadReasonClass: "privacy_request", now: t0 });
    const uncertain = safeSnapshot([{ authorizationId, state: "signing_unknown" }]);
    uncertain.pinnedMintedSignature = "unavailable";
    uncertain.pinnedAuthorizationStates = [{ authorizationId, state: "unavailable" }];
    state = reconcileErasure(state, signatureId, uncertain, t1);
    expect(state.erasureCases[0].state).toBe("pending");
    expect(state.erasureCases[0].blockers).toEqual(expect.arrayContaining([
      "PINNED_MINT_STATE_UNAVAILABLE",
      `AUTHORIZATION_NOT_SAFELY_DEAD:${authorizationId}`,
      `AUTHORIZATION_STATE_UNCONFIRMED:${authorizationId}`,
    ]));
  });

  it("erases only after every authority is safely dead and retains a non-personal terminal tombstone", () => {
    let state = beginErasure(seeded(), { signatureId, broadReasonClass: "privacy_request", now: t0 });
    state = drainPublicationLeases(state, signatureId, "2026-09-04T12:00:01.000Z");
    state = reconcileErasure(state, signatureId, safeSnapshot([
      { authorizationId, state: "expired_unused_finalized" },
    ]), t1);
    expect(state.erasureCases[0].state).toBe("ready_for_controlled_delete");

    state = completeControlledErasure(state, {
      signatureId,
      now: t2,
      deletingLastRetainedSignature: true,
      noMintLegalOrSecurityObligation: true,
    });
    expect(state.controls[0]).toMatchObject({ issuanceState: "erased", originServingEnabled: false });
    expect(state.inventories[0]).toEqual({
      signatureId,
      transactionHintsPresent: false,
      authorizationPayloadsPresent: false,
      signerAssociationsPresent: false,
      tokenMetadataPresent: false,
      pinProviderReceiptsPresent: false,
      contentReferencesPresent: false,
      v1PersonalRecordPresent: false,
      accountIdentityPresent: false,
      tombstone: { signatureId, erasedAt: t2, broadReasonClass: "privacy_request" },
    });
    expect(state.suppressions).toHaveLength(2);
    expect(() => beginErasure(state, { signatureId, broadReasonClass: "retry", now: "2026-09-04T12:03:00.000Z" })).toThrow(/never re-enter/);
  });

  it("does not delete shared account identity when another retained obligation remains", () => {
    let state = beginErasure(seeded(), { signatureId, broadReasonClass: "privacy_request", now: t0 });
    state = reconcileErasure(state, signatureId, safeSnapshot(), t1);
    state = completeControlledErasure(state, {
      signatureId,
      now: t2,
      deletingLastRetainedSignature: false,
      noMintLegalOrSecurityObligation: true,
    });
    expect(state.inventories[0].accountIdentityPresent).toBe(true);
  });
});

describe("additive V2 cutover gates", () => {
  const ready: CutoverReadiness = {
    v1BackupComplete: true,
    additiveSchemaApplied: true,
    mintControlsBackfilled: true,
    contentReferencesBackfilled: true,
    v1WritersUseSharedFencing: true,
    localContractTestsPassed: true,
    sepoliaDeploymentVerified: true,
    indexerFullRebuildVerified: true,
    endpointsBehindDisabledFlag: true,
    sepoliaRehearsalPassed: true,
    securityReviewPassed: true,
    productionRunbookCreatedNotExecuted: true,
    explicitMainnetDeploymentApproval: true,
    mainnetDeploymentVerified: true,
    roleTransferVerified: true,
    sourceAndBytecodeVerified: true,
    rpcAgreementHealthy: true,
    signerHealthy: true,
    redundantPinHealthVerified: true,
    publicationFencingVerified: true,
  };

  it("backfills controls without auto-publishing, minting, suppressing, or changing visibility", () => {
    const state = backfillEligibleMintControls(createPublicationControlState([deploymentA]), [signatureId]);
    expect(state.controls).toEqual([expect.objectContaining({ issuanceState: "enabled", version: 1 })]);
    expect(state.chainProjections).toEqual([]);
    expect(state.leases).toEqual([]);
    expect(state.pointers).toEqual([]);
    expect(state.suppressions).toEqual([]);
    expect(isPubliclyVisible(state, signatureId, deploymentA)).toBe(false);
  });

  it("fails production closed without explicit mainnet approval or any post-deploy health gate", () => {
    expect(authorizationIssuanceMayBeEnabled(ready, "sepolia")).toBe(true);
    expect(authorizationIssuanceMayBeEnabled(ready, "mainnet")).toBe(true);
    const blocked = { ...ready, explicitMainnetDeploymentApproval: false, redundantPinHealthVerified: false };
    expect(authorizationIssuanceMayBeEnabled(blocked, "mainnet")).toBe(false);
    expect(cutoverBlockers(blocked, "mainnet")).toEqual(expect.arrayContaining([
      "explicitMainnetDeploymentApproval",
      "redundantPinHealthVerified",
    ]));
  });

  it.each([
    "roleTransferVerified",
    "sourceAndBytecodeVerified",
    "rpcAgreementHealthy",
    "signerHealthy",
    "redundantPinHealthVerified",
  ] as const)("fails Sepolia closed while %s is false", (gate) => {
    const blocked = { ...ready, [gate]: false };
    expect(authorizationIssuanceMayBeEnabled(blocked, "sepolia")).toBe(false);
    expect(cutoverBlockers(blocked, "sepolia")).toContain(gate);
  });
});

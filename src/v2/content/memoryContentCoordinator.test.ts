import { describe, expect, it } from "vitest";
import {
  ContentCoordinationError,
  MemoryContentCoordinator,
  type ContentCoordinationErrorCode,
  type ContentReferenceIntent,
  type MetadataWorkerHandle,
  type WriteAuthority,
} from "./memoryContentCoordinator.js";

class ManualClock {
  value = 1_788_516_000_000;
  readonly now = (): number => this.value;

  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
const pngBytes = Buffer.from("exact-png-fixture");
const metadataBytes = Buffer.from('{"name":"exact canonical metadata"}');

function errorCode(action: () => unknown): ContentCoordinationErrorCode | null {
  try {
    action();
    return null;
  } catch (error) {
    if (!(error instanceof ContentCoordinationError)) throw error;
    return error.code;
  }
}

function v1Reference(signatureId: string, objectKey = "sha256/shared-svg.svg"): ContentReferenceIntent {
  return {
    storageTargetId: "v1-primary",
    objectKey,
    kind: "v1_svg",
    referenceId: signatureId,
  };
}

function metadataPlan(
  signatureId: string,
  deploymentId = "sepolia-canonical",
  sharedSvgKey = "bafy-shared-svg",
): ContentReferenceIntent[] {
  const objects = [
    ["v2_svg_pin", sharedSvgKey],
    ["v2_png_pin", `bafy-png-${signatureId}`],
    ["v2_metadata_pin", `bafy-metadata-${signatureId}-${deploymentId}`],
  ] as const;
  return objects.flatMap(([kind, objectKey]) => ["pin-a", "pin-b"].map((storageTargetId) => ({
    storageTargetId,
    objectKey,
    kind,
    referenceId: `${signatureId}:${deploymentId}:${kind}`,
  })));
}

function bytesFor(reference: ContentReferenceIntent): Uint8Array {
  if (reference.kind === "v2_svg_pin" || reference.kind === "v1_svg") return svgBytes;
  if (reference.kind === "v2_png_pin" || reference.kind === "v1_png") return pngBytes;
  return metadataBytes;
}

function writeAndCommit(
  coordinator: MemoryContentCoordinator,
  reference: ContentReferenceIntent,
  authority: WriteAuthority,
  owner = "writer",
) {
  const lease = coordinator.beginWrite({
    owner,
    purpose: reference.kind,
    ttlMs: 1_000,
    reference,
    authority,
  });
  coordinator.putExternal(lease.leaseId, bytesFor(reference));
  coordinator.verifyExternal(lease.leaseId, bytesFor(reference));
  return { lease, reference: coordinator.commitWrite(lease.leaseId) };
}

function reserveAndPublish(
  coordinator: MemoryContentCoordinator,
  signatureId: string,
  deploymentId = "sepolia-canonical",
  sharedSvgKey?: string,
): { handle: MetadataWorkerHandle; plan: ContentReferenceIntent[] } {
  coordinator.registerSignature(signatureId);
  const plan = metadataPlan(signatureId, deploymentId, sharedSvgKey);
  const handle = coordinator.reserveMetadata({
    signatureId,
    deploymentId,
    owner: `metadata-worker-${signatureId}`,
    ttlMs: 5_000,
    requiredReferences: plan,
  });
  coordinator.beginMetadataPublishing(handle);
  for (const reference of plan) {
    writeAndCommit(coordinator, reference, { kind: "metadata", handle }, handle.owner);
  }
  return { handle, plan };
}

describe("content-object writer fencing", () => {
  it("requires a durable control, external put, and exact independent verification before commit", () => {
    const coordinator = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const reference = v1Reference("sg-missing-control");
    expect(errorCode(() => coordinator.beginWrite({
      owner: "v1",
      purpose: "claim",
      ttlMs: 1_000,
      reference,
      authority: { kind: "v1", signatureId: "sg-missing-control", controlVersion: 1n },
    }))).toBe("CONTROL_MISSING");

    const control = coordinator.registerSignature("sg-a");
    const lease = coordinator.beginWrite({
      owner: "v1",
      purpose: "claim",
      ttlMs: 1_000,
      reference: v1Reference("sg-a"),
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    });
    expect(errorCode(() => coordinator.commitWrite(lease.leaseId))).toBe("EXTERNAL_OBJECT_MISSING");

    coordinator.putExternal(lease.leaseId, svgBytes);
    expect(errorCode(() => coordinator.commitWrite(lease.leaseId))).toBe("EXTERNAL_OBJECT_UNVERIFIED");
    expect(errorCode(() => coordinator.verifyExternal(lease.leaseId, Buffer.from("wrong"))))
      .toBe("EXTERNAL_OBJECT_MISMATCH");

    coordinator.verifyExternal(lease.leaseId, svgBytes);
    expect(coordinator.commitWrite(lease.leaseId)).toMatchObject({
      kind: "v1_svg",
      referenceId: "sg-a",
    });
    expect(coordinator.getGuard("v1-primary", "sha256/shared-svg.svg")?.state).toBe("present");
    coordinator.assertInvariants();
  });

  it("lets only the newest concurrent writer attach while preserving an earlier committed reference", () => {
    const coordinator = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const a = coordinator.registerSignature("sg-a");
    const b = coordinator.registerSignature("sg-b");
    const refA = v1Reference("sg-a");
    const refB = v1Reference("sg-b");
    const leaseA = coordinator.beginWrite({
      owner: "a",
      purpose: "claim-a",
      ttlMs: 2_000,
      reference: refA,
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: a.version },
    });
    const leaseB = coordinator.beginWrite({
      owner: "b",
      purpose: "claim-b",
      ttlMs: 2_000,
      reference: refB,
      authority: { kind: "v1", signatureId: "sg-b", controlVersion: b.version },
    });
    for (const lease of [leaseA, leaseB]) {
      coordinator.putExternal(lease.leaseId, svgBytes);
      coordinator.verifyExternal(lease.leaseId, svgBytes);
    }
    expect(errorCode(() => coordinator.commitWrite(leaseA.leaseId))).toBe("STALE_FENCE");
    coordinator.commitWrite(leaseB.leaseId);

    writeAndCommit(
      coordinator,
      refA,
      { kind: "v1", signatureId: "sg-a", controlVersion: a.version },
      "a-retry",
    );
    expect(coordinator.listReferences("v1-primary", refA.objectKey).map((item) => item.referenceId).sort())
      .toEqual(["sg-a", "sg-b"]);
    expect(coordinator.externalWriteCount("v1-primary", refA.objectKey)).toBe(3);
    coordinator.assertInvariants();
  });

  it("rejects a different byte sequence under the same content-addressed key without corrupting the first write", () => {
    const coordinator = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const control = coordinator.registerSignature("sg-a");
    const first = coordinator.beginWrite({
      owner: "first",
      purpose: "claim",
      ttlMs: 1_000,
      reference: v1Reference("sg-a"),
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    });
    coordinator.putExternal(first.leaseId, svgBytes);

    const second = coordinator.beginWrite({
      owner: "second",
      purpose: "retry",
      ttlMs: 1_000,
      reference: v1Reference("sg-a"),
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    });
    expect(errorCode(() => coordinator.putExternal(second.leaseId, Buffer.from("different"))))
      .toBe("CONTENT_KEY_COLLISION");
    expect(Buffer.from(coordinator.getExternalBytes("v1-primary", first.objectKey) ?? []).equals(svgBytes)).toBe(true);
  });

  it("makes commit idempotent but never returns mutable internal records", () => {
    const coordinator = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const control = coordinator.registerSignature("sg-a");
    const { lease, reference } = writeAndCommit(
      coordinator,
      v1Reference("sg-a"),
      { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    );
    expect(coordinator.commitWrite(lease.leaseId)).toEqual(reference);

    reference.referenceId = "tampered";
    const bytes = coordinator.getExternalBytes("v1-primary", "sha256/shared-svg.svg")!;
    bytes[0] ^= 0xff;
    expect(coordinator.listReferences()[0].referenceId).toBe("sg-a");
    expect(Buffer.from(coordinator.getExternalBytes("v1-primary", "sha256/shared-svg.svg")!).equals(svgBytes)).toBe(true);
    coordinator.assertInvariants();
  });
});

describe("GC grace, crash recovery, and orphan reconciliation", () => {
  it("retains identical bytes until the last independent reference is released", () => {
    const coordinator = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const a = coordinator.registerSignature("sg-a");
    const b = coordinator.registerSignature("sg-b");
    const refA = v1Reference("sg-a");
    const refB = v1Reference("sg-b");
    writeAndCommit(coordinator, refA, { kind: "v1", signatureId: "sg-a", controlVersion: a.version });
    writeAndCommit(coordinator, refB, { kind: "v1", signatureId: "sg-b", controlVersion: b.version });

    coordinator.releaseReference(refA);
    expect(errorCode(() => coordinator.beginGc("v1-primary", refA.objectKey, 1_000)))
      .toBe("REFERENCES_REMAIN");
    expect(coordinator.hasExternalObject("v1-primary", refA.objectKey)).toBe(true);

    coordinator.releaseReference(refB);
    expect(coordinator.beginGc("v1-primary", refA.objectKey, 1_000).fencingToken).toBeGreaterThan(0n);
  });

  it("blocks GC for every unexpired writer, including an older already-fenced writer", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now, minimumPinReplicas: 1 });
    const a = coordinator.registerSignature("sg-a");
    const b = coordinator.registerSignature("sg-b");
    const oldLease = coordinator.beginWrite({
      owner: "old",
      purpose: "old",
      ttlMs: 2_000,
      reference: v1Reference("sg-a"),
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: a.version },
    });
    const newest = coordinator.beginWrite({
      owner: "new",
      purpose: "new",
      ttlMs: 500,
      reference: v1Reference("sg-b"),
      authority: { kind: "v1", signatureId: "sg-b", controlVersion: b.version },
    });
    coordinator.abortWrite(newest.leaseId);
    expect(errorCode(() => coordinator.beginGc("v1-primary", oldLease.objectKey, 1_000)))
      .toBe("LIVE_WRITER_EXISTS");

    clock.advance(2_001);
    const fence = coordinator.beginGc("v1-primary", oldLease.objectKey, 1_000);
    expect(fence.fencingToken).toBeGreaterThan(oldLease.fencingToken);
  });

  it("recovers after crashes before and after external deletion", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now, minimumPinReplicas: 1 });
    const control = coordinator.registerSignature("sg-a");
    const ref = v1Reference("sg-a");
    writeAndCommit(coordinator, ref, { kind: "v1", signatureId: "sg-a", controlVersion: control.version });
    coordinator.releaseReference(ref);

    const firstFence = coordinator.beginGc(ref.storageTargetId, ref.objectKey, 1_000);
    const recoveredFence = coordinator.beginGc(ref.storageTargetId, ref.objectKey, 9_999);
    expect(recoveredFence).toEqual(firstFence);
    expect(errorCode(() => coordinator.deleteExternalForGc(firstFence))).toBe("GC_GRACE_ACTIVE");

    clock.advance(1_000);
    coordinator.deleteExternalForGc(firstFence);
    // Crash here: a new reconciler resumes the same durable fence.
    expect(coordinator.beginGc(ref.storageTargetId, ref.objectKey, 1_000)).toEqual(firstFence);
    expect(coordinator.completeGc(firstFence).state).toBe("absent");
    expect(coordinator.hasExternalObject(ref.storageTargetId, ref.objectKey)).toBe(false);
  });

  it("repeats deletion when a delayed stale write lands after the first delete", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now, minimumPinReplicas: 1 });
    const control = coordinator.registerSignature("sg-a");
    const reference = v1Reference("sg-a");
    const lease = coordinator.beginWrite({
      owner: "slow-request",
      purpose: "claim",
      ttlMs: 100,
      reference,
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    });
    clock.advance(101);
    const fence = coordinator.beginGc(reference.storageTargetId, reference.objectKey, 500);
    clock.advance(500);
    coordinator.deleteExternalForGc(fence);

    coordinator.putExternal(lease.leaseId, svgBytes);
    expect(errorCode(() => coordinator.completeGc(fence))).toBe("OBJECT_STILL_PRESENT");
    coordinator.deleteExternalForGc(fence);
    coordinator.completeGc(fence);
    expect(errorCode(() => coordinator.commitWrite(lease.leaseId))).toBe("WRITE_LEASE_EXPIRED");
  });

  it("sweeps a delayed orphan that lands after the guard was marked absent", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now, minimumPinReplicas: 1 });
    const control = coordinator.registerSignature("sg-a");
    const reference = v1Reference("sg-a");
    const lease = coordinator.beginWrite({
      owner: "slow-request",
      purpose: "claim",
      ttlMs: 100,
      reference,
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    });
    clock.advance(101);
    const fence = coordinator.beginGc(reference.storageTargetId, reference.objectKey, 500);
    clock.advance(500);
    coordinator.deleteExternalForGc(fence);
    coordinator.completeGc(fence);

    coordinator.putExternal(lease.leaseId, svgBytes);
    expect(coordinator.hasExternalObject(reference.storageTargetId, reference.objectKey)).toBe(true);
    expect(coordinator.sweepOrphan(reference.storageTargetId, reference.objectKey)).toBe(true);
    expect(coordinator.sweepOrphan(reference.storageTargetId, reference.objectKey)).toBe(false);
  });

  it("refuses every new writer while deletion_pending, then permits a verified rewrite after absent", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now, minimumPinReplicas: 1 });
    const control = coordinator.registerSignature("sg-a");
    const reference = v1Reference("sg-a");
    const committed = writeAndCommit(
      coordinator,
      reference,
      { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    );
    coordinator.releaseReference(reference);
    const fence = coordinator.beginGc(reference.storageTargetId, reference.objectKey, 500);
    expect(errorCode(() => coordinator.beginWrite({
      owner: "blocked",
      purpose: "retry",
      ttlMs: 1_000,
      reference,
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    }))).toBe("DELETION_PENDING");

    clock.advance(500);
    coordinator.deleteExternalForGc(fence);
    coordinator.completeGc(fence);
    const rewritten = writeAndCommit(
      coordinator,
      reference,
      { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
      "rewrite",
    );
    expect(rewritten.lease.fencingToken).toBeGreaterThan(committed.lease.fencingToken);
    coordinator.assertInvariants();
  });
});

describe("metadata reservation, publication, freeze, and erasure", () => {
  it("requires two independent retained targets for every V2 object role", () => {
    const coordinator = new MemoryContentCoordinator();
    coordinator.registerSignature("sg-a");
    const incomplete = metadataPlan("sg-a").filter((reference) => reference.storageTargetId === "pin-a");
    expect(errorCode(() => coordinator.reserveMetadata({
      signatureId: "sg-a",
      deploymentId: "sepolia-canonical",
      owner: "worker",
      ttlMs: 1_000,
      requiredReferences: incomplete,
    }))).toBe("MISSING_REPLICA");
  });

  it("does not verify metadata until every planned provider reference has exact verified bytes", () => {
    const coordinator = new MemoryContentCoordinator();
    coordinator.registerSignature("sg-a");
    const plan = metadataPlan("sg-a");
    const handle = coordinator.reserveMetadata({
      signatureId: "sg-a",
      deploymentId: "sepolia-canonical",
      owner: "worker",
      ttlMs: 5_000,
      requiredReferences: plan,
    });
    coordinator.beginMetadataPublishing(handle);
    for (const reference of plan.slice(0, -1)) {
      writeAndCommit(coordinator, reference, { kind: "metadata", handle });
    }
    expect(errorCode(() => coordinator.markMetadataVerified(handle))).toBe("MISSING_REPLICA");

    writeAndCommit(coordinator, plan.at(-1)!, { kind: "metadata", handle });
    expect(coordinator.markMetadataVerified(handle).state).toBe("verified");
    expect(coordinator.freezeMetadata("sg-a", "sepolia-canonical", 1n).state).toBe("frozen");
    expect(errorCode(() => coordinator.reserveMetadata({
      signatureId: "sg-a",
      deploymentId: "sepolia-canonical",
      owner: "replacement",
      ttlMs: 5_000,
      requiredReferences: plan,
    }))).toBe("METADATA_FROZEN");
    coordinator.assertInvariants();
  });

  it("recovers an expired publish lease without letting the old worker attach anything", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now });
    coordinator.registerSignature("sg-a");
    const plan = metadataPlan("sg-a");
    const oldHandle = coordinator.reserveMetadata({
      signatureId: "sg-a",
      deploymentId: "sepolia-canonical",
      owner: "crashed-worker",
      ttlMs: 100,
      requiredReferences: plan,
    });
    coordinator.beginMetadataPublishing(oldHandle);
    writeAndCommit(coordinator, plan[0], { kind: "metadata", handle: oldHandle });
    clock.advance(101);

    const recovered = coordinator.reserveMetadata({
      signatureId: "sg-a",
      deploymentId: "sepolia-canonical",
      owner: "recovery-worker",
      ttlMs: 5_000,
      requiredReferences: plan,
    });
    expect(recovered.fencingToken).toBeGreaterThan(oldHandle.fencingToken);
    expect(errorCode(() => coordinator.beginWrite({
      owner: "late-old-worker",
      purpose: "late",
      ttlMs: 1_000,
      reference: plan[1],
      authority: { kind: "metadata", handle: oldHandle },
    }))).toBe("STALE_FENCE");

    for (const reference of plan.slice(1)) {
      writeAndCommit(coordinator, reference, { kind: "metadata", handle: recovered });
    }
    coordinator.markMetadataVerified(recovered);
    coordinator.freezeMetadata("sg-a", "sepolia-canonical", 1n);
    coordinator.assertInvariants();
  });

  it("fences an in-flight preparation atomically with erasure and rejects its delayed commit", () => {
    const coordinator = new MemoryContentCoordinator();
    coordinator.registerSignature("sg-a");
    const plan = metadataPlan("sg-a");
    const handle = coordinator.reserveMetadata({
      signatureId: "sg-a",
      deploymentId: "sepolia-canonical",
      owner: "worker",
      ttlMs: 5_000,
      requiredReferences: plan,
    });
    coordinator.beginMetadataPublishing(handle);
    writeAndCommit(coordinator, plan[0], { kind: "metadata", handle });
    const delayed = coordinator.beginWrite({
      owner: "worker",
      purpose: "delayed-pin",
      ttlMs: 5_000,
      reference: plan[1],
      authority: { kind: "metadata", handle },
    });
    coordinator.putExternal(delayed.leaseId, bytesFor(plan[1]));
    coordinator.verifyExternal(delayed.leaseId, bytesFor(plan[1]));

    const control = coordinator.beginErasure("sg-a", "participant_request");
    expect(control.state).toBe("erasure_pending");
    expect(coordinator.getMetadata("sg-a", "sepolia-canonical")?.state).toBe("aborting");
    expect(coordinator.getLease(delayed.leaseId)?.state).toBe("aborted");
    expect(errorCode(() => coordinator.commitWrite(delayed.leaseId))).toBe("WRITE_LEASE_TERMINAL");

    expect(coordinator.finishMetadataAbort("sg-a", "sepolia-canonical").state).toBe("aborted");
    expect(coordinator.listReferences().filter((reference) => reference.controlSignatureId === "sg-a"))
      .toEqual([]);
    coordinator.eraseMetadata("sg-a", "sepolia-canonical", { authorityReconciled: true });
    expect(coordinator.completeErasure("sg-a").state).toBe("erased");
    expect(errorCode(() => coordinator.registerSignature("sg-a"))).toBe("ERASED_TOMBSTONE");
    coordinator.assertInvariants();
  });

  it("requires explicit authority reconciliation and full drain before sealing the erased tombstone", () => {
    const coordinator = new MemoryContentCoordinator();
    const { handle } = reserveAndPublish(coordinator, "sg-a");
    coordinator.markMetadataVerified(handle);
    coordinator.freezeMetadata("sg-a", "sepolia-canonical", 1n);
    coordinator.beginErasure("sg-a", "participant_request");
    expect(errorCode(() => coordinator.completeErasure("sg-a"))).toBe("ERASURE_NOT_DRAINED");
    expect(errorCode(() => (coordinator.eraseMetadata as (
      signatureId: string,
      deploymentId: string,
      options: { authorityReconciled: boolean },
    ) => void)("sg-a", "sepolia-canonical", { authorityReconciled: false })))
      .toBe("AUTHORITY_NOT_RECONCILED");

    coordinator.eraseMetadata("sg-a", "sepolia-canonical", { authorityReconciled: true });
    coordinator.completeErasure("sg-a");
    expect(errorCode(() => coordinator.reserveMetadata({
      signatureId: "sg-a",
      deploymentId: "sepolia-canonical",
      owner: "resurrection",
      ttlMs: 1_000,
      requiredReferences: metadataPlan("sg-a"),
    }))).toBe("ERASED_TOMBSTONE");
  });

  it("removes only the erased signature's references when another signature shares the same SVG CIDs", () => {
    const coordinator = new MemoryContentCoordinator();
    const first = reserveAndPublish(coordinator, "sg-a", "sepolia-canonical", "bafy-identical-svg");
    coordinator.markMetadataVerified(first.handle);
    coordinator.freezeMetadata("sg-a", "sepolia-canonical", 1n);
    const second = reserveAndPublish(coordinator, "sg-b", "sepolia-canonical", "bafy-identical-svg");
    coordinator.markMetadataVerified(second.handle);
    coordinator.freezeMetadata("sg-b", "sepolia-canonical", 1n);

    coordinator.beginErasure("sg-a", "participant_request");
    coordinator.eraseMetadata("sg-a", "sepolia-canonical", { authorityReconciled: true });
    coordinator.completeErasure("sg-a");

    for (const target of ["pin-a", "pin-b"]) {
      const shared = coordinator.listReferences(target, "bafy-identical-svg");
      expect(shared).toHaveLength(1);
      expect(shared[0].controlSignatureId).toBe("sg-b");
      expect(errorCode(() => coordinator.beginGc(target, "bafy-identical-svg", 1_000)))
        .toBe("REFERENCES_REMAIN");
    }
    coordinator.assertInvariants();
  });

  it("serializes concurrent V1 and V2 writers through one hash/CID guard", () => {
    const coordinator = new MemoryContentCoordinator();
    const v1Control = coordinator.registerSignature("sg-v1");
    coordinator.registerSignature("sg-v2");
    const plan = metadataPlan("sg-v2");
    const sharedV2 = plan[0];
    const v1 = {
      storageTargetId: sharedV2.storageTargetId,
      objectKey: sharedV2.objectKey,
      kind: "v1_svg" as const,
      referenceId: "sg-v1",
    };
    const handle = coordinator.reserveMetadata({
      signatureId: "sg-v2",
      deploymentId: "sepolia-canonical",
      owner: "v2-worker",
      ttlMs: 5_000,
      requiredReferences: plan,
    });
    coordinator.beginMetadataPublishing(handle);

    const v1Lease = coordinator.beginWrite({
      owner: "v1-worker",
      purpose: "claim",
      ttlMs: 5_000,
      reference: v1,
      authority: { kind: "v1", signatureId: "sg-v1", controlVersion: v1Control.version },
    });
    const v2Lease = coordinator.beginWrite({
      owner: "v2-worker",
      purpose: "pin",
      ttlMs: 5_000,
      reference: sharedV2,
      authority: { kind: "metadata", handle },
    });
    for (const lease of [v1Lease, v2Lease]) {
      coordinator.putExternal(lease.leaseId, svgBytes);
      coordinator.verifyExternal(lease.leaseId, svgBytes);
    }
    expect(errorCode(() => coordinator.commitWrite(v1Lease.leaseId))).toBe("STALE_FENCE");
    coordinator.commitWrite(v2Lease.leaseId);
    writeAndCommit(
      coordinator,
      v1,
      { kind: "v1", signatureId: "sg-v1", controlVersion: v1Control.version },
      "v1-retry",
    );
    expect(coordinator.listReferences(v1.storageTargetId, v1.objectKey)).toHaveLength(2);
    coordinator.assertInvariants();
  });
});

describe("input and state-machine fail-closed behavior", () => {
  it("rejects non-positive leases/grace periods and wrong authority/reference classes", () => {
    const coordinator = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const control = coordinator.registerSignature("sg-a");
    expect(errorCode(() => coordinator.beginWrite({
      owner: "writer",
      purpose: "claim",
      ttlMs: 0,
      reference: v1Reference("sg-a"),
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    }))).toBe("INVALID_ARGUMENT");
    expect(errorCode(() => coordinator.beginGc("target", "key", -1))).toBe("INVALID_ARGUMENT");
  });

  it("invalidates every active lease when a control is blocked", () => {
    const coordinator = new MemoryContentCoordinator({ minimumPinReplicas: 1 });
    const control = coordinator.registerSignature("sg-a");
    const lease = coordinator.beginWrite({
      owner: "writer",
      purpose: "claim",
      ttlMs: 5_000,
      reference: v1Reference("sg-a"),
      authority: { kind: "v1", signatureId: "sg-a", controlVersion: control.version },
    });
    coordinator.putExternal(lease.leaseId, svgBytes);
    coordinator.verifyExternal(lease.leaseId, svgBytes);
    const blocked = coordinator.blockSignature("sg-a", "security_hold");
    expect(blocked.version).toBe(2n);
    expect(coordinator.getLease(lease.leaseId)?.state).toBe("aborted");
    expect(errorCode(() => coordinator.commitWrite(lease.leaseId))).toBe("WRITE_LEASE_TERMINAL");
    expect(coordinator.listReferences()).toEqual([]);
  });
});

describe("metadata reservation conflicts", () => {
  const signatureId = "sg1_reservation";
  const deploymentId = "sepolia-canonical";

  const setup = () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now });
    coordinator.registerSignature(signatureId);
    const plan = metadataPlan(signatureId, deploymentId);
    const reserve = (owner: string, ttlMs = 5_000, references = plan) =>
      coordinator.reserveMetadata({ signatureId, deploymentId, owner, ttlMs, requiredReferences: references });
    return { clock, coordinator, plan, reserve };
  };

  it("returns the same live reservation to the worker that already owns it", () => {
    const { reserve } = setup();
    const first = reserve("worker-a");
    const again = reserve("worker-a");
    expect(again.owner).toBe(first.owner);
    expect(again.fencingToken).toBe(first.fencingToken);
  });

  it("refuses a second worker while the reservation lease is still live", () => {
    const { reserve } = setup();
    reserve("worker-a");
    expect(errorCode(() => reserve("worker-b"))).toBe("METADATA_LEASE_HELD");
  });

  it("hands the reservation to a new worker once the lease expires, with a higher fencing token", () => {
    const { clock, reserve } = setup();
    const first = reserve("worker-a", 1_000);
    clock.advance(1_001);
    const second = reserve("worker-b", 1_000);
    expect(second.owner).toBe("worker-b");
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
  });

  it("refuses a reservation that would change the immutable object identities", () => {
    const { coordinator, reserve } = setup();
    reserve("worker-a");
    const different = metadataPlan(signatureId, deploymentId, "bafy-other-shared-svg");
    expect(errorCode(() => coordinator.reserveMetadata({
      signatureId, deploymentId, owner: "worker-a", ttlMs: 5_000, requiredReferences: different,
    }))).toBe("METADATA_EXISTS");
  });

  it("fences a reservation whose signature control has moved on", () => {
    const { coordinator, reserve } = setup();
    reserve("worker-a");
    coordinator.blockSignature(signatureId, "moderation hold");
    expect(errorCode(() => reserve("worker-a"))).toBeTruthy();
  });

  it("refuses to re-lease metadata that is already verified or frozen", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now });
    const { handle, plan } = reserveAndPublish(coordinator, signatureId, deploymentId);
    coordinator.markMetadataVerified(handle);
    const reserve = (owner: string) => coordinator.reserveMetadata({
      signatureId, deploymentId, owner, ttlMs: 5_000, requiredReferences: plan,
    });
    expect(errorCode(() => reserve(handle.owner))).toBe("METADATA_NOT_VERIFIED");
    coordinator.freezeMetadata(signatureId, deploymentId, coordinator.getControl(signatureId)!.version);
    expect(errorCode(() => reserve(handle.owner))).toBe("METADATA_FROZEN");
  });

  it("refuses to recreate a terminal metadata preparation", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now });
    coordinator.registerSignature(signatureId);
    const plan = metadataPlan(signatureId, deploymentId);
    const handle = coordinator.reserveMetadata({ signatureId, deploymentId, owner: "worker-a", ttlMs: 5_000, requiredReferences: plan });
    coordinator.beginMetadataPublishing(handle);
    coordinator.beginErasure(signatureId, "claim withdrawn");
    expect(errorCode(() => coordinator.reserveMetadata({
      signatureId, deploymentId, owner: "worker-a", ttlMs: 5_000, requiredReferences: plan,
    }))).toBeTruthy();
  });

  it("validates its own reservation inputs before touching any control", () => {
    const { coordinator, plan } = setup();
    const bad = (overrides: Record<string, unknown>) => errorCode(() => coordinator.reserveMetadata({
      signatureId, deploymentId, owner: "worker-a", ttlMs: 5_000, requiredReferences: plan, ...overrides,
    } as Parameters<MemoryContentCoordinator["reserveMetadata"]>[0]));
    expect(bad({ signatureId: "" })).toBeTruthy();
    expect(bad({ deploymentId: "" })).toBeTruthy();
    expect(bad({ owner: "" })).toBeTruthy();
    expect(bad({ ttlMs: 0 })).toBeTruthy();
    expect(bad({ ttlMs: -1 })).toBeTruthy();
  });
});

describe("writer lease expiry and deletion fences", () => {
  const signatureId = "sg1_fences";

  const coordinatorWithObject = () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now });
    const control = coordinator.registerSignature(signatureId);
    const reference = v1Reference(signatureId);
    writeAndCommit(coordinator, reference, { kind: "v1", signatureId, controlVersion: control.version });
    return { clock, coordinator, reference };
  };

  it("expires only the writing leases whose deadline has passed", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now });
    const control = coordinator.registerSignature(signatureId);
    const authority: WriteAuthority = { kind: "v1", signatureId, controlVersion: control.version };
    const short = coordinator.beginWrite({ owner: "short", purpose: "v1_svg", ttlMs: 1_000, reference: v1Reference(signatureId, "sha256/a.svg"), authority });
    const long = coordinator.beginWrite({ owner: "long", purpose: "v1_svg", ttlMs: 10_000, reference: v1Reference(signatureId, "sha256/b.svg"), authority });

    expect(coordinator.expireWriterLeases()).toBe(0);
    clock.advance(1_001);
    expect(coordinator.expireWriterLeases()).toBe(1);
    expect(coordinator.getLease(short.leaseId)?.state).toBe("expired");
    expect(coordinator.getLease(long.leaseId)?.state).toBe("writing");
    // Expiry is not repeated for a lease already marked.
    expect(coordinator.expireWriterLeases()).toBe(0);
  });

  it("refuses to begin deletion while a durable reference remains", () => {
    const { coordinator, reference } = coordinatorWithObject();
    expect(errorCode(() => coordinator.beginGc(reference.storageTargetId, reference.objectKey, 1_000)))
      .toBe("REFERENCES_REMAIN");
  });

  it("refuses to begin deletion while any writer lease is still live", () => {
    const { coordinator, reference } = coordinatorWithObject();
    const control = coordinator.getControl(signatureId)!;
    coordinator.releaseReference(reference);
    coordinator.beginWrite({
      owner: "late", purpose: "v1_svg", ttlMs: 10_000, reference,
      authority: { kind: "v1", signatureId, controlVersion: control.version },
    });
    expect(errorCode(() => coordinator.beginGc(reference.storageTargetId, reference.objectKey, 1_000)))
      .toBe("LIVE_WRITER_EXISTS");
  });

  it("holds external deletion and completion until the grace period elapses", () => {
    const { clock, coordinator, reference } = coordinatorWithObject();
    coordinator.releaseReference(reference);
    const fence = coordinator.beginGc(reference.storageTargetId, reference.objectKey, 5_000);
    expect(errorCode(() => coordinator.deleteExternalForGc(fence))).toBe("GC_GRACE_ACTIVE");
    expect(errorCode(() => coordinator.completeGc(fence))).toBe("GC_GRACE_ACTIVE");
    clock.advance(5_000);
    coordinator.deleteExternalForGc(fence);
    expect(coordinator.completeGc(fence).state).toBe("absent");
  });

  it("refuses to complete deletion while the external object is still present", () => {
    const { clock, coordinator, reference } = coordinatorWithObject();
    coordinator.releaseReference(reference);
    const fence = coordinator.beginGc(reference.storageTargetId, reference.objectKey, 1_000);
    clock.advance(1_000);
    expect(errorCode(() => coordinator.completeGc(fence))).toBe("OBJECT_STILL_PRESENT");
  });

  it("returns the same fence when deletion is already pending", () => {
    const { coordinator, reference } = coordinatorWithObject();
    coordinator.releaseReference(reference);
    const first = coordinator.beginGc(reference.storageTargetId, reference.objectKey, 1_000);
    const again = coordinator.beginGc(reference.storageTargetId, reference.objectKey, 1_000);
    expect(again.fencingToken).toBe(first.fencingToken);
    expect(again.deleteAfter).toBe(first.deleteAfter);
  });

  it("validates deletion inputs before creating any fence", () => {
    const { coordinator, reference } = coordinatorWithObject();
    expect(errorCode(() => coordinator.beginGc("", reference.objectKey, 1_000))).toBeTruthy();
    expect(errorCode(() => coordinator.beginGc(reference.storageTargetId, "", 1_000))).toBeTruthy();
    expect(errorCode(() => coordinator.beginGc(reference.storageTargetId, reference.objectKey, 0))).toBeTruthy();
  });

  it("reports no guard for an object that was never written", () => {
    const clock = new ManualClock();
    const coordinator = new MemoryContentCoordinator({ now: clock.now });
    expect(coordinator.getGuard("v1-primary", "sha256/never.svg")).toBeNull();
    expect(coordinator.getLease("lease-that-does-not-exist")).toBeNull();
    expect(coordinator.getControl("sg1_unknown")).toBeNull();
    expect(coordinator.hasReference(v1Reference("sg1_unknown"))).toBe(false);
    expect(coordinator.releaseReference(v1Reference("sg1_unknown"))).toBe(false);
  });
});

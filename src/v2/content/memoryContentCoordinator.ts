import { createHash } from "node:crypto";

export const CONTENT_REFERENCE_KINDS = [
  "v1_svg",
  "v1_png",
  "v2_svg_pin",
  "v2_png_pin",
  "v2_metadata_pin",
] as const;

export type ContentReferenceKind = (typeof CONTENT_REFERENCE_KINDS)[number];
export type SignatureControlState = "enabled" | "blocked" | "erasure_pending" | "erased";
export type ContentGuardState = "absent" | "present" | "deletion_pending";
export type WriteLeaseState = "writing" | "committed" | "aborted" | "expired";
export type MetadataPreparationState =
  | "reserved"
  | "publishing"
  | "verified"
  | "frozen"
  | "aborting"
  | "aborted";

export type ContentCoordinationErrorCode =
  | "INVALID_ARGUMENT"
  | "CONTROL_MISSING"
  | "CONTROL_NOT_ENABLED"
  | "ERASED_TOMBSTONE"
  | "METADATA_EXISTS"
  | "METADATA_LEASE_HELD"
  | "METADATA_LEASE_EXPIRED"
  | "METADATA_NOT_PUBLISHING"
  | "METADATA_NOT_VERIFIED"
  | "METADATA_NOT_DRAINED"
  | "METADATA_FROZEN"
  | "MISSING_REPLICA"
  | "DELETION_PENDING"
  | "WRITE_LEASE_NOT_FOUND"
  | "WRITE_LEASE_EXPIRED"
  | "WRITE_LEASE_TERMINAL"
  | "STALE_FENCE"
  | "CONTENT_KEY_COLLISION"
  | "EXTERNAL_OBJECT_MISSING"
  | "EXTERNAL_OBJECT_MISMATCH"
  | "EXTERNAL_OBJECT_UNVERIFIED"
  | "REFERENCE_CONFLICT"
  | "REFERENCES_REMAIN"
  | "LIVE_WRITER_EXISTS"
  | "GC_NOT_PENDING"
  | "GC_GRACE_ACTIVE"
  | "OBJECT_STILL_PRESENT"
  | "ERASURE_NOT_PENDING"
  | "ERASURE_NOT_DRAINED"
  | "AUTHORITY_NOT_RECONCILED";

export class ContentCoordinationError extends Error {
  constructor(
    readonly code: ContentCoordinationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ContentCoordinationError";
  }
}

export interface SignatureMintControl {
  signatureId: string;
  state: SignatureControlState;
  version: bigint;
  reason: string | null;
  updatedAt: number;
}

export interface ContentReferenceIntent {
  storageTargetId: string;
  objectKey: string;
  kind: ContentReferenceKind;
  referenceId: string;
}

export interface ContentReference extends ContentReferenceIntent {
  controlSignatureId: string;
  createdAt: number;
}

export interface ContentObjectGuard {
  storageTargetId: string;
  objectKey: string;
  state: ContentGuardState;
  fencingToken: bigint;
  deleteAfter: number | null;
  updatedAt: number;
}

export interface MetadataWorkerHandle {
  signatureId: string;
  deploymentId: string;
  owner: string;
  fencingToken: bigint;
}

export interface MetadataPreparation {
  signatureId: string;
  deploymentId: string;
  state: MetadataPreparationState;
  observedControlVersion: bigint;
  fencingToken: bigint;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  requiredReferences: readonly ContentReferenceIntent[];
  preparedAt: number;
  verifiedAt: number | null;
  frozenAt: number | null;
}

export type WriteAuthority =
  | {
      kind: "v1";
      signatureId: string;
      controlVersion: bigint;
    }
  | {
      kind: "metadata";
      handle: MetadataWorkerHandle;
    };

export interface BeginWriteInput {
  owner: string;
  purpose: string;
  ttlMs: number;
  reference: ContentReferenceIntent;
  authority: WriteAuthority;
}

export interface ContentWriteLease {
  leaseId: string;
  storageTargetId: string;
  objectKey: string;
  fencingToken: bigint;
  owner: string;
  purpose: string;
  state: WriteLeaseState;
  createdAt: number;
  expiresAt: number;
  reference: ContentReferenceIntent;
  controlSignatureId: string;
  controlVersion: bigint;
  metadataKey: string | null;
  metadataFencingToken: bigint | null;
  metadataOwner: string | null;
  externalWriteObserved: boolean;
  verifiedSha256: string | null;
  verifiedLength: number | null;
  committedReferenceKey: string | null;
}

export interface GcFence {
  storageTargetId: string;
  objectKey: string;
  fencingToken: bigint;
  deleteAfter: number;
}

interface ExternalObject {
  bytes: Uint8Array;
  writes: number;
  lastVerifiedSha256: string | null;
}

export interface MemoryContentCoordinatorOptions {
  now?: () => number;
  minimumPinReplicas?: number;
}

function fail(code: ContentCoordinationErrorCode, message: string): never {
  throw new ContentCoordinationError(code, message);
}

function assertNonempty(value: string, label: string): void {
  if (value.length === 0) fail("INVALID_ARGUMENT", `${label} must not be empty.`);
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("INVALID_ARGUMENT", `${label} must be a positive safe-integer duration.`);
  }
}

function objectIdentity(storageTargetId: string, objectKey: string): string {
  return JSON.stringify([storageTargetId, objectKey]);
}

function referenceIdentity(reference: ContentReferenceIntent): string {
  return JSON.stringify([
    reference.storageTargetId,
    reference.objectKey,
    reference.kind,
    reference.referenceId,
  ]);
}

function metadataIdentity(signatureId: string, deploymentId: string): string {
  return JSON.stringify([signatureId, deploymentId]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right));
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function cloneIntent(intent: ContentReferenceIntent): ContentReferenceIntent {
  return { ...intent };
}

function cloneControl(control: SignatureMintControl): SignatureMintControl {
  return { ...control };
}

function cloneGuard(guard: ContentObjectGuard): ContentObjectGuard {
  return { ...guard };
}

function cloneReference(reference: ContentReference): ContentReference {
  return { ...reference };
}

function cloneLease(lease: ContentWriteLease): ContentWriteLease {
  return { ...lease, reference: cloneIntent(lease.reference) };
}

function clonePreparation(preparation: MetadataPreparation): MetadataPreparation {
  return {
    ...preparation,
    requiredReferences: preparation.requiredReferences.map(cloneIntent),
  };
}

function sortedIntentIdentities(intents: readonly ContentReferenceIntent[]): string[] {
  return intents.map(referenceIdentity).sort();
}

function sameIntents(
  left: readonly ContentReferenceIntent[],
  right: readonly ContentReferenceIntent[],
): boolean {
  const a = sortedIntentIdentities(left);
  const b = sortedIntentIdentities(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Executable in-memory reference model for the §11.16 fencing protocol.
 *
 * Database mutations are synchronous here and therefore stand in for one
 * serializable transaction/row lock. External writes are deliberately split
 * into separate calls: a delayed stale worker may still put bytes, but it can
 * never attach a durable reference after losing its fence.
 */
export class MemoryContentCoordinator {
  private readonly now: () => number;
  private readonly minimumPinReplicas: number;
  private readonly controls = new Map<string, SignatureMintControl>();
  private readonly guards = new Map<string, ContentObjectGuard>();
  private readonly leases = new Map<string, ContentWriteLease>();
  private readonly references = new Map<string, ContentReference>();
  private readonly externalObjects = new Map<string, ExternalObject>();
  private readonly metadata = new Map<string, MetadataPreparation>();
  private leaseSequence = 0;

  constructor(options: MemoryContentCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.minimumPinReplicas = options.minimumPinReplicas ?? 2;
    if (!Number.isSafeInteger(this.minimumPinReplicas) || this.minimumPinReplicas <= 0) {
      fail("INVALID_ARGUMENT", "minimumPinReplicas must be a positive safe integer.");
    }
  }

  registerSignature(signatureId: string): SignatureMintControl {
    assertNonempty(signatureId, "signatureId");
    const existing = this.controls.get(signatureId);
    if (existing) {
      if (existing.state === "erased") {
        fail("ERASED_TOMBSTONE", "An erased signature can never be re-enabled.");
      }
      return cloneControl(existing);
    }
    const control: SignatureMintControl = {
      signatureId,
      state: "enabled",
      version: 1n,
      reason: null,
      updatedAt: this.readNow(),
    };
    this.controls.set(signatureId, control);
    return cloneControl(control);
  }

  getControl(signatureId: string): SignatureMintControl | null {
    const control = this.controls.get(signatureId);
    return control ? cloneControl(control) : null;
  }

  blockSignature(signatureId: string, reason: string): SignatureMintControl {
    assertNonempty(reason, "reason");
    const control = this.requireControl(signatureId);
    if (control.state === "erased") {
      fail("ERASED_TOMBSTONE", "An erased signature control is terminal.");
    }
    if (control.state === "erasure_pending") {
      fail("ERASURE_NOT_DRAINED", "An erasure-pending signature cannot return to an ordinary block.");
    }
    control.state = "blocked";
    control.reason = reason;
    control.version += 1n;
    control.updatedAt = this.readNow();
    this.fenceSignatureWorkers(signatureId);
    return cloneControl(control);
  }

  beginErasure(signatureId: string, reason: string): SignatureMintControl {
    assertNonempty(reason, "reason");
    const control = this.requireControl(signatureId);
    if (control.state === "erased") {
      fail("ERASED_TOMBSTONE", "An erased signature control is terminal.");
    }
    if (control.state === "erasure_pending") return cloneControl(control);
    control.state = "erasure_pending";
    control.reason = reason;
    control.version += 1n;
    control.updatedAt = this.readNow();
    this.fenceSignatureWorkers(signatureId);
    return cloneControl(control);
  }

  completeErasure(signatureId: string): SignatureMintControl {
    const control = this.requireControl(signatureId);
    if (control.state !== "erasure_pending") {
      fail("ERASURE_NOT_PENDING", "Erasure must be durably pending before it can complete.");
    }
    if ([...this.metadata.values()].some((row) => row.signatureId === signatureId)) {
      fail("ERASURE_NOT_DRAINED", "Metadata preparations must be erased first.");
    }
    if ([...this.references.values()].some((reference) => reference.controlSignatureId === signatureId)) {
      fail("ERASURE_NOT_DRAINED", "Content references must be released first.");
    }
    if ([...this.leases.values()].some((lease) =>
      lease.controlSignatureId === signatureId && lease.state === "writing")) {
      fail("ERASURE_NOT_DRAINED", "Content writer leases must be fenced first.");
    }
    control.state = "erased";
    control.reason ??= "erased";
    control.version += 1n;
    control.updatedAt = this.readNow();
    return cloneControl(control);
  }

  reserveMetadata(input: {
    signatureId: string;
    deploymentId: string;
    owner: string;
    ttlMs: number;
    requiredReferences: readonly ContentReferenceIntent[];
  }): MetadataWorkerHandle {
    assertNonempty(input.signatureId, "signatureId");
    assertNonempty(input.deploymentId, "deploymentId");
    assertNonempty(input.owner, "owner");
    assertPositiveDuration(input.ttlMs, "ttlMs");
    this.validateMetadataReferences(input.requiredReferences);

    const control = this.requireEnabledControl(input.signatureId);
    const key = metadataIdentity(input.signatureId, input.deploymentId);
    const current = this.metadata.get(key);
    const now = this.readNow();

    if (!current) {
      const preparation: MetadataPreparation = {
        signatureId: input.signatureId,
        deploymentId: input.deploymentId,
        state: "reserved",
        observedControlVersion: control.version,
        fencingToken: 1n,
        leaseOwner: input.owner,
        leaseExpiresAt: now + input.ttlMs,
        requiredReferences: input.requiredReferences.map(cloneIntent),
        preparedAt: now,
        verifiedAt: null,
        frozenAt: null,
      };
      this.metadata.set(key, preparation);
      return this.handleFor(preparation);
    }

    if (!sameIntents(current.requiredReferences, input.requiredReferences)) {
      fail("METADATA_EXISTS", "A metadata reservation already exists with immutable object identities.");
    }
    if (current.observedControlVersion !== control.version) {
      this.fenceMetadataPreparation(current);
      fail("STALE_FENCE", "The metadata reservation observed an obsolete signature-control version.");
    }
    if (current.state === "frozen") {
      fail("METADATA_FROZEN", "Frozen metadata cannot be leased or replaced.");
    }
    if (current.state === "verified") {
      fail("METADATA_NOT_VERIFIED", "Verified metadata is awaiting freeze and has no writer lease.");
    }
    if (current.state === "aborting" || current.state === "aborted") {
      fail("METADATA_NOT_DRAINED", "A terminal metadata preparation cannot be recreated.");
    }
    if (current.leaseExpiresAt !== null && current.leaseExpiresAt > now) {
      if (current.leaseOwner === input.owner) return this.handleFor(current);
      fail("METADATA_LEASE_HELD", "Another metadata worker owns the live preparation lease.");
    }

    current.fencingToken += 1n;
    current.leaseOwner = input.owner;
    current.leaseExpiresAt = now + input.ttlMs;
    return this.handleFor(current);
  }

  beginMetadataPublishing(handle: MetadataWorkerHandle): MetadataPreparation {
    const preparation = this.requireLiveMetadataHandle(handle);
    if (preparation.state !== "reserved" && preparation.state !== "publishing") {
      fail("METADATA_NOT_PUBLISHING", "Metadata cannot enter publishing from its current state.");
    }
    preparation.state = "publishing";
    return clonePreparation(preparation);
  }

  markMetadataVerified(handle: MetadataWorkerHandle): MetadataPreparation {
    const preparation = this.requireLiveMetadataHandle(handle);
    if (preparation.state !== "publishing") {
      fail("METADATA_NOT_PUBLISHING", "Only a publishing metadata reservation can be verified.");
    }
    for (const required of preparation.requiredReferences) {
      const reference = this.references.get(referenceIdentity(required));
      if (!reference || reference.controlSignatureId !== preparation.signatureId) {
        fail("MISSING_REPLICA", `Missing verified reference ${referenceIdentity(required)}.`);
      }
      const guard = this.guards.get(objectIdentity(required.storageTargetId, required.objectKey));
      const external = this.externalObjects.get(objectIdentity(required.storageTargetId, required.objectKey));
      if (!guard || guard.state !== "present" || !external?.lastVerifiedSha256) {
        fail("MISSING_REPLICA", `Object ${required.objectKey} is not retained and verified.`);
      }
    }
    preparation.state = "verified";
    preparation.verifiedAt = this.readNow();
    preparation.leaseOwner = null;
    preparation.leaseExpiresAt = null;
    return clonePreparation(preparation);
  }

  freezeMetadata(
    signatureId: string,
    deploymentId: string,
    expectedControlVersion: bigint,
  ): MetadataPreparation {
    const preparation = this.requireMetadata(signatureId, deploymentId);
    const control = this.requireEnabledControl(signatureId);
    if (control.version !== expectedControlVersion
      || preparation.observedControlVersion !== expectedControlVersion) {
      fail("STALE_FENCE", "Metadata freeze observed a stale signature-control version.");
    }
    if (preparation.state === "frozen") return clonePreparation(preparation);
    if (preparation.state !== "verified") {
      fail("METADATA_NOT_VERIFIED", "Metadata must be externally verified before freeze.");
    }
    preparation.state = "frozen";
    preparation.frozenAt = this.readNow();
    return clonePreparation(preparation);
  }

  finishMetadataAbort(signatureId: string, deploymentId: string): MetadataPreparation {
    const preparation = this.requireMetadata(signatureId, deploymentId);
    if (preparation.state === "aborted") return clonePreparation(preparation);
    if (preparation.state !== "aborting") {
      fail("METADATA_NOT_DRAINED", "Metadata must be fenced into aborting before cleanup.");
    }
    for (const reference of preparation.requiredReferences) this.releaseReference(reference);
    preparation.state = "aborted";
    preparation.leaseOwner = null;
    preparation.leaseExpiresAt = null;
    return clonePreparation(preparation);
  }

  eraseMetadata(
    signatureId: string,
    deploymentId: string,
    options: { authorityReconciled: true },
  ): void {
    if (options.authorityReconciled !== true) {
      fail("AUTHORITY_NOT_RECONCILED", "Mint authority must be proven safely dead before metadata erasure.");
    }
    const control = this.requireControl(signatureId);
    if (control.state !== "erasure_pending") {
      fail("ERASURE_NOT_PENDING", "Metadata erasure requires a durable erasure fence.");
    }
    const key = metadataIdentity(signatureId, deploymentId);
    const preparation = this.metadata.get(key);
    if (!preparation) return;
    if (preparation.state !== "aborted" && preparation.state !== "frozen") {
      fail("METADATA_NOT_DRAINED", "In-flight metadata must finish aborting before erasure.");
    }
    for (const reference of preparation.requiredReferences) this.releaseReference(reference);
    this.metadata.delete(key);
  }

  getMetadata(signatureId: string, deploymentId: string): MetadataPreparation | null {
    const preparation = this.metadata.get(metadataIdentity(signatureId, deploymentId));
    return preparation ? clonePreparation(preparation) : null;
  }

  beginWrite(input: BeginWriteInput): ContentWriteLease {
    assertNonempty(input.owner, "owner");
    assertNonempty(input.purpose, "purpose");
    assertPositiveDuration(input.ttlMs, "ttlMs");
    this.validateIntent(input.reference);

    let controlSignatureId: string;
    let controlVersion: bigint;
    let metadataKey: string | null = null;
    let metadataFencingToken: bigint | null = null;
    let metadataOwner: string | null = null;

    if (input.authority.kind === "v1") {
      if (input.reference.kind !== "v1_svg" && input.reference.kind !== "v1_png") {
        fail("INVALID_ARGUMENT", "V1 authority can create only V1 artifact references.");
      }
      const control = this.requireEnabledControl(input.authority.signatureId);
      if (control.version !== input.authority.controlVersion) {
        fail("STALE_FENCE", "The V1 writer observed an obsolete signature-control version.");
      }
      controlSignatureId = input.authority.signatureId;
      controlVersion = control.version;
    } else {
      if (!input.reference.kind.startsWith("v2_")) {
        fail("INVALID_ARGUMENT", "Metadata authority can create only V2 pin references.");
      }
      const preparation = this.requireLiveMetadataHandle(input.authority.handle);
      if (preparation.state !== "publishing") {
        fail("METADATA_NOT_PUBLISHING", "Content publication requires a publishing metadata reservation.");
      }
      if (!preparation.requiredReferences.some((item) =>
        referenceIdentity(item) === referenceIdentity(input.reference))) {
        fail("INVALID_ARGUMENT", "The content reference is not part of the frozen metadata plan.");
      }
      controlSignatureId = preparation.signatureId;
      controlVersion = preparation.observedControlVersion;
      metadataKey = metadataIdentity(preparation.signatureId, preparation.deploymentId);
      metadataFencingToken = preparation.fencingToken;
      metadataOwner = preparation.leaseOwner;
    }

    const guard = this.ensureGuard(input.reference.storageTargetId, input.reference.objectKey);
    if (guard.state === "deletion_pending") {
      fail("DELETION_PENDING", "Object deletion is fenced; the writer must wait and retry.");
    }
    guard.fencingToken += 1n;
    guard.updatedAt = this.readNow();
    const leaseId = `cwl_${++this.leaseSequence}`;
    const lease: ContentWriteLease = {
      leaseId,
      storageTargetId: input.reference.storageTargetId,
      objectKey: input.reference.objectKey,
      fencingToken: guard.fencingToken,
      owner: input.owner,
      purpose: input.purpose,
      state: "writing",
      createdAt: this.readNow(),
      expiresAt: this.readNow() + input.ttlMs,
      reference: cloneIntent(input.reference),
      controlSignatureId,
      controlVersion,
      metadataKey,
      metadataFencingToken,
      metadataOwner,
      externalWriteObserved: false,
      verifiedSha256: null,
      verifiedLength: null,
      committedReferenceKey: null,
    };
    this.leases.set(leaseId, lease);
    return cloneLease(lease);
  }

  putExternal(leaseId: string, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) fail("INVALID_ARGUMENT", "External object bytes must not be empty.");
    const lease = this.requireLease(leaseId);
    const key = objectIdentity(lease.storageTargetId, lease.objectKey);
    const existing = this.externalObjects.get(key);
    if (existing && !equalBytes(existing.bytes, bytes)) {
      fail("CONTENT_KEY_COLLISION", "A content-addressed key already contains different bytes.");
    }
    if (existing) {
      existing.writes += 1;
    } else {
      this.externalObjects.set(key, {
        bytes: cloneBytes(bytes),
        writes: 1,
        lastVerifiedSha256: null,
      });
    }
    // This intentionally records completion even for an aborted/expired lease:
    // the remote request may have started before the database fence changed.
    lease.externalWriteObserved = true;
  }

  verifyExternal(leaseId: string, expectedBytes: Uint8Array): string {
    const lease = this.requireLease(leaseId);
    if (!lease.externalWriteObserved) {
      fail("EXTERNAL_OBJECT_UNVERIFIED", "The worker must perform its idempotent put/pin first.");
    }
    const external = this.externalObjects.get(objectIdentity(lease.storageTargetId, lease.objectKey));
    if (!external) fail("EXTERNAL_OBJECT_MISSING", "The external target does not contain the object.");
    if (!equalBytes(external.bytes, expectedBytes)) {
      fail("EXTERNAL_OBJECT_MISMATCH", "Independent retrieval did not match the exact expected bytes.");
    }
    const digest = sha256(expectedBytes);
    lease.verifiedSha256 = digest;
    lease.verifiedLength = expectedBytes.byteLength;
    external.lastVerifiedSha256 = digest;
    return digest;
  }

  commitWrite(leaseId: string): ContentReference {
    const lease = this.requireLease(leaseId);
    if (lease.state === "committed") {
      const existing = lease.committedReferenceKey
        ? this.references.get(lease.committedReferenceKey)
        : undefined;
      if (!existing) fail("REFERENCE_CONFLICT", "Committed lease lost its durable reference.");
      return cloneReference(existing);
    }
    if (lease.state !== "writing") {
      fail("WRITE_LEASE_TERMINAL", "A terminal content lease cannot attach a reference.");
    }
    if (lease.expiresAt <= this.readNow()) {
      lease.state = "expired";
      fail("WRITE_LEASE_EXPIRED", "The content writer lease expired before commit.");
    }
    this.assertLeaseAuthority(lease);
    const objectKey = objectIdentity(lease.storageTargetId, lease.objectKey);
    const guard = this.guards.get(objectKey);
    if (!guard || guard.state === "deletion_pending"
      || guard.fencingToken !== lease.fencingToken) {
      fail("STALE_FENCE", "The content writer lost the hash/CID guard fence.");
    }
    const external = this.externalObjects.get(objectKey);
    if (!external) fail("EXTERNAL_OBJECT_MISSING", "Cannot reference a missing external object.");
    if (!lease.verifiedSha256 || lease.verifiedLength === null) {
      fail("EXTERNAL_OBJECT_UNVERIFIED", "Exact external bytes must be verified before commit.");
    }
    if (external.bytes.byteLength !== lease.verifiedLength
      || sha256(external.bytes) !== lease.verifiedSha256) {
      fail("EXTERNAL_OBJECT_MISMATCH", "External bytes changed after verification.");
    }

    const key = referenceIdentity(lease.reference);
    const prior = this.references.get(key);
    if (prior && prior.controlSignatureId !== lease.controlSignatureId) {
      fail("REFERENCE_CONFLICT", "The same reference identity belongs to another signature.");
    }
    const reference: ContentReference = prior ?? {
      ...cloneIntent(lease.reference),
      controlSignatureId: lease.controlSignatureId,
      createdAt: this.readNow(),
    };
    this.references.set(key, reference);
    lease.state = "committed";
    lease.committedReferenceKey = key;
    guard.state = "present";
    guard.deleteAfter = null;
    guard.updatedAt = this.readNow();
    return cloneReference(reference);
  }

  abortWrite(leaseId: string): ContentWriteLease {
    const lease = this.requireLease(leaseId);
    if (lease.state === "writing") lease.state = "aborted";
    return cloneLease(lease);
  }

  expireWriterLeases(): number {
    let count = 0;
    const now = this.readNow();
    for (const lease of this.leases.values()) {
      if (lease.state === "writing" && lease.expiresAt <= now) {
        lease.state = "expired";
        count += 1;
      }
    }
    return count;
  }

  releaseReference(reference: ContentReferenceIntent): boolean {
    return this.references.delete(referenceIdentity(reference));
  }

  hasReference(reference: ContentReferenceIntent): boolean {
    return this.references.has(referenceIdentity(reference));
  }

  beginGc(storageTargetId: string, objectKey: string, graceMs: number): GcFence {
    assertNonempty(storageTargetId, "storageTargetId");
    assertNonempty(objectKey, "objectKey");
    assertPositiveDuration(graceMs, "graceMs");
    const guard = this.ensureGuard(storageTargetId, objectKey);
    if (guard.state === "deletion_pending") return this.gcFenceFor(guard);
    if (this.referencesForObject(storageTargetId, objectKey).length > 0) {
      fail("REFERENCES_REMAIN", "Object deletion requires zero durable references.");
    }
    if (this.hasLiveWriter(storageTargetId, objectKey)) {
      fail("LIVE_WRITER_EXISTS", "Object deletion requires every writer lease to expire or terminate.");
    }
    guard.fencingToken += 1n;
    guard.state = "deletion_pending";
    guard.deleteAfter = this.readNow() + graceMs;
    guard.updatedAt = this.readNow();
    return this.gcFenceFor(guard);
  }

  deleteExternalForGc(fence: GcFence): void {
    const guard = this.requireGcFence(fence);
    if (this.readNow() < fence.deleteAfter) {
      fail("GC_GRACE_ACTIVE", "The conservative external-write grace period has not elapsed.");
    }
    if (this.referencesForObject(fence.storageTargetId, fence.objectKey).length > 0) {
      fail("REFERENCES_REMAIN", "A reference appeared before external deletion.");
    }
    if (this.hasLiveWriter(fence.storageTargetId, fence.objectKey)) {
      fail("LIVE_WRITER_EXISTS", "A live writer appeared before external deletion.");
    }
    this.externalObjects.delete(objectIdentity(fence.storageTargetId, fence.objectKey));
    guard.updatedAt = this.readNow();
  }

  completeGc(fence: GcFence): ContentObjectGuard {
    const guard = this.requireGcFence(fence);
    if (this.readNow() < fence.deleteAfter) {
      fail("GC_GRACE_ACTIVE", "The conservative external-write grace period has not elapsed.");
    }
    if (this.referencesForObject(fence.storageTargetId, fence.objectKey).length > 0) {
      fail("REFERENCES_REMAIN", "A reference appeared before GC completion.");
    }
    if (this.hasLiveWriter(fence.storageTargetId, fence.objectKey)) {
      fail("LIVE_WRITER_EXISTS", "A live writer appeared before GC completion.");
    }
    if (this.externalObjects.has(objectIdentity(fence.storageTargetId, fence.objectKey))) {
      fail("OBJECT_STILL_PRESENT", "External deletion must be verified before marking the guard absent.");
    }
    guard.state = "absent";
    guard.deleteAfter = null;
    guard.updatedAt = this.readNow();
    return cloneGuard(guard);
  }

  sweepOrphan(storageTargetId: string, objectKey: string): boolean {
    const guard = this.ensureGuard(storageTargetId, objectKey);
    if (guard.state !== "absent"
      || this.referencesForObject(storageTargetId, objectKey).length > 0
      || this.hasLiveWriter(storageTargetId, objectKey)) return false;
    return this.externalObjects.delete(objectIdentity(storageTargetId, objectKey));
  }

  getGuard(storageTargetId: string, objectKey: string): ContentObjectGuard | null {
    const guard = this.guards.get(objectIdentity(storageTargetId, objectKey));
    return guard ? cloneGuard(guard) : null;
  }

  getLease(leaseId: string): ContentWriteLease | null {
    const lease = this.leases.get(leaseId);
    return lease ? cloneLease(lease) : null;
  }

  listReferences(storageTargetId?: string, objectKey?: string): ContentReference[] {
    return [...this.references.values()]
      .filter((reference) => storageTargetId === undefined || reference.storageTargetId === storageTargetId)
      .filter((reference) => objectKey === undefined || reference.objectKey === objectKey)
      .map(cloneReference);
  }

  hasExternalObject(storageTargetId: string, objectKey: string): boolean {
    return this.externalObjects.has(objectIdentity(storageTargetId, objectKey));
  }

  getExternalBytes(storageTargetId: string, objectKey: string): Uint8Array | null {
    const external = this.externalObjects.get(objectIdentity(storageTargetId, objectKey));
    return external ? cloneBytes(external.bytes) : null;
  }

  externalWriteCount(storageTargetId: string, objectKey: string): number {
    return this.externalObjects.get(objectIdentity(storageTargetId, objectKey))?.writes ?? 0;
  }

  assertInvariants(): void {
    for (const reference of this.references.values()) {
      const key = objectIdentity(reference.storageTargetId, reference.objectKey);
      const guard = this.guards.get(key);
      if (!guard || guard.state !== "present" || !this.externalObjects.has(key)) {
        throw new Error(`Invariant violation: durable reference ${referenceIdentity(reference)} points to a missing object.`);
      }
      const control = this.controls.get(reference.controlSignatureId);
      if (!control || control.state === "erased") {
        throw new Error(`Invariant violation: reference retained for erased/missing control ${reference.controlSignatureId}.`);
      }
    }
    for (const preparation of this.metadata.values()) {
      const control = this.controls.get(preparation.signatureId);
      if (!control || control.state === "erased") {
        throw new Error(`Invariant violation: metadata retained for erased/missing control ${preparation.signatureId}.`);
      }
      if (preparation.state === "verified" || preparation.state === "frozen") {
        for (const required of preparation.requiredReferences) {
          if (!this.references.has(referenceIdentity(required))) {
            throw new Error(`Invariant violation: ${preparation.state} metadata lost a required reference.`);
          }
        }
      }
    }
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("INVALID_ARGUMENT", "Clock must return a non-negative safe-integer millisecond timestamp.");
    }
    return value;
  }

  private requireControl(signatureId: string): SignatureMintControl {
    const control = this.controls.get(signatureId);
    if (!control) fail("CONTROL_MISSING", "A missing signature mint control fails closed.");
    return control;
  }

  private requireEnabledControl(signatureId: string): SignatureMintControl {
    const control = this.requireControl(signatureId);
    if (control.state === "erased") fail("ERASED_TOMBSTONE", "An erased signature cannot publish again.");
    if (control.state !== "enabled") {
      fail("CONTROL_NOT_ENABLED", "Signature mint control is not enabled.");
    }
    return control;
  }

  private validateIntent(intent: ContentReferenceIntent): void {
    assertNonempty(intent.storageTargetId, "storageTargetId");
    assertNonempty(intent.objectKey, "objectKey");
    assertNonempty(intent.referenceId, "referenceId");
    if (!(CONTENT_REFERENCE_KINDS as readonly string[]).includes(intent.kind)) {
      fail("INVALID_ARGUMENT", "Unknown content reference kind.");
    }
  }

  private validateMetadataReferences(references: readonly ContentReferenceIntent[]): void {
    if (references.length === 0) fail("MISSING_REPLICA", "Metadata requires retained pin references.");
    const unique = new Set<string>();
    for (const reference of references) {
      this.validateIntent(reference);
      if (!reference.kind.startsWith("v2_")) {
        fail("INVALID_ARGUMENT", "Metadata plans may contain only V2 pin references.");
      }
      const key = referenceIdentity(reference);
      if (unique.has(key)) fail("INVALID_ARGUMENT", "Metadata reference identities must be unique.");
      unique.add(key);
    }
    for (const kind of ["v2_svg_pin", "v2_png_pin", "v2_metadata_pin"] as const) {
      const targets = new Set(
        references.filter((reference) => reference.kind === kind)
          .map((reference) => reference.storageTargetId),
      );
      if (targets.size < this.minimumPinReplicas) {
        fail("MISSING_REPLICA", `${kind} requires ${this.minimumPinReplicas} independent targets.`);
      }
    }
  }

  private handleFor(preparation: MetadataPreparation): MetadataWorkerHandle {
    if (!preparation.leaseOwner) fail("METADATA_LEASE_EXPIRED", "Metadata has no active worker owner.");
    return {
      signatureId: preparation.signatureId,
      deploymentId: preparation.deploymentId,
      owner: preparation.leaseOwner,
      fencingToken: preparation.fencingToken,
    };
  }

  private requireMetadata(signatureId: string, deploymentId: string): MetadataPreparation {
    const preparation = this.metadata.get(metadataIdentity(signatureId, deploymentId));
    if (!preparation) fail("METADATA_EXISTS", "Metadata preparation does not exist.");
    return preparation;
  }

  private requireLiveMetadataHandle(handle: MetadataWorkerHandle): MetadataPreparation {
    const preparation = this.requireMetadata(handle.signatureId, handle.deploymentId);
    if (preparation.fencingToken !== handle.fencingToken
      || preparation.leaseOwner !== handle.owner) {
      fail("STALE_FENCE", "Metadata worker no longer owns the preparation fence.");
    }
    if (preparation.leaseExpiresAt === null || preparation.leaseExpiresAt <= this.readNow()) {
      fail("METADATA_LEASE_EXPIRED", "Metadata worker lease expired.");
    }
    const control = this.requireEnabledControl(handle.signatureId);
    if (control.version !== preparation.observedControlVersion) {
      fail("STALE_FENCE", "Metadata worker observed an obsolete signature-control version.");
    }
    return preparation;
  }

  private fenceMetadataPreparation(preparation: MetadataPreparation): void {
    if (preparation.state === "reserved"
      || preparation.state === "publishing"
      || preparation.state === "verified") {
      preparation.state = "aborting";
      preparation.fencingToken += 1n;
      preparation.leaseOwner = null;
      preparation.leaseExpiresAt = null;
    }
  }

  private fenceSignatureWorkers(signatureId: string): void {
    for (const preparation of this.metadata.values()) {
      if (preparation.signatureId === signatureId) this.fenceMetadataPreparation(preparation);
    }
    for (const lease of this.leases.values()) {
      if (lease.controlSignatureId !== signatureId || lease.state !== "writing") continue;
      lease.state = "aborted";
      const guard = this.guards.get(objectIdentity(lease.storageTargetId, lease.objectKey));
      if (guard && guard.state !== "deletion_pending"
        && guard.fencingToken === lease.fencingToken) {
        guard.fencingToken += 1n;
        guard.updatedAt = this.readNow();
      }
    }
  }

  private ensureGuard(storageTargetId: string, objectKey: string): ContentObjectGuard {
    const key = objectIdentity(storageTargetId, objectKey);
    let guard = this.guards.get(key);
    if (!guard) {
      guard = {
        storageTargetId,
        objectKey,
        state: "absent",
        fencingToken: 0n,
        deleteAfter: null,
        updatedAt: this.readNow(),
      };
      this.guards.set(key, guard);
    }
    return guard;
  }

  private requireLease(leaseId: string): ContentWriteLease {
    const lease = this.leases.get(leaseId);
    if (!lease) fail("WRITE_LEASE_NOT_FOUND", "Unknown content writer lease.");
    return lease;
  }

  private assertLeaseAuthority(lease: ContentWriteLease): void {
    const control = this.requireEnabledControl(lease.controlSignatureId);
    if (control.version !== lease.controlVersion) {
      fail("STALE_FENCE", "Content writer observed an obsolete signature-control version.");
    }
    if (lease.metadataKey === null) return;
    const preparation = this.metadata.get(lease.metadataKey);
    if (!preparation || preparation.state !== "publishing"
      || preparation.fencingToken !== lease.metadataFencingToken
      || preparation.leaseOwner !== lease.metadataOwner) {
      fail("STALE_FENCE", "Content writer lost its metadata-preparation fence.");
    }
  }

  private referencesForObject(storageTargetId: string, objectKey: string): ContentReference[] {
    return [...this.references.values()].filter((reference) =>
      reference.storageTargetId === storageTargetId && reference.objectKey === objectKey);
  }

  private hasLiveWriter(storageTargetId: string, objectKey: string): boolean {
    const now = this.readNow();
    return [...this.leases.values()].some((lease) =>
      lease.storageTargetId === storageTargetId
      && lease.objectKey === objectKey
      && lease.state === "writing"
      && lease.expiresAt > now);
  }

  private gcFenceFor(guard: ContentObjectGuard): GcFence {
    if (guard.state !== "deletion_pending" || guard.deleteAfter === null) {
      fail("GC_NOT_PENDING", "Content object does not have a deletion fence.");
    }
    return {
      storageTargetId: guard.storageTargetId,
      objectKey: guard.objectKey,
      fencingToken: guard.fencingToken,
      deleteAfter: guard.deleteAfter,
    };
  }

  private requireGcFence(fence: GcFence): ContentObjectGuard {
    const guard = this.guards.get(objectIdentity(fence.storageTargetId, fence.objectKey));
    if (!guard || guard.state !== "deletion_pending"
      || guard.fencingToken !== fence.fencingToken
      || guard.deleteAfter !== fence.deleteAfter) {
      fail("STALE_FENCE", "GC worker no longer owns the deletion fence.");
    }
    return guard;
  }
}

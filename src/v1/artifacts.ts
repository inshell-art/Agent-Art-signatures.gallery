import { sha256Hex } from "./renderer.js";
import {
  MemoryContentCoordinator,
  type ContentReferenceIntent,
  type GcFence,
} from "../v2/content/index.js";

export type ArtifactKind = "svg" | "png";

export interface StoredArtifact {
  key: string;
  sha256: string;
  byteLength: number;
  referenceCreated: boolean;
}

export interface ArtifactWriteContext {
  signatureId: string;
  owner?: string;
  leaseTtlMs?: number;
}

export interface ArtifactStore {
  putVerified(kind: ArtifactKind, bytes: Uint8Array, context: ArtifactWriteContext): Promise<StoredArtifact>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  releaseReference(kind: ArtifactKind, key: string, signatureId: string): boolean | Promise<boolean>;
}

export class MemoryArtifactStore implements ArtifactStore {
  static readonly STORAGE_TARGET_ID = "v1-primary";

  constructor(readonly content = new MemoryContentCoordinator({ minimumPinReplicas: 1 })) {}

  async putVerified(kind: ArtifactKind, bytes: Uint8Array, context: ArtifactWriteContext): Promise<StoredArtifact> {
    const copy = Buffer.from(bytes);
    const sha256 = sha256Hex(copy);
    const key = `sha256/${sha256}.${kind}`;
    const control = this.content.registerSignature(context.signatureId);
    const reference = this.reference(kind, key, context.signatureId);
    const referenceCreated = !this.content.hasReference(reference);
    const lease = this.content.beginWrite({
      owner: context.owner ?? `v1-claim:${context.signatureId}`,
      purpose: `v1_${kind}_claim`,
      ttlMs: context.leaseTtlMs ?? 120_000,
      reference,
      authority: { kind: "v1", signatureId: context.signatureId, controlVersion: control.version },
    });
    let committed = false;
    try {
      this.content.putExternal(lease.leaseId, copy);
      this.content.verifyExternal(lease.leaseId, copy);
      this.content.commitWrite(lease.leaseId);
      committed = true;
      const confirmed = this.content.getExternalBytes(MemoryArtifactStore.STORAGE_TARGET_ID, key);
      if (!confirmed || confirmed.length !== copy.length || sha256Hex(confirmed) !== sha256) {
        throw new Error("Artifact write verification failed.");
      }
      return { key, sha256, byteLength: copy.length, referenceCreated };
    } catch (error) {
      if (!committed) this.content.abortWrite(lease.leaseId);
      else if (referenceCreated) this.content.releaseReference(reference);
      throw error;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const value = this.content.getExternalBytes(MemoryArtifactStore.STORAGE_TARGET_ID, key);
    return value ? Buffer.from(value) : null;
  }

  async delete(key: string): Promise<void> {
    if (!this.content.hasExternalObject(MemoryArtifactStore.STORAGE_TARGET_ID, key)) return;
    throw new Error("Direct artifact deletion is disabled; release references and use the fenced garbage-collection protocol.");
  }

  releaseReference(kind: ArtifactKind, key: string, signatureId: string): boolean {
    return this.content.releaseReference(this.reference(kind, key, signatureId));
  }

  beginGarbageCollection(key: string, graceMs: number): GcFence {
    return this.content.beginGc(MemoryArtifactStore.STORAGE_TARGET_ID, key, graceMs);
  }

  deleteGarbage(fence: GcFence): void {
    this.content.deleteExternalForGc(fence);
    this.content.completeGc(fence);
  }

  private reference(kind: ArtifactKind, key: string, signatureId: string): ContentReferenceIntent {
    return {
      storageTargetId: MemoryArtifactStore.STORAGE_TARGET_ID,
      objectKey: key,
      kind: kind === "svg" ? "v1_svg" : "v1_png",
      referenceId: signatureId,
    };
  }
}

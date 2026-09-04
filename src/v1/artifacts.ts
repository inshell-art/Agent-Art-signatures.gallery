import { sha256Hex } from "./renderer.js";

export type ArtifactKind = "svg" | "png";

export interface StoredArtifact {
  key: string;
  sha256: string;
  byteLength: number;
}

export interface ArtifactStore {
  putVerified(kind: ArtifactKind, bytes: Uint8Array): Promise<StoredArtifact>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly objects = new Map<string, Buffer>();

  async putVerified(kind: ArtifactKind, bytes: Uint8Array): Promise<StoredArtifact> {
    const copy = Buffer.from(bytes);
    const sha256 = sha256Hex(copy);
    const key = `sha256/${sha256}.${kind}`;
    const existing = this.objects.get(key);
    if (existing && (existing.length !== copy.length || sha256Hex(existing) !== sha256)) {
      throw new Error("Content-addressed artifact integrity failure.");
    }
    if (!existing) this.objects.set(key, copy);
    const confirmed = this.objects.get(key);
    if (!confirmed || confirmed.length !== copy.length || sha256Hex(confirmed) !== sha256) {
      throw new Error("Artifact write verification failed.");
    }
    return { key, sha256, byteLength: copy.length };
  }

  async get(key: string): Promise<Buffer | null> {
    const value = this.objects.get(key);
    return value ? Buffer.from(value) : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { sha256Hex } from "./renderer.js";
import type {
  ArtifactKind,
  ArtifactStore,
  ArtifactWriteContext,
  StoredArtifact,
} from "./artifacts.js";

export type { ArtifactKind } from "./artifacts.js";

export interface ArtifactReferenceLedger {
  add(input: {
    storageKey: string;
    signatureId: string;
    kind: ArtifactKind;
    sha256: string;
    byteLength: number;
  }): Promise<boolean>;
  remove(storageKey: string, signatureId: string, kind: ArtifactKind): Promise<boolean>;
  count(storageKey: string): Promise<number>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Workspace-contained, content-addressed artifact adapter for local rehearsal. */
export class FileArtifactStore implements ArtifactStore {
  private readonly objectRoot: string;

  constructor(
    root: string,
    private readonly ledger?: ArtifactReferenceLedger,
  ) {
    this.objectRoot = resolve(root, "objects");
  }

  private pathFor(key: string): string {
    if (!/^sha256\/[0-9a-f]{64}\.(?:svg|png)$/.test(key)) throw new Error("Invalid artifact storage key.");
    const path = resolve(this.objectRoot, key);
    if (!path.startsWith(`${this.objectRoot}${sep}`)) throw new Error("Artifact path escaped its local root.");
    return path;
  }

  async putVerified(kind: ArtifactKind, bytes: Uint8Array, context: ArtifactWriteContext): Promise<StoredArtifact> {
    const copy = Buffer.from(bytes);
    const sha256 = sha256Hex(copy);
    const key = `sha256/${sha256}.${kind}`;
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });

    let existing: Buffer | null = null;
    try {
      existing = await readFile(target);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (existing) {
      if (existing.length !== copy.length || sha256Hex(existing) !== sha256) {
        throw new Error("Existing local artifact failed its content-addressed integrity check.");
      }
    } else {
      const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(copy);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
        // Persist the new directory entry before recording its PostgreSQL
        // reference so a successful claim cannot outlive a crash-lost file.
        const directory = await open(dirname(target), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      const confirmed = await readFile(target);
      if (confirmed.length !== copy.length || sha256Hex(confirmed) !== sha256) {
        throw new Error("Local artifact write verification failed.");
      }
    }

    const referenceCreated = this.ledger
      ? await this.ledger.add({ storageKey: key, signatureId: context.signatureId, kind, sha256, byteLength: copy.length })
      : true;
    return { key, sha256, byteLength: copy.length, referenceCreated };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    if (this.ledger && await this.ledger.count(key) > 0) {
      throw new Error("Referenced local artifacts cannot be deleted.");
    }
    await rm(this.pathFor(key), { force: true });
  }

  async releaseReference(kind: ArtifactKind, key: string, signatureId: string): Promise<boolean> {
    return this.ledger?.remove(key, signatureId, kind) ?? false;
  }
}

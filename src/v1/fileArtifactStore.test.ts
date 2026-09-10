import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileArtifactStore, type ArtifactKind, type ArtifactReferenceLedger } from "./fileArtifactStore.js";

class Ledger implements ArtifactReferenceLedger {
  readonly references = new Set<string>();

  async add(input: { storageKey: string; signatureId: string; kind: ArtifactKind }): Promise<boolean> {
    const key = `${input.storageKey}:${input.signatureId}:${input.kind}`;
    const created = !this.references.has(key);
    this.references.add(key);
    return created;
  }

  async remove(storageKey: string, signatureId: string, kind: ArtifactKind): Promise<boolean> {
    return this.references.delete(`${storageKey}:${signatureId}:${kind}`);
  }

  async count(storageKey: string): Promise<number> {
    return [...this.references].filter((entry) => entry.startsWith(`${storageKey}:`)).length;
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileArtifactStore", () => {
  it("deduplicates bytes while retaining independent signature references", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "sg-file-artifacts-"));
    roots.push(root);
    const ledger = new Ledger();
    const store = new FileArtifactStore(root, ledger);
    const bytes = Buffer.from("durable local SVG");

    const first = await store.putVerified("svg", bytes, { signatureId: `sg1_${"a".repeat(52)}` });
    const repeat = await store.putVerified("svg", bytes, { signatureId: `sg1_${"a".repeat(52)}` });
    const second = await store.putVerified("svg", bytes, { signatureId: `sg1_${"b".repeat(52)}` });

    expect(repeat.key).toBe(first.key);
    expect(second.key).toBe(first.key);
    expect(first.referenceCreated).toBe(true);
    expect(repeat.referenceCreated).toBe(false);
    expect(await ledger.count(first.key)).toBe(2);
    expect(await store.get(first.key)).toEqual(bytes);
    await expect(store.delete(first.key)).rejects.toThrow("Referenced local artifacts cannot be deleted");
  });

  it("rejects traversal-shaped object keys", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "sg-file-artifacts-"));
    roots.push(root);
    const store = new FileArtifactStore(root);
    await expect(store.get("../outside.svg")).rejects.toThrow("Invalid artifact storage key");
  });
});

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

describe("FileArtifactStore integrity and lifecycle", () => {
  const newStore = async (ledger?: Ledger) => {
    const root = await mkdtemp(resolve(tmpdir(), "sg-file-artifacts-"));
    roots.push(root);
    return { root, store: new FileArtifactStore(root, ledger) };
  };
  const signatureId = `sg1_${"c".repeat(52)}`;

  it("refuses to reuse a stored object whose bytes no longer match its content address", async () => {
    const { root, store } = await newStore();
    const bytes = Buffer.from("frozen artwork");
    const stored = await store.putVerified("svg", bytes, { signatureId });

    await writeFile(resolve(root, "objects", stored.key), Buffer.from("tampered artwork"));
    await expect(store.putVerified("svg", bytes, { signatureId })).rejects.toThrow(/content-addressed integrity check/);
  });

  it("refuses to reuse a stored object of the right hash but the wrong length", async () => {
    const { root, store } = await newStore();
    const bytes = Buffer.from("frozen artwork");
    const stored = await store.putVerified("svg", bytes, { signatureId });

    await writeFile(resolve(root, "objects", stored.key), Buffer.concat([bytes, Buffer.from("!")]));
    await expect(store.putVerified("svg", bytes, { signatureId })).rejects.toThrow(/content-addressed integrity check/);
  });

  it("reports a created reference when no ledger is attached and never claims one on release", async () => {
    const { store } = await newStore();
    const stored = await store.putVerified("png", Buffer.from("card bytes"), { signatureId });
    expect(stored.referenceCreated).toBe(true);
    expect(await store.releaseReference("png", stored.key, signatureId)).toBe(false);
  });

  it("deletes only once the ledger holds no reference, and tolerates a missing object", async () => {
    const ledger = new Ledger();
    const { root, store } = await newStore(ledger);
    const stored = await store.putVerified("svg", Buffer.from("releasable"), { signatureId });

    await expect(store.delete(stored.key)).rejects.toThrow(/Referenced local artifacts/);
    expect(await store.releaseReference("svg", stored.key, signatureId)).toBe(true);
    expect(await ledger.count(stored.key)).toBe(0);
    await store.delete(stored.key);
    expect(await store.get(stored.key)).toBeNull();
    // A second delete is a no-op rather than an error, so cleanup stays idempotent.
    await store.delete(stored.key);
  });

  it("rejects every storage key that is not a content-addressed svg or png object", async () => {
    const { store } = await newStore();
    for (const key of [
      "objects/x.svg",
      `sha256/${"a".repeat(63)}.svg`,
      `sha256/${"a".repeat(64)}.gif`,
      `sha256/${"A".repeat(64)}.svg`,
      `sha256/${"a".repeat(64)}.svg/../../escape.svg`,
      `../sha256/${"a".repeat(64)}.svg`,
    ]) {
      await expect(store.get(key)).rejects.toThrow(/Invalid artifact storage key/);
      await expect(store.delete(key)).rejects.toThrow(/Invalid artifact storage key/);
    }
  });

  it("leaves no temporary file behind when the object directory cannot be written", async () => {
    const { root, store } = await newStore();
    const bytes = Buffer.from("unwritable");
    await store.putVerified("svg", Buffer.from("seed the directory"), { signatureId });
    const objects = resolve(root, "objects", "sha256");
    await chmod(objects, 0o500);
    try {
      await expect(store.putVerified("svg", bytes, { signatureId })).rejects.toThrow();
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(objects)).filter((entry) => entry.includes(".tmp-"))).toEqual([]);
    } finally {
      await chmod(objects, 0o700);
    }
  });

  it("returns the exact stored bytes for a key it wrote", async () => {
    const { root, store } = await newStore();
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252]);
    const stored = await store.putVerified("png", bytes, { signatureId });
    expect(await store.get(stored.key)).toEqual(Buffer.from(bytes));
    expect(await readFile(resolve(root, "objects", stored.key))).toEqual(Buffer.from(bytes));
    expect(stored.byteLength).toBe(bytes.length);
  });
});

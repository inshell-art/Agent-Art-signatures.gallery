import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./memoryStore.js";
import type { NewInstance } from "./types.js";

function newInstance(overrides: Partial<NewInstance> = {}): NewInstance {
  return {
    xUserId: null,
    seedHandle: "alice",
    readingCode: "hfwo" as any,
    readingJson: { tempo: "hurried", weight: "firm", steadiness: "wavering", reach: "open" },
    rationale: null,
    sourcePostId: "1",
    offsetVector: { tempo: 1, weight: 1, steadiness: 0, reach: 1 },
    specVersion: "test-v0",
    mapVersion: "test-map-v0",
    schemaVersion: "reading.v1",
    provenance: "unverified",
    supersedes: null,
    ...overrides,
  };
}

describe("MemoryStore", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  describe("accounts / claiming", () => {
    it("returns null for an unknown xUserId", async () => {
      expect(await store.getAccountByXUserId("999")).toBeNull();
    });

    it("creates an account on first claim, freezing seedHandle", async () => {
      const account = await store.claimAccount("1", "alice");
      expect(account).toEqual({ xUserId: "1", seedHandle: "alice", currentHandle: "alice", claimedAt: expect.any(Date) });
    });

    it("on a later claim by the same xUserId, updates currentHandle but never seedHandle (§10)", async () => {
      await store.claimAccount("1", "alice");
      const renamed = await store.claimAccount("1", "alice_renamed");
      expect(renamed.seedHandle).toBe("alice");
      expect(renamed.currentHandle).toBe("alice_renamed");

      const fetched = await store.getAccountByXUserId("1");
      expect(fetched).toEqual(renamed);
    });

    it("keeps separate accounts distinct by xUserId even with the same handle", async () => {
      const a = await store.claimAccount("1", "shared");
      const b = await store.claimAccount("2", "shared");
      expect(a.xUserId).not.toBe(b.xUserId);
      expect(await store.getAccountByXUserId("1")).toEqual(a);
      expect(await store.getAccountByXUserId("2")).toEqual(b);
    });
  });

  describe("instances", () => {
    it("assigns sequential ids and per-handle sequence numbers, independent across handles", async () => {
      const a1 = await store.insertInstance(newInstance({ seedHandle: "alice", sourcePostId: "1" }));
      const b1 = await store.insertInstance(newInstance({ seedHandle: "bob", sourcePostId: "1" }));
      const a2 = await store.insertInstance(newInstance({ seedHandle: "alice", sourcePostId: "2" }));

      expect([a1.id, b1.id, a2.id]).toEqual(["1", "2", "3"]);
      expect(a1.sequence).toBe(1);
      expect(b1.sequence).toBe(1);
      expect(a2.sequence).toBe(2);
    });

    it("finds an instance by idempotency key, scoped per handle", async () => {
      await store.insertInstance(newInstance({ seedHandle: "alice", sourcePostId: "42" }));
      expect(await store.findInstanceByIdempotencyKey("alice", "42")).not.toBeNull();
      expect(await store.findInstanceByIdempotencyKey("alice", "43")).toBeNull();
      expect(await store.findInstanceByIdempotencyKey("bob", "42")).toBeNull();
    });

    it("lists instances for a handle ordered by sequence, excluding other handles", async () => {
      await store.insertInstance(newInstance({ seedHandle: "alice", sourcePostId: "1" }));
      await store.insertInstance(newInstance({ seedHandle: "bob", sourcePostId: "1" }));
      await store.insertInstance(newInstance({ seedHandle: "alice", sourcePostId: "2" }));
      await store.insertInstance(newInstance({ seedHandle: "alice", sourcePostId: "3" }));

      const aliceInstances = await store.listInstancesForHandle("alice");
      expect(aliceInstances.map((i) => i.sourcePostId)).toEqual(["1", "2", "3"]);
      expect(aliceInstances.every((i) => i.seedHandle === "alice")).toBe(true);
    });

    it("returns an empty list for a handle with no instances", async () => {
      expect(await store.listInstancesForHandle("nobody")).toEqual([]);
    });

    it("gets an instance by id, or null if unknown", async () => {
      const inserted = await store.insertInstance(newInstance());
      expect(await store.getInstanceById(inserted.id)).toEqual(inserted);
      expect(await store.getInstanceById("does-not-exist")).toBeNull();
    });

    it("updates provenance in place without touching other fields", async () => {
      const inserted = await store.insertInstance(newInstance({ provenance: "unverified" }));
      await store.updateProvenance(inserted.id, "verified");
      const updated = await store.getInstanceById(inserted.id);
      expect(updated?.provenance).toBe("verified");
      expect(updated?.id).toBe(inserted.id);
      expect(updated?.sourcePostId).toBe(inserted.sourcePostId);
    });

    it("silently no-ops updateProvenance for an unknown id", async () => {
      await expect(store.updateProvenance("does-not-exist", "verified")).resolves.toBeUndefined();
    });

    it("keeps id counters independent across separate MemoryStore instances", async () => {
      const other = new MemoryStore();
      const fromStore = await store.insertInstance(newInstance());
      const fromOther = await other.insertInstance(newInstance());
      expect(fromStore.id).toBe("1");
      expect(fromOther.id).toBe("1");
    });
  });
});

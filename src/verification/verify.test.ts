import { describe, expect, it, vi } from "vitest";
import type { Store } from "../store/types.js";
import { verifyAndRecordProvenance } from "./verify.js";
import type { XApiClient } from "./xApiClient.js";

function fakeStore(): Store {
  return {
    getAccountByXUserId: vi.fn(),
    claimAccount: vi.fn(),
    findInstanceByIdempotencyKey: vi.fn(),
    insertInstance: vi.fn(),
    listInstancesForHandle: vi.fn(),
    getInstanceById: vi.fn(),
    updateProvenance: vi.fn(async () => {}),
  };
}

describe("verifyAndRecordProvenance", () => {
  it("records 'verified' when the X API confirms the mention", async () => {
    const store = fakeStore();
    const xApiClient: XApiClient = { verifyMention: vi.fn(async () => true) };

    await verifyAndRecordProvenance(store, xApiClient, "instance-1", "alice", "123", "grok");

    expect(xApiClient.verifyMention).toHaveBeenCalledWith({ postId: "123", handle: "alice", agentHandle: "grok" });
    expect(store.updateProvenance).toHaveBeenCalledWith("instance-1", "verified");
  });

  it("records 'unverified' when the X API can't confirm the mention", async () => {
    const store = fakeStore();
    const xApiClient: XApiClient = { verifyMention: vi.fn(async () => false) };

    await verifyAndRecordProvenance(store, xApiClient, "instance-1", "alice", "123", "grok");

    expect(store.updateProvenance).toHaveBeenCalledWith("instance-1", "unverified");
  });

  it("propagates a rejection from the X API client rather than swallowing it (caller's job to catch)", async () => {
    const store = fakeStore();
    const xApiClient: XApiClient = { verifyMention: vi.fn(async () => Promise.reject(new Error("network down"))) };

    await expect(verifyAndRecordProvenance(store, xApiClient, "instance-1", "alice", "123", "grok")).rejects.toThrow(
      "network down",
    );
    expect(store.updateProvenance).not.toHaveBeenCalled();
  });
});

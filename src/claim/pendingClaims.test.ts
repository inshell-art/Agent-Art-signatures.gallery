import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingClaims } from "./pendingClaims.js";

describe("PendingClaims", () => {
  it("returns the verifier that started a state", () => {
    const pending = new PendingClaims();
    pending.start("state-1", "verifier-1");
    expect(pending.consume("state-1")).toBe("verifier-1");
  });

  it("is single-use: consuming the same state twice returns null the second time", () => {
    const pending = new PendingClaims();
    pending.start("state-1", "verifier-1");
    expect(pending.consume("state-1")).toBe("verifier-1");
    expect(pending.consume("state-1")).toBeNull();
  });

  it("returns null for an unknown state (a forged callback)", () => {
    const pending = new PendingClaims();
    expect(pending.consume("never-started")).toBeNull();
  });

  it("keeps distinct states independent", () => {
    const pending = new PendingClaims();
    pending.start("a", "verifier-a");
    pending.start("b", "verifier-b");
    expect(pending.consume("b")).toBe("verifier-b");
    expect(pending.consume("a")).toBe("verifier-a");
  });

  describe("TTL expiry", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("expires a state after 5 minutes", () => {
      const pending = new PendingClaims();
      pending.start("state-1", "verifier-1");
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(pending.consume("state-1")).toBeNull();
    });

    it("still accepts a state just under the TTL", () => {
      const pending = new PendingClaims();
      pending.start("state-1", "verifier-1");
      vi.advanceTimersByTime(5 * 60 * 1000 - 1);
      expect(pending.consume("state-1")).toBe("verifier-1");
    });
  });
});

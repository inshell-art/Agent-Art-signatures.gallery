import { describe, expect, it } from "vitest";
import { DailyCircuitBreaker, SlidingWindowLimits } from "./limits.js";

describe("sliding window rate limits", () => {
  it("refuses the request that would exceed the limit and allows it again once the window passes", () => {
    const limits = new SlidingWindowLimits();
    expect(limits.consume("claim", "ip", 2, 1_000, 0)).toBe(true);
    expect(limits.consume("claim", "ip", 2, 1_000, 100)).toBe(true);
    expect(limits.consume("claim", "ip", 2, 1_000, 200)).toBe(false);
    // A refusal must not itself count as an event, or the caller could never recover.
    expect(limits.consume("claim", "ip", 2, 1_000, 300)).toBe(false);
    expect(limits.consume("claim", "ip", 2, 1_000, 1_101)).toBe(true);
  });

  it("keeps buckets and keys independent", () => {
    const limits = new SlidingWindowLimits();
    expect(limits.consume("claim", "alice", 1, 1_000, 0)).toBe(true);
    expect(limits.consume("claim", "alice", 1, 1_000, 0)).toBe(false);
    expect(limits.consume("claim", "bob", 1, 1_000, 0)).toBe(true);
    expect(limits.consume("mint", "alice", 1, 1_000, 0)).toBe(true);
  });

  it("keeps bucket names that share a prefix from sharing a budget", () => {
    const limits = new SlidingWindowLimits();
    // The bucket/key boundary must survive names that differ only in where it falls.
    expect(limits.consume("claim", "x-1", 1, 1_000, 0)).toBe(true);
    expect(limits.consume("claim-x", "1", 1, 1_000, 0)).toBe(true);
    expect(limits.consume("claim", "x-1", 1, 1_000, 0)).toBe(false);
    expect(limits.consume("claim-x", "1", 1, 1_000, 0)).toBe(false);
  });

  it("expires stale keys once the map grows past its bound without dropping live ones", () => {
    const limits = new SlidingWindowLimits();
    for (let index = 0; index < 2_100; index += 1) {
      expect(limits.consume("sweep", `key-${index}`, 1, 1_000, 0)).toBe(true);
    }
    expect(limits.consume("sweep", "key-0", 1, 1_000, 0)).toBe(false);

    // Still inside the window: a sweep must retain every recorded event.
    expect(limits.consume("sweep", "fresh-inside", 1, 1_000, 500)).toBe(true);
    expect(limits.consume("sweep", "key-0", 1, 1_000, 500)).toBe(false);

    // Past the window: stale keys are dropped and the caller is served again.
    expect(limits.consume("sweep", "fresh-outside", 1, 1_000, 5_000)).toBe(true);
    expect(limits.consume("sweep", "key-0", 1, 1_000, 5_000)).toBe(true);
    expect(limits.consume("sweep", "fresh-outside", 1, 1_000, 5_001)).toBe(false);
  });
});

describe("daily identity circuit breaker", () => {
  it("stops at the limit and reports usage without consuming a call", () => {
    const breaker = new DailyCircuitBreaker(2);
    expect(breaker.usage()).toEqual({ count: 0, limit: 2 });
    expect(breaker.tryConsume(new Date("2026-09-11T10:00:00.000Z"))).toBe(true);
    expect(breaker.tryConsume(new Date("2026-09-11T23:59:59.999Z"))).toBe(true);
    expect(breaker.usage()).toEqual({ count: 2, limit: 2 });
    expect(breaker.tryConsume(new Date("2026-09-11T23:59:59.999Z"))).toBe(false);
    expect(breaker.usage()).toEqual({ count: 2, limit: 2 });
  });

  it("resets on the UTC day boundary, not on a rolling window", () => {
    const breaker = new DailyCircuitBreaker(1);
    expect(breaker.tryConsume(new Date("2026-09-11T00:00:00.000Z"))).toBe(true);
    expect(breaker.tryConsume(new Date("2026-09-11T12:00:00.000Z"))).toBe(false);
    expect(breaker.tryConsume(new Date("2026-09-12T00:00:00.000Z"))).toBe(true);
    expect(breaker.usage()).toEqual({ count: 1, limit: 1 });
    // A clock that moves backwards into another day still re-arms rather than locking out.
    expect(breaker.tryConsume(new Date("2026-09-11T00:00:00.000Z"))).toBe(true);
  });

  it("refuses every call when configured with a zero limit", () => {
    const breaker = new DailyCircuitBreaker(0);
    expect(breaker.tryConsume(new Date("2026-09-11T10:00:00.000Z"))).toBe(false);
    expect(breaker.usage()).toEqual({ count: 0, limit: 0 });
  });
});

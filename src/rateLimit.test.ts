import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "./rateLimit.js";

describe("RateLimiter", () => {
  it("allows up to the limit within the window, then blocks", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("tracks keys independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("b")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  it("a limit of 0 blocks every request for a key", () => {
    const limiter = new RateLimiter(0, 60_000);
    expect(limiter.tryConsume("a")).toBe(false);
  });

  describe("sliding window", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("frees up capacity once the oldest hit falls outside the window", () => {
      const limiter = new RateLimiter(2, 1000);
      expect(limiter.tryConsume("a")).toBe(true);
      vi.advanceTimersByTime(500);
      expect(limiter.tryConsume("a")).toBe(true);
      expect(limiter.tryConsume("a")).toBe(false); // window full: two hits inside 1000ms

      vi.advanceTimersByTime(501); // first hit (t=0) now outside the 1000ms window
      expect(limiter.tryConsume("a")).toBe(true);
    });

    it("does not free capacity before the window has elapsed", () => {
      const limiter = new RateLimiter(1, 1000);
      expect(limiter.tryConsume("a")).toBe(true);
      vi.advanceTimersByTime(999);
      expect(limiter.tryConsume("a")).toBe(false);
    });
  });
});

import { describe, expect, it } from "vitest";
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
});

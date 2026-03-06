import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiter } from "@/lib/tws/rate-limiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(3, 1000); // 3 requests per 1 second (for fast tests)
  });

  it("allows requests under the limit", async () => {
    await limiter.waitForSlot();
    await limiter.waitForSlot();
    await limiter.waitForSlot();
    expect(limiter.activeCount).toBe(3);
  });

  it("tracks active count correctly", async () => {
    expect(limiter.activeCount).toBe(0);
    await limiter.waitForSlot();
    expect(limiter.activeCount).toBe(1);
    await limiter.waitForSlot();
    expect(limiter.activeCount).toBe(2);
  });

  it("resets correctly", async () => {
    await limiter.waitForSlot();
    await limiter.waitForSlot();
    expect(limiter.activeCount).toBe(2);
    limiter.reset();
    expect(limiter.activeCount).toBe(0);
  });

  it("expires old timestamps from the window", async () => {
    const shortLimiter = new RateLimiter(2, 100); // 2 requests per 100ms
    await shortLimiter.waitForSlot();
    await shortLimiter.waitForSlot();
    expect(shortLimiter.activeCount).toBe(2);

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 150));
    expect(shortLimiter.activeCount).toBe(0);

    // Should be able to make more requests
    await shortLimiter.waitForSlot();
    expect(shortLimiter.activeCount).toBe(1);
  });

  it("uses default values (55 requests, 10 min window)", () => {
    const defaultLimiter = new RateLimiter();
    expect(defaultLimiter.activeCount).toBe(0);
  });
});

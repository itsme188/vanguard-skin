/**
 * Token-bucket rate limiter for IBKR TWS API requests.
 *
 * IB enforces ~60 historical data requests per 10-minute window.
 * We use a conservative limit of 55 to provide headroom.
 */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private maxRequests: number = 55,
    private windowMs: number = 10 * 60 * 1000, // 10 minutes
  ) {}

  /**
   * Wait until a request slot is available.
   * Resolves immediately if under the limit, otherwise waits.
   */
  async waitForSlot(): Promise<void> {
    while (true) {
      const now = Date.now();
      // Purge timestamps outside the window
      this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return;
      }

      // Wait until the oldest timestamp exits the window
      const oldest = this.timestamps[0];
      const waitTime = this.windowMs - (now - oldest) + 100; // +100ms buffer
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(waitTime, 5000)),
      );
    }
  }

  /** Current number of requests in the active window. */
  get activeCount(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    return this.timestamps.length;
  }

  /** Estimated seconds until a slot opens. Returns 0 if immediately available. */
  get estimatedWaitSeconds(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length < this.maxRequests) return 0;
    const oldest = this.timestamps[0];
    return Math.ceil((this.windowMs - (now - oldest)) / 1000);
  }

  /** Reset the rate limiter (useful for testing). */
  reset(): void {
    this.timestamps = [];
  }
}

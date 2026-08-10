/**
 * Tests for running-marker.ts — verifying the "evening" type extension.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setRunningMarker,
  clearRunningMarker,
  withRunningMarker,
  confirmMacSent,
} from "@/lib/cron/running-marker";

describe("running-marker", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
  });

  it("setRunningMarker('evening') calls /internal/running-marker?type=evening&action=set", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "topsecret";

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await setRunningMarker("evening");

    expect(fetch).toHaveBeenCalledWith(
      "https://worker.example.com/internal/running-marker?type=evening&action=set",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Cron-Secret": "topsecret" }),
      })
    );
  });

  it("clearRunningMarker('evening') calls /internal/running-marker?type=evening&action=clear", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "topsecret";

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await clearRunningMarker("evening");

    expect(fetch).toHaveBeenCalledWith(
      "https://worker.example.com/internal/running-marker?type=evening&action=clear",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("no-ops when WORKER_MARKER_URL is unset (evening)", async () => {
    delete process.env.WORKER_MARKER_URL;
    process.env.CRON_SHARED_SECRET = "s";

    await setRunningMarker("evening");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("existing briefing type still works for set", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "s";

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await setRunningMarker("briefing");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("type=briefing&action=set"),
      expect.anything()
    );
  });

  it("existing digest type still works for clear", async () => {
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "s";

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await clearRunningMarker("digest");

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("type=digest&action=clear"),
      expect.anything()
    );
  });
});

/**
 * withRunningMarker — holds `mac-running-{type}` for the whole lifetime of the
 * send pipeline so an awake-but-slow Mac never loses the race to the Worker's
 * cloud fallback.
 *
 * Regression context (2026-08-09 Sunday briefing): the route fired
 * `void setRunningMarker("briefing")` and immediately entered 215.6s of
 * synchronous better-sqlite3 work. The un-awaited fetch never got an event-loop
 * turn, its 3s AbortController fired, and the marker was never written — so the
 * Worker's 16:45 dispatch saw no live Mac and shipped a degraded duplicate.
 * Even a successfully-written marker would have expired: the old 10-min TTL is
 * shorter than the gap from every Mac tick to the Worker's dispatch.
 */
describe("withRunningMarker", () => {
  const OLD_ENV = process.env;

  const callsMatching = (fragment: string) =>
    vi.mocked(fetch).mock.calls.filter(([url]) =>
      String(url).includes(fragment)
    ).length;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "topsecret";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("awaits the initial set before invoking fn", async () => {
    // The 2026-08-09 pin. With `void setRunningMarker(...)` the pipeline starts
    // immediately and the marker write is left to race a starved event loop.
    let resolveSet: ((res: Response) => void) | undefined;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveSet = resolve;
      })
    );

    const fn = vi.fn().mockResolvedValue("sent");
    const pending = withRunningMarker("briefing", fn);

    await Promise.resolve();
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    resolveSet!({ ok: true } as Response);
    await expect(pending).resolves.toBe("sent");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("renews the marker across a pipeline longer than the old 10-minute TTL", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    let finish: (() => void) | undefined;
    const pipeline = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const pending = withRunningMarker("digest", () => pipeline);

    // 14 minutes in — under the old 10-min TTL the marker was long gone.
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(callsMatching("action=set")).toBeGreaterThanOrEqual(7);
    expect(callsMatching("action=clear")).toBe(0);

    finish!();
    await pending;
  });

  it("stops the heartbeat and clears the marker once fn resolves", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await withRunningMarker("evening", async () => "done");

    expect(callsMatching("type=evening&action=clear")).toBe(1);

    const setsAfterCompletion = callsMatching("action=set");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(callsMatching("action=set")).toBe(setsAfterCompletion);
  });

  it("clears the marker and rethrows when fn throws", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await expect(
      withRunningMarker("briefing", async () => {
        throw new Error("pipeline exploded");
      })
    ).rejects.toThrow("pipeline exploded");

    expect(callsMatching("type=briefing&action=clear")).toBe(1);

    const setsAfterThrow = callsMatching("action=set");
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(callsMatching("action=set")).toBe(setsAfterThrow);
  });

  it("still runs fn when the initial set fails", async () => {
    // Never block email delivery on Worker RTT — a marker we could not write is
    // a degraded race, not a failed send.
    vi.mocked(fetch).mockRejectedValue(new Error("worker unreachable"));

    const fn = vi.fn().mockResolvedValue("sent anyway");

    await expect(withRunningMarker("digest", fn)).resolves.toBe("sent anyway");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("no-ops the marker calls but still runs fn when env is unset", async () => {
    delete process.env.WORKER_MARKER_URL;

    const fn = vi.fn().mockResolvedValue("sent");

    await expect(withRunningMarker("briefing", fn)).resolves.toBe("sent");
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * Issue #40: a heartbeat PUT already in flight when `fn` resolves must not
   * be allowed to land AFTER the finally's DELETE — that would recreate a
   * fresh 15-min `mac-running` marker after the pipeline has already ended.
   */
  describe("heartbeat overlap / in-flight awaiting (issue #40)", () => {
    it("awaits an in-flight heartbeat before issuing the clear call", async () => {
      vi.useFakeTimers();

      let setCallCount = 0;
      let resolveHeartbeat: ((res: Response) => void) | undefined;

      vi.mocked(fetch).mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("action=set")) {
          setCallCount++;
          if (setCallCount === 1) {
            // Initial (awaited) set — resolves immediately.
            return Promise.resolve({ ok: true } as Response);
          }
          // First heartbeat tick — stays pending until the test resolves it.
          return new Promise<Response>((resolve) => {
            resolveHeartbeat = resolve;
          });
        }
        return Promise.resolve({ ok: true } as Response); // clear
      });

      let finishPipeline: (() => void) | undefined;
      const pipeline = new Promise<void>((resolve) => {
        finishPipeline = resolve;
      });

      const pending = withRunningMarker("briefing", () => pipeline, {
        heartbeatMs: 1000,
      });

      await Promise.resolve();
      await Promise.resolve();

      // Fire exactly one heartbeat tick — its PUT is now in flight and unresolved.
      await vi.advanceTimersByTimeAsync(1000);
      expect(resolveHeartbeat).toBeDefined();
      expect(callsMatching("type=briefing&action=clear")).toBe(0);

      // Pipeline finishes while that heartbeat fetch is STILL pending.
      finishPipeline!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The finally must be blocked awaiting the in-flight beat — no clear yet.
      expect(callsMatching("type=briefing&action=clear")).toBe(0);

      // Only once the heartbeat's fetch resolves does the finally proceed.
      resolveHeartbeat!({ ok: true } as Response);
      await pending;

      expect(callsMatching("type=briefing&action=clear")).toBe(1);
    });

    it("never issues an overlapping heartbeat while one is still in flight", async () => {
      vi.useFakeTimers();

      let setCallCount = 0;
      let resolveFirstHeartbeat: ((res: Response) => void) | undefined;

      vi.mocked(fetch).mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("action=set")) {
          setCallCount++;
          if (setCallCount === 1) {
            return Promise.resolve({ ok: true } as Response); // initial set
          }
          if (setCallCount === 2) {
            // First heartbeat — left pending on purpose.
            return new Promise<Response>((resolve) => {
              resolveFirstHeartbeat = resolve;
            });
          }
          return Promise.resolve({ ok: true } as Response);
        }
        return Promise.resolve({ ok: true } as Response); // clear
      });

      // A pipeline that never resolves on its own — this test only cares
      // about heartbeat ticks, not completion.
      withRunningMarker("digest", () => new Promise<string>(() => {}), {
        heartbeatMs: 1000,
      });

      await Promise.resolve();
      await Promise.resolve();

      // First tick starts the in-flight PUT.
      await vi.advanceTimersByTimeAsync(1000);
      expect(setCallCount).toBe(2);

      // Second tick fires while the first PUT is still unresolved — must be
      // skipped, not fire a third fetch.
      await vi.advanceTimersByTimeAsync(1000);
      expect(setCallCount).toBe(2);

      // Resolve the first heartbeat — the NEXT tick is now free to fire.
      resolveFirstHeartbeat!({ ok: true } as Response);
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(1000);
      expect(setCallCount).toBe(3);
    });
  });

  /**
   * Issue #39: `confirmMacSent` can't signal failure to the wrapper. A
   * successful send whose confirmation never lands must NOT have
   * `mac-running` cleared — otherwise the Worker sees neither `mac-sent` nor
   * `mac-running` and its catch-up sweep can fire a duplicate.
   */
  describe("confirmSent ack tracking (issue #39)", () => {
    it("clears the marker normally once confirmSent() is acked", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const result = await withRunningMarker("digest", async ({ confirmSent }) => {
        await confirmSent();
        return "sent";
      });

      expect(result).toBe("sent");
      expect(callsMatching("type=digest&action=clear")).toBe(1);
    });

    it("clears the marker normally when fn never calls confirmSent()", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      const result = await withRunningMarker("evening", async () => "skipped");

      expect(result).toBe("skipped");
      expect(callsMatching("type=evening&action=clear")).toBe(1);
    });

    it("leaves mac-running in place and warns when confirmSent() is attempted but never acked", async () => {
      vi.useFakeTimers();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      vi.mocked(fetch).mockImplementation((url: unknown) => {
        const s = String(url);
        if (s.includes("/internal/mac-sent")) {
          return Promise.resolve({ ok: false, status: 500 } as Response);
        }
        return Promise.resolve({ ok: true } as Response); // set/clear
      });

      const pending = withRunningMarker("briefing", async ({ confirmSent }) => {
        await confirmSent();
        return "sent";
      });

      // confirmMacSent retries 3x, 2s apart by default — advance past both
      // inter-attempt delays so every attempt runs to exhaustion.
      await vi.advanceTimersByTimeAsync(6000);

      await expect(pending).resolves.toBe("sent");
      expect(callsMatching("type=briefing&action=clear")).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("confirmMacSent(briefing) never acked"),
      );

      warnSpy.mockRestore();
    });

    it("still clears the marker when fn throws, even without a confirm attempt", async () => {
      vi.useFakeTimers();
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

      await expect(
        withRunningMarker("digest", async () => {
          throw new Error("pipeline exploded");
        })
      ).rejects.toThrow("pipeline exploded");

      expect(callsMatching("type=digest&action=clear")).toBe(1);
    });
  });
});

/**
 * confirmMacSent — bounded retry (issue #39). A single dropped fetch used to
 * silently discard the confirmation; now it returns a boolean the caller can
 * actually act on, with a small bounded retry to ride out one transient blip.
 */
describe("confirmMacSent", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    process.env.WORKER_MARKER_URL = "https://worker.example.com";
    process.env.CRON_SHARED_SECRET = "topsecret";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = OLD_ENV;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns true on the first successful attempt without retrying", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await expect(
      confirmMacSent("briefing", { retryDelayMs: 0 })
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries up to the configured attempt count and returns false when all fail", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);

    await expect(
      confirmMacSent("digest", { attempts: 3, retryDelayMs: 0 })
    ).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("returns true if a later attempt succeeds after earlier ones fail", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ ok: true } as Response);

    await expect(
      confirmMacSent("evening", { attempts: 3, retryDelayMs: 0 })
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("waits retryDelayMs between attempts", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);

    const pending = confirmMacSent("briefing", {
      attempts: 2,
      retryDelayMs: 5000,
    });

    // First attempt's (microtask-resolved) fetch runs without needing a
    // timer advance.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Still inside the delay window — the second attempt must not fire yet.
    await vi.advanceTimersByTimeAsync(4000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Past the delay — second (final) attempt fires.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);

    await expect(pending).resolves.toBe(false);
  });

  it("returns false without calling fetch when WORKER_MARKER_URL is unset", async () => {
    delete process.env.WORKER_MARKER_URL;

    await expect(confirmMacSent("briefing")).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns false without calling fetch when CRON_SHARED_SECRET is unset", async () => {
    delete process.env.CRON_SHARED_SECRET;

    await expect(confirmMacSent("digest")).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

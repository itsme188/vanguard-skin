/**
 * Tests for running-marker.ts — verifying the "evening" type extension.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setRunningMarker,
  clearRunningMarker,
  withRunningMarker,
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
});

/**
 * The Hub's polling mechanics (slice F, Task 6; spec §4.6, M-F3).
 *
 * Fake timers plus an injected fetch — no wall-clock sleeps, no jsdom, no React
 * Testing Library (neither is a dependency of this repo and none may be added).
 * That constraint is exactly why `createPollController` is React-free.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createPollController,
  type FetchImpl,
  type StreamSpec,
} from "@/app/dashboard/today/hub-live/poll-controller";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A fetch stub whose per-call resolution is controlled by the test. */
function deferredFetch() {
  const calls: Array<{ url: string; signal: AbortSignal; resolve: (v: unknown) => void }> = [];
  const impl: FetchImpl = (input, init) =>
    new Promise((resolve) => {
      calls.push({
        url: String(input),
        signal: init!.signal as AbortSignal,
        resolve: resolve as (v: unknown) => void,
      });
    }) as Promise<Response>;
  return { impl, calls };
}

const stream = (over: Partial<StreamSpec<string>> = {}): StreamSpec<string> => ({
  name: "status",
  intervalMs: () => 2_000,
  run: async (signal, fetchImpl) => {
    const res = await fetchImpl("/api/print-watch/status", { signal });
    return String(res);
  },
  onResult: () => undefined,
  ...over,
});

describe("createPollController — generations", () => {
  it("DROPS a slow older response that lands after a newer one (spec §8 'generation-ordered responses')", async () => {
    const applied: string[] = [];
    const { impl, calls } = deferredFetch();
    const c = createPollController({
      streams: [stream({ onResult: (v) => applied.push(v) })],
      fetchImpl: impl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // generation 1, in flight

    c.refresh("status");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2); // generation 2, in flight

    calls[1].resolve("new"); // the NEWER one lands first
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve("old"); // the older one lands second
    await vi.advanceTimersByTimeAsync(0);

    expect(applied).toEqual(["new"]); // "old" never reaches onResult
  });

  it("a SUPERSEDED run cannot re-arm the timer while the newer one is still in flight", async () => {
    // What this pins that the test above does not: the generation counter
    // itself. `fire` aborts the previous controller BEFORE stamping the new
    // generation, so at the `onResult` gate `generation !== s.generation` is
    // redundant with `controller.signal.aborted` — delete the counter and the
    // race test above still passes. The counter is NOT dead code, though: the
    // `generation === s.generation` clause in fire()'s `finally` is what stops
    // a superseded run from RESCHEDULING. Without it the stale run below arms a
    // timer, that timer fires mid-flight, aborts the live generation and issues
    // a fourth-wall request — the self-overlap the recursive setTimeout exists
    // to prevent.
    const applied: string[] = [];
    const { impl, calls } = deferredFetch();
    const c = createPollController({
      streams: [stream({ intervalMs: () => 2_000, onResult: (v) => applied.push(v) })],
      fetchImpl: impl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // generation 1, in flight

    c.refresh("status");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2); // generation 2 issued; generation 1 aborted

    // The stale run's promise ignores its own abort signal and lands late —
    // what a cached response, a service worker or any fetch stub can do.
    calls[0].resolve("stale");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);

    // A full cadence later: still exactly two requests, and the NEWER one is
    // still alive rather than aborted by a ghost timer.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(calls).toHaveLength(2);
    expect(calls[1].signal.aborted).toBe(false);
    c.stop();
  });

  it("stamps a generation PER STREAM, never one shared counter (the generationOf seam)", async () => {
    const { impl, calls } = deferredFetch();
    const c = createPollController({
      streams: [stream(), stream({ name: "cockpit", intervalMs: () => 60_000 })],
      fetchImpl: impl,
    });
    expect(c.generationOf("status")).toBe(0); // nothing issued yet
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.generationOf("status")).toBe(1);
    expect(c.generationOf("cockpit")).toBe(1);

    c.refresh("status");
    await vi.advanceTimersByTimeAsync(0);
    expect(c.generationOf("status")).toBe(2);
    expect(c.generationOf("cockpit")).toBe(1); // a sibling refresh never bumps it
    expect(c.generationOf("no-such-stream")).toBe(0);

    calls.forEach((k) => k.resolve("x"));
    await vi.advanceTimersByTimeAsync(0);
    c.stop();
  });

  it("aborts the in-flight request on pause and applies nothing", async () => {
    const applied: string[] = [];
    const { impl, calls } = deferredFetch();
    const c = createPollController({
      streams: [stream({ onResult: (v) => applied.push(v) })],
      fetchImpl: impl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0].signal.aborted).toBe(false);

    c.pause();
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);
  });

  it("resume issues exactly ONE immediate fetch per stream and restarts the timer", async () => {
    const { impl, calls } = deferredFetch();
    const c = createPollController({
      streams: [stream(), stream({ name: "cockpit", intervalMs: () => 60_000 })],
      fetchImpl: impl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    calls.forEach((k) => k.resolve("x"));
    await vi.advanceTimersByTimeAsync(0);
    const before = calls.length;

    c.pause();
    c.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(before + 2); // one per stream, not two per stream
  });

  it("follows the print state: the cadence is re-read from intervalMs on EVERY reschedule", async () => {
    let hot = false;
    const { impl, calls } = deferredFetch();
    const c = createPollController({
      streams: [stream({ intervalMs: () => (hot ? 2_000 : 30_000) })],
      fetchImpl: impl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve("x");
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toHaveLength(1); // still cool
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    hot = true;
    calls[1].resolve("x");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(3); // now hot
  });

  it("two hot prints share ONE stream — the controller never forks a poll per print", async () => {
    const { impl, calls } = deferredFetch();
    const c = createPollController({ streams: [stream({ intervalMs: () => 2_000 })], fetchImpl: impl });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    calls[0].resolve("two prints");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2); // 2 ticks, 2 requests — not 4
  });

  it("uses recursive setTimeout, never setInterval, so a slow response cannot overlap itself", async () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const { impl, calls } = deferredFetch();
    const c = createPollController({ streams: [stream()], fetchImpl: impl });
    c.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // the first is still in flight; no second was scheduled
    c.stop();
    spy.mockRestore();
  });

  it("an error in one stream never stops the others and reports through onError", async () => {
    const errors: unknown[] = [];
    const applied: string[] = [];
    const c = createPollController({
      streams: [
        stream({
          name: "bad",
          run: async () => {
            throw new Error("boom");
          },
          onError: (e) => errors.push(e),
        }),
        stream({ name: "good", run: async () => "ok", onResult: (v) => applied.push(v) }),
      ],
      fetchImpl: (async () => new Response("{}")) as FetchImpl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect((errors[0] as Error).message).toBe("boom");
    expect(applied).toEqual(["ok"]);
    c.stop();
  });
});

describe("the trigger tells a stream WHY it is running (Codex round 1 #7 / F-S2)", () => {
  it("reports start, then timer, then refresh, then resume — in that order for the same stream", async () => {
    const triggers: string[] = [];
    const c = createPollController({
      streams: [
        stream({
          intervalMs: () => 1_000,
          run: async (_signal, _fetchImpl, trigger) => {
            triggers.push(trigger);
            return "x";
          },
        }),
      ],
      fetchImpl: (async () => new Response("{}")) as FetchImpl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    c.refresh("status");
    await vi.advanceTimersByTimeAsync(0);
    c.pause();
    c.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers).toEqual(["start", "timer", "refresh", "resume"]);
    c.stop();
  });

  it("a run that returns null never reaches onResult, and still reschedules", async () => {
    const applied: string[] = [];
    const c = createPollController({
      streams: [
        stream({
          intervalMs: () => 1_000,
          run: async (_s, _f, trigger) => (trigger === "start" ? null : "later"),
          onResult: (v) => applied.push(v),
        }),
      ],
      fetchImpl: (async () => new Response("{}")) as FetchImpl,
    });
    c.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]); // the SSR payload was already the freshest thing
    await vi.advanceTimersByTimeAsync(1_000);
    expect(applied).toEqual(["later"]); // the timer still fired
    c.stop();
  });

  it("stop() works when it is destructured off the controller (F-S9)", () => {
    const c = createPollController({
      streams: [stream()],
      fetchImpl: (async () => new Response("{}")) as FetchImpl,
    });
    c.start();
    const { stop } = c;
    expect(() => stop()).not.toThrow();
  });
});

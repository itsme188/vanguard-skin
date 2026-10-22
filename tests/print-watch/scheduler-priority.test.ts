// The low-priority SEC lane (filing summary, spec hardening 11): print-watch
// release acquisition always goes first. A low waiter is granted only when no
// normal waiter is queued for the same host family, and is granted once the
// normal waiters drain. Every existing call (no options) is "normal".

import { describe, it, expect } from "vitest";
import { AcquisitionScheduler } from "@/lib/print-watch/scheduler";

function makeClock(start = 1_000_000) {
  let now = start;
  let sleepers: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ at: now + ms, resolve });
      }),
    async advance(ms: number) {
      now += ms;
      const due = sleepers.filter((s) => s.at <= now);
      sleepers = sleepers.filter((s) => s.at > now);
      for (const s of due.sort((a, b) => a.at - b.at)) s.resolve();
      await flush();
    },
  };
}

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function oneAtATime() {
  const clock = makeClock();
  const s = new AcquisitionScheduler(
    { "sec.gov": { ratePerSecond: 100, concurrency: 1 } },
    { now: clock.now, sleep: clock.sleep },
  );
  return { s, clock };
}

describe("AcquisitionScheduler low priority", () => {
  it("a low waiter queued before a normal waiter is granted after it", async () => {
    const { s } = oneAtATime();
    const order: string[] = [];
    const releaseHeld = await s.throttle("www.sec.gov");

    const low = s.throttle("www.sec.gov", undefined, { priority: "low" }).then((r) => {
      order.push("low");
      return r;
    });
    const normal = s.throttle("data.sec.gov").then((r) => {
      order.push("normal");
      return r;
    });
    await flush();
    expect(order).toEqual([]);

    releaseHeld();
    const releaseNormal = await normal;
    await flush();
    expect(order).toEqual(["normal"]);

    releaseNormal();
    const releaseLow = await low;
    expect(order).toEqual(["normal", "low"]);
    releaseLow();
  });

  it("normal waiters keep FIFO among themselves ahead of every low waiter", async () => {
    const { s } = oneAtATime();
    const order: string[] = [];
    const held = await s.throttle("www.sec.gov");
    const track = (name: string, p: Promise<() => void>) =>
      p.then((release) => {
        order.push(name);
        release();
      });
    const all = Promise.all([
      track("low1", s.throttle("www.sec.gov", undefined, { priority: "low" })),
      track("n1", s.throttle("www.sec.gov")),
      track("low2", s.throttle("www.sec.gov", undefined, { priority: "low" })),
      track("n2", s.throttle("www.sec.gov", undefined, { priority: "normal" })),
    ]);
    held();
    await all;
    expect(order).toEqual(["n1", "n2", "low1", "low2"]);
  });

  it("a low request with free capacity and an empty queue goes straight through", async () => {
    const { s } = oneAtATime();
    const release = await s.throttle("www.sec.gov", undefined, { priority: "low" });
    release();
  });

  it("an aborted low waiter leaves the queue and consumes nothing", async () => {
    const { s } = oneAtATime();
    const held = await s.throttle("www.sec.gov");
    const ac = new AbortController();
    const low = s.throttle("www.sec.gov", ac.signal, { priority: "low" });
    ac.abort();
    await expect(low).rejects.toThrow(/aborted/);
    held();
    const next = await s.throttle("www.sec.gov");
    next();
  });

  it("fetchFor passes the priority through to the throttle", async () => {
    const { s } = oneAtATime();
    const order: string[] = [];
    const held = await s.throttle("www.sec.gov");
    const signal = new AbortController().signal;
    const fake = async (url: string) => {
      order.push(url);
      return new Response(null, { status: 404 });
    };
    const lowFetch = s.fetchFor(signal, fake, { priority: "low" });
    const normalFetch = s.fetchFor(signal, fake);
    const p1 = lowFetch("https://www.sec.gov/low");
    const p2 = normalFetch("https://www.sec.gov/normal");
    await flush();
    held();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["https://www.sec.gov/normal", "https://www.sec.gov/low"]);
  });
});

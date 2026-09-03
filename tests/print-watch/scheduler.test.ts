import { describe, it, expect } from "vitest";
import {
  AcquisitionScheduler,
  AbortedError,
  DEFAULT_POLICY,
  HOST_POLICIES,
  MAX_BODY_HOLD_MS,
  SEC_FAMILY,
  acquisitionScheduler,
  hostFamily,
} from "@/lib/print-watch/scheduler";

/** A manual clock: `sleep` parks the caller until `advance` moves time past its
 *  wake-up. No test in this file may touch the wall clock — every rule the
 *  scheduler enforces is a rule about time, so time is an input here. */
function makeClock(start = 1_000_000) {
  let now = start;
  let sleepers: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleepers.push({ at: now + ms, resolve });
      }),
    /** Move time forward, wake everything due, and drain the microtask queue
     *  the wake-ups produce (a granted waiter may register the next sleep). */
    async advance(ms: number) {
      now += ms;
      const due = sleepers.filter((s) => s.at <= now);
      sleepers = sleepers.filter((s) => s.at > now);
      for (const s of due.sort((a, b) => a.at - b.at)) s.resolve();
      await flush();
    },
    pendingSleepers: () => sleepers.length,
  };
}

/** Drain the microtask queue so promise chains settle without wall-clock time. */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** A response whose body is a stream that never ends on its own — it models a
 *  streamed SEC exhibit that is still arriving. */
function neverEndingResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk"));
    },
  });
  return new Response(body);
}

describe("hostFamily", () => {
  it("folds every sec.gov host into one family and keeps others as themselves", () => {
    expect(hostFamily("www.sec.gov")).toBe(SEC_FAMILY);
    expect(hostFamily("data.sec.gov")).toBe(SEC_FAMILY);
    expect(hostFamily("EFTS.SEC.GOV")).toBe(SEC_FAMILY);
    expect(hostFamily("sec.gov")).toBe(SEC_FAMILY);
    expect(hostFamily("ir.acme.example")).toBe("ir.acme.example");
    // A look-alike host is NOT the SEC family: the suffix match is on ".sec.gov".
    expect(hostFamily("sec.gov.evil.example")).toBe("sec.gov.evil.example");
    expect(hostFamily("notsec.gov")).toBe("notsec.gov");
    expect(hostFamily("  WWW.SEC.GOV  ")).toBe(SEC_FAMILY);
    // A fully-qualified spelling stays inside the SEC budget instead of being
    // handed a private 5/s family of its own.
    expect(hostFamily("www.sec.gov.")).toBe(SEC_FAMILY);
    expect(hostFamily("sec.gov.")).toBe(SEC_FAMILY);
  });

  it("ships the SEC fair-access policy and a default for every other host", () => {
    expect(HOST_POLICIES[SEC_FAMILY]).toEqual({ ratePerSecond: 2, concurrency: 2 });
    expect(DEFAULT_POLICY).toEqual({ ratePerSecond: 5, concurrency: 2 });
    expect(acquisitionScheduler).toBeInstanceOf(AcquisitionScheduler);
  });
});

describe("AcquisitionScheduler.throttle", () => {
  it("SEC family: at most 2 requests per second across CIKs, and the bucket refills", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const r1 = await s.throttle("data.sec.gov");
    const r2 = await s.throttle("www.sec.gov");
    r1();
    r2();
    let third = false;
    const p = s.throttle("efts.sec.gov").then((rel) => {
      third = true;
      rel();
    });
    await clock.advance(100);
    expect(third).toBe(false); // no token yet
    await clock.advance(500); // 600ms → one token refilled at 2/s
    await p;
    expect(third).toBe(true);
  });

  it("concurrency cap: a third in-flight request waits for a release, not for a token", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 2 } }, clock);
    const r1 = await s.throttle("x.example");
    await s.throttle("x.example");
    let third = false;
    const p = s.throttle("x.example").then((rel) => {
      third = true;
      rel();
    });
    await clock.advance(1_000);
    expect(third).toBe(false);
    r1();
    await p; // the release itself must wake the waiter — no clock tick here
    expect(third).toBe(true);
  });

  it("rejects with AbortedError when the signal aborts while waiting, and the slot is not consumed", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 1, concurrency: 1 } }, clock);
    const r1 = await s.throttle("x.example");
    const ac = new AbortController();
    const p = s.throttle("x.example", ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    r1();

    // The aborted waiter left nothing behind: one refilled token is enough.
    let acquired = false;
    const q = s.throttle("x.example").then((rel) => {
      acquired = true;
      rel();
    });
    await clock.advance(1_000);
    await q;
    expect(acquired).toBe(true);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const ac = new AbortController();
    ac.abort();
    await expect(s.throttle("data.sec.gov", ac.signal)).rejects.toBeInstanceOf(AbortedError);
    // …and the token it would have taken is still there.
    const rel = await s.throttle("data.sec.gov");
    rel();
  });

  it("serves waiters first-come-first-served", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 1 } }, clock);
    const held = await s.throttle("x.example");
    const order: string[] = [];
    const a = s.throttle("x.example").then((rel) => {
      order.push("a");
      rel();
    });
    const b = s.throttle("x.example").then((rel) => {
      order.push("b");
      rel();
    });
    held();
    await a;
    await b;
    expect(order).toEqual(["a", "b"]);
  });

  it("different host families do not share a bucket", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    (await s.throttle("data.sec.gov"))();
    (await s.throttle("www.sec.gov"))();
    // SEC's bucket is empty; another host still has its own 5/s bucket.
    let other = false;
    const p = s.throttle("ir.acme.example").then((rel) => {
      other = true;
      rel();
    });
    await flush();
    await p;
    expect(other).toBe(true);
  });
});

describe("AcquisitionScheduler.fetchFor", () => {
  it("throttles by the URL's host family and merges the pass signal into init.signal", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const seen: Array<{ url: string; aborted: boolean; hasSignal: boolean }> = [];
    const fake = async (url: string, init?: RequestInit) => {
      seen.push({
        url,
        aborted: init?.signal?.aborted ?? false,
        hasSignal: Boolean(init?.signal),
      });
      return new Response("ok");
    };
    const ac = new AbortController();
    const f = s.fetchFor(ac.signal, fake);
    // Each body is consumed, which is what returns the concurrency slot — so
    // the only thing the third request can be waiting on is a token.
    await (await f("https://data.sec.gov/submissions/CIK1.json")).text();
    await (await f("https://www.sec.gov/Archives/x.htm")).text();
    let third = false;
    const p = f("https://efts.sec.gov/y").then(async (res) => {
      third = true;
      await res.text();
    });
    await clock.advance(100);
    expect(third).toBe(false); // same family, bucket empty
    await clock.advance(500);
    await p;
    expect(third).toBe(true);
    expect(seen.map((x) => x.aborted)).toEqual([false, false, false]);
    expect(seen.every((x) => x.hasSignal)).toBe(true);
    ac.abort();
    await expect(f("https://data.sec.gov/z")).rejects.toBeInstanceOf(AbortedError);
  });

  it("merges a caller-supplied init.signal with the pass signal", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    let sawAborted: boolean | null = null;
    const fake = async (_url: string, init?: RequestInit) => {
      sawAborted = init?.signal?.aborted ?? false;
      return new Response("ok");
    };
    const pass = new AbortController();
    const perRequest = new AbortController();
    const f = s.fetchFor(pass.signal, fake);
    perRequest.abort();
    await (await f("https://ir.acme.example/a", { signal: perRequest.signal })).text();
    expect(sawAborted).toBe(true); // the per-request signal reached the fetch
    expect(pass.signal.aborted).toBe(false); // …without aborting the pass
  });

  it("holds the concurrency slot until the response body closes", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 2 } }, clock);
    const ac = new AbortController();
    const f = s.fetchFor(ac.signal, async () => new Response("payload"));
    const first = await f("https://x.example/1");
    await f("https://x.example/2"); // second slot, body left unread
    let third = false;
    const p = f("https://x.example/3").then(async (res) => {
      third = true;
      await res.text();
    });
    await clock.advance(1_000); // tokens are plentiful; only slots are scarce
    expect(third).toBe(false);
    expect(await first.text()).toBe("payload"); // reading the body frees slot 1
    await p;
    expect(third).toBe(true);
  });

  it("releases the slot when the request fails before any body (headers-only failure)", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 1 } }, clock);
    const ac = new AbortController();
    const boom = s.fetchFor(ac.signal, async () => {
      throw new Error("socket hang up");
    });
    await expect(boom("https://x.example/1")).rejects.toThrow("socket hang up");

    // A null-body response (204) also releases: there is nothing to stream.
    const empty = s.fetchFor(ac.signal, async () => new Response(null, { status: 204 }));
    const res = await empty("https://x.example/2");
    expect(res.status).toBe(204);

    let third = false;
    const ok = s.fetchFor(ac.signal, async () => new Response("ok"));
    const p = ok("https://x.example/3").then(async (r) => {
      third = true;
      await r.text();
    });
    await flush();
    await p;
    expect(third).toBe(true);
  });

  it("releases the slot at HEADERS for a status nobody streams (404, 302)", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 1 } }, clock);
    const ac = new AbortController();
    // A 404 body that is never read — the ordinary EDGAR "not posted yet".
    const missing = s.fetchFor(ac.signal, async () => new Response("not found", { status: 404 }));
    const gone = await missing("https://x.example/1");
    expect(gone.status).toBe(404);
    // A redirect the caller only reads a header off.
    const moved = s.fetchFor(ac.signal, async () =>
      new Response("moved", { status: 302, headers: { location: "https://x.example/2" } }),
    );
    const hop = await moved("https://x.example/1");
    expect(hop.headers.get("location")).toBe("https://x.example/2");

    // Neither took the single slot with it: the next request goes straight
    // through with no clock advance and no watchdog.
    let third = false;
    const ok = s.fetchFor(ac.signal, async () => new Response("ok"));
    const p = ok("https://x.example/3").then(async (res) => {
      third = true;
      await res.text();
    });
    await flush();
    await p;
    expect(third).toBe(true);
    // …and the bodies are still readable for any caller that wants them.
    expect(await gone.text()).toBe("not found");
  });

  it("still holds the slot for a 200 until its body closes", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 1 } }, clock);
    const ac = new AbortController();
    const f = s.fetchFor(ac.signal, async () => new Response("payload", { status: 200 }));
    const first = await f("https://x.example/1");
    let second = false;
    const p = f("https://x.example/2").then(async (res) => {
      second = true;
      await res.text();
    });
    await clock.advance(1_000);
    expect(second).toBe(false); // the 200's body is still open
    expect(await first.text()).toBe("payload");
    await p;
    expect(second).toBe(true);
  });

  it("releases the slot when the source stream errors mid-body", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 1 } }, clock);
    const ac = new AbortController();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const f = s.fetchFor(ac.signal, async () => {
      if (source) return new Response("ok");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            controller.enqueue(new TextEncoder().encode("first chunk"));
          },
        }),
      );
    });
    const first = await f("https://x.example/1");
    const read = first.text().catch(() => "errored");
    let second = false;
    const p = f("https://x.example/2").then(async (res) => {
      second = true;
      await res.text();
    });
    await clock.advance(1_000);
    expect(second).toBe(false);
    source.error(new Error("socket died")); // the wire drops mid-body
    expect(await read).toBe("errored");
    await p; // released without waiting for MAX_BODY_HOLD_MS
    expect(second).toBe(true);
  });

  it("releases the slot when the consumer cancels the body", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 1 } }, clock);
    const ac = new AbortController();
    const f = s.fetchFor(ac.signal, () => Promise.resolve(neverEndingResponse()));
    const first = await f("https://x.example/1");
    let second = false;
    const p = f("https://x.example/2").then(async (res) => {
      second = true;
      await res.body?.cancel();
    });
    await clock.advance(1_000);
    expect(second).toBe(false);
    await first.body?.cancel();
    await p;
    expect(second).toBe(true);
  });

  it("releases the slot when the pass aborts while a body is still open", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 1 } }, clock);
    const passA = new AbortController();
    const held = s.fetchFor(passA.signal, () => Promise.resolve(neverEndingResponse()));
    await held("https://x.example/1"); // slot held by an unread body

    const passB = new AbortController();
    const waiting = s.fetchFor(passB.signal, async () => new Response("ok"));
    let second = false;
    const p = waiting("https://x.example/2").then(async (res) => {
      second = true;
      await res.text();
    });
    await clock.advance(1_000);
    expect(second).toBe(false);
    passA.abort(); // the pass that owns the open body ends
    await p;
    expect(second).toBe(true);
  });

  it("releases a body that is never read once the hold watchdog expires", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 100, concurrency: 1 } }, clock);
    const ac = new AbortController();
    const f = s.fetchFor(ac.signal, () => Promise.resolve(neverEndingResponse()));
    await f("https://x.example/1"); // abandoned body (a redirect hop, a 404 …)
    let second = false;
    const p = f("https://x.example/2").then(async (res) => {
      second = true;
      await res.body?.cancel();
    });
    await clock.advance(1_000);
    expect(second).toBe(false);
    await clock.advance(MAX_BODY_HOLD_MS);
    await p;
    expect(second).toBe(true);
  });
});

describe("AcquisitionScheduler.runPass", () => {
  it("coalesces: one running pass per print, one pending pass at most, and the pending one runs after", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    let release!: () => void;
    const runs: string[] = [];
    const first = s.runPass(
      7,
      async () => {
        runs.push("a");
        await new Promise<void>((r) => {
          release = r;
        });
      },
      "cadence",
    );
    await flush();
    expect(s.passInFlight(7)).toBe(true);
    const second = s.runPass(7, async () => { runs.push("b"); }, "burst");
    const third = s.runPass(7, async () => { runs.push("c"); }, "burst"); // joins the pending slot
    release();
    await first;
    await second;
    await third;
    expect(runs).toEqual(["a", "b"]); // exactly one pending pass ran; "c" joined it
    expect(s.passInFlight(7)).toBe(false);
  });

  it("passes for different prints run concurrently", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const order: string[] = [];
    let releaseA!: () => void;
    const a = s.runPass(
      1,
      async () => {
        order.push("a-start");
        await new Promise<void>((r) => {
          releaseA = r;
        });
        order.push("a-end");
      },
      "cadence",
    );
    const b = s.runPass(2, async () => { order.push("b"); }, "cadence");
    await b;
    releaseA();
    await a;
    expect(order).toEqual(["a-start", "b", "a-end"]);
  });

  it("a runner that throws does not wedge the print: the next pass runs", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    await expect(
      s.runPass(3, async () => {
        throw new Error("boom");
      }, "cadence"),
    ).rejects.toThrow("boom");
    expect(s.passInFlight(3)).toBe(false);
    let ran = false;
    await s.runPass(3, async () => { ran = true; }, "cadence");
    expect(ran).toBe(true);
  });

  it("a runner that throws SYNCHRONOUSLY settles and leaves the print clean", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const syncThrow = (): Promise<void> => {
      throw new Error("sync boom");
    };
    await expect(s.runPass(8, syncThrow, "cadence")).rejects.toThrow("sync boom");
    expect(s.passInFlight(8)).toBe(false);
    let ran = false;
    await s.runPass(8, async () => { ran = true; }, "cadence");
    expect(ran).toBe(true);
  });

  it("a pending pass still runs after the running pass throws", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    let fail!: (e: unknown) => void;
    const first = s.runPass(4, async () => {
      await new Promise<void>((_r, rej) => {
        fail = rej;
      });
    }, "cadence");
    await flush();
    let pendingRan = false;
    const second = s.runPass(4, async () => { pendingRan = true; }, "go");
    fail(new Error("first blew up"));
    await expect(first).rejects.toThrow("first blew up");
    await second;
    expect(pendingRan).toBe(true);
  });

  it("returns the runner's value and hands the runner an abortable signal", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    let seen: AbortSignal | null = null;
    const value = await s.runPass<number>(
      5,
      async (signal) => {
        seen = signal;
        return 42;
      },
      "go",
    );
    expect(value).toBe(42);
    expect(seen).not.toBeNull();
  });
});

describe("AcquisitionScheduler.reset", () => {
  it("aborts the running pass, rejects the pending one, and frees waiting throttlers", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler({ "x.example": { ratePerSecond: 1, concurrency: 1 } }, clock);
    let passSignal: AbortSignal | null = null;
    let releaseRunner!: () => void;
    const running = s.runPass(11, async (signal) => {
      passSignal = signal;
      await new Promise<void>((r) => {
        releaseRunner = r;
      });
    }, "cadence");
    await flush();
    let pendingRan = false;
    const pending = s.runPass(11, async () => { pendingRan = true; }, "burst");

    const held = await s.throttle("x.example"); // takes the only token + slot
    const waiting = s.throttle("x.example"); // parked behind it

    s.reset();

    expect(passSignal).not.toBeNull();
    expect((passSignal as unknown as AbortSignal).aborted).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(AbortedError);
    await expect(waiting).rejects.toBeInstanceOf(AbortedError);
    expect(s.passInFlight(11)).toBe(false);

    releaseRunner();
    await running;
    expect(pendingRan).toBe(false);

    // The buckets are fresh after a reset: a new request goes straight through
    // even though the pre-reset holder never released.
    held();
    const after = await s.throttle("x.example");
    after();
  });

  it("settles a waitForWake and forgets remembered wakes", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const waiting = s.waitForWake(12, 10_000);
    s.wake(13, "burst"); // remembered, no waiter
    s.reset();
    expect(await waiting).toBe("timeout");
    const t = s.waitForWake(13, 1_000);
    await clock.advance(1_000);
    expect(await t).toBe("timeout"); // the remembered wake did not survive
  });
});

describe("AcquisitionScheduler.wake / waitForWake", () => {
  it("waitForWake resolves early with the wake reason, and times out otherwise", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const waiting = s.waitForWake(5, 10_000);
    s.wake(5);
    expect(await waiting).toBe("go");
    const t = s.waitForWake(5, 10_000);
    await clock.advance(10_000);
    expect(await t).toBe("timeout");
  });

  it("a wake that arrives before the wait is remembered once", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    s.wake(9, "burst");
    expect(await s.waitForWake(9, 10_000)).toBe("burst");
    const t = s.waitForWake(9, 1_000);
    await clock.advance(1_000);
    expect(await t).toBe("timeout");
  });

  it("a woken wait's timer never resolves a LATER wait", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const firstWait = s.waitForWake(6, 1_000);
    s.wake(6, "stranded");
    expect(await firstWait).toBe("stranded");
    // The first wait's 1_000ms timer is still armed; a second wait started now
    // must NOT be resolved by it.
    const secondWait = s.waitForWake(6, 5_000);
    let settled: string | null = null;
    void secondWait.then((r) => {
      settled = r;
    });
    await clock.advance(1_000); // the FIRST wait's deadline passes
    expect(settled).toBeNull();
    await clock.advance(4_000); // the second wait's own deadline
    expect(await secondWait).toBe("timeout");
  });

  it("a wake with no waiter is remembered once per print, and prints do not cross", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    s.wake(20, "go");
    s.wake(20, "burst"); // the first remembered wake stands
    expect(await s.waitForWake(20, 1_000)).toBe("go");
    const other = s.waitForWake(21, 1_000);
    await clock.advance(1_000);
    expect(await other).toBe("timeout");
  });

  it("wakes every waiter parked on the same print", async () => {
    const clock = makeClock();
    const s = new AcquisitionScheduler(undefined, clock);
    const a = s.waitForWake(30, 10_000);
    const b = s.waitForWake(30, 10_000);
    s.wake(30, "go");
    expect(await a).toBe("go");
    expect(await b).toBe("go");
  });
});

/**
 * The process-global acquisition scheduler (spec §4.3 "Scheduler"; v1 §4.2
 * left it unbuilt). It owns every outbound request the print-watch makes:
 *
 *  - per-HOST-FAMILY token buckets + concurrency caps (`throttle`) — the SEC
 *    hosts (www / data / efts) share ONE bucket at 2 requests/second across
 *    every CIK, which is what the SEC's fair-access policy actually measures;
 *  - a fetch wrapper (`fetchFor`) that applies the throttle by the request's
 *    host and merges the pass signal into `init.signal`, so an aborted pass
 *    cancels the socket (AbortSignal.any, Node 24). The concurrency slot is
 *    held until the response BODY closes — a streamed SEC exhibit is one
 *    request for the whole read, not just for its headers;
 *  - per-print pass coalescing (`runPass`): one pass runs at a time per print,
 *    a pass requested meanwhile is remembered ONCE and runs after, so a burst
 *    of hits never queues a pile of identical passes. WHEN A PASS SETTLES ITS
 *    SIGNAL IS ABORTED — work that must outlive the pass must not be linked to
 *    the pass signal (that abort is what stops a finished pass from leaving a
 *    straggler request holding a concurrency slot);
 *  - an explicit wake (`wake` / `waitForWake`) so a go request ends the loop's
 *    cadence sleep NOW instead of at the next tick.
 *
 * Pure over injected `now`/`sleep`, so every rule above is unit-tested on a
 * manual clock. TWS (the DJ wire) is not an HTTP host and keeps the adapter's
 * own pacing; it only receives the pass signal.
 *
 * Waiting is EVENT-DRIVEN, not poll-driven: a waiter parks on the family's
 * FIFO queue and is woken by whatever unblocks it (a release, or the single
 * refill timer the bucket arms when the queue is token-starved). A poll loop
 * would either burn wall-clock sleeps in tests or, worse, sleep through a
 * release that arrives with no clock tick behind it.
 */
import type { FetchLike } from "./hardened-fetch";

export interface HostPolicy {
  /** Requests per second for the whole family. CLAMPED to a positive number:
   *  `0` becomes 0.001/s, not "never" — a policy is a pace, never a pause
   *  switch (a pause belongs in the watcher, which can decline to poll). */
  ratePerSecond: number;
  /** Simultaneous in-flight requests for the whole family. CLAMPED to ≥ 1 for
   *  the same reason: `0` would park every waiter forever. */
  concurrency: number;
}

export const SEC_FAMILY = "sec.gov";
export const DEFAULT_POLICY: HostPolicy = { ratePerSecond: 5, concurrency: 2 };
export const HOST_POLICIES: Record<string, HostPolicy> = {
  [SEC_FAMILY]: { ratePerSecond: 2, concurrency: 2 },
};

/**
 * The longest a single response body may hold its concurrency slot. The slot
 * is meant to be returned when the body closes, but an abandoned stream fires
 * neither `flush` nor `cancel`, so the hold is bounded: after this the slot
 * goes back whether or not the body ever closed. Deliberately far longer than
 * any read the print-watch performs (the 2MB cap in `hardened-fetch.ts` sees
 * to that).
 *
 * It is a BACKSTOP, not the mechanism. Two faster paths return the slot first:
 * `fetchFor` never holds one for a 3xx/4xx/5xx at all (nothing streams those),
 * and `hardenedFetchText` cancels the body on every early exit it takes. What
 * is left for the watchdog is a future caller abandoning a 2xx body.
 */
export const MAX_BODY_HOLD_MS = 120_000;

/** Statuses whose responses may not carry a body — `new Response(stream, …)`
 *  throws for these, so such a response is passed through untouched. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** "www.sec.gov" | "data.sec.gov" | "efts.sec.gov" → "sec.gov"; any other host
 *  → itself (lower-cased). The suffix match is on ".sec.gov", so a look-alike
 *  like "sec.gov.evil.example" is its OWN family and never borrows the SEC
 *  budget. */
export function hostFamily(hostname: string): string {
  // The trailing root label of an FQDN ("www.sec.gov.") is dropped first, so a
  // fully-qualified spelling cannot slip out of the SEC budget into its own
  // 5/s family (review M2).
  const h = hostname.trim().toLowerCase().replace(/\.$/, "");
  return h === SEC_FAMILY || h.endsWith(`.${SEC_FAMILY}`) ? SEC_FAMILY : h;
}

export type PassReason = "cadence" | "burst" | "go" | "stranded";

export interface SchedulerSeams {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export class AbortedError extends Error {
  override readonly name = "AbortError";
  constructor(message = "aborted") {
    super(message);
  }
}

/** `Transformer.cancel` exists at runtime (WHATWG streams, Node ≥ 20) but is
 *  missing from this TypeScript lib.dom, so it is declared here and the
 *  transformer is passed as a typed variable rather than a literal. */
type CancellableTransformer = Transformer<Uint8Array, Uint8Array> & {
  cancel?: (reason?: unknown) => void;
};

/** One parked `throttle` call. `grant` hands over a fresh release function;
 *  `fail` rejects it; `detach` drops its abort listener. */
interface ThrottleWaiter {
  grant: (release: () => void) => void;
  fail: (err: unknown) => void;
  detach: () => void;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  inFlight: number;
  waiters: ThrottleWaiter[];
  /** At most one refill timer per bucket, however many waiters are parked. */
  refillTimerArmed: boolean;
}

interface PendingPass {
  reason: PassReason;
  runner: (signal: AbortSignal) => Promise<unknown>;
  done: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface PassState {
  running: Promise<unknown> | null;
  controller: AbortController | null;
  reason: PassReason | null;
  pending: PendingPass | null;
}

interface WakeWaiter {
  settle: (reason: PassReason | "timeout") => void;
}

export class AcquisitionScheduler {
  private readonly policies: Record<string, HostPolicy>;
  private readonly seams: SchedulerSeams;
  private readonly buckets = new Map<string, Bucket>();
  private readonly passes = new Map<number, PassState>();
  private readonly waiters = new Map<number, Set<WakeWaiter>>();
  private readonly pendingWakes = new Map<number, PassReason>();

  constructor(
    policies: Record<string, HostPolicy> = HOST_POLICIES,
    seams: Partial<SchedulerSeams> = {},
  ) {
    this.policies = policies;
    this.seams = {
      now: seams.now ?? (() => Date.now()),
      sleep: seams.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  // ---------------------------------------------------------------- throttle

  private policyFor(family: string): HostPolicy {
    const policy = this.policies[family] ?? DEFAULT_POLICY;
    // A zero or negative rate would park every waiter forever; treat it as
    // "very slow" rather than "never".
    return {
      ratePerSecond: Math.max(0.001, policy.ratePerSecond),
      concurrency: Math.max(1, Math.floor(policy.concurrency)),
    };
  }

  private bucketFor(family: string): { bucket: Bucket; policy: HostPolicy } {
    const policy = this.policyFor(family);
    let bucket = this.buckets.get(family);
    if (!bucket) {
      bucket = {
        tokens: policy.ratePerSecond,
        lastRefillMs: this.seams.now(),
        inFlight: 0,
        waiters: [],
        refillTimerArmed: false,
      };
      this.buckets.set(family, bucket);
    }
    return { bucket, policy };
  }

  private refill(bucket: Bucket, policy: HostPolicy): void {
    const now = this.seams.now();
    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    bucket.tokens = Math.min(
      policy.ratePerSecond,
      bucket.tokens + (elapsed / 1000) * policy.ratePerSecond,
    );
    bucket.lastRefillMs = now;
  }

  /** Consume one token + one slot; the returned release is idempotent and
   *  wakes the next waiter in line. */
  private take(family: string, bucket: Bucket): () => void {
    bucket.tokens -= 1;
    bucket.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.inFlight = Math.max(0, bucket.inFlight - 1);
      this.pump(family);
    };
  }

  /** Grant as many parked waiters as the bucket currently allows. */
  private pump(family: string): void {
    const { bucket, policy } = this.bucketFor(family);
    while (bucket.waiters.length > 0) {
      if (bucket.inFlight >= policy.concurrency) return; // a release will pump again
      this.refill(bucket, policy);
      if (bucket.tokens < 1) {
        this.armRefillTimer(family, bucket, policy);
        return;
      }
      const waiter = bucket.waiters.shift();
      if (!waiter) return;
      const release = this.take(family, bucket);
      waiter.detach();
      waiter.grant(release); // resolves a promise — never re-enters pump here
    }
  }

  private armRefillTimer(family: string, bucket: Bucket, policy: HostPolicy): void {
    if (bucket.refillTimerArmed) return;
    const deficit = Math.max(0, 1 - bucket.tokens);
    const waitMs = Math.max(1, Math.ceil((deficit / policy.ratePerSecond) * 1000));
    bucket.refillTimerArmed = true;
    void this.seams.sleep(waitMs).then(() => {
      bucket.refillTimerArmed = false;
      this.pump(family);
    });
  }

  /**
   * Waits for a token AND a concurrency slot for the host's family; resolves
   * to the release function. Rejects with `AbortedError` when the signal
   * aborts while waiting — an aborted waiter consumes neither a token nor a
   * slot.
   */
  throttle(hostname: string, signal?: AbortSignal): Promise<() => void> {
    const family = hostFamily(hostname);
    if (signal?.aborted) {
      return Promise.reject(new AbortedError(`throttle(${family}) aborted before it started`));
    }
    const { bucket, policy } = this.bucketFor(family);
    // Fast path: nobody ahead of us and capacity right now. Queued waiters are
    // served FIFO, so a newcomer never jumps them.
    if (bucket.waiters.length === 0) {
      this.refill(bucket, policy);
      if (bucket.tokens >= 1 && bucket.inFlight < policy.concurrency) {
        return Promise.resolve(this.take(family, bucket));
      }
    }
    return new Promise<() => void>((resolve, reject) => {
      let settled = false;
      const waiter: ThrottleWaiter = {
        grant: (release) => {
          if (settled) {
            // Raced with an abort: hand back BOTH halves of the capacity
            // `take()` consumed — the release returns the slot, the token has
            // to be put back by hand or the bucket under-counts forever
            // (review M1; unreachable today because an aborted waiter is
            // spliced out of the queue before it can be granted).
            bucket.tokens += 1;
            release();
            return;
          }
          settled = true;
          resolve(release);
        },
        fail: (err) => {
          if (settled) return;
          settled = true;
          waiter.detach();
          reject(err);
        },
        detach: () => {
          if (signal) signal.removeEventListener("abort", onAbort);
        },
      };
      const onAbort = () => {
        const at = bucket.waiters.indexOf(waiter);
        if (at >= 0) bucket.waiters.splice(at, 1);
        waiter.fail(new AbortedError(`throttle(${family}) aborted while waiting`));
      };
      bucket.waiters.push(waiter);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.pump(family);
    });
  }

  // ---------------------------------------------------------------- fetchFor

  /**
   * `global fetch` wrapped with `throttle(host of the URL)` and the pass
   * signal merged into `init.signal`. `FetchLike` takes a string URL
   * (`hardened-fetch.ts`).
   *
   * The concurrency slot is held until the response body closes (end, cancel,
   * error or the pass aborting), so a slow streamed read counts as one
   * in-flight request for its whole life. A body nobody ever reads gives its
   * slot back after `MAX_BODY_HOLD_MS`.
   */
  fetchFor(signal: AbortSignal, fetchImpl: FetchLike = (url, init) => fetch(url, init)): FetchLike {
    return async (url, init) => {
      const release = await this.throttle(new URL(url).hostname, signal);
      let handedOff = false;
      try {
        const merged = init?.signal ? AbortSignal.any([init.signal, signal]) : signal;
        const res = await fetchImpl(url, { ...init, signal: merged });
        if (
          !res.body ||
          merged.aborted ||
          NULL_BODY_STATUSES.has(res.status) ||
          res.status < 200 ||
          // Redirects and errors are never STREAMED by any caller in this repo
          // (`hardenedFetchText` reads a body only on the 2xx path), and a 404
          // is the ordinary EDGAR answer before a filing posts. Holding a slot
          // for those bodies stalled the whole SEC lane for the watchdog's two
          // minutes at exactly print time (review C1).
          res.status >= 300
        ) {
          return res; // nothing to stream: the `finally` returns the slot now
        }
        const finish = this.holdUntilBodyCloses(release, merged);
        const transformer: CancellableTransformer = { flush: finish, cancel: finish };
        const guarded = res.body.pipeThrough(new TransformStream(transformer));
        const wrapped = new Response(guarded, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
        handedOff = true; // set last: if wrapping threw, the `finally` releases
        return wrapped;
      } finally {
        if (!handedOff) release();
      }
    };
  }

  /** Wrap `release` so it runs exactly once — on body end/cancel/error, on the
   *  pass aborting, or on the hold watchdog, whichever comes first. */
  private holdUntilBodyCloses(release: () => void, signal: AbortSignal): () => void {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finish);
      release();
    };
    signal.addEventListener("abort", finish, { once: true });
    void this.seams.sleep(MAX_BODY_HOLD_MS).then(finish);
    return finish;
  }

  // ----------------------------------------------------------------- runPass

  passInFlight(printId: number): boolean {
    const state = this.passes.get(printId);
    return state ? state.running !== null : false;
  }

  /**
   * One running pass per print; a request while one runs is remembered ONCE
   * and runs after. Returns when the pass this call caused (or joined) has
   * finished.
   *
   * Coalescing is FIRST-RUNNER-WINS: a later request joins the pending pass
   * rather than replacing its runner (a pass re-reads the runtime when it
   * starts, so the first runner is as fresh as the last). Joiners therefore
   * receive the FIRST pending runner's value — in practice every pass runner
   * resolves to `void`.
   *
   * WHEN A PASS SETTLES ITS SIGNAL IS ABORTED — never hand the pass signal to
   * work that must outlive the pass (a fire-and-forget drain, a background
   * enrich, a detached fetch): it dies the moment the runner resolves. That
   * abort is deliberate; it is what keeps a finished pass from leaving a
   * straggler request holding a host family's concurrency slot.
   */
  runPass<T = void>(
    printId: number,
    runner: (signal: AbortSignal) => Promise<T>,
    reason: PassReason,
  ): Promise<T> {
    let state = this.passes.get(printId);
    if (!state) {
      state = { running: null, controller: null, reason: null, pending: null };
      this.passes.set(printId, state);
    }
    if (state.running) {
      if (state.pending) return state.pending.done as Promise<T>;
      let resolve!: (value: unknown) => void;
      let reject!: (err: unknown) => void;
      const done = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      state.pending = {
        reason,
        runner: runner as (signal: AbortSignal) => Promise<unknown>,
        done,
        resolve,
        reject,
      };
      return done as Promise<T>;
    }
    return this.startPass(printId, state, runner, reason);
  }

  private startPass<T>(
    printId: number,
    state: PassState,
    runner: (signal: AbortSignal) => Promise<T>,
    reason: PassReason,
  ): Promise<T> {
    const controller = new AbortController();
    state.controller = controller;
    state.reason = reason;
    const running = (async () => {
      // Yield once so `state.running` below is assigned BEFORE anything can
      // reach the `finally`: a runner that throws synchronously would
      // otherwise clear a slot that has not been filled yet and wedge the
      // print behind a `running` promise nothing ever clears.
      await Promise.resolve();
      try {
        return await runner(controller.signal);
      } finally {
        this.finishPass(printId, state, controller);
      }
    })();
    state.running = running;
    return running;
  }

  private finishPass(printId: number, state: PassState, controller: AbortController): void {
    if (state.controller === controller) {
      state.running = null;
      state.controller = null;
      state.reason = null;
    }
    // The pass is over: cancel any straggler request of its own that still
    // holds a concurrency slot (an abandoned redirect body, say).
    controller.abort(new AbortedError(`print ${printId} pass finished`));
    const next = state.pending;
    state.pending = null;
    if (next) {
      this.startPass(printId, state, next.runner, next.reason).then(next.resolve, next.reject);
      return;
    }
    if (this.passes.get(printId) === state) this.passes.delete(printId);
  }

  // ------------------------------------------------------------ wake / sleep

  /** Ends a `waitForWake` early with reason "go" (or the given reason). Safe to
   *  call when nothing waits — remembered ONCE until the next wait. */
  wake(printId: number, reason: PassReason = "go"): void {
    const parked = this.waiters.get(printId);
    if (parked && parked.size > 0) {
      for (const waiter of Array.from(parked)) waiter.settle(reason);
      return;
    }
    if (!this.pendingWakes.has(printId)) this.pendingWakes.set(printId, reason);
  }

  /** The loop's cadence sleep: resolves early on `wake()`. */
  waitForWake(printId: number, timeoutMs: number): Promise<PassReason | "timeout"> {
    const remembered = this.pendingWakes.get(printId);
    if (remembered !== undefined) {
      this.pendingWakes.delete(printId);
      return Promise.resolve(remembered);
    }
    return new Promise<PassReason | "timeout">((resolve) => {
      const waiter: WakeWaiter = {
        settle: (reason) => {
          // Identity, not print id: this wait's own deadline must never settle
          // a LATER wait that reused the same print.
          if (!this.dropWakeWaiter(printId, waiter)) return;
          resolve(reason);
        },
      };
      const parked = this.waiters.get(printId) ?? new Set<WakeWaiter>();
      parked.add(waiter);
      this.waiters.set(printId, parked);
      void this.seams.sleep(timeoutMs).then(() => waiter.settle("timeout"));
    });
  }

  private dropWakeWaiter(printId: number, waiter: WakeWaiter): boolean {
    const parked = this.waiters.get(printId);
    if (!parked || !parked.delete(waiter)) return false;
    if (parked.size === 0) this.waiters.delete(printId);
    return true;
  }

  // ------------------------------------------------------------------- reset

  /** Tests / restarts: abort every active pass, settle everything parked, and
   *  start from empty buckets. Nothing is left half-waiting. */
  reset(): void {
    for (const [family, bucket] of this.buckets) {
      for (const waiter of bucket.waiters.splice(0)) {
        waiter.detach();
        waiter.fail(new AbortedError(`scheduler reset while waiting for ${family}`));
      }
    }
    this.buckets.clear();

    for (const [printId, state] of this.passes) {
      const pending = state.pending;
      state.pending = null;
      state.controller?.abort(new AbortedError(`scheduler reset (print ${printId})`));
      pending?.reject(new AbortedError(`scheduler reset (print ${printId})`));
    }
    this.passes.clear();

    for (const parked of Array.from(this.waiters.values())) {
      for (const waiter of Array.from(parked)) waiter.settle("timeout");
    }
    this.waiters.clear();
    this.pendingWakes.clear();
  }
}

/** The process-global instance the watcher uses. */
export const acquisitionScheduler = new AcquisitionScheduler();

/**
 * The Hub's polling mechanics, with no React in them (spec §4.6: "In-flight
 * requests carry a generation counter; older responses are dropped; requests
 * abort on unmount and when the tab is hidden, resume on visibility").
 *
 * Pure by design so it can be tested with fake timers and an injected fetch —
 * this repo has no jsdom and no React Testing Library, and none may be added.
 *
 * Recursive setTimeout, never setInterval: a status request that takes longer
 * than its own cadence must not overlap itself. That is the rule the print
 * panel already followed (PrintWatchPanel.tsx: "Recursive setTimeout (never
 * setInterval, to avoid overlap)") and it is kept verbatim here.
 */
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** WHY this run is happening (Codex round 1 #7 / F-S2). The cockpit stream is
 *  the reason this exists: a server-rendered payload means `start` should issue
 *  NO request, a mutation or a returning tab wants a cheap GET, and only the
 *  60-second tick wants the POST that refreshes intel. Without it a stream
 *  cannot tell a first paint from a timer tick, and the wiring comes out
 *  inverted — refetching what the server just rendered while never refreshing
 *  what goes stale. */
export type StreamTrigger = "start" | "timer" | "refresh" | "resume";

export interface StreamSpec<T> {
  name: string;
  /** Milliseconds until the NEXT run, computed from the freshest state. Read
   *  again on EVERY reschedule, so a print going hot changes the cadence
   *  without restarting the controller. */
  intervalMs: () => number;
  /** One request. Rejects on abort; the controller swallows AbortError.
   *  Returning `null` means "nothing to do" — `onResult` is NOT called. */
  run: (signal: AbortSignal, fetchImpl: FetchImpl, trigger: StreamTrigger) => Promise<T | null>;
  /** Applied ONLY when the response's generation is still the newest AND the
   *  run returned something.
   *
   *  Declared as a METHOD, not as a `(value: T) => void` property, on purpose:
   *  the controller holds streams of DIFFERENT payload types in one
   *  `Array<StreamSpec<unknown>>`, and under `strictFunctionTypes` a property
   *  of that shape makes `T` contravariant, so a `StreamSpec<string>` is not a
   *  `StreamSpec<unknown>` and the array does not typecheck. Method members are
   *  compared bivariantly, which is exactly the intended semantics here: the
   *  controller never inspects a payload, it only hands it straight back to the
   *  stream that produced it. */
  onResult(value: T): void;
  onError?: (err: unknown) => void;
}

export interface PollController {
  start(): void;
  /** Abort every in-flight request and stop every timer. Idempotent. */
  pause(): void;
  /** One immediate run per stream, then the timers restart. Idempotent. */
  resume(): void;
  /** Fire one stream now, out of band (the onChanged path). */
  refresh(name: string): void;
  /** Fire every stream now. */
  refreshAll(): void;
  stop(): void;
  /** Test seam: the generation last ISSUED for a stream. */
  generationOf(name: string): number;
}

interface StreamState {
  spec: StreamSpec<unknown>;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "AbortError");
}

export function createPollController(opts: {
  streams: Array<StreamSpec<unknown>>;
  fetchImpl: FetchImpl;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): PollController {
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;
  const states = new Map<string, StreamState>(
    opts.streams.map((spec) => [spec.name, { spec, generation: 0, timer: null, controller: null }]),
  );
  let running = false;

  function clearTimer(s: StreamState) {
    if (s.timer !== null) {
      clearT(s.timer);
      s.timer = null;
    }
  }

  function schedule(s: StreamState) {
    clearTimer(s);
    if (!running) return;
    s.timer = setT(() => {
      s.timer = null;
      void fire(s, "timer");
    }, s.spec.intervalMs());
  }

  async function fire(s: StreamState, trigger: StreamTrigger) {
    if (!running) return;
    // A new run supersedes whatever was in flight for this stream: abort it so
    // the socket closes, and stamp the generation the response must match.
    s.controller?.abort();
    const controller = new AbortController();
    s.controller = controller;
    s.generation += 1;
    const generation = s.generation;
    try {
      const value = await s.spec.run(controller.signal, opts.fetchImpl, trigger);
      // Three ways not to apply: a newer run was issued, this one was aborted,
      // or the run declined to fetch (null) and has nothing to say.
      if (!running || controller.signal.aborted || generation !== s.generation) return;
      if (value !== null && value !== undefined) s.spec.onResult(value);
    } catch (err) {
      if (!isAbort(err) && !controller.signal.aborted) s.spec.onError?.(err);
    } finally {
      if (s.controller === controller) s.controller = null;
      if (running && generation === s.generation) schedule(s);
    }
  }

  // F-S9: `pause` is captured as a closure so `stop()` never reaches for
  // `this` — a destructured `const { stop } = controller` would otherwise
  // throw at the call site rather than at the mistake.
  function pause() {
    running = false;
    for (const s of states.values()) {
      clearTimer(s);
      s.controller?.abort();
      s.controller = null;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      for (const s of states.values()) void fire(s, "start");
    },
    pause,
    resume() {
      if (running) return;
      running = true;
      for (const s of states.values()) void fire(s, "resume");
    },
    refresh(name: string) {
      const s = states.get(name);
      if (s && running) void fire(s, "refresh");
    },
    refreshAll() {
      if (!running) return;
      for (const s of states.values()) void fire(s, "refresh");
    },
    stop() {
      pause();
      states.clear();
    },
    generationOf(name: string) {
      return states.get(name)?.generation ?? 0;
    },
  };
}

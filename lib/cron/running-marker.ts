/**
 * Mac-side helpers to set/clear the `mac-running-{type}-{date}` KV marker
 * on the Worker. Posted at the entry of /api/cron/{briefing,digest} and
 * cleared in finally so the Worker's fallback path can re-check before
 * firing. Closes the 8:45→8:57 race observed 2026-04-27 where a slow Mac
 * primary completed AFTER the Worker timed out, and the Worker fired a
 * thinned-out duplicate via fallback.
 *
 * Graceful-degradation: if WORKER_MARKER_URL or CRON_SHARED_SECRET is
 * unset, both calls become no-ops. If the Worker is unreachable, errors
 * are swallowed — never block the Mac's email delivery on Worker RTT.
 *
 * Fire-and-forget: callers should not await the return for correctness;
 * the marker is best-effort signaling, not a blocking dependency.
 */

const DEFAULT_TIMEOUT_MS = 3000;

async function callRunningMarkerEndpoint(
  type: "briefing" | "digest" | "evening",
  action: "set" | "clear",
  opts?: { timeoutMs?: number },
): Promise<void> {
  const url = process.env.WORKER_MARKER_URL;
  const secret = process.env.CRON_SHARED_SECRET;
  if (!url || !secret) return;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const target = `${url.replace(/\/$/, "")}/internal/running-marker?type=${type}&action=${action}`;
    const res = await fetch(target, {
      method: "POST",
      headers: { "X-Cron-Secret": secret },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[running-marker] worker returned ${res.status} for ${action}; ignoring`,
      );
    }
  } catch (err) {
    console.warn(
      `[running-marker] worker unreachable for ${action}; ignoring:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function setRunningMarker(type: "briefing" | "digest" | "evening"): Promise<void> {
  return callRunningMarkerEndpoint(type, "set");
}

export function clearRunningMarker(type: "briefing" | "digest" | "evening"): Promise<void> {
  return callRunningMarkerEndpoint(type, "clear");
}

/** How often the marker is re-posted while a send pipeline is running. */
const HEARTBEAT_MS = 2 * 60 * 1000;

/** Context passed into `withRunningMarker`'s `fn` so it can confirm the send. */
interface RunningMarkerCtx {
  /**
   * Call once the send has actually gone out. Wraps `confirmMacSent(type)`
   * and records whether the Worker acked it, so the wrapper's `finally` can
   * decide whether it is safe to clear `mac-running` (see below).
   */
  confirmSent: () => Promise<void>;
}

/**
 * Hold `mac-running-{type}` for exactly the lifetime of `fn`.
 *
 * Four things this fixes, any of which alone can lose the send race to the
 * Worker's cloud fallback or hand it a false "safe to retry" signal:
 *
 *  1. The initial set is AWAITED. Callers used to fire `void setRunningMarker()`
 *     and immediately enter the pipeline, whose synchronous better-sqlite3 work
 *     starves the event loop for minutes — the un-awaited fetch never got a turn
 *     and its own 3s AbortController killed it, so the marker was never written.
 *     (The awaited `checkCloudMarker` one line earlier succeeded on the same
 *     tick, which is how we know the network was never at fault.) Route entry is
 *     before any heavy work, so awaiting here costs at most the 3s timeout.
 *
 *  2. The marker is RENEWED every 2 minutes. The Worker-side TTL is a fixed
 *     constant, and a fixed constant silently ages out as the pipeline grows —
 *     the original 10 min was sized against a 5-min pipeline that is now 13-17.
 *     Heartbeating means no constant has to predict the pipeline's length; the
 *     TTL only has to outlive a single starved gap.
 *
 *  3. Heartbeats never overlap, and the finally AWAITS any beat still in
 *     flight before clearing. `setInterval` doesn't wait for its own async
 *     callback, so without this a beat fired just before `fn` resolves can
 *     have its PUT still in flight when the finally's DELETE goes out — the
 *     PUT can land AFTER the DELETE and recreate a fresh 15-min `mac-running`
 *     marker after the pipeline has already ended, delaying the Worker's
 *     cloud retry on a Mac that actually failed.
 *
 *  4. `mac-running` is only cleared once `confirmMacSent` has actually been
 *     ACKED (or was never attempted at all, e.g. a skipped/no-op send). If
 *     `fn` calls `ctx.confirmSent()` and the Worker never acks — even after
 *     the bounded retries inside `confirmMacSent` — clearing `mac-running`
 *     here would leave the Worker seeing NEITHER `mac-sent` NOR
 *     `mac-running`, and its catch-up sweep can't distinguish that from
 *     "nothing ever ran" and may fire a duplicate. Leaving the marker in
 *     place lets it act as a shield until it TTL-expires on its own.
 *
 * Never blocks delivery on Worker RTT: a failed set, beat, or confirm is
 * swallowed by the underlying endpoint calls, and `fn` runs regardless.
 */
export async function withRunningMarker<T>(
  type: "briefing" | "digest" | "evening",
  fn: (ctx: RunningMarkerCtx) => Promise<T>,
  opts?: { heartbeatMs?: number },
): Promise<T> {
  await setRunningMarker(type);

  // Tracks the currently in-flight heartbeat PUT (if any) so the finally can
  // await it before deleting the marker — see fix #3 above.
  let heartbeatInFlight: Promise<void> | null = null;

  const beat = setInterval(() => {
    // Skip this tick rather than starting an overlapping PUT: the next tick
    // (2 min later) re-posts anyway, and serializing is enough to guarantee
    // no beat's response can straddle the finally's clear below.
    if (heartbeatInFlight) return;
    heartbeatInFlight = setRunningMarker(type).finally(() => {
      heartbeatInFlight = null;
    });
  }, opts?.heartbeatMs ?? HEARTBEAT_MS);
  // Never let the heartbeat hold the Node process open on its own.
  (beat as { unref?: () => void }).unref?.();

  let confirmAttempted = false;
  let confirmAcked = false;

  const confirmSent = async (): Promise<void> => {
    const url = process.env.WORKER_MARKER_URL;
    const secret = process.env.CRON_SHARED_SECRET;
    if (!url || !secret) {
      // Same no-op contract as every other marker call in this module: with
      // the Worker unconfigured (local dev), behave exactly as before this
      // change — confirmation was never "attempted", so the finally clears
      // the marker normally below.
      return;
    }
    confirmAttempted = true;
    confirmAcked = await confirmMacSent(type);
  };

  try {
    return await fn({ confirmSent });
  } finally {
    clearInterval(beat);
    // Awaited so a beat that was mid-flight when fn resolved cannot land its
    // PUT after the DELETE below (fix #3).
    if (heartbeatInFlight) {
      await heartbeatInFlight;
    }

    if (confirmAttempted && !confirmAcked) {
      // mac-sent never landed despite the bounded retries in confirmMacSent.
      // Do NOT clear mac-running: deleting it now would leave the Worker
      // with no signal at all, and its catch-up sweep could fire a
      // duplicate send. Leave it to TTL-expire instead (fix #4).
      console.warn(
        `[running-marker] confirmMacSent(${type}) never acked after retries — ` +
          `leaving mac-running-${type} in place to TTL-expire instead of clearing it now`,
      );
    } else {
      // Awaited so the mac-sent → mac-running handoff ordering is deterministic:
      // callers confirm inside `fn`, so it has already landed by the time
      // the running marker goes away. Bounded by the same 3s timeout.
      await clearRunningMarker(type);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default bounded-retry shape for confirmMacSent — see its docstring. */
const DEFAULT_CONFIRM_ATTEMPTS = 3;
const DEFAULT_CONFIRM_RETRY_DELAY_MS = 2 * 1000;

/**
 * Tell the Worker the Mac just successfully shipped {type} for today.
 *
 * The Worker writes a 30h `mac-sent-{type}-{YYYY-MM-DD}` KV marker so its
 * catch-up retry sweep (added 2026-05-14) won't fire a duplicate hours later.
 *
 * Without this, the Worker can't tell "Mac successfully sent via launchd" from
 * "nothing shipped yet" — the only thing that writes `mac-sent` from the
 * Worker side is a successful Worker → Mac primary call, which is rare in the
 * Mesh CGNAT setup where the Worker's primary call almost always fails fast
 * with CF 1016. Mac confirming directly closes that gap.
 *
 * Returns whether the Worker ACKED the confirmation (`res.ok` on some
 * attempt) — `withRunningMarker` uses this to decide whether it is safe to
 * clear `mac-running` (see its docstring, fix #4). A single dropped fetch
 * used to silently swallow the confirmation entirely; a successful send with
 * a failed confirm meant the Worker saw neither `mac-sent` nor (after the old
 * unconditional clear) `mac-running`, so its catch-up sweep could fire a
 * duplicate. The bounded retry (3 attempts, ~2s apart by default) covers a
 * single transient blip without turning this into an unbounded delivery
 * blocker — `attempts`/`retryDelayMs` are overridable (tests use 0-delay).
 *
 * Never throws and never blocks longer than `attempts * (timeout + delay)`;
 * `false` (including the "env not configured" no-op case) just means the
 * caller cannot treat the confirmation as landed.
 */
export async function confirmMacSent(
  type: "briefing" | "digest" | "evening",
  opts?: { attempts?: number; retryDelayMs?: number },
): Promise<boolean> {
  const url = process.env.WORKER_MARKER_URL;
  const secret = process.env.CRON_SHARED_SECRET;
  if (!url || !secret) return false;

  const attempts = opts?.attempts ?? DEFAULT_CONFIRM_ATTEMPTS;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_CONFIRM_RETRY_DELAY_MS;
  const target = `${url.replace(/\/$/, "")}/internal/mac-sent?type=${type}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const res = await fetch(target, {
        method: "POST",
        headers: { "X-Cron-Secret": secret },
        signal: controller.signal,
      });
      if (res.ok) return true;
      console.warn(
        `[mac-sent] worker returned ${res.status} for ${type} (attempt ${attempt}/${attempts})`,
      );
    } catch (err) {
      console.warn(
        `[mac-sent] worker unreachable for ${type} (attempt ${attempt}/${attempts}):`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  console.warn(
    `[mac-sent] all ${attempts} attempts failed for ${type}; mac-running will be left for the caller to handle`,
  );
  return false;
}

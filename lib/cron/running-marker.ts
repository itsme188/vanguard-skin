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

/**
 * Hold `mac-running-{type}` for exactly the lifetime of `fn`.
 *
 * Two things this fixes, either of which alone loses the send race to the
 * Worker's cloud fallback (both fired on the 2026-08-09 Sunday briefing):
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
 * Never blocks delivery on Worker RTT: a failed set or beat is swallowed by
 * callRunningMarkerEndpoint, and `fn` runs regardless.
 */
export async function withRunningMarker<T>(
  type: "briefing" | "digest" | "evening",
  fn: () => Promise<T>,
  opts?: { heartbeatMs?: number },
): Promise<T> {
  await setRunningMarker(type);

  const beat = setInterval(() => {
    void setRunningMarker(type);
  }, opts?.heartbeatMs ?? HEARTBEAT_MS);
  // Never let the heartbeat hold the Node process open on its own.
  (beat as { unref?: () => void }).unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(beat);
    // Awaited so the mac-sent → mac-running handoff ordering is deterministic:
    // callers write mac-sent inside `fn`, so it has already landed by the time
    // the running marker goes away. Bounded by the same 3s timeout.
    await clearRunningMarker(type);
  }
}

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
 * Fire-and-forget — never block email delivery on Worker RTT.
 */
export async function confirmMacSent(
  type: "briefing" | "digest" | "evening",
): Promise<void> {
  const url = process.env.WORKER_MARKER_URL;
  const secret = process.env.CRON_SHARED_SECRET;
  if (!url || !secret) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const target = `${url.replace(/\/$/, "")}/internal/mac-sent?type=${type}`;
    const res = await fetch(target, {
      method: "POST",
      headers: { "X-Cron-Secret": secret },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[mac-sent] worker returned ${res.status} for ${type}; ignoring`,
      );
    }
  } catch (err) {
    console.warn(
      `[mac-sent] worker unreachable for ${type}; ignoring:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

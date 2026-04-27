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
  type: "briefing" | "digest",
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

export function setRunningMarker(type: "briefing" | "digest"): Promise<void> {
  return callRunningMarkerEndpoint(type, "set");
}

export function clearRunningMarker(type: "briefing" | "digest"): Promise<void> {
  return callRunningMarkerEndpoint(type, "clear");
}

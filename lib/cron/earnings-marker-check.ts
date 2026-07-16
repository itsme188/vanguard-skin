/**
 * Mac-side helpers for the earnings preview/recap KV markers maintained
 * by the Worker. Mirrors lib/cron/marker-check.ts + running-marker.ts but
 * keyed on (phase, eventId) instead of (type, date).
 *
 * Three endpoints on the Worker:
 *   GET  /internal/earnings-marker          → returns {sentBy: "mac"|"cloud"|null}
 *   POST /internal/earnings-running-marker  → action=set|clear
 *   POST /internal/earnings-sent-marker     → write mac-sent on success
 *
 * Graceful degradation: if WORKER_MARKER_URL is unset, all calls become
 * no-ops + Mac primary path proceeds unaltered. Phase 4 is a resilience
 * layer; lack of Worker should never block the Mac.
 */

const DEFAULT_TIMEOUT_MS = 3000;

export type EarningsPhase = "preview" | "recap";
export type EarningsMarkerSentBy = "mac" | "cloud" | null;

export interface EarningsMarkerStatus {
  sentBy: EarningsMarkerSentBy;
}

async function workerFetch(
  path: string,
  searchParams: URLSearchParams,
  method: "GET" | "POST",
  opts?: { timeoutMs?: number },
): Promise<Response | null> {
  const url = process.env.WORKER_MARKER_URL;
  const secret = process.env.CRON_SHARED_SECRET;
  if (!url || !secret) return null;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const target = `${url.replace(/\/$/, "")}${path}?${searchParams.toString()}`;
    const res = await fetch(target, {
      method,
      headers: { "X-Cron-Secret": secret },
      signal: controller.signal,
    });
    return res;
  } catch (err) {
    console.warn(
      `[earnings-marker] worker unreachable (${method} ${path}); ignoring:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the cloud-sent / mac-sent status for an event/phase pair.
 * The Mac route consults this BEFORE firing — if the Worker fallback
 * already delivered, Mac skips its own send.
 */
export async function checkEarningsCloudMarker(
  phase: EarningsPhase,
  eventId: number,
): Promise<EarningsMarkerStatus | null> {
  const params = new URLSearchParams({
    phase,
    eventId: String(eventId),
  });
  const res = await workerFetch("/internal/earnings-marker", params, "GET");
  if (!res || !res.ok) return null;
  try {
    return (await res.json()) as EarningsMarkerStatus;
  } catch {
    return null;
  }
}

/**
 * Set the running marker (10-min TTL). Mac calls this at the entry of
 * its cron-route POST so the Worker fallback knows the Mac is mid-fire.
 */
export function setEarningsRunningMarker(
  phase: EarningsPhase,
  eventId: number,
): Promise<Response | null> {
  const params = new URLSearchParams({
    phase,
    eventId: String(eventId),
    action: "set",
  });
  return workerFetch("/internal/earnings-running-marker", params, "POST");
}

export function clearEarningsRunningMarker(
  phase: EarningsPhase,
  eventId: number,
): Promise<Response | null> {
  const params = new URLSearchParams({
    phase,
    eventId: String(eventId),
    action: "clear",
  });
  return workerFetch("/internal/earnings-running-marker", params, "POST");
}

/**
 * Write the mac-sent marker so the Worker fallback skips this event/phase
 * on the next sweep tick.
 */
export function writeMacSentEarningsMarker(
  phase: EarningsPhase,
  eventId: number,
): Promise<Response | null> {
  const params = new URLSearchParams({
    phase,
    eventId: String(eventId),
  });
  return workerFetch("/internal/earnings-sent-marker", params, "POST");
}

export interface CloudSentEarningsMarker {
  phase: EarningsPhase;
  eventId: number;
  /** ISO timestamp the Worker wrote at send time; null for malformed values. */
  sentAt: string | null;
}

/**
 * List every live cloud-sent-earnings-* marker (30h TTL) so the sweep can
 * backfill local earnings_emails audit rows for sends the Worker delivered
 * while the Mac slept — including events whose send windows have since
 * closed, which the per-candidate marker check above can never see
 * (observed 7/14: cloud-sent previews left no audit row, so EarningsHub
 * chips + the email viewer lost them when the KV TTL expired).
 *
 * Read-only by design: the marker doubles as the Worker's own send dedup,
 * so the Mac must NOT delete it. The audit row is what stops repeat
 * reconciles (INSERT ... DO NOTHING); the TTL cleans up the KV side.
 */
export async function fetchCloudSentEarnings(): Promise<CloudSentEarningsMarker[]> {
  const res = await workerFetch(
    "/internal/cloud-sent-earnings",
    new URLSearchParams(),
    "GET",
  );
  if (!res || !res.ok) return [];
  try {
    const body = (await res.json()) as { sends?: CloudSentEarningsMarker[] };
    return Array.isArray(body.sends) ? body.sends : [];
  } catch {
    return [];
  }
}

/**
 * Push-at-print dedup marker (Wave 1 §2). Whichever side (Mac enrichment,
 * Mac reconcile, Worker cloud-enrich) captures the actual checks this BEFORE
 * pushing and writes it after. `false`/unreachable → allow the push (a
 * duplicate requires both sides active, which requires the Worker reachable).
 */
export async function checkPrintPushMarker(eventId: number): Promise<boolean> {
  const params = new URLSearchParams({ eventId: String(eventId) });
  const res = await workerFetch("/internal/print-push-marker", params, "GET");
  if (!res || !res.ok) return false;
  try {
    const body = (await res.json()) as { pushed?: boolean };
    return body.pushed === true;
  } catch {
    return false;
  }
}

export function writePrintPushMarker(eventId: number): Promise<Response | null> {
  const params = new URLSearchParams({ eventId: String(eventId) });
  return workerFetch("/internal/print-push-marker", params, "POST");
}

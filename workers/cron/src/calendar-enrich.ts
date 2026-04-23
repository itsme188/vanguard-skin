/**
 * Worker calendar-enrich dispatch — primary-only parity (Phase 9a).
 *
 * Fires every 15 minutes via the "every-15m" cron trigger, but self-gates
 * inside `shouldRunNow` to US-market business hours (09:30 → 18:00 ET,
 * Mon-Fri). The 18:00 upper bound extends past market close specifically
 * so AMC earnings (release 16:15 ET, reaction window 16:15 + 2h = 18:15)
 * can still be captured within the runner's -2h window.
 *
 * Architecture mirrors briefing/digest: try the Mac primary via
 * `callPrimary`, record an `enrich-sent-{slot}` KV marker on success.
 *
 * Cloud fallback is staged for a follow-up — the Worker currently logs
 * primary failure but does NOT independently fetch FRED/Finnhub actuals
 * or Polygon intraday bars. The Mac is the source of truth for which
 * events even exist; once the Mac reconciles (auto-refresh pipeline or
 * next 15-min slot), events in the [now-2h, now-5min] window get
 * enriched.
 *
 * See TODO: full cloud-fallback parity needs Mac-side `/api/calendar/
 * enrich/candidates` + Worker-side Polygon client + Mac-side
 * `/api/calendar/reconcile-cloud-enrich`.
 */

import { getCurrentETHour, getCurrentETMinute, getCurrentETDayOfWeek, todayET } from "./dst";

// ── Primary call ────────────────────────────────────────────────────

export type PrimaryEnrichResult =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "timeout" }
  | { kind: "network_error"; message: string }
  | { kind: "server_error"; status: number; body: unknown };

async function callEnrichPrimary(
  meshHostname: string,
  cronSecret: string,
  timeoutMs: number,
): Promise<PrimaryEnrichResult> {
  const url = `${meshHostname.replace(/\/$/, "")}/api/calendar/enrich`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cron-Secret": cronSecret,
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }
    if (res.ok) return { kind: "success", status: res.status, body };
    return { kind: "server_error", status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { kind: "timeout" };
    }
    return {
      kind: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── When to run ─────────────────────────────────────────────────────

export function shouldRunCalendarEnrich(
  now: { hour: number; minute: number; dow: number } = {
    hour: getCurrentETHour(),
    minute: getCurrentETMinute(),
    dow: getCurrentETDayOfWeek(),
  },
): boolean {
  // Mon-Fri only (dow 1..5)
  if (now.dow < 1 || now.dow > 5) return false;
  // 09:30 ET to 17:59 ET (inclusive)
  const minuteOfDay = now.hour * 60 + now.minute;
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay <= 17 * 60 + 59;
}

// ── KV marker for per-slot dedup ────────────────────────────────────

/**
 * 15-minute slot key so re-fires within the same tick don't call the Mac
 * twice. Format: enrich-sent-YYYY-MM-DD-HHMM, TTL 2h.
 */
function slotKey(date: string, hour: number, minute: number): string {
  const slotMin = Math.floor(minute / 15) * 15;
  return `enrich-sent-${date}-${String(hour).padStart(2, "0")}${String(slotMin).padStart(2, "0")}`;
}

export interface EnrichRunResult {
  skipped?: "off_hours" | "already_sent_this_slot";
  primary?: PrimaryEnrichResult;
  fallback?: "not_implemented";
  sentBy?: "mac" | "cloud";
}

export interface EnrichRunEnv {
  CRON_KV: KVNamespace;
  CRON_SHARED_SECRET: string;
  MESH_HOSTNAME: string;
  PRIMARY_TIMEOUT_MS: string;
}

export async function runCalendarEnrich(
  env: EnrichRunEnv,
): Promise<EnrichRunResult> {
  if (!shouldRunCalendarEnrich()) {
    return { skipped: "off_hours" };
  }

  const hour = getCurrentETHour();
  const minute = getCurrentETMinute();
  const key = slotKey(todayET(), hour, minute);

  const existing = await env.CRON_KV.get(key);
  if (existing) {
    return { skipped: "already_sent_this_slot" };
  }

  // Primary: call the Mac. The Mac's /api/calendar/enrich runs the full
  // window-filter + actual-fetch + TWS reaction capture server-side.
  const primary = await callEnrichPrimary(
    env.MESH_HOSTNAME,
    env.CRON_SHARED_SECRET,
    parseInt(env.PRIMARY_TIMEOUT_MS, 10) || 120000,
  );

  if (primary.kind === "success") {
    await env.CRON_KV.put(key, new Date().toISOString(), {
      expirationTtl: 2 * 3600,
    });
    return { primary, sentBy: "mac" };
  }

  // Cloud fallback staged for follow-up. Log the failure mode in the
  // KV for observability — still don't write a success marker, so the
  // next 15-min tick retries.
  await env.CRON_KV.put(
    `enrich-fail-${todayET()}-${hour}${minute}`,
    JSON.stringify({ at: new Date().toISOString(), primary }),
    { expirationTtl: 24 * 3600 },
  );

  return { primary, fallback: "not_implemented" };
}

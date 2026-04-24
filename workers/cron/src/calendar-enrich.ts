/**
 * Worker calendar-enrich dispatch.
 *
 * Fires every 15 minutes via the "every-15m" cron trigger, but self-gates
 * inside `shouldRunNow` to US-market business hours (09:30 → 18:00 ET,
 * Mon-Fri). The 18:00 upper bound extends past market close specifically
 * so AMC earnings (release 16:15 ET, reaction window 16:15 + 2h = 18:15)
 * can still be captured within the runner's -2h window.
 *
 * Architecture mirrors briefing/digest: try the Mac primary via
 * `callPrimary`, record an `enrich-sent-{slot}` KV marker on success. On
 * primary failure, Phase 9b kicks in:
 *
 *   1. Read the latest R2 state snapshot.
 *   2. Filter calendar events to the [now-2h, now-5min] window.
 *   3. For each candidate, fetch actual value (FRED/Finnhub — Claude nonfred
 *      deferred to next Mac wake) and reaction bars (Polygon).
 *   4. Write payload to KV at `cloud-enriched-{eventId}` (7d TTL).
 *   5. Mac reconciles on next wake via /api/calendar/reconcile-cloud-enrich,
 *      with TWS-always-wins precedence on reaction_snapshot.
 *
 * The cloud branch is gated by `CLOUD_ENRICH_ENABLED=true` — otherwise it's
 * the pre-Phase-9b log-only behavior (same as before).
 */

import { getCurrentETHour, getCurrentETMinute, getCurrentETDayOfWeek, todayET } from "./dst";
import { loadLatestSnapshot } from "./state";
import { composeReleaseInstant, resolveSectorEtf } from "./reaction-matcher";
import { captureReactionFromYahoo } from "./yahoo";
import { fetchActualForEventCloud, type WorkerEnrichActualResult } from "./enrich-actuals";

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
  if (now.dow < 1 || now.dow > 5) return false;
  const minuteOfDay = now.hour * 60 + now.minute;
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay <= 17 * 60 + 59;
}

// ── Slot keys ───────────────────────────────────────────────────────

function slotKey(date: string, hour: number, minute: number): string {
  const slotMin = Math.floor(minute / 15) * 15;
  return `enrich-sent-${date}-${String(hour).padStart(2, "0")}${String(slotMin).padStart(2, "0")}`;
}

function cloudSlotKey(date: string, hour: number, minute: number): string {
  const slotMin = Math.floor(minute / 15) * 15;
  return `cloud-sent-enrich-${date}-${String(hour).padStart(2, "0")}${String(slotMin).padStart(2, "0")}`;
}

function failSlotKey(date: string, hour: number, minute: number): string {
  const slotMin = Math.floor(minute / 15) * 15;
  return `enrich-fail-${date}-${String(hour).padStart(2, "0")}${String(slotMin).padStart(2, "0")}`;
}

export function cloudEnrichedKey(eventId: number): string {
  return `cloud-enriched-${eventId}`;
}

// ── Payload shape (shared with reconcile endpoint on Mac) ───────────

export interface CloudEnrichedPayload {
  eventId: number;
  source_key: string;
  actual: string | null;
  consensus: string | null;
  source: WorkerEnrichActualResult["source"];
  deferred?: boolean;
  reason?: string;
  reaction: unknown; // ReactionSnapshot JSON, or null
  fetchedAt: string;
}

// ── Return shape ────────────────────────────────────────────────────

export interface EnrichRunResult {
  skipped?: "off_hours" | "already_sent_this_slot" | "cloud_disabled";
  primary?: PrimaryEnrichResult;
  fallback?: FallbackRunSummary;
  sentBy?: "mac" | "cloud" | "none";
}

export interface FallbackRunSummary {
  kind: "success" | "no_candidates" | "snapshot_missing" | "error";
  candidatesProcessed?: number;
  failures?: number;
  deferred?: number;
  error?: string;
}

export interface EnrichRunEnv {
  CRON_KV: KVNamespace;
  /** Required for the cloud-fallback path; primary-only runs may omit. */
  ARCHIVE?: R2Bucket;
  CRON_SHARED_SECRET: string;
  MESH_HOSTNAME: string;
  PRIMARY_TIMEOUT_MS: string;
  CLOUD_ENRICH_ENABLED?: string;
  FRED_API_KEY?: string;
  FINNHUB_API_KEY?: string;
}

// ── Fallback: cloud enrichment ──────────────────────────────────────

const CANDIDATE_WINDOW_MS_MAX = 2 * 60 * 60 * 1000;
const CANDIDATE_WINDOW_MS_MIN = 5 * 60 * 1000;
const MAX_CANDIDATES_PER_TICK = 10;

interface SnapshotCalendarEvent {
  id?: unknown;
  source_key?: unknown;
  event_type?: unknown;
  event_date?: unknown;
  release_time?: unknown;
  symbol?: unknown;
  consensus_estimate?: unknown;
  security_id?: unknown;
  actual_value?: unknown;
  enriched_at?: unknown;
  reaction_snapshot?: unknown;
}

export interface RunCloudFallbackOpts {
  /** Override wallclock for candidate-window computation. Defaults to Date.now(). */
  nowMs?: number;
  /** Pacing between Polygon symbol fetches. Defaults to 300ms. Tests pass 0. */
  pacingMs?: number;
}

export async function runCloudFallback(
  env: EnrichRunEnv,
  opts: RunCloudFallbackOpts | number = {},
): Promise<FallbackRunSummary> {
  // Backwards-compat: earlier signature accepted nowMs positionally.
  const nowMs = typeof opts === "number" ? opts : opts.nowMs ?? Date.now();
  const pacingMs = typeof opts === "number" ? undefined : opts.pacingMs;
  if (env.CLOUD_ENRICH_ENABLED !== "true") {
    return { kind: "error", error: "cloud_enrich_disabled" };
  }

  if (!env.ARCHIVE) {
    return { kind: "error", error: "archive_binding_missing" };
  }

  const snapshot = await loadLatestSnapshot(env.ARCHIVE);
  if (!snapshot) return { kind: "snapshot_missing" };

  const events = (snapshot.calendarEvents as unknown as SnapshotCalendarEvent[]) ?? [];
  const candidates: {
    id: number;
    source_key: string;
    event_type: string;
    event_date: string;
    release_time: string;
    symbol: string | null;
    consensus_estimate: string | null;
    releaseInstant: Date;
  }[] = [];

  for (const ev of events) {
    if (ev.enriched_at != null) continue;
    if (typeof ev.release_time !== "string" || !ev.release_time) continue;
    if (typeof ev.event_date !== "string" || !ev.event_date) continue;
    if (typeof ev.source_key !== "string") continue;
    if (typeof ev.id !== "number") continue;

    const releaseInstant = composeReleaseInstant(ev.event_date, ev.release_time);
    if (!releaseInstant) continue;
    const ageMs = nowMs - releaseInstant.getTime();
    if (ageMs < CANDIDATE_WINDOW_MS_MIN || ageMs > CANDIDATE_WINDOW_MS_MAX) continue;

    candidates.push({
      id: ev.id,
      source_key: ev.source_key,
      event_type: typeof ev.event_type === "string" ? ev.event_type : "",
      event_date: ev.event_date,
      release_time: ev.release_time,
      symbol: typeof ev.symbol === "string" ? ev.symbol : null,
      consensus_estimate: typeof ev.consensus_estimate === "string" ? ev.consensus_estimate : null,
      releaseInstant,
    });
    if (candidates.length >= MAX_CANDIDATES_PER_TICK) break;
  }

  if (candidates.length === 0) return { kind: "no_candidates" };

  let failures = 0;
  let deferred = 0;

  for (const cand of candidates) {
    try {
      const existing = await env.CRON_KV.get(cloudEnrichedKey(cand.id));
      if (existing) continue; // idempotent across ticks in the same slot

      const actual = await fetchActualForEventCloud(
        { source_key: cand.source_key, event_date: cand.event_date, consensus_estimate: cand.consensus_estimate },
        env,
      );
      if (actual.deferred) deferred += 1;

      // Earnings sector is not in the snapshot; map from event_type only on
      // cloud path. Macro events map cleanly; earnings will get null sector
      // ETF and publish SPY/QQQ/TLT only — Mac's TWS-upgrade path can add
      // the sector ETF later if needed.
      const sectorEtf = resolveSectorEtf(cand.event_type, null);
      // Yahoo requires no API key — always attempt reaction capture.
      const reaction = await captureReactionFromYahoo(cand.releaseInstant, sectorEtf, { pacingMs });

      const payload: CloudEnrichedPayload = {
        eventId: cand.id,
        source_key: cand.source_key,
        actual: actual.actual,
        consensus: actual.consensus,
        source: actual.source,
        deferred: actual.deferred,
        reason: actual.reason,
        reaction,
        fetchedAt: new Date().toISOString(),
      };

      await env.CRON_KV.put(cloudEnrichedKey(cand.id), JSON.stringify(payload), {
        expirationTtl: 7 * 24 * 3600,
      });
    } catch (err) {
      failures += 1;
      console.error(`[cloud-enrich] candidate ${cand.id} failed:`, err);
    }
  }

  return { kind: "success", candidatesProcessed: candidates.length, failures, deferred };
}

// ── Top-level runner ────────────────────────────────────────────────

export interface RunCalendarEnrichOpts {
  /** Forward to runCloudFallback — 0 in tests to bypass Polygon pacer. */
  pacingMs?: number;
}

export async function runCalendarEnrich(
  env: EnrichRunEnv,
  opts: RunCalendarEnrichOpts = {},
): Promise<EnrichRunResult> {
  if (!shouldRunCalendarEnrich()) {
    return { skipped: "off_hours" };
  }

  const hour = getCurrentETHour();
  const minute = getCurrentETMinute();
  const date = todayET();
  const key = slotKey(date, hour, minute);

  const existing = await env.CRON_KV.get(key);
  if (existing) {
    return { skipped: "already_sent_this_slot" };
  }

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

  // Primary failed — journal the failure and run cloud fallback (if enabled).
  await env.CRON_KV.put(
    failSlotKey(date, hour, minute),
    JSON.stringify({ at: new Date().toISOString(), primary }),
    { expirationTtl: 24 * 3600 },
  );

  if (env.CLOUD_ENRICH_ENABLED !== "true") {
    return { primary, fallback: { kind: "error", error: "cloud_enrich_disabled" }, sentBy: "none" };
  }

  const fallback = await runCloudFallback(env, { pacingMs: opts.pacingMs });
  if (fallback.kind === "success" && fallback.candidatesProcessed && fallback.candidatesProcessed > 0) {
    // Writes the per-slot success marker AND deletes the fail journal.
    await env.CRON_KV.put(
      cloudSlotKey(date, hour, minute),
      new Date().toISOString(),
      { expirationTtl: 2 * 3600 },
    );
    await env.CRON_KV.delete(failSlotKey(date, hour, minute));
    return { primary, fallback, sentBy: "cloud" };
  }

  return { primary, fallback, sentBy: "none" };
}

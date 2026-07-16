/**
 * Worker calendar-enrich dispatch.
 *
 * Fires every 15 minutes via the "every-15m" cron trigger, but self-gates
 * inside `shouldRunNow` to US-market business hours (09:30 → 18:59 ET,
 * Mon-Fri). The 18:59 upper bound (extended from 18:00, B8) exists because
 * earnings-row reaction capture is gated to T+115min (`REACTION_READY_MS`,
 * see cloud-enriched.ts) — a late-AMC name (e.g. 16:30 release) isn't
 * reaction-ready until ~18:25, so the old 18:00 boundary gave it zero
 * capturable ticks. 18:59 gives every AMC name at least two tick
 * opportunities within the runner's -2h candidate window.
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
import { issuerSiblings } from "./fallback-earnings";
import { readPrintPushMarker, writePrintPushMarker } from "./earnings-markers";
import { composePrintPushMessage } from "./print-push-message";
import { sendPushover } from "./pushover";
import {
  cloudEnrichedKey,
  isPayloadComplete,
  isEarningsRow,
  REACTION_READY_MS,
  type CloudEnrichedPayload,
} from "./cloud-enriched";

// Back-compat re-exports — existing importers/tests reach these through
// calendar-enrich; the definitions now live in cloud-enriched.ts.
export { cloudEnrichedKey, isPayloadComplete, type CloudEnrichedPayload };

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
  // Upper bound 18:59 ET (was 17:59, B8): reaction capture needs a tick at
  // ≥ release+110min (bars target T+120 with 10-min tolerance —
  // BAR_TOLERANCE_MS in reaction-matcher.ts). The AMC cohort releases
  // 16:00–16:30, so the latest capturable floor is 18:20 (16:30 release);
  // 18:59 gives every AMC name at least two tick opportunities
  // (e.g. 16:30 → 18:30 + 18:45). Before this, cloud AMC reactions were
  // structurally impossible.
  return minuteOfDay >= 9 * 60 + 30 && minuteOfDay <= 18 * 60 + 59;
}

/**
 * Gate for the earnings cloud-fallback sweep. Wider than the
 * calendar-enrich gate so the AMC-recap window (release at 16:15 → recap
 * at ~18:15) is covered. Window: Mon–Fri 05:00–20:59 ET (covers BMO
 * preview at 06:00 → AMC recap at 18:15+, plus hour of slack on either
 * side for clock skew). Outside this window the Mac sweep is also idle
 * (TWS market session is 09:30–16:00 + extended hours) so there's
 * nothing to fall back ON.
 *
 * Upper bound 20:59 ET (extended from 20:00, #17 T4 — same B8 18:00→18:59
 * precedent): the EOD earnings wrap's AMC deadline is 20:00 ET
 * (SLOT_DEADLINES_ET / cloudSlotDeadlinePassed in fallback-earnings.ts), so
 * the 20:00 tick — when a not-all-reported AMC cluster fires at deadline —
 * must be INSIDE the gate. A `<= 20 * 60` bound would fire the sweep at 20:00
 * but starve the 20:15/20:30/20:45 ticks that a slightly-late deadline pass
 * still needs.
 */
export function shouldRunEarningsFallback(
  now: { hour: number; minute: number; dow: number } = {
    hour: getCurrentETHour(),
    minute: getCurrentETMinute(),
    dow: getCurrentETDayOfWeek(),
  },
): boolean {
  if (now.dow < 1 || now.dow > 5) return false;
  const minuteOfDay = now.hour * 60 + now.minute;
  return minuteOfDay >= 5 * 60 && minuteOfDay <= 20 * 60 + 59;
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
  /** Last per-candidate failure message — set when failures > 0 so a partial
   *  (or total) failure surfaces a diagnosable reason, not just a count. */
  lastError?: string;
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
  // Push-at-print (Wave 1 §2) — same Pushover creds the level-scan fan-out
  // uses (workers/cron/src/pushover.ts).
  PUSHOVER_APP_TOKEN?: string;
  PUSHOVER_USER_KEY?: string;
  PUSHOVER_LINK_BASE?: string;
}

// ── Fallback: cloud enrichment ──────────────────────────────────────

const CANDIDATE_WINDOW_MS_MAX = 2 * 60 * 60 * 1000;
const CANDIDATE_WINDOW_MS_MIN = 5 * 60 * 1000;
// Earnings rows retry up to 12h post-release (Mac MAX_AGE_MS_EARNINGS mirror
// — a BMO 08:00 print can't capture a reaction before the market opens, and
// retries continue until the payload is COMPLETE). Macro rows keep 2h.
const MAX_AGE_MS_EARNINGS = 12 * 60 * 60 * 1000;
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
    const maxAgeMs = isEarningsRow(
      typeof ev.event_type === "string" ? ev.event_type : "",
      ev.source_key,
    )
      ? MAX_AGE_MS_EARNINGS
      : CANDIDATE_WINDOW_MS_MAX;
    if (ageMs < CANDIDATE_WINDOW_MS_MIN || ageMs > maxAgeMs) continue;

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
  let lastError: string | null = null;

  for (const cand of candidates) {
    try {
      const isEarnings = isEarningsRow(cand.event_type, cand.source_key);
      const existingRaw = await env.CRON_KV.get(cloudEnrichedKey(cand.id));
      let existing: CloudEnrichedPayload | null = null;
      if (existingRaw) {
        try {
          existing = JSON.parse(existingRaw) as CloudEnrichedPayload;
        } catch {
          existing = null;
        }
        // Macro rows keep single-shot semantics EXACTLY (immediate partial
        // capture is by design). Earnings rows retry until COMPLETE — the
        // Worker mirror of the Mac's migration-062 retry-until-complete.
        if (!isEarnings) continue;
        if (existing && isPayloadComplete(existing, cand.releaseInstant, nowMs)) continue;
      }

      // Fetch only what's missing — an existing actual is never re-fetched
      // (subrequest saving) and never erased by a later null fetch.
      const haveActual = existing?.actual != null && existing?.deferred !== true;
      const actual: WorkerEnrichActualResult = haveActual
        ? { actual: existing!.actual, consensus: existing!.consensus, source: existing!.source }
        : await fetchActualForEventCloud(
            { source_key: cand.source_key, event_date: cand.event_date, consensus_estimate: cand.consensus_estimate },
            env,
          );
      if (!haveActual && actual.deferred) deferred += 1;

      // Earnings sector is not in the snapshot; map from event_type only on
      // cloud path. Macro events map cleanly; earnings will get null sector
      // ETF and publish SPY/QQQ/TLT only — Mac's TWS-upgrade path can add
      // the sector ETF later if needed.
      const sectorEtf = resolveSectorEtf(cand.event_type, null);
      // Earnings reactions are pointless before T+115 (bars target T+120,
      // 10-min tolerance) — Mac REACTION_READY_MS mirror. Macro rows are
      // NEVER gated (immediate partial capture is by design).
      const reactionAllowed =
        !isEarnings || nowMs - cand.releaseInstant.getTime() >= REACTION_READY_MS;
      const reaction =
        existing?.reaction ??
        (reactionAllowed
          ? await captureReactionFromYahoo(cand.releaseInstant, sectorEtf, {
              pacingMs,
              eventSymbol: cand.event_type === "earnings" ? cand.symbol : null,
            })
          : null);

      const payload: CloudEnrichedPayload = {
        eventId: cand.id,
        source_key: cand.source_key,
        actual: actual.actual ?? existing?.actual ?? null,
        consensus: actual.consensus ?? existing?.consensus ?? null,
        source: actual.actual != null ? actual.source : existing?.source ?? actual.source,
        deferred: actual.deferred,
        reason: actual.reason,
        reaction: reaction ?? existing?.reaction ?? null,
        fetchedAt: new Date().toISOString(),
      };

      await env.CRON_KV.put(cloudEnrichedKey(cand.id), JSON.stringify(payload), {
        expirationTtl: 7 * 24 * 3600,
      });

      // Push-at-print (Wave 1 §2): the Worker is often the first to capture
      // an actual while the Mac sleeps — push immediately rather than waiting
      // for the Mac's wake-up reconcile. Held/watchlist from the snapshot
      // (watchlistSymbols is additive v8; older snapshots → held-only),
      // muted list respected, issuer-family aware, KV-marker deduped.
      // Costs up to 3 subrequests per print (marker read, Pushover POST,
      // marker write) against the invocation's 50-subrequest free-tier budget.
      if (
        cand.event_type === "earnings" &&
        cand.symbol &&
        payload.actual != null &&
        !payload.deferred
      ) {
        try {
          const sym = cand.symbol.toUpperCase();
          const family = issuerSiblings(sym).map((s) => s.toUpperCase());
          const heldSet = new Set((snapshot.heldSymbols ?? []).map((s) => s.toUpperCase()));
          const watchSet = new Set((snapshot.watchlistSymbols ?? []).map((s) => s.toUpperCase()));
          const muted = new Set(
            (snapshot.earningsSettings?.mutedSymbols ?? []).map((s) => s.toUpperCase()),
          );
          const enabled = snapshot.earningsSettings?.enabled !== false;
          const covered = family.some((f) => heldSet.has(f) || watchSet.has(f));
          const isMuted = family.some((f) => muted.has(f));
          if (enabled && covered && !isMuted && !(await readPrintPushMarker(env.CRON_KV, cand.id))) {
            const { title, message } = composePrintPushMessage({
              symbol: sym,
              actualValue: payload.actual,
              consensusValue: payload.consensus,
              reactionJson: payload.reaction ? JSON.stringify(payload.reaction) : null,
            });
            // Same link-base resolution as sendLevelAlertPush (pushover.ts) —
            // no MESH_HOSTNAME-independent hardcoded IP.
            const base =
              env.PUSHOVER_LINK_BASE ??
              (env.MESH_HOSTNAME ? `https://${env.MESH_HOSTNAME}` : "http://localhost:3099");
            const pushRes = await sendPushover(env, {
              title,
              message,
              url: `${base}/dashboard/today`,
              urlTitle: "Open Earnings Hub",
            });
            if (pushRes.sent) await writePrintPushMarker(env.CRON_KV, cand.id);
          }
        } catch (err) {
          console.warn(`[calendar-enrich] print-push failed for ${cand.id}:`, err);
        }
      }
    } catch (err) {
      failures += 1;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[cloud-enrich] candidate ${cand.id} failed:`, err);
    }
  }

  return {
    kind: "success",
    candidatesProcessed: candidates.length,
    failures,
    deferred,
    lastError: lastError ?? undefined,
  };
}

// ── Top-level runner ────────────────────────────────────────────────

export interface RunCalendarEnrichOpts {
  /** Forward to runCloudFallback — 0 in tests to bypass Polygon pacer. */
  pacingMs?: number;
}

/**
 * Decide whether a tick where the Mac primary failed is worth keeping the
 * `enrich-fail-{slot}` journal marker.
 *
 * The Mac primary (Worker → Mesh CGNAT IP) is unreachable from Cloudflare's
 * edge on EVERY tick — it fast-fails with CF error 1016. So a primary failure
 * by itself is the normal idle state, not a problem. The journal marker should
 * only persist when the cloud fallback ALSO couldn't make clean progress:
 *   - a real error (missing archive binding, cloud disabled, etc.)
 *   - a missing snapshot
 *   - candidate-level failures during enrichment
 * A benign `no_candidates` (nothing in the enrichment window) or a clean
 * success with zero candidate-failures clears the journal — otherwise a whole
 * quiet market day reads as a wall of `enrich-fail` markers (observed 6/02).
 */
export function isBenignEnrichOutcome(fallback: FallbackRunSummary): boolean {
  if (fallback.kind === "no_candidates") return true;
  if (fallback.kind === "success" && !(fallback.failures && fallback.failures > 0)) {
    return true;
  }
  return false;
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
    parseInt(env.PRIMARY_TIMEOUT_MS, 10) || 300000,
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
  if (fallback.failures && fallback.failures > 0) {
    // Partial (or total) candidate failure is masked by kind:"success" whenever
    // any candidate processed — elevate it so it doesn't hide in an info log.
    console.error(
      `[calendar-enrich] cloud fallback had ${fallback.failures} candidate failure(s)` +
        (fallback.lastError ? `: ${fallback.lastError}` : ""),
    );
  }
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

  // No cloud send this tick. The Mac primary is unreachable from CF's edge by
  // design (CF 1016) every tick, so clear the fail journal we wrote above unless
  // the cloud fallback ALSO hit a real problem — a benign no_candidates idle
  // tick must not read as a failure in the KV marker scan.
  if (isBenignEnrichOutcome(fallback)) {
    await env.CRON_KV.delete(failSlotKey(date, hour, minute));
  }

  return { primary, fallback, sentBy: "none" };
}

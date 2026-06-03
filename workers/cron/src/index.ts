/**
 * Vanguard Skin cron Worker — Phase 4 (primary-only).
 *
 * Session B deliverable: reliable retry + dedup for the Mac's briefing/digest
 * emails. If the Mac is awake and reachable via MESH_HOSTNAME, the Worker
 * calls /api/cron/{briefing|digest} and records a mac-sent marker in KV.
 *
 * Session C wires in the cloud fallback: on primary-path failure, the Worker
 * will generate + send the email itself. For now, non-success outcomes are
 * logged only — the cloud fallback is a stub.
 *
 * Exposes two HTTP endpoints for the Mac side + smoke testing:
 *   GET  /internal/marker?type={briefing|digest|evening}   (X-Cron-Secret required)
 *   POST /internal/trigger?type={briefing|digest|evening}  (X-Cron-Secret required)
 */

import {
  readMarkers,
  writeMarker,
  setRunningMarker,
  clearRunningMarker,
  setAttemptingMarker,
  clearAttemptingMarker,
  getMarkerStatus,
  type JobType,
  type SentBy,
} from "./dedup";
import {
  getCurrentETHour,
  getCurrentETMinute,
  getCurrentETDayOfWeek,
  todayET,
} from "./dst";
import { callPrimary, type PrimaryResult } from "./primary";
import { runFallbackDigest, type FallbackResult } from "./fallback-digest";
import { runFallbackBriefing } from "./fallback-briefing";
import { runFallbackEvening } from "./fallback-evening";
import { isMarketHoliday, shouldSendBriefingToday } from "./market-holidays";
import {
  runCalendarEnrich,
  runCloudFallback,
  shouldRunCalendarEnrich,
  shouldRunEarningsFallback,
} from "./calendar-enrich";
import { runEarningsFallback } from "./fallback-earnings";
import {
  getEarningsMarkerStatus,
  readEarningsMarkers,
  setEarningsRunningMarker,
  clearEarningsRunningMarker,
  writeEarningsMarker,
  type EarningsPhase,
} from "./earnings-markers";
import { runLevelScan, shouldRunLevelScan } from "./level-scan";
import {
  runNewsletterFetch,
  shouldRunNewsletterFetch,
} from "./newsletter-fetch";
import {
  ibkrConfigFromEnv,
} from "./ibkr-oauth";
import { fetchLiveIbkrPositions, liveSymbolsForContext } from "./ibkr-positions";

export interface Env {
  // Bindings
  CRON_KV: KVNamespace;
  ARCHIVE: R2Bucket;
  // Vars (wrangler.toml [vars])
  EXPECTED_HOUR_BRIEFING: string;
  EXPECTED_HOUR_DIGEST: string;
  EXPECTED_MINUTE_DIGEST?: string;
  // Evening email — Mon-Thu 7pm ET, Fri 5:30pm ET
  EXPECTED_HOUR_EVENING_MON_THU: string;
  EXPECTED_HOUR_EVENING_FRI: string;
  EXPECTED_MINUTE_EVENING_FRI: string;
  PRIMARY_TIMEOUT_MS: string;
  // Secrets (`wrangler secret put`)
  CRON_SHARED_SECRET: string;
  MESH_HOSTNAME: string;
  // Session-C secrets — optional in Session B, present for typing only.
  ANTHROPIC_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  WORKER_GMAIL_CLIENT_ID?: string;
  WORKER_GMAIL_CLIENT_SECRET?: string;
  WORKER_GMAIL_REFRESH_TOKEN?: string;
  BRIEFING_EMAIL_TO?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_DOMAIN?: string;
  // Phase 9b — cloud-enrich fallback secrets + flag.
  CLOUD_ENRICH_ENABLED?: string;
  FRED_API_KEY?: string;
  FINNHUB_API_KEY?: string;
  // Pushover for cloud-side level scan fan-out (Tier 4a).
  PUSHOVER_APP_TOKEN?: string;
  PUSHOVER_USER_KEY?: string;
  PUSHOVER_LINK_BASE?: string;
  // IBKR first-party OAuth 1.0a (Tier 3) — headless cloud read of live positions.
  IBKR_CONSUMER_KEY?: string;
  IBKR_ACCESS_TOKEN?: string;
  IBKR_PREPEND?: string;
  IBKR_DH_PRIME?: string;
  IBKR_DH_GENERATOR?: string;
  IBKR_SIGNATURE_KEY_PKCS8?: string;
  IBKR_BASE_URL?: string;
  IBKR_REALM?: string;
}

export function parseJobFromClock(env: Env): { type: JobType; expectedHour: number } | null {
  const hour = getCurrentETHour();
  const minute = getCurrentETMinute();
  const dow = getCurrentETDayOfWeek();
  const briefingHour = parseInt(env.EXPECTED_HOUR_BRIEFING, 10);
  const digestHour = parseInt(env.EXPECTED_HOUR_DIGEST, 10);
  // Minute gate for the digest so the Worker fallback fires at the SAME 8:45
  // */15 tick the Mac targets — not the 8:00 top-of-hour tick. Defaults to 45
  // when unset. The cron lands on :00/:15/:30/:45, so minute===45 hits 8:45.
  const digestMinute = parseInt(env.EXPECTED_MINUTE_DIGEST ?? "45", 10);
  const eveningMonThuHour = parseInt(env.EXPECTED_HOUR_EVENING_MON_THU, 10);
  const eveningFriHour = parseInt(env.EXPECTED_HOUR_EVENING_FRI, 10);
  const eveningFriMinute = parseInt(env.EXPECTED_MINUTE_EVENING_FRI, 10);

  // Briefing fires at 15:00 ET on BOTH Sunday and Monday; runJob's
  // shouldSendBriefingToday gate picks the right day (normally Sunday, deferred
  // to Monday when the upcoming Monday is a market holiday). A normal Monday
  // tick is gated out, so this never double-sends.
  if (hour === briefingHour && (dow === 0 || dow === 1)) {
    return { type: "briefing", expectedHour: briefingHour };
  }
  if (hour === digestHour && minute === digestMinute && dow >= 1 && dow <= 5) {
    return { type: "digest", expectedHour: digestHour };
  }
  // Evening — Mon-Thu 19:00 ET, Fri 17:30 ET.
  // Winter day-shift note: Mon-Thu 7pm EST = 00:00 UTC NEXT day (Tue-Fri UTC).
  // parseJobFromClock reads ET wall-clock via Intl, so the cron firing at
  // 00:00 UTC on (say) Tuesday still maps to ET Monday 19:00 — caught here.
  if (hour === eveningMonThuHour && minute === 0 && dow >= 1 && dow <= 4) {
    return { type: "evening", expectedHour: eveningMonThuHour };
  }
  if (hour === eveningFriHour && minute === eveningFriMinute && dow === 5) {
    return { type: "evening", expectedHour: eveningFriHour };
  }
  return null;
}

interface RunJobOpts {
  dryRun?: boolean;
  fallbackOnly?: boolean; // skip primary, go straight to fallback (smoke test)
  force?: boolean; // bypass the holiday/briefing-day gate (manual /internal/trigger)
}

interface RunJobResult {
  skipped?:
    | "already_sent"
    | "already_sent_by_cloud"
    | "mac_still_running"
    | "cloud_attempt_in_flight"
    | "market_holiday"
    | "not_briefing_day";
  primary?: PrimaryResult;
  fallback?: FallbackResult;
  sentBy?: SentBy;
}

async function runJob(type: JobType, env: Env, opts: RunJobOpts = {}): Promise<RunJobResult> {
  const date = todayET();

  // Holiday gating (mirrors the Mac cron routes). Skip BEFORE calling the Mac
  // or touching markers so a closed day produces no email and no marker churn.
  // Bypassed by the manual /internal/trigger endpoint (opts.force) — an explicit
  // smoke-test or hand-trigger should run regardless of the calendar.
  if (!opts.force) {
    if ((type === "digest" || type === "evening") && isMarketHoliday(date)) {
      console.log(`[runJob ${type}] ${date} is a market holiday — skipping.`);
      return { skipped: "market_holiday" };
    }
    if (type === "briefing" && !shouldSendBriefingToday(date)) {
      console.log(`[runJob briefing] ${date} is not the briefing send-day (holiday shift) — skipping.`);
      return { skipped: "not_briefing_day" };
    }
  }

  const markers = await readMarkers(env.CRON_KV, type, date);

  if (markers.mac && !opts.dryRun) return { skipped: "already_sent" };
  if (markers.cloud && !opts.dryRun) return { skipped: "already_sent_by_cloud" };
  // A concurrent invocation is already inside the fallback path. Bail out so
  // 4 consecutive ticks at hh:00/15/30/45 don't all enter fallback and ship
  // 4 emails before the first one finishes its 5-min run.
  if (markers.cloudAttempting && !opts.dryRun) {
    return { skipped: "cloud_attempt_in_flight" };
  }

  // Optionally skip primary entirely — for exercising the fallback path in tests.
  let primary: PrimaryResult | undefined;
  if (!opts.fallbackOnly) {
    primary = await callPrimary({
      meshHostname: env.MESH_HOSTNAME,
      cronSecret: env.CRON_SHARED_SECRET,
      type,
      timeoutMs: parseInt(env.PRIMARY_TIMEOUT_MS, 10) || 300000,
      // Digest: since last sent (matches launchd wrapper). Without this the
      // Mac defaults to generateDailyDigest (last 24h) — which is yesterday's
      // content re-packaged as today's email.
      body: type === "digest" ? { mode: "since_last" } : undefined,
    });

    if (primary.kind === "success") {
      if (!opts.dryRun) await writeMarker(env.CRON_KV, "mac", type, date);
      return { primary, sentBy: "mac" };
    }
    if (primary.kind === "skipped_by_mac") {
      return { primary };
    }

    // Primary timed out or errored from our perspective. Re-read markers
    // before firing the fallback: the Mac may have completed slowly during
    // our timeout window and written mac-sent (via the Mac→Worker callback
    // wired into /api/cron/*), or it may still be running and have set the
    // mac-running marker. Either way, we should NOT re-send. This closes
    // the 8:45→8:57 race observed 2026-04-27.
    if (!opts.dryRun) {
      const reMarkers = await readMarkers(env.CRON_KV, type, date);
      if (reMarkers.mac) return { primary, sentBy: "mac", skipped: "already_sent" };
      if (reMarkers.cloud) return { primary, skipped: "already_sent_by_cloud" };
      if (reMarkers.cloudAttempting) {
        return { primary, skipped: "cloud_attempt_in_flight" };
      }
      if (reMarkers.macRunning) {
        return { primary, skipped: "mac_still_running" };
      }
    }
  }

  // Claim the fallback BEFORE the heavy Gmail+Claude+Resend work. The 10-min
  // TTL on this marker auto-expires if the invocation dies mid-fallback, so
  // a killed run lets the next tick retry. Skipping when dryRun keeps tests
  // hermetic.
  if (!opts.dryRun) await setAttemptingMarker(env.CRON_KV, type, date);

  // Primary failed (timeout / network / 5xx) or was skipped — run fallback.
  let fallback: FallbackResult;
  try {
    if (type === "briefing") {
      fallback = await runFallbackBriefing(env, { dryRun: opts.dryRun });
    } else if (type === "evening") {
      fallback = await runFallbackEvening(env, { dryRun: opts.dryRun });
    } else {
      fallback = await runFallbackDigest(env, { dryRun: opts.dryRun });
    }
  } catch (err) {
    console.error(`[runJob ${type}] fallback threw:`, err);
    fallback = {
      kind: "error",
      error: err instanceof Error ? `${err.message}\n${err.stack?.slice(0, 500)}` : String(err),
    };
  }

  if (fallback.kind === "success") {
    if (!opts.dryRun) {
      // Write cloud-sent first, then clear cloud-attempting. Order matters:
      // if the invocation dies between these two, the next tick still sees
      // cloud-sent and skips. Reverse order would leave an idle 10-min window
      // where neither marker is set.
      await writeMarker(env.CRON_KV, "cloud", type, date);
      await clearAttemptingMarker(env.CRON_KV, type, date);
    }
    return { primary, fallback, sentBy: "cloud" };
  }

  // Fallback didn't ship. Clear the attempting marker so the next tick can
  // retry immediately instead of waiting 10 min for the TTL to expire.
  if (!opts.dryRun) await clearAttemptingMarker(env.CRON_KV, type, date);
  return { primary, fallback };
}

// ── Catch-up retry ──────────────────────────────────────────────────────────
//
// If the scheduled-window dispatch failed silently (Worker killed mid-fallback,
// transient Anthropic outage, Gmail OAuth blip, …), the user lost the email
// for the day. This sweep re-tries each email type once its scheduled window
// has clearly passed without a marker, so the cron is self-healing.
//
// Bound the window so we don't ship "morning digest" at 4pm — only catch up
// within a few hours of the original window.

interface CatchUpJob {
  type: JobType;
  /** ET hour after which catch-up is allowed (must be after the original window). */
  afterHour: number;
  /** ET hour before which catch-up is allowed (don't ship hours late). */
  beforeHour: number;
  /** Day-of-week filter — same semantics as parseJobFromClock. */
  dows: number[];
}

export function catchUpCandidates(): CatchUpJob[] {
  return [
    // Digest scheduled Mon-Fri 8:00-8:45 ET. Catch up between 9:30 ET (first
    // calendar-enrich tick after the digest window) and 12:00 ET noon.
    { type: "digest", afterHour: 9, beforeHour: 12, dows: [1, 2, 3, 4, 5] },
    // Evening Mon-Thu 19:00 ET. Catch up 20:00-22:00 ET same day. Fri 17:30 ET
    // catch-up is handled by the same window via dow=5 + afterHour=18.
    { type: "evening", afterHour: 20, beforeHour: 23, dows: [1, 2, 3, 4] },
    { type: "evening", afterHour: 18, beforeHour: 22, dows: [5] },
    // Briefing Sun 15:00 ET (or deferred to a holiday Monday). Catch up
    // 17:00-22:00 ET on Sun AND Mon; runJob's shouldSendBriefingToday gate
    // prevents a normal-Monday catch-up from firing.
    { type: "briefing", afterHour: 17, beforeHour: 22, dows: [0, 1] },
  ];
}

async function runCatchUp(env: Env): Promise<{ ran: JobType[]; skipped: JobType[] }> {
  const hour = getCurrentETHour();
  const dow = getCurrentETDayOfWeek();
  const date = todayET();
  const ran: JobType[] = [];
  const skipped: JobType[] = [];

  for (const cand of catchUpCandidates()) {
    if (!cand.dows.includes(dow)) continue;
    if (hour < cand.afterHour || hour >= cand.beforeHour) continue;

    const markers = await readMarkers(env.CRON_KV, cand.type, date);
    if (markers.mac || markers.cloud || markers.cloudAttempting || markers.macRunning) {
      skipped.push(cand.type);
      continue;
    }

    console.log(
      `[catch-up] ${cand.type} appears missed (ET ${hour}, dow ${dow}, no markers) — dispatching fallback retry`,
    );
    const result = await runJob(cand.type, env);
    console.log(`[catch-up] ${cand.type} result:`, JSON.stringify(result));
    ran.push(cand.type);
  }

  return { ran, skipped };
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // PRIORITY 1: the briefing/digest/evening dispatch is the highest-stakes
    // job (user-visible email). Run it FIRST and AWAIT it — not via
    // ctx.waitUntil — so the invocation's wall-clock and subrequest budget
    // are dedicated to completing the email and writing the marker before
    // siblings start competing for resources. Pre-2026-05-14 this ran in
    // parallel via ctx.waitUntil and (we suspect) the invocation died with
    // the marker write still pending, producing 5/13's silent miss.
    const job = parseJobFromClock(env);
    if (job) {
      console.log(`[cron ${event.cron}] running ${job.type} at ET ${job.expectedHour}:00 (${todayET()})`);
      try {
        const result = await runJob(job.type, env);
        console.log(`[cron] result:`, JSON.stringify(result));
      } catch (err) {
        console.error(`[cron ${event.cron}] runJob threw:`, err);
      }
    } else if (!shouldRunCalendarEnrich()) {
      console.log(
        `[cron ${event.cron}] wrong-hour slot — ET ${getCurrentETHour()}:00, dow=${getCurrentETDayOfWeek()} — no scheduled email job`,
      );
    }

    // PRIORITY 2: the catch-up sweep — re-tries a digest/evening/briefing
    // that should have been sent by now but has no marker. Awaited (not
    // waitUntil) for the same reason as the primary dispatch above: we
    // want the marker write to land before the invocation can be killed.
    try {
      const catchUp = await runCatchUp(env);
      if (catchUp.ran.length > 0) {
        console.log(`[catch-up] ran:`, JSON.stringify(catchUp));
      }
    } catch (err) {
      console.error(`[catch-up] threw:`, err);
    }

    // PRIORITY 3: dispatch the periodic non-email jobs. These are lower
    // stakes (data enrichment, push notifications) and tolerate getting
    // killed mid-flight — they'll re-try on the next 15-min tick. Using
    // ctx.waitUntil lets them run concurrently after the email job has
    // already finished.
    if (shouldRunCalendarEnrich()) {
      ctx.waitUntil(
        (async () => {
          console.log(`[cron ${event.cron}] running calendar-enrich at ${todayET()}`);
          const result = await runCalendarEnrich(env);
          console.log(`[cron calendar-enrich] result:`, JSON.stringify(result));
        })(),
      );
    }

    if (shouldRunEarningsFallback()) {
      ctx.waitUntil(
        (async () => {
          console.log(`[cron ${event.cron}] running earnings-fallback at ${todayET()}`);
          const result = await runEarningsFallback(env);
          if (result.failed > 0 && result.sent === 0) {
            // Every candidate failed and nothing shipped — elevate so it can't
            // hide behind a routine info log (the 5/20 silent-failure lesson).
            console.error(
              `[cron earnings-fallback] ALL ${result.failed} candidate(s) failed, 0 sent:`,
              JSON.stringify(result),
            );
          } else if (result.swept > 0 || result.failed > 0) {
            console.log(`[cron earnings-fallback] result:`, JSON.stringify(result));
          }
        })(),
      );
    }

    if (shouldRunLevelScan()) {
      ctx.waitUntil(
        (async () => {
          const result = await runLevelScan(env);
          if (result.fired > 0 || result.deduped > 0 || result.skipped > 0) {
            console.log(`[cron ${event.cron}] level-scan result:`, JSON.stringify(result));
          }
        })(),
      );
    }

    if (shouldRunNewsletterFetch()) {
      ctx.waitUntil(
        (async () => {
          const result = await runNewsletterFetch(env);
          console.log(`[cron ${event.cron}] newsletter-fetch result:`, JSON.stringify(result));
        })(),
      );
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // All /internal/* routes require the shared secret.
    if (url.pathname.startsWith("/internal/")) {
      const provided = request.headers.get("x-cron-secret") ?? "";
      if (!env.CRON_SHARED_SECRET || provided !== env.CRON_SHARED_SECRET) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    if (request.method === "GET" && url.pathname === "/internal/marker") {
      const typeParam = url.searchParams.get("type");
      if (typeParam !== "briefing" && typeParam !== "digest" && typeParam !== "evening") {
        return Response.json({ error: "type must be briefing, digest, or evening" }, { status: 400 });
      }
      const status = await getMarkerStatus(env.CRON_KV, typeParam);
      return Response.json(status);
    }

    // Mac POSTs this after its launchd-driven /api/cron/{type} successfully
    // ships an email. Worker's catch-up retry then sees mac-sent and skips
    // — without this, a successful Mac launchd send would still trigger a
    // Worker catch-up retry duplicate at 9:30 ET (no mac-sent marker exists
    // because the Worker→Mac primary path is what normally writes it, and
    // primary fails fast with CF 1016 when Mac is on Cloudflare Mesh CGNAT).
    if (request.method === "POST" && url.pathname === "/internal/mac-sent") {
      const typeParam = url.searchParams.get("type");
      if (typeParam !== "briefing" && typeParam !== "digest" && typeParam !== "evening") {
        return Response.json({ error: "type must be briefing, digest, or evening" }, { status: 400 });
      }
      // Mac may want to confirm a send for a different date than today (e.g.
      // sending a "yesterday catchup" briefing). Accept ?date but default to
      // today ET — same convention as todayET() everywhere else.
      const dateParam = url.searchParams.get("date") ?? todayET();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return Response.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
      }
      await writeMarker(env.CRON_KV, "mac", typeParam, dateParam);
      return Response.json({ ok: true, type: typeParam, date: dateParam });
    }

    // Mac calls this at the start (action=set) and end (action=clear) of
    // /api/cron/{briefing,digest,evening}. Worker re-checks markers before firing
    // fallback so a slow-but-successful Mac primary doesn't trigger a
    // duplicate fallback email.
    if (request.method === "POST" && url.pathname === "/internal/running-marker") {
      const typeParam = url.searchParams.get("type");
      const action = url.searchParams.get("action");
      if (typeParam !== "briefing" && typeParam !== "digest" && typeParam !== "evening") {
        return Response.json({ error: "type must be briefing, digest, or evening" }, { status: 400 });
      }
      if (action !== "set" && action !== "clear") {
        return Response.json({ error: "action must be set or clear" }, { status: 400 });
      }
      if (action === "set") {
        await setRunningMarker(env.CRON_KV, typeParam);
      } else {
        await clearRunningMarker(env.CRON_KV, typeParam);
      }
      return Response.json({ ok: true, action, type: typeParam });
    }

    // Cloud-fired level markers — Mac polls on wake, inserts level_alerts
    // for each fired payload, then DELETEs per levelId. Pushover already
    // fired from the Worker — reconcile is audit/UI only.
    if (request.method === "GET" && url.pathname === "/internal/cloud-fired-levels") {
      const list = await env.CRON_KV.list({ prefix: "cloud-fired-level-" });
      const payloads: Record<string, unknown> = {};
      await Promise.all(
        list.keys.map(async (k) => {
          const value = await env.CRON_KV.get(k.name);
          if (value) {
            const m = /^cloud-fired-level-(\d+)$/.exec(k.name);
            if (m) {
              try {
                payloads[m[1]] = JSON.parse(value);
              } catch {
                // skip malformed entries
              }
            }
          }
        }),
      );
      return Response.json({ payloads });
    }

    if (request.method === "DELETE" && url.pathname === "/internal/cloud-fired-levels") {
      const levelIdStr = url.searchParams.get("levelId");
      if (!levelIdStr || !/^\d+$/.test(levelIdStr)) {
        return Response.json({ error: "levelId (numeric) is required" }, { status: 400 });
      }
      await env.CRON_KV.delete(`cloud-fired-level-${levelIdStr}`);
      return Response.json({ ok: true });
    }

    // Mac sets this every time its auto-refresh pipeline completes
    // detectAndFireAlerts. Worker pre-checks before firing a cloud scan,
    // preventing duplicate firing during the overlap when Mac is alive.
    // 90-min TTL — wider than the 30-min auto-refresh window so a brief
    // Mac hiccup doesn't immediately tip into cloud-side firing.
    if (request.method === "POST" && url.pathname === "/internal/mac-recent-scan") {
      await env.CRON_KV.put("mac-recent-scan", new Date().toISOString(), {
        expirationTtl: 90 * 60,
      });
      return Response.json({ ok: true });
    }

    // Cloud-fetched newsletters — Mac polls on wake, inserts each payload
    // into research_articles (INSERT OR IGNORE on gmail_message_id), applies
    // the D3 portfolio-relevance gate against local research_sources.allow_off_topic,
    // then DELETEs per gmail_message_id. Sibling shape to /internal/cloud-fired-levels.
    if (request.method === "GET" && url.pathname === "/internal/cloud-fetched-newsletters") {
      const list = await env.CRON_KV.list({ prefix: "cloud-fetched-newsletter-" });
      const payloads: Record<string, unknown> = {};
      await Promise.all(
        list.keys.map(async (k) => {
          const value = await env.CRON_KV.get(k.name);
          if (value) {
            const m = /^cloud-fetched-newsletter-(.+)$/.exec(k.name);
            if (m) {
              try {
                payloads[m[1]] = JSON.parse(value);
              } catch {
                // skip malformed entries
              }
            }
          }
        }),
      );
      return Response.json({ payloads });
    }

    if (request.method === "DELETE" && url.pathname === "/internal/cloud-fetched-newsletters") {
      const messageId = url.searchParams.get("messageId");
      if (!messageId || messageId.length === 0) {
        return Response.json({ error: "messageId is required" }, { status: 400 });
      }
      await env.CRON_KV.delete(`cloud-fetched-newsletter-${messageId}`);
      return Response.json({ ok: true });
    }

    // Mac POSTs this after its fetchNewArticles completes (success or no-op,
    // not on failure — Worker's next tick should still fire if Mac is dying).
    // 60-min TTL keeps Worker idle while Mac is alive but lets Worker take
    // over if Mac misses one full cycle.
    if (request.method === "POST" && url.pathname === "/internal/mac-recent-newsletter-sync") {
      await env.CRON_KV.put("mac-recent-newsletter-sync", new Date().toISOString(), {
        expirationTtl: 60 * 60,
      });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/internal/trigger") {
      const typeParam = url.searchParams.get("type");
      if (typeParam === "level-scan") {
        const dryRun = url.searchParams.get("dryRun") === "true";
        const result = await runLevelScan(env, { dryRun });
        return Response.json(result);
      }
      if (typeParam === "newsletter-fetch") {
        const result = await runNewsletterFetch(env);
        return Response.json(result);
      }
      if (typeParam === "calendar-enrich") {
        const fallbackOnly = url.searchParams.get("fallbackOnly") === "true";
        if (fallbackOnly) {
          const result = await runCloudFallback(env);
          return Response.json({ fallback: result });
        }
        const result = await runCalendarEnrich(env);
        return Response.json(result);
      }
      if (typeParam === "earnings-fallback") {
        const dryRun = url.searchParams.get("dryRun") === "true";
        const result = await runEarningsFallback(env, { dryRun });
        return Response.json(result);
      }
      if (typeParam !== "briefing" && typeParam !== "digest" && typeParam !== "evening") {
        return Response.json(
          { error: "type must be briefing, digest, evening, calendar-enrich, or earnings-fallback" },
          { status: 400 },
        );
      }
      const dryRun = url.searchParams.get("dryRun") === "true";
      const fallbackOnly = url.searchParams.get("fallbackOnly") === "true";
      // Manual triggers bypass the holiday/briefing-day gate by default (smoke
      // tests + hand-triggers should run regardless of the calendar). Pass
      // force=false to exercise the gate itself.
      const force = url.searchParams.get("force") !== "false";
      const result = await runJob(typeParam, env, { dryRun, fallbackOnly, force });
      return Response.json(result);
    }

    // Earnings markers — Mac side polls before firing /api/cron/earnings-*
    // (skip if cloud already sent) and POSTs running marker at entry/clear
    // at exit. Same shape as the briefing/digest endpoints but keyed on
    // (phase, eventId).
    if (request.method === "GET" && url.pathname === "/internal/earnings-marker") {
      const phase = url.searchParams.get("phase");
      const eventIdStr = url.searchParams.get("eventId");
      if (phase !== "preview" && phase !== "recap") {
        return Response.json({ error: "phase must be preview or recap" }, { status: 400 });
      }
      const eventId = parseInt(eventIdStr ?? "", 10);
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return Response.json({ error: "eventId must be a positive integer" }, { status: 400 });
      }
      const status = await getEarningsMarkerStatus(env.CRON_KV, phase as EarningsPhase, eventId);
      return Response.json(status);
    }

    if (request.method === "POST" && url.pathname === "/internal/earnings-running-marker") {
      const phase = url.searchParams.get("phase");
      const eventIdStr = url.searchParams.get("eventId");
      const action = url.searchParams.get("action");
      if (phase !== "preview" && phase !== "recap") {
        return Response.json({ error: "phase must be preview or recap" }, { status: 400 });
      }
      const eventId = parseInt(eventIdStr ?? "", 10);
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return Response.json({ error: "eventId must be a positive integer" }, { status: 400 });
      }
      if (action !== "set" && action !== "clear") {
        return Response.json({ error: "action must be set or clear" }, { status: 400 });
      }
      if (action === "set") {
        await setEarningsRunningMarker(env.CRON_KV, phase as EarningsPhase, eventId);
      } else {
        await clearEarningsRunningMarker(env.CRON_KV, phase as EarningsPhase, eventId);
      }
      return Response.json({ ok: true, phase, eventId, action });
    }

    // Mac POSTs this when its earnings route fires successfully so the
    // Worker fallback knows to skip on the next sweep tick.
    if (request.method === "POST" && url.pathname === "/internal/earnings-sent-marker") {
      const phase = url.searchParams.get("phase");
      const eventIdStr = url.searchParams.get("eventId");
      if (phase !== "preview" && phase !== "recap") {
        return Response.json({ error: "phase must be preview or recap" }, { status: 400 });
      }
      const eventId = parseInt(eventIdStr ?? "", 10);
      if (!Number.isInteger(eventId) || eventId <= 0) {
        return Response.json({ error: "eventId must be a positive integer" }, { status: 400 });
      }
      await writeEarningsMarker(env.CRON_KV, "mac", phase as EarningsPhase, eventId);
      return Response.json({ ok: true, phase, eventId });
    }

    // Phase 9b — Mac reconcile endpoints. Mac polls to read cloud-enriched
    // payloads, then calls DELETE per eventId after it has committed to DB.
    if (request.method === "GET" && url.pathname === "/internal/cloud-enriched") {
      const list = await env.CRON_KV.list({ prefix: "cloud-enriched-" });
      const payloads: Record<string, unknown> = {};
      await Promise.all(list.keys.map(async (k) => {
        const value = await env.CRON_KV.get(k.name);
        if (value) {
          const m = /^cloud-enriched-(\d+)$/.exec(k.name);
          if (m) {
            try {
              payloads[m[1]] = JSON.parse(value);
            } catch {
              // skip malformed entries
            }
          }
        }
      }));
      return Response.json({ payloads });
    }

    if (request.method === "DELETE" && url.pathname === "/internal/cloud-enriched") {
      const eventIdStr = url.searchParams.get("eventId");
      if (!eventIdStr || !/^\d+$/.test(eventIdStr)) {
        return Response.json({ error: "eventId (numeric) is required" }, { status: 400 });
      }
      await env.CRON_KV.delete(`cloud-enriched-${eventIdStr}`);
      return Response.json({ ok: true });
    }

    // Tier 3 live smoke test — mint LST headlessly + read live IBKR positions
    // from the Worker runtime (proves the WebCrypto OAuth path). X-Cron-Secret
    // gated. Read-only.
    if (request.method === "POST" && url.pathname === "/internal/ibkr-test") {
      const cfg = ibkrConfigFromEnv(env as unknown as Record<string, string | undefined>);
      if (!cfg) return Response.json({ error: "IBKR secrets not configured" }, { status: 400 });
      try {
        // Exercise the EXACT path the composers use (fetch + map), not just the
        // raw read — so this smoke test verifies the real Tier 3 delivery code,
        // including OCC option parsing against live broker rows.
        const positions = await fetchLiveIbkrPositions(cfg);
        const sample = positions.slice(0, 6).map((p) => ({
          symbol: p.symbol,
          type: p.securityType,
          underlying: p.underlyingSymbol,
          qty: p.quantity,
          costBasis: p.costBasis,
        }));
        return Response.json({
          ok: true,
          positionCount: positions.length,
          contextSymbols: liveSymbolsForContext(positions),
          sample,
        });
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error)?.message ?? String(err) }, { status: 502 });
      }
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        worker: "vanguard-skin-cron",
        nowET: { hour: getCurrentETHour(), dow: getCurrentETDayOfWeek(), date: todayET() },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

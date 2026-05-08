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

export interface Env {
  // Bindings
  CRON_KV: KVNamespace;
  ARCHIVE: R2Bucket;
  // Vars (wrangler.toml [vars])
  EXPECTED_HOUR_BRIEFING: string;
  EXPECTED_HOUR_DIGEST: string;
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
}

export function parseJobFromClock(env: Env): { type: JobType; expectedHour: number } | null {
  const hour = getCurrentETHour();
  const minute = getCurrentETMinute();
  const dow = getCurrentETDayOfWeek();
  const briefingHour = parseInt(env.EXPECTED_HOUR_BRIEFING, 10);
  const digestHour = parseInt(env.EXPECTED_HOUR_DIGEST, 10);
  const eveningMonThuHour = parseInt(env.EXPECTED_HOUR_EVENING_MON_THU, 10);
  const eveningFriHour = parseInt(env.EXPECTED_HOUR_EVENING_FRI, 10);
  const eveningFriMinute = parseInt(env.EXPECTED_MINUTE_EVENING_FRI, 10);

  if (hour === briefingHour && dow === 0) {
    return { type: "briefing", expectedHour: briefingHour };
  }
  if (hour === digestHour && dow >= 1 && dow <= 5) {
    return { type: "digest", expectedHour: digestHour };
  }
  // Evening — Mon-Thu 19:00 ET, Fri 17:30 ET.
  // Winter day-shift note: Mon-Thu 7pm EST = 00:00 UTC NEXT day (Tue-Fri UTC).
  // parseJobFromClock reads ET wall-clock via Intl, so the cron firing at
  // 00:00 UTC on (say) Tuesday still maps to ET Monday 19:00 — caught here.
  if (hour === eveningMonThuHour && dow >= 1 && dow <= 4) {
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
}

interface RunJobResult {
  skipped?: "already_sent" | "already_sent_by_cloud" | "mac_still_running";
  primary?: PrimaryResult;
  fallback?: FallbackResult;
  sentBy?: SentBy;
}

async function runJob(type: JobType, env: Env, opts: RunJobOpts = {}): Promise<RunJobResult> {
  const date = todayET();
  const markers = await readMarkers(env.CRON_KV, type, date);

  if (markers.mac && !opts.dryRun) return { skipped: "already_sent" };
  if (markers.cloud && !opts.dryRun) return { skipped: "already_sent_by_cloud" };

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
      if (reMarkers.macRunning) {
        return { primary, skipped: "mac_still_running" };
      }
    }
  }

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
    if (!opts.dryRun) await writeMarker(env.CRON_KV, "cloud", type, date);
    return { primary, fallback, sentBy: "cloud" };
  }

  return { primary, fallback };
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Calendar-enrich trigger (every 15 min) is dispatched separately — it
    // fires far more often than the briefing/digest triggers, so we check
    // its window first and only fall through to the hourly-job dispatcher
    // when calendar-enrich doesn't claim the tick.
    if (shouldRunCalendarEnrich()) {
      ctx.waitUntil(
        (async () => {
          console.log(`[cron ${event.cron}] running calendar-enrich at ${todayET()}`);
          const result = await runCalendarEnrich(env);
          console.log(`[cron calendar-enrich] result:`, JSON.stringify(result));
        })()
      );
      // Continue below — the briefing/digest hour check is independent.
    }

    // Earnings cloud-fallback sweep — runs alongside calendar-enrich on the
    // same 15-min cadence. Mac is primary; this only fires when Mac hasn't
    // touched a candidate (no audit row in snapshot, no mac-sent marker, no
    // mac-running marker, no cloud-sent marker). Self-gates via
    // shouldRunEarningsFallback (Mon-Fri 05:00-20:00 ET) — wider than the
    // calendar-enrich gate to cover BMO previews at 06:00 AND the 18:15+
    // AMC recap window which the calendar-enrich 18:00 cutoff would miss.
    if (shouldRunEarningsFallback()) {
      ctx.waitUntil(
        (async () => {
          console.log(`[cron ${event.cron}] running earnings-fallback at ${todayET()}`);
          const result = await runEarningsFallback(env);
          if (result.swept > 0) {
            console.log(`[cron earnings-fallback] result:`, JSON.stringify(result));
          }
        })()
      );
    }

    const job = parseJobFromClock(env);
    if (!job) {
      if (!shouldRunCalendarEnrich()) {
        console.log(
          `[cron ${event.cron}] wrong-hour slot — ET ${getCurrentETHour()}:00, dow=${getCurrentETDayOfWeek()} — skipping.`
        );
      }
      return;
    }

    ctx.waitUntil(
      (async () => {
        console.log(`[cron ${event.cron}] running ${job.type} at ET ${job.expectedHour}:00 (${todayET()})`);
        const result = await runJob(job.type, env);
        console.log(`[cron] result:`, JSON.stringify(result));
      })()
    );
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

    if (request.method === "POST" && url.pathname === "/internal/trigger") {
      const typeParam = url.searchParams.get("type");
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
      const result = await runJob(typeParam, env, { dryRun, fallbackOnly });
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

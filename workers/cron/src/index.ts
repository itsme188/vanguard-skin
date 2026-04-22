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
 *   GET  /internal/marker?type={briefing|digest}   (X-Cron-Secret required)
 *   POST /internal/trigger?type={briefing|digest}  (X-Cron-Secret required)
 */

import {
  readMarkers,
  writeMarker,
  getMarkerStatus,
  type JobType,
  type SentBy,
} from "./dedup";
import {
  getCurrentETHour,
  getCurrentETDayOfWeek,
  todayET,
} from "./dst";
import { callPrimary, type PrimaryResult } from "./primary";
import { runFallbackDigest, type FallbackResult } from "./fallback-digest";
import { runFallbackBriefing } from "./fallback-briefing";

export interface Env {
  // Bindings
  CRON_KV: KVNamespace;
  ARCHIVE: R2Bucket;
  // Vars (wrangler.toml [vars])
  EXPECTED_HOUR_BRIEFING: string;
  EXPECTED_HOUR_DIGEST: string;
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
  FROM_EMAIL?: string;
}

function parseJobFromClock(env: Env): { type: JobType; expectedHour: number } | null {
  const hour = getCurrentETHour();
  const dow = getCurrentETDayOfWeek();
  const briefingHour = parseInt(env.EXPECTED_HOUR_BRIEFING, 10);
  const digestHour = parseInt(env.EXPECTED_HOUR_DIGEST, 10);

  if (hour === briefingHour && dow === 0) {
    return { type: "briefing", expectedHour: briefingHour };
  }
  if (hour === digestHour && dow >= 1 && dow <= 5) {
    return { type: "digest", expectedHour: digestHour };
  }
  return null;
}

interface RunJobOpts {
  dryRun?: boolean;
  fallbackOnly?: boolean; // skip primary, go straight to fallback (smoke test)
}

interface RunJobResult {
  skipped?: "already_sent" | "already_sent_by_cloud";
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
      timeoutMs: parseInt(env.PRIMARY_TIMEOUT_MS, 10) || 120000,
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
  }

  // Primary failed (timeout / network / 5xx) or was skipped — run fallback.
  let fallback: FallbackResult;
  try {
    fallback = type === "briefing"
      ? await runFallbackBriefing(env, { dryRun: opts.dryRun })
      : await runFallbackDigest(env, { dryRun: opts.dryRun });
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
    const job = parseJobFromClock(env);
    if (!job) {
      console.log(
        `[cron ${event.cron}] wrong-hour slot — ET ${getCurrentETHour()}:00, dow=${getCurrentETDayOfWeek()} — skipping.`
      );
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
      if (typeParam !== "briefing" && typeParam !== "digest") {
        return Response.json({ error: "type must be briefing or digest" }, { status: 400 });
      }
      const status = await getMarkerStatus(env.CRON_KV, typeParam);
      return Response.json(status);
    }

    if (request.method === "POST" && url.pathname === "/internal/trigger") {
      const typeParam = url.searchParams.get("type");
      if (typeParam !== "briefing" && typeParam !== "digest") {
        return Response.json({ error: "type must be briefing or digest" }, { status: 400 });
      }
      const dryRun = url.searchParams.get("dryRun") === "true";
      const fallbackOnly = url.searchParams.get("fallbackOnly") === "true";
      const result = await runJob(typeParam, env, { dryRun, fallbackOnly });
      return Response.json(result);
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

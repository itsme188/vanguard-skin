/**
 * Shared X-Cron-Secret auth wrapper for /api/cron/* route handlers.
 *
 * Extracted so the earnings preview/recap routes (Phase 3) don't duplicate
 * the boilerplate already repeated across /api/cron/{briefing,digest}.
 * Worker-fallback bookends (cloud-marker pre-check + mac-running set/clear)
 * are NOT in this wrapper — earnings doesn't have a Worker fallback path
 * yet (deferred to Phase 4), and the existing briefing/digest routes have
 * the bookend inlined for now. When Phase 4 lands, this file is the right
 * place to add the bookend as a higher-order option.
 */

import { timingSafeEqual } from "node:crypto";

export interface CronAuthError {
  status: number;
  message: string;
}

/**
 * Verify the request bears a valid X-Cron-Secret header, then dispatch fn()
 * and JSON-encode its return. fn() may throw `{ status, message }` to map
 * to a custom HTTP status; everything else becomes 500.
 */
export async function withCronAuth<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<Response> {
  const expected = process.env.CRON_SHARED_SECRET;
  if (!expected) {
    return Response.json(
      { error: "Server not configured: CRON_SHARED_SECRET missing." },
      { status: 500 },
    );
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!constantTimeEqual(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await fn();
    return Response.json(result);
  } catch (err) {
    if (isCronAuthError(err)) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[cron]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

function isCronAuthError(err: unknown): err is CronAuthError {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  return typeof e.status === "number" && typeof e.message === "string";
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

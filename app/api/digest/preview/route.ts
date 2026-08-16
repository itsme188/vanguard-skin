import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateDigestSince,
  generateDigestSinceAdaptive,
  getLastDigestSentAt,
} from "@/lib/digest/daily-digest";
import { generateDigestByCompanySince } from "@/lib/digest/group-by-company";
import { briefingToHtml } from "@/lib/calendar/briefing-html";

const TITLE = "Daily Research Digest";

function resolveSince(request: NextRequest): string {
  const sinceParam = new URL(request.url).searchParams.get("since");
  if (sinceParam) return sinceParam;
  const lastSent = getLastDigestSentAt(db);
  return (
    lastSent ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
}

/**
 * GET /api/digest/preview?since=YYYY-MM-DD
 *
 * SIDE-EFFECT-FREE read (#35 task 5). Returns the two DETERMINISTIC renderings
 * (by-publication + by-company) — pure DB reads, no AI, no writes. It does NOT
 * run the adaptive synthesis (`generateDigestSinceAdaptive`), which fires a
 * paid Sonnet call and, on a synthesis fallback, writes a telemetry ring buffer
 * (recordSynthesisFallback → settings). Under SameSite=Lax a bare GET has no
 * CSRF protection, so a cross-site navigation must not be able to burn AI
 * budget: the structured layout is produced ONLY via POST. structuredHtml is
 * null here; the client POSTs to fill it.
 */
export async function GET(request: NextRequest) {
  const since = resolveSince(request);

  const bySourceMd = generateDigestSince(db, since);
  const byCompanyMd = generateDigestByCompanySince(db, since);

  if (!bySourceMd && !byCompanyMd) {
    return NextResponse.json({
      success: true,
      since,
      empty: true,
      structuredHtml: null,
      bySourceHtml: null,
      byCompanyHtml: null,
    });
  }

  return NextResponse.json({
    success: true,
    since,
    empty: false,
    structuredHtml: null,
    bySourceHtml: bySourceMd ? briefingToHtml(bySourceMd, TITLE) : null,
    byCompanyHtml: byCompanyMd ? briefingToHtml(byCompanyMd, TITLE) : null,
  });
}

/**
 * POST /api/digest/preview?since=YYYY-MM-DD
 *
 * Produces all three renderings, including the STRUCTURED layout — exactly what
 * the next real email will send (morning flavor, no anomalies). This is the
 * paid-AI path: generateDigestSinceAdaptive fires one Sonnet synthesis when ≥5
 * commentary articles are in the window, and is the write path (telemetry) that
 * GET used to carry. User-triggered, acceptable cost.
 */
export async function POST(request: NextRequest) {
  const since = resolveSince(request);

  const structuredMd = await generateDigestSinceAdaptive(db, since, {
    includeAnomalies: false,
    edition: "morning",
  });
  const bySourceMd = generateDigestSince(db, since);
  const byCompanyMd = generateDigestByCompanySince(db, since);

  if (!structuredMd && !bySourceMd && !byCompanyMd) {
    return NextResponse.json({
      success: true,
      since,
      empty: true,
      structuredHtml: null,
      bySourceHtml: null,
      byCompanyHtml: null,
    });
  }

  return NextResponse.json({
    success: true,
    since,
    empty: false,
    structuredHtml: structuredMd ? briefingToHtml(structuredMd, TITLE) : null,
    bySourceHtml: bySourceMd ? briefingToHtml(bySourceMd, TITLE) : null,
    byCompanyHtml: byCompanyMd ? briefingToHtml(byCompanyMd, TITLE) : null,
  });
}

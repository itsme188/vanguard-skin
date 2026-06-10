import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateDigestSince,
  generateDigestSinceAdaptive,
  getLastDigestSentAt,
} from "@/lib/digest/daily-digest";
import { generateDigestByCompanySince } from "@/lib/digest/group-by-company";
import { briefingToHtml } from "@/lib/calendar/briefing-html";

/**
 * Returns the morning digest content rendered two ways: by-source (the
 * existing layout, what the email actually sends) and by-company (the
 * grouped view). Used by <DigestEmailViewer> for client-side toggling
 * without requiring a re-fetch.
 *
 * Defaults to the last-24h window — same as the cron path. Pass ?since=
 * to override (YYYY-MM-DD or ISO).
 *
 * GET /api/digest/preview?since=2026-05-01
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");

  let since: string;
  if (sinceParam) {
    since = sinceParam;
  } else {
    const lastSent = getLastDigestSentAt(db);
    since = lastSent ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // Structured layout = exactly what the next real email will send (morning
  // flavor, no anomalies). NOTE: fires one Sonnet synthesis call when ≥5
  // commentary articles are in the window — user-triggered, acceptable cost.
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

  const title = "Daily Research Digest";
  return NextResponse.json({
    success: true,
    since,
    empty: false,
    structuredHtml: structuredMd ? briefingToHtml(structuredMd, title) : null,
    bySourceHtml: bySourceMd ? briefingToHtml(bySourceMd, title) : null,
    byCompanyHtml: byCompanyMd ? briefingToHtml(byCompanyMd, title) : null,
  });
}

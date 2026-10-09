import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPrintRecord } from "@/lib/earnings/print-record";

export const dynamic = "force-dynamic";

/**
 * GET /api/print-watch/record?eventId=<id>: one event's print, its sheet
 * lines and its output-button evaluation, whatever state the print is in.
 *
 * The status route stops listing a finished print once its event date is no
 * longer today, on purpose. This is the scoped read an armed Hub row uses to
 * show a read-only record of such a print. Detail: lib/earnings/print-record.ts.
 *
 * A PURE read (store SELECTs only), so the GET guard in
 * tests/api/no-state-changing-get.test.ts stays satisfied.
 *
 * A HUMAN route by the proxy's default classification, like the sibling
 * print-watch reads: it has no `lib/auth/route-policy.ts` entry because
 * `classifyRoute()` returns "human" for anything not carved out.
 *
 * An event with no print answers 200 with `print: null`: "nothing was
 * captured" is an ordinary answer, not a missing resource.
 */
export async function GET(request: NextRequest) {
  try {
    const raw = new URL(request.url).searchParams.get("eventId");
    if (raw === null || !/^[1-9]\d*$/.test(raw.trim())) {
      return NextResponse.json(
        { success: false, error: "Query param 'eventId' must be a positive whole number." },
        { status: 400 },
      );
    }
    const eventId = Number(raw.trim());
    if (!Number.isSafeInteger(eventId)) {
      return NextResponse.json(
        { success: false, error: "Query param 'eventId' must be a positive whole number." },
        { status: 400 },
      );
    }
    return NextResponse.json({ success: true, data: getPrintRecord(db, eventId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

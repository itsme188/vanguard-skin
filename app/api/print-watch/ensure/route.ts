import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensurePrintWatch, getWatchStatus } from "@/lib/print-watch/watcher";
import { armReconcileTimer } from "@/lib/print-watch/read-scheduler";

/**
 * POST /api/print-watch/ensure — the ONLY route allowed to start or advance
 * watcher work (Codex #9; see the GET /status handler's doc comment for
 * why that split matters). Empty body.
 *
 * `ensurePrintWatch` is synchronous and idempotent (watcher.ts's own doc
 * comment) — safe to call as often as the panel likes; it reconciles armed
 * events against prints, updates states, and makes sure exactly the
 * in-window prints have a live poll loop, then returns immediately (the
 * loops themselves run detached).
 *
 * This is also where slice D's durable first-pass reconcile timer is armed
 * (#16). `bootstrapEarningsRegistries()` takes no `db`, and the panel calls
 * this route on every load, so it is the natural place: `armReconcileTimer`
 * is idempotent, unref'd, and inert while the scheduler is disabled.
 */
export async function POST() {
  try {
    ensurePrintWatch(db);
    armReconcileTimer(db);
    return NextResponse.json({ success: true, data: { prints: getWatchStatus(db).length } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

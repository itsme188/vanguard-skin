import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getPrintById } from "@/lib/print-watch/store";
import { evaluatePrintOutputs } from "@/lib/earnings/print-outputs";
import { printPostPrintSheetNow } from "@/lib/earnings/post-print-sheet";

export const dynamic = "force-dynamic";

/**
 * POST /api/print-watch/print-sheet { printId } — put the whole print on paper
 * (live print v2 slice E, spec §4.5).
 *
 * The 409 body is `outputs.printSheet.reason` VERBATIM, so the sentence the
 * button's tooltip shows and the sentence the refusal returns are the same
 * string from the same function — they can never drift.
 *
 * A successful monospace downgrade is a 200, not an error: paper came out, and
 * `road` says which kind, because a "printed" toast that hid the downgrade
 * would be the app lying about what is in the tray. Only a failure of BOTH
 * roads is a 500.
 *
 * `human` by the proxy's default classification (session + double-submit CSRF +
 * trusted Origin on unsafe methods) — no lib/auth/route-policy.ts entry.
 */
export async function POST(request: NextRequest) {
  try {
    // Every malformed shape is a 400, never a 500: unparseable bytes, a literal
    // `null` (which `typeof` calls an object), an array, a bare primitive, or a
    // missing/non-integer printId. 500 stays reserved for a genuinely
    // unexpected exception — same rule as the sibling send-recap route.
    const body = (await request.json().catch(() => ({}))) as { printId?: unknown } | null;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ success: false, error: "Body must be a JSON object." }, { status: 400 });
    }
    // Integer-ness only: a negative or absurd id is well-formed and lands on
    // 404 (no such print), not 400.
    if (typeof body.printId !== "number" || !Number.isInteger(body.printId)) {
      return NextResponse.json(
        { success: false, error: "Body field 'printId' must be an integer." },
        { status: 400 },
      );
    }
    if (!getPrintById(db, body.printId)) {
      return NextResponse.json({ success: false, error: `No print ${body.printId}.` }, { status: 404 });
    }
    // The same read the status route's `outputs` field is built from, so the
    // dark button and the refused press agree by construction.
    const outputs = evaluatePrintOutputs(db, body.printId);
    if (!outputs.printSheet.enabled) {
      return NextResponse.json({ success: false, error: outputs.printSheet.reason }, { status: 409 });
    }
    const result = await printPostPrintSheetNow(db, body.printId);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

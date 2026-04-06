import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  listCorporateActions,
  addCorporateAction,
  undoCorporateAction,
} from "@/lib/compute/corporate-actions";

/**
 * GET /api/corporate-actions?securityId=N — list actions (optionally per security)
 */
export async function GET(request: NextRequest) {
  try {
    const securityIdParam = request.nextUrl.searchParams.get("securityId");
    const securityId = securityIdParam ? parseInt(securityIdParam, 10) : undefined;

    const actions = listCorporateActions(db, securityId);
    return NextResponse.json({ success: true, actions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * POST /api/corporate-actions — add a corporate action
 * Body: { securityId, actionType, effectiveDate, ratioNumerator, ratioDenominator?, notes? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { securityId, actionType, effectiveDate, ratioNumerator, ratioDenominator, notes } = body;

    if (!securityId || !actionType || !effectiveDate || !ratioNumerator) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: securityId, actionType, effectiveDate, ratioNumerator" },
        { status: 400 },
      );
    }

    if (!["SPLIT", "REVERSE_SPLIT"].includes(actionType)) {
      return NextResponse.json(
        { success: false, error: "actionType must be SPLIT or REVERSE_SPLIT" },
        { status: 400 },
      );
    }

    const action = addCorporateAction(db, {
      securityId,
      actionType,
      effectiveDate,
      ratioNumerator,
      ratioDenominator,
      notes,
    });

    return NextResponse.json({ success: true, action });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/corporate-actions?id=N — undo and remove a corporate action
 */
export async function DELETE(request: NextRequest) {
  try {
    const idParam = request.nextUrl.searchParams.get("id");
    if (!idParam) {
      return NextResponse.json(
        { success: false, error: "Missing id parameter" },
        { status: 400 },
      );
    }

    const id = parseInt(idParam, 10);
    undoCorporateAction(db, id);

    return NextResponse.json({ success: true, message: `Corporate action ${id} undone` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

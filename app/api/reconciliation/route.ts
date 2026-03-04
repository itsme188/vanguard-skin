import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  addReconciliationCheckpoint,
  deleteReconciliationCheckpoint,
} from "@/lib/queries/reconciliation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId, checkpointDate, statementValue, notes } = body;

    if (!accountId || !checkpointDate || statementValue === undefined) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: accountId, checkpointDate, statementValue" },
        { status: 400 }
      );
    }

    const checkpoint = addReconciliationCheckpoint(
      db,
      accountId,
      checkpointDate,
      statementValue,
      notes
    );

    return NextResponse.json({ success: true, data: checkpoint });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing id parameter" },
        { status: 400 }
      );
    }

    deleteReconciliationCheckpoint(db, parseInt(id, 10));
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

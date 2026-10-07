import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  addReconciliationCheckpoint,
  deleteReconciliationCheckpoint,
} from "@/lib/queries/reconciliation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId, checkpointDate, statementValue, notes, replaceCheckpointId } = body;

    if (!accountId || !checkpointDate || statementValue === undefined) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: accountId, checkpointDate, statementValue" },
        { status: 400 }
      );
    }

    // Replacing a saved checkpoint needs the id of the row the user was shown;
    // a loose flag (true, "1") is never a replace instruction.
    const hasReplaceId = replaceCheckpointId !== undefined && replaceCheckpointId !== null;
    if (hasReplaceId && !(Number.isInteger(replaceCheckpointId) && replaceCheckpointId > 0)) {
      return NextResponse.json(
        { success: false, error: "replaceCheckpointId must be the id of the checkpoint to replace" },
        { status: 400 }
      );
    }

    const result = addReconciliationCheckpoint(
      db,
      accountId,
      checkpointDate,
      statementValue,
      notes,
      hasReplaceId ? { replaceCheckpointId } : {}
    );

    if (result.status === "exists") {
      const { existing } = result;
      return NextResponse.json(
        {
          success: false,
          code: "checkpoint_exists",
          error: `A checkpoint is already saved for ${existing.account_name} on ${existing.checkpoint_date}. Nothing was changed. Pick another date, or choose to replace the saved one.`,
          existing,
        },
        { status: 409 }
      );
    }

    return NextResponse.json({
      success: true,
      data: result.checkpoint,
      replaced: result.status === "replaced",
    });
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

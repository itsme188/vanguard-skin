import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getDataConfidence } from "@/lib/queries/data-confidence";

export async function GET() {
  try {
    const confidence = getDataConfidence(db);
    return NextResponse.json({ success: true, data: confidence });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

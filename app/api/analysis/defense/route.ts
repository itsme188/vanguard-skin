import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveScope } from "@/lib/queries/accounts";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const scope = req.nextUrl.searchParams.get("scope");
    const accountIds = resolveScope(db, scope);
    return NextResponse.json({ success: true, data: computeDefenseAnalysis(db, accountIds) });
  } catch (err) {
    console.error("[api/analysis/defense]", err);
    const message = err instanceof Error ? err.message : "Failed to compute defense analysis";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

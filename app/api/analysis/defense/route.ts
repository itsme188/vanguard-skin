import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveScope } from "@/lib/queries/accounts";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const scope = req.nextUrl.searchParams.get("scope");
    const accountIds = resolveScope(db, scope);
    return NextResponse.json(computeDefenseAnalysis(db, accountIds));
  } catch (err) {
    console.error("[api/analysis/defense]", err);
    return NextResponse.json({ error: "Failed to compute defense analysis" }, { status: 500 });
  }
}

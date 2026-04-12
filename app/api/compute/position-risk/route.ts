import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computePositionRisk } from "@/lib/compute/risk";
import { resolveScopeToSingleId } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    const accountId = accountIdParam ? Number(accountIdParam) : resolveScopeToSingleId(db, scope);
    const topNParam = searchParams.get("topN");
    const topN = topNParam ? Number(topNParam) : 10;

    const result = computePositionRisk(db, { accountId, topN });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

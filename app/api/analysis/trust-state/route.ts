import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";
import { resolveScope } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope");
    const accountIds = resolveScope(db, scope);
    const state = getAnalysisTrustState(db, accountIds);
    return NextResponse.json({ success: true, data: state });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

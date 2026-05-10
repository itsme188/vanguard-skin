import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { suggestAllocation } from "@/lib/compute/cash-deploy";
import { resolveScope } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope") ?? "all";
    const cashParam = searchParams.get("cash");
    const cashAmount = cashParam ? Number(cashParam) : 0;
    if (!Number.isFinite(cashAmount) || cashAmount < 0) {
      return NextResponse.json(
        { success: false, error: "cash must be a non-negative number" },
        { status: 400 }
      );
    }
    const accountIds = resolveScope(db, scope);
    const result = suggestAllocation(db, scope, accountIds, cashAmount);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

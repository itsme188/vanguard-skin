import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { resolveScope } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    // resolveScope, never a first-id collapse: a scope is a SET of accounts.
    const accountIds = accountIdParam ? [Number(accountIdParam)] : resolveScope(db, scope);

    const result = computePortfolioGreeks(db, { accountIds });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

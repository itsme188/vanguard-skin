import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const accountId = accountIdParam ? Number(accountIdParam) : undefined;

    const result = computePortfolioGreeks(db, { accountId });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

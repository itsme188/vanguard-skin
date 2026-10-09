import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeXirr } from "@/lib/compute/xirr";
import { resolveScope } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get("startDate") ?? undefined;
    const endDate = searchParams.get("endDate") ?? undefined;
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    // An explicit accountId is one account. A named scope is its WHOLE id
    // list (one money-weighted return over every account in it), never the
    // first account alone. "all" or no scope resolves to undefined: every
    // account.
    const result = accountIdParam
      ? computeXirr(db, { startDate, endDate, accountId: Number(accountIdParam) })
      : computeXirr(db, { startDate, endDate, accountIds: resolveScope(db, scope) });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { reconcileCostBasis } from "@/lib/compute/cost-basis-reconciliation";
import { resolveScope } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    // reconcileCostBasis takes ONE account (or none = every account). A scope
    // that resolves to several accounts must not silently shrink to the first.
    let accountId: number | undefined;
    if (accountIdParam) {
      accountId = Number(accountIdParam);
    } else {
      const ids = resolveScope(db, scope);
      if (ids && ids.length > 1) {
        return NextResponse.json(
          {
            success: false,
            error:
              "Cost-basis reconciliation checks one account at a time. Pick a single account instead of a multi-account scope.",
          },
          { status: 400 }
        );
      }
      accountId = ids?.[0];
    }

    const result = reconcileCostBasis(db, { accountId });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

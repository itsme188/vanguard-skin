import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getExpiringOptions } from "@/lib/compute/options-expirations";
import { resolveScope } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope");
    const daysParam = searchParams.get("days");
    // Use resolveScope (array) not resolveScopeToSingleId — Expirations
    // shows options across all accounts in a scope; the multi-account
    // case must work for "all" scope to surface anything.
    const accountIds = resolveScope(db, scope);
    const parsedDays = daysParam ? Number(daysParam) : 90;
    const daysWindow = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 90;

    const expirations = getExpiringOptions(db, { accountIds, daysWindow });

    return NextResponse.json({ success: true, data: expirations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

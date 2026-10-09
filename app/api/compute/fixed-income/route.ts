import { db } from "@/lib/db";
import { resolveScope } from "@/lib/queries/accounts";
import { todayET } from "@/lib/calendar/date-utils";
import { computeFixedIncomeExposure } from "@/lib/compute/fixed-income-exposure";

/**
 * Thin wrapper: the logic lives in lib/compute/fixed-income-exposure.ts.
 * "Today" is the Eastern calendar date, read once, so the maturity filter
 * and every duration are judged on the same day.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const scope = searchParams.get("scope");
    const accountIds = resolveScope(db, scope);
    const data = computeFixedIncomeExposure(db, accountIds, todayET());
    return Response.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

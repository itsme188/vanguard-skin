import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeAllScenarios, computeScenario, PRESET_SCENARIOS } from "@/lib/compute/scenarios";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const accountId = accountIdParam ? Number(accountIdParam) : undefined;
    const scenarioId = searchParams.get("scenario");

    if (scenarioId) {
      // Single scenario
      const scenario = PRESET_SCENARIOS.find((s) => s.id === scenarioId);
      if (!scenario) {
        return NextResponse.json(
          { success: false, error: `Unknown scenario: ${scenarioId}` },
          { status: 400 }
        );
      }
      const result = computeScenario(db, scenario, { accountId });
      return NextResponse.json({ success: true, data: result });
    }

    // All scenarios
    const results = computeAllScenarios(db, { accountId });
    return NextResponse.json({ success: true, data: results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

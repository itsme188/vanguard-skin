import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeAllScenarios, computeScenario, PRESET_SCENARIOS, type ScenarioDefinition, type ScenarioResult } from "@/lib/compute/scenarios";
import { matchScenariosToThemes, SCENARIO_RECIPES } from "@/lib/compute/scenario-recipes";
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { mondayOf } from "@/lib/calendar/date-utils";
import { resolveScopeToSingleId } from "@/lib/queries/accounts";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    const accountId = accountIdParam ? Number(accountIdParam) : resolveScopeToSingleId(db, scope);
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

    // All scenarios — decorate with "live now" reason from cached macro themes
    const results = computeAllScenarios(db, { accountId });
    const weekOf = mondayOf(new Date().toISOString().slice(0, 10));
    const cached = getCachedMacroThemes(db, scope ?? "all", weekOf);
    const activeThemes = cached ? (JSON.parse(cached.themesJson) as Array<{ name: string; factor_label: string; direction: string }>) : [];
    const decoratedRecipes = matchScenariosToThemes(SCENARIO_RECIPES, activeThemes);
    const liveNowMap = new Map(decoratedRecipes.map((r) => [r.id, r.liveNowReason]));
    const decoratedResults: ScenarioResult[] = results.map((r) => ({
      ...r,
      liveNowReason: liveNowMap.get(r.scenario.id),
    }));
    return NextResponse.json({ success: true, data: decoratedResults });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/compute/scenarios — Compute a custom what-if scenario.
 *
 * Body: {
 *   marketMove: number (-0.50 to 0.30),
 *   rateMove?: number (basis points),
 *   sectorMoves?: Record<string, number>,
 *   name?: string,
 *   accountId?: number
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { marketMove, rateMove, sectorMoves, name, accountId: bodyAccountId, scope } = body as {
      marketMove?: number;
      rateMove?: number;
      sectorMoves?: Record<string, number>;
      name?: string;
      accountId?: number;
      scope?: string;
    };
    // Match the GET path's scope resolution so a custom scenario is baselined
    // to the same account set as the preset cards it renders next to.
    const accountId = bodyAccountId ?? resolveScopeToSingleId(db, scope ?? null);

    if (marketMove == null || typeof marketMove !== "number") {
      return NextResponse.json(
        { success: false, error: "marketMove is required (number between -0.50 and 0.30)" },
        { status: 400 }
      );
    }

    if (marketMove < -0.50 || marketMove > 0.50) {
      return NextResponse.json(
        { success: false, error: "marketMove must be between -0.50 and 0.50" },
        { status: 400 }
      );
    }

    if (rateMove != null && (typeof rateMove !== "number" || !Number.isFinite(rateMove))) {
      return NextResponse.json(
        { success: false, error: "rateMove must be a finite number (basis points)" },
        { status: 400 }
      );
    }

    const hasSectorMoves = sectorMoves && Object.keys(sectorMoves).length > 0;

    const scenario: ScenarioDefinition = {
      id: "custom",
      name: name || "Custom Scenario",
      description: buildCustomDescription(marketMove, rateMove, sectorMoves),
      category: hasSectorMoves ? "sector" : rateMove ? "rate" : "custom",
      marketMove,
      rateMove,
      sectorMoves: hasSectorMoves ? sectorMoves : undefined,
    };

    const result = computeScenario(db, scenario, { accountId });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

function buildCustomDescription(
  marketMove: number,
  rateMove?: number,
  sectorMoves?: Record<string, number>
): string {
  const parts: string[] = [];
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

  parts.push(`Market ${pct(marketMove)}`);
  if (rateMove) parts.push(`rates ${rateMove > 0 ? "+" : ""}${rateMove}bp`);
  if (sectorMoves) {
    const overrides = Object.entries(sectorMoves)
      .slice(0, 3)
      .map(([s, m]) => `${s} ${pct(m)}`)
      .join(", ");
    parts.push(overrides);
  }
  return parts.join(" · ");
}

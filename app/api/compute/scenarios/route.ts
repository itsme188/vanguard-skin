import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeAllScenarios, computeScenario, PRESET_SCENARIOS, type ScenarioDefinition, type ScenarioResult } from "@/lib/compute/scenarios";
import { matchScenariosToThemes, SCENARIO_RECIPES } from "@/lib/compute/scenario-recipes";
import { getCachedMacroThemesForNow } from "@/lib/compute/theme-week";
import { resolveScope } from "@/lib/queries/accounts";
import { VOL_MOVE_MIN, VOL_MOVE_MAX } from "@/lib/compute/option-reprice";
import { SCENARIO_INPUT_BOUNDS, customScenarioBodyProblem } from "@/lib/compute/scenario-input-bounds";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const accountIdParam = searchParams.get("accountId");
    const scope = searchParams.get("scope");
    const accountIds = accountIdParam ? [Number(accountIdParam)] : resolveScope(db, scope);
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
      const result = computeScenario(db, scenario, { accountIds });
      return NextResponse.json({ success: true, data: result });
    }

    // All scenarios — decorate with "live now" reason from cached macro themes
    const results = computeAllScenarios(db, { accountIds });
    // The badge is scope-independent: always the 'all' themes, whatever scope
    // the exposure figures were computed for. The shared reader picks the week
    // (Eastern; on a weekend the upcoming week once generated). No cached
    // 'all' themes = no badge.
    const cached = getCachedMacroThemesForNow(db, "all");
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
 *   marketMove: number (-0.50 to 0.50, a decimal fraction),
 *   rateMove?: number (basis points, -1000 to 1000),
 *   volMove?: number (volatility points, -20 to 60) — option repricing only,
 *   sectorMoves?: Record<string, number> (each -0.50 to 0.50),
 *   name?: string,
 *   accountId?: number
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { marketMove, rateMove, volMove, sectorMoves, name, accountId: bodyAccountId, scope } = body as {
      marketMove?: number;
      rateMove?: number;
      volMove?: number;
      sectorMoves?: Record<string, number>;
      name?: string;
      accountId?: number;
      scope?: string;
    };
    // Match the GET path's scope resolution so a custom scenario is baselined
    // to the same account set as the preset cards it renders next to.
    const accountIds = bodyAccountId != null ? [bodyAccountId] : resolveScope(db, scope ?? null);

    const marketLimit = SCENARIO_INPUT_BOUNDS.marketMove.toFixed(2);
    if (marketMove == null || typeof marketMove !== "number" || !Number.isFinite(marketMove)) {
      return NextResponse.json(
        { success: false, error: `marketMove is required (number between -${marketLimit} and ${marketLimit})` },
        { status: 400 }
      );
    }

    if (Math.abs(marketMove) > SCENARIO_INPUT_BOUNDS.marketMove) {
      return NextResponse.json(
        { success: false, error: `marketMove must be between -${marketLimit} and ${marketLimit}` },
        { status: 400 }
      );
    }

    const bodyProblem = customScenarioBodyProblem({ rateMove, sectorMoves });
    if (bodyProblem) {
      return NextResponse.json({ success: false, error: bodyProblem }, { status: 400 });
    }

    if (volMove != null) {
      if (typeof volMove !== "number" || !Number.isFinite(volMove)) {
        return NextResponse.json(
          { success: false, error: "volMove must be a finite number (volatility points)" },
          { status: 400 }
        );
      }
      if (volMove < VOL_MOVE_MIN || volMove > VOL_MOVE_MAX) {
        return NextResponse.json(
          { success: false, error: `volMove must be between ${VOL_MOVE_MIN} and ${VOL_MOVE_MAX} points` },
          { status: 400 }
        );
      }
    }

    const hasSectorMoves = sectorMoves && Object.keys(sectorMoves).length > 0;

    const scenario: ScenarioDefinition = {
      id: "custom",
      name: name || "Custom Scenario",
      description: buildCustomDescription(marketMove, rateMove, sectorMoves, volMove),
      category: hasSectorMoves ? "sector" : rateMove ? "rate" : "custom",
      marketMove,
      rateMove,
      volMove: volMove || undefined,
      sectorMoves: hasSectorMoves ? sectorMoves : undefined,
    };

    const result = computeScenario(db, scenario, { accountIds });
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
  sectorMoves?: Record<string, number>,
  volMove?: number
): string {
  const parts: string[] = [];
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;

  parts.push(`Market ${pct(marketMove)}`);
  if (rateMove) parts.push(`rates ${rateMove > 0 ? "+" : ""}${rateMove}bp`);
  if (volMove) parts.push(`vol ${volMove > 0 ? "+" : ""}${volMove} pts`);
  if (sectorMoves) {
    const overrides = Object.entries(sectorMoves)
      .slice(0, 3)
      .map(([s, m]) => `${s} ${pct(m)}`)
      .join(", ");
    parts.push(overrides);
  }
  return parts.join(" · ");
}

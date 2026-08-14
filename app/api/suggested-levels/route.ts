import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getOhlcvBars, getLatestPriceNative } from "@/lib/queries/ohlcv";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { computeSuggestedLevels } from "@/lib/chart/suggested-levels";
import {
  getOrGenerateNarrative,
  getCachedLevelNarrative,
} from "@/lib/chart/narrate-levels";
import type { SuggestedLevel } from "@/lib/chart/suggested-levels";

type Bars = ReturnType<typeof getOhlcvBars>;

/**
 * Shared compute (native-currency frame — see the long comment below). Returns
 * either a ready-to-send Response (bad input / no data) or the computed levels
 * plus everything the narrative step needs.
 */
type ComputeOutcome =
  | { kind: "response"; response: Response }
  | {
      kind: "ok";
      securityId: number;
      symbol: string;
      currentPrice: number;
      bars: Bars;
      usdPerUnit: number;
      result: ReturnType<typeof computeSuggestedLevels>;
    };

function computeBase(req: NextRequest): ComputeOutcome {
  const { searchParams } = new URL(req.url);
  const idParam = searchParams.get("securityId");
  const securityId = Number(idParam);
  if (!Number.isFinite(securityId) || securityId <= 0) {
    return {
      kind: "response",
      response: Response.json(
        { error: "securityId query param is required" },
        { status: 400 },
      ),
    };
  }

  // Everything below runs in the security's NATIVE currency frame — bars are
  // native, so the current price must be too (the pre-fix USD-converted
  // getLatestPrice put a KRW name +199,687% "away" from its own pivots).
  // usdPerUnit ships alongside for the ATR text ONLY (it mirrors
  // MarketDataPanel's USD KPI-row ATR); it is 1 for USD securities.
  // Suggested PRICES render NATIVE by user decision (2026-08-05, re-affirmed
  // 2026-08-06) — they must match the accepted-levels list in the same panel,
  // which is documented intentionally-native. Do not convert them client-side.
  const secRow = db
    .prepare(`SELECT currency, symbol FROM securities WHERE id = ?`)
    .get(securityId) as { currency: string | null; symbol: string } | undefined;
  const usdPerUnit = getUsdPerUnit(db, secRow?.currency ?? null);

  // Daily bars only for now; a ~500-bar lookback (~2 years) is plenty for
  // pivot detection without pulling the entire history on every call.
  const bars = getOhlcvBars(db, securityId, "1 day", { limit: 500 });
  if (bars.length === 0) {
    return {
      kind: "response",
      response: Response.json({
        levels: [],
        atr: null,
        currentPrice: null,
        usdPerUnit,
        barsAnalyzed: 0,
        computedAt: new Date().toISOString(),
        warning: "No OHLCV history for this security. Run a chart sync first.",
      }),
    };
  }

  const priceRow = getLatestPriceNative(db, securityId);
  const currentPrice =
    priceRow?.close_price ??
    (bars.length > 0 ? bars[bars.length - 1].close : null);

  if (!Number.isFinite(currentPrice) || (currentPrice as number) <= 0) {
    return {
      kind: "response",
      response: Response.json({
        levels: [],
        atr: null,
        currentPrice,
        usdPerUnit,
        barsAnalyzed: bars.length,
        computedAt: new Date().toISOString(),
        warning: "Could not resolve a current price for this security.",
      }),
    };
  }

  const result = computeSuggestedLevels(bars, currentPrice as number);

  return {
    kind: "ok",
    securityId,
    symbol: secRow?.symbol ?? "",
    currentPrice: currentPrice as number,
    bars,
    usdPerUnit,
    result,
  };
}

function wantsNarratives(req: NextRequest): boolean {
  return new URL(req.url).searchParams.get("narratives") === "1";
}

/**
 * GET /api/suggested-levels?securityId=…[&narratives=1]
 *
 * SIDE-EFFECT-FREE (#35 task 5). computeSuggestedLevels is pure. When
 * narratives=1 the levels are enriched with narratives READ FROM CACHE ONLY
 * (getCachedLevelNarrative → null when not yet generated) — GET never calls the
 * paid Haiku generator, which also INSERTs. Under SameSite=Lax a bare GET has
 * no CSRF protection, so narrative generation moved to POST. The client GETs
 * for display, then POSTs to fill any missing narratives.
 */
export async function GET(req: NextRequest) {
  const outcome = computeBase(req);
  if (outcome.kind === "response") return outcome.response;

  const { result, usdPerUnit, securityId } = outcome;

  if (wantsNarratives(req) && result.levels.length > 0) {
    const enriched = result.levels.map((level: SuggestedLevel) => ({
      ...level,
      narrative: getCachedLevelNarrative(db, {
        securityId,
        levelPrice: level.price,
        direction: level.type,
      }),
    }));
    return Response.json({ ...result, levels: enriched, usdPerUnit });
  }

  return Response.json({ ...result, usdPerUnit });
}

/**
 * POST /api/suggested-levels?securityId=…&narratives=1
 *
 * Generate (or reuse today's cached) per-level narratives — the paid-AI write
 * path. Returns the same shape as GET, with narratives populated.
 */
export async function POST(req: NextRequest) {
  const outcome = computeBase(req);
  if (outcome.kind === "response") return outcome.response;

  const { result, usdPerUnit, securityId, symbol, currentPrice, bars } = outcome;

  if (result.levels.length > 0) {
    const narratives = await Promise.all(
      result.levels.map((level: SuggestedLevel) =>
        getOrGenerateNarrative(db, {
          securityId,
          symbol,
          currentPrice,
          level,
          recentBars: bars,
        }),
      ),
    );
    const enriched = result.levels.map((level: SuggestedLevel, i: number) => ({
      ...level,
      narrative: narratives[i],
    }));
    return Response.json({ ...result, levels: enriched, usdPerUnit });
  }

  return Response.json({ ...result, usdPerUnit });
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateMacroThemes, type MacroTheme } from "@/lib/compute/macro-themes";
import { getCachedMacroThemes } from "@/lib/queries/analysis-macro-themes";
import { mondayOf } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

const ALLOWED_SCOPES = new Set(["all", "vanguard", "ibkr", "roth"]);

/**
 * GET /api/analysis/macro-themes — SIDE-EFFECT-FREE cache read (#35 task 5).
 *
 * Returns the cached themes for (scope, thisWeek) or a `notGenerated` marker.
 * It NEVER generates-on-miss: generation is a paid Sonnet call AND a write
 * (upsertMacroThemes, including the under-threshold empty-cache branch), and a
 * bare SameSite=Lax GET carries no CSRF protection. Generation happens ONLY via
 * POST. The client POSTs to fill an empty cache. A cached row with an empty
 * themes array means "computed, under threshold" → surface underThreshold.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  if (!scope || !ALLOWED_SCOPES.has(scope)) {
    return NextResponse.json(
      { success: false, error: "scope required (all|vanguard|ibkr|roth)" },
      { status: 400 }
    );
  }
  const weekParam = url.searchParams.get("week");
  const week = weekParam ? mondayOf(weekParam) : mondayOf(new Date().toISOString().slice(0, 10));

  const cached = getCachedMacroThemes(db, scope, week);
  if (!cached) {
    return NextResponse.json({ success: true, notGenerated: true, themes: null });
  }

  let themes: MacroTheme[] = [];
  try {
    themes = JSON.parse(cached.themesJson) as MacroTheme[];
  } catch {
    themes = [];
  }
  const sourceSummary = cached.sourceSummary ? JSON.parse(cached.sourceSummary) : null;
  // An empty cached array is the persisted under-threshold verdict.
  const underThreshold = themes.length === 0;
  return NextResponse.json({
    success: true,
    themes,
    sourceSummary,
    fromCache: true,
    generatedAt: cached.generatedAt,
    underThreshold,
  });
}

const lastMacroRegenAt = new Map<string, number>();
const MACRO_REGEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  let body: { scope?: string };
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: "invalid JSON body" }, { status: 400 }); }
  const scope = body.scope;
  if (!scope || !ALLOWED_SCOPES.has(scope)) {
    return NextResponse.json({ success: false, error: "scope required" }, { status: 400 });
  }
  const now = Date.now();
  const last = lastMacroRegenAt.get(scope) ?? 0;
  if (now - last < MACRO_REGEN_WINDOW_MS) {
    return NextResponse.json(
      { success: false, error: "rate-limited", retryAfter: MACRO_REGEN_WINDOW_MS - (now - last) },
      { status: 429 }
    );
  }
  lastMacroRegenAt.set(scope, now);
  const week = mondayOf(new Date().toISOString().slice(0, 10));
  try {
    const r = await generateMacroThemes(db, { scope, weekOf: week, forceRegen: true });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

export function __resetMacroRegenLimitForTests() {
  lastMacroRegenAt.clear();
}

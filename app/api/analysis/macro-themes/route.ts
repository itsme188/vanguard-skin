import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateMacroThemes, MacroThemesParseError, type MacroTheme } from "@/lib/compute/macro-themes";
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

// The 24h window is stamped only by a SUCCESSFUL generation (see POST): a reply
// we could not parse is not a generation, and stamping it up front locked the
// scope out of its Macro card for a full day (2026-09-10 QA). Failures instead
// get their own short cooldown, so a persistently broken model is still billed
// at most once per MACRO_FAIL_COOLDOWN_MS rather than on every page load.
const lastMacroRegenAt = new Map<string, number>();
const lastMacroFailAt = new Map<string, number>();
const MACRO_REGEN_WINDOW_MS = 24 * 60 * 60 * 1000;
const MACRO_FAIL_COOLDOWN_MS = 10 * 60 * 1000;

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
  const lastFail = lastMacroFailAt.get(scope) ?? 0;
  if (now - lastFail < MACRO_FAIL_COOLDOWN_MS) {
    return NextResponse.json(
      { success: false, error: "rate-limited", retryAfter: MACRO_FAIL_COOLDOWN_MS - (now - lastFail) },
      { status: 429 }
    );
  }
  const week = mondayOf(new Date().toISOString().slice(0, 10));
  try {
    const r = await generateMacroThemes(db, { scope, weekOf: week, forceRegen: true });
    lastMacroRegenAt.set(scope, now);
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    lastMacroFailAt.set(scope, now);
    // The client renders `error` verbatim, so it must stay user-facing; the
    // parser text / reply snippet goes to the server log only.
    const message = e instanceof Error ? e.message : "Failed to generate macro themes";
    const detail = e instanceof MacroThemesParseError ? e.detail : message;
    console.error(`[macro-themes] generation failed for scope=${scope}: ${detail}`);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export function __resetMacroRegenLimitForTests() {
  lastMacroRegenAt.clear();
  lastMacroFailAt.clear();
}

/** Clear ONLY the short failure cooldown — proves the 24h window is untouched. */
export function __clearMacroFailCooldownForTests() {
  lastMacroFailAt.clear();
}

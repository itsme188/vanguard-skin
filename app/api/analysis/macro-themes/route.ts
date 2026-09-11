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

// The 24h window is CLAIMED before the generation and RELEASED if it fails
// (see POST). The claim has to happen before the await — this map is the only
// mutex the route has, and without a pre-stamp two concurrent POSTs for one
// scope (two tabs, a StrictMode double-effect, an A→B→A scope toggle) both
// reach the paid generator. The release is what keeps a reply we could not
// parse from locking the scope out of its Macro card for a full day
// (2026-09-10 QA): a failure is not a generation. Failures instead get their
// own short cooldown, so a persistently broken model is still billed at most
// once per MACRO_FAIL_COOLDOWN_MS rather than on every page load.
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
      {
        success: false,
        error: "rate-limited",
        // `reason` tells the card WHICH limit fired: the two windows are a day
        // apart, and answering the failure cooldown with "refreshes once a day"
        // named the wrong cause and the wrong wait.
        reason: "daily",
        retryAfter: MACRO_REGEN_WINDOW_MS - (now - last),
      },
      { status: 429 }
    );
  }
  const lastFail = lastMacroFailAt.get(scope) ?? 0;
  if (now - lastFail < MACRO_FAIL_COOLDOWN_MS) {
    return NextResponse.json(
      {
        success: false,
        error: "rate-limited",
        reason: "last_attempt_failed",
        retryAfter: MACRO_FAIL_COOLDOWN_MS - (now - lastFail),
      },
      { status: 429 }
    );
  }
  // Claim the window BEFORE the await — see the note on lastMacroRegenAt. A
  // second POST that arrives while this one is still in flight now sees the
  // claim and 429s instead of starting a second paid generation.
  lastMacroRegenAt.set(scope, now);
  const week = mondayOf(new Date().toISOString().slice(0, 10));
  try {
    const r = await generateMacroThemes(db, { scope, weekOf: week, forceRegen: true });
    // A success supersedes any earlier failure for this scope.
    lastMacroFailAt.delete(scope);
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    // Release the 24h claim (a failure is not a generation) and fall back to
    // the short failure cooldown.
    lastMacroRegenAt.delete(scope);
    lastMacroFailAt.set(scope, now);
    // The client renders `error` verbatim, so it must stay user-facing. Only
    // MacroThemesParseError carries a message written for a reader; every other
    // throw (a provider error string, a refusal) is raw vendor text and goes to
    // the server log only.
    const raw = e instanceof Error ? e.message : String(e);
    const message =
      e instanceof MacroThemesParseError
        ? e.message
        : "Couldn't refresh macro themes — try again in a few minutes.";
    const detail = e instanceof MacroThemesParseError ? e.detail : raw;
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

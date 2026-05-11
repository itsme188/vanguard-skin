import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateMacroThemes } from "@/lib/compute/macro-themes";
import { mondayOf } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

const ALLOWED_SCOPES = new Set(["all", "vanguard", "ibkr", "roth"]);

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
  try {
    const r = await generateMacroThemes(db, { scope, weekOf: week });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
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

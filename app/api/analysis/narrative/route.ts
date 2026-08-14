import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateNarrative,
  NARRATIVE_SURFACES,
} from "@/lib/compute/analysis-narratives";
import { getCachedNarrative } from "@/lib/queries/analysis-narratives";
import { mondayOf } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/analysis/narrative — SIDE-EFFECT-FREE cache read (#35 task 5).
 *
 * Returns the cached narrative for (scope, surface, thisWeek) or a
 * `notGenerated` marker. It NEVER generates-on-miss: generation is a paid
 * Sonnet call and a write (upsertNarrative), and under SameSite=Lax a bare GET
 * carries no CSRF protection — so a cross-site top-level navigation must not be
 * able to burn AI budget or write the cache. Generation happens ONLY via POST
 * (the existing force-regen path). The client fires POST when it needs to fill
 * an empty cache. This enforces the app's own "cached-AI GET-read / POST-regen"
 * convention (CLAUDE.md).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const surface = url.searchParams.get("surface");

  if (!scope) {
    return NextResponse.json(
      { success: false, error: "scope required" },
      { status: 400 }
    );
  }
  if (
    !surface ||
    !(NARRATIVE_SURFACES as readonly string[]).includes(surface)
  ) {
    return NextResponse.json(
      { success: false, error: "unknown surface" },
      { status: 404 }
    );
  }

  const week = mondayOf(new Date().toISOString().slice(0, 10));

  const cached = getCachedNarrative(db, scope, surface, week);
  if (cached) {
    return NextResponse.json({
      success: true,
      narrativeMd: cached.narrativeMd,
      fromCache: true,
      generatedAt: cached.generatedAt,
    });
  }

  // Cache miss — report "not generated yet" WITHOUT generating. The client
  // POSTs to generate on demand.
  return NextResponse.json({
    success: true,
    narrativeMd: null,
    generatedAt: null,
    notGenerated: true,
  });
}

// Per-process rate limiter; OK for the single-server Electron deployment. If
// this app ever scales horizontally, swap for a settings-table or Redis-backed
// counter so all pods share the limit.
const lastRegenAt = new Map<string, number>();
const REGEN_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  let body: { scope?: string; surface?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "invalid JSON body" },
      { status: 400 }
    );
  }
  const { scope, surface } = body;
  if (!scope || !surface) {
    return NextResponse.json(
      { success: false, error: "scope+surface required" },
      { status: 400 }
    );
  }
  if (!(NARRATIVE_SURFACES as readonly string[]).includes(surface)) {
    return NextResponse.json(
      { success: false, error: "unknown surface" },
      { status: 404 }
    );
  }
  const key = `${scope}::${surface}`;
  const now = Date.now();
  const hadPreviousStamp = lastRegenAt.has(key);
  const previousStamp = lastRegenAt.get(key);
  const last = previousStamp ?? 0;
  if (now - last < REGEN_WINDOW_MS) {
    return NextResponse.json(
      {
        success: false,
        error: "rate-limited",
        retryAfter: REGEN_WINDOW_MS - (now - last),
      },
      { status: 429 }
    );
  }
  // Stamp BEFORE generating so a concurrent double-click (arriving while
  // Sonnet is still running) also gets blocked, not just sequential calls.
  lastRegenAt.set(key, now);
  const week = mondayOf(new Date().toISOString().slice(0, 10));
  try {
    const r = await generateNarrative(db, {
      scope,
      surfaceKey: surface,
      weekOf: week,
      forceRegen: true,
    });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    // Roll back the stamp: a transient AI failure must not burn the 24h
    // window — only the double-click guard above is the stamp's real job.
    if (hadPreviousStamp) {
      lastRegenAt.set(key, previousStamp!);
    } else {
      lastRegenAt.delete(key);
    }
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

// Test-only export so the rate-limit maps can be reset between test cases.
// Do NOT call from production code.
export function __resetRateLimitForTests() {
  lastRegenAt.clear();
}

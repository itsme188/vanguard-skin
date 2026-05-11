import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateNarrative,
  NARRATIVE_SURFACES,
} from "@/lib/compute/analysis-narratives";
import { mondayOf } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

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
  try {
    const r = await generateNarrative(db, {
      scope,
      surfaceKey: surface,
      weekOf: week,
    });
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
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
  const last = lastRegenAt.get(key) ?? 0;
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
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}

// Test-only export so the rate-limit map can be reset between test cases.
// Do NOT call from production code.
export function __resetRateLimitForTests() {
  lastRegenAt.clear();
}

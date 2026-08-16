import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getLevelsForSecurity,
  getActiveLevels,
  getLevelById,
} from "@/lib/queries/security-levels";
import {
  upsertLevel,
  deactivateLevel,
  reactivateLevel,
  deleteLevel,
} from "@/lib/mutations/security-levels";
import { resolveLevelPrice } from "@/lib/alerts/resolve-level-price";
import { todayET } from "@/lib/calendar/date-utils";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const securityId = searchParams.get("securityId");
    const activeOnly = searchParams.get("activeOnly") !== "false";

    const levels = securityId
      ? getLevelsForSecurity(db, Number(securityId), { activeOnly })
      : getActiveLevels(db);

    // Enrich with effective_price — static levels echo `price`, MA-based
    // levels get the live MA computed from ohlcv_bars. effective_price is
    // null when an MA level doesn't have enough bars yet; UI renders an
    // "insufficient history" chip in that case.
    const enriched = levels.map((l) => ({
      ...l,
      effective_price:
        l.price_source === "static" ? l.price : resolveLevelPrice(db, l),
    }));
    // Note: resolveLevelPrice return type already narrows to `number | null`.

    return NextResponse.json({ success: true, levels: enriched });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.security_id || !body.level_type || typeof body.price !== "number") {
      return NextResponse.json(
        { success: false, error: "security_id, level_type, and price required" },
        { status: 400 }
      );
    }
    // QA security-detail-levels--past-expiry-accepted-renders-armed-never-fires:
    // a brand-new level with an already-past expires_at used to be accepted
    // silently (200) and render in the active list looking armed, but
    // getArmedLevels/findCrossedLevels filter `expires_at >= date('now')` —
    // the scanner permanently excludes it and it can never fire. Reject at
    // creation with an honest 400 instead. This gate is create-only (POST
    // never carries an `id`, unlike PATCH's edit path) so it never touches
    // legitimate historical writes: PATCH edits that keep an old expiry,
    // sync/import re-upserts, and newsletter-accept all call upsertLevel
    // directly and are untouched. ET-anchored per project convention — never
    // new Date().toISOString().slice(0,10).
    if (typeof body.expires_at === "string" && body.expires_at < todayET()) {
      return NextResponse.json(
        {
          success: false,
          error: `Expiry date ${body.expires_at} is in the past — this level would be created already expired and could never fire. Pick today or a later date.`,
        },
        { status: 400 }
      );
    }
    const id = upsertLevel(db, body);
    const level = getLevelById(db, id);
    return NextResponse.json({ success: true, id, level });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, action } = body;
    if (!id) {
      return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
    }
    if (action === "deactivate") {
      deactivateLevel(db, id);
    } else if (action === "reactivate") {
      reactivateLevel(db, id);
    } else {
      upsertLevel(db, body);
    }
    return NextResponse.json({ success: true, level: getLevelById(db, id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "id required" }, { status: 400 });
    }
    deleteLevel(db, Number(id));
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

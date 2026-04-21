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

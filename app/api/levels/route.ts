import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getLevelsForSecurity,
  getActiveLevels,
  getLevelById,
  getScanPriceStalenessBySecurity,
  getLatestScanPriceForSecurity,
} from "@/lib/queries/security-levels";
import {
  BEYOND_SCAN_RANGE_EXPLANATION,
  isLevelBeyondScanRange,
} from "@/lib/levels/scan-range";
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
    //
    // …and with the scanner's price-freshness verdict. A level whose security
    // hasn't been priced inside the scan window is skipped on every pass, so
    // the panel must be able to say "armed but not being monitored" instead of
    // rendering it as live coverage (the band half of that disclosure is
    // computed client-side from currentPrice; freshness needs the price DATE,
    // which only the server has).
    const staleness = getScanPriceStalenessBySecurity(
      db,
      levels.map((l) => l.security_id),
    );
    const enriched = levels.map((l) => ({
      ...l,
      effective_price:
        l.price_source === "static" ? l.price : resolveLevelPrice(db, l),
      price_date: staleness.get(l.security_id)?.priceDate ?? null,
      price_is_stale: staleness.get(l.security_id)?.isStale ?? false,
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
    // QA security-detail-levels--negative-price-accepted-armed: price -50 was
    // accepted, stored armed + auto_approved, and rendered "-$50.00 · 1559.8%
    // away" in the Armed inbox — a point off the price axis that no scan can
    // ever cross. Same create-only shape as the expiry guard below (POST never
    // carries an `id`), so PATCH edits and in-process upsertLevel callers
    // (sync/import/newsletter-accept) are untouched.
    //
    // Zero is only rejected for STATIC levels: on an MA-based level `price` is
    // just a reference echo (resolveLevelPrice recomputes from ohlcv_bars) and
    // the Add form legitimately sends `currentPrice ?? 0` there.
    const priceSource = typeof body.price_source === "string" ? body.price_source : "static";
    const priceInvalid =
      !Number.isFinite(body.price) ||
      body.price < 0 ||
      (priceSource === "static" && body.price <= 0);
    if (priceInvalid) {
      return NextResponse.json(
        {
          success: false,
          error: `Price ${body.price} is not a valid level price — a level marks a point on the price axis, so it must be a positive dollar amount.`,
        },
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
    // A create lands ALREADY auto_approved (armed), so a mis-scaled level buys
    // coverage the scanner skips on every pass. The Add forms warn before the
    // save, but a headless POST had no signal at all — hence this non-blocking
    // `warning`. Not a refusal: marking structure to arm later is legitimate,
    // and unlike the review-approve guard this path has no force flag to
    // override one with. The arm-time refusal lives in approveLevelGuarded.
    const priceInfo = getLatestScanPriceForSecurity(db, body.security_id);
    const warning =
      priceInfo.isFresh &&
      isLevelBeyondScanRange(
        priceSource === "static" ? body.price : null,
        priceInfo.currentPrice,
        priceInfo.secType
      )
        ? BEYOND_SCAN_RANGE_EXPLANATION
        : undefined;
    return NextResponse.json({ success: true, id, level, ...(warning ? { warning } : {}) });
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

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getActiveWatchlist } from "@/lib/queries/watchlist";
import {
  addToWatchlist,
  updateWatchlistItem,
  removeFromWatchlist,
} from "@/lib/mutations/watchlist";

export async function GET() {
  try {
    const items = getActiveWatchlist(db);
    return NextResponse.json({ success: true, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { securityId, symbol, priceTargetLow, priceTargetHigh, thesis } =
      body;

    // If a symbol is provided instead of securityId, resolve it
    let resolvedSecurityId = securityId;
    if (!resolvedSecurityId && symbol) {
      const row = db
        .prepare("SELECT id FROM securities WHERE symbol = ? LIMIT 1")
        .get(symbol) as { id: number } | undefined;

      if (!row) {
        // Create a minimal security record for the watchlist
        const result = db
          .prepare(
            "INSERT INTO securities (symbol, security_type) VALUES (?, 'stock')"
          )
          .run(symbol.toUpperCase());
        resolvedSecurityId = result.lastInsertRowid;
      } else {
        resolvedSecurityId = row.id;
      }
    }

    if (!resolvedSecurityId) {
      return NextResponse.json(
        { success: false, error: "securityId or symbol required" },
        { status: 400 }
      );
    }

    addToWatchlist(db, {
      securityId: Number(resolvedSecurityId),
      priceTargetLow,
      priceTargetHigh,
      thesis,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, priceTargetLow, priceTargetHigh, thesis } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: "id required" },
        { status: 400 }
      );
    }

    updateWatchlistItem(db, id, { priceTargetLow, priceTargetHigh, thesis });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { success: false, error: "id required" },
        { status: 400 }
      );
    }

    removeFromWatchlist(db, parseInt(id, 10));
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

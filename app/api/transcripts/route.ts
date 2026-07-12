import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getTranscriptsSummary,
  getCachedTranscript,
  getCachedQuarters,
} from "@/lib/queries/transcripts";
import type { EarningsTranscript } from "@/lib/types";
import { fetchTranscript } from "@/lib/transcripts/fetch";
import { decodeFilingEntities } from "@/lib/apis/edgar";

/**
 * Rows cached before the fetch-time entity decoder existed still carry raw
 * numeric references (&#160; / &#744;) in their stored transcript text.
 * Decoding at the read boundary self-heals every legacy row without a data
 * migration; the decoder is a no-op on already-clean text.
 */
function withDecodedTranscript(row: EarningsTranscript): EarningsTranscript {
  return row.transcript
    ? { ...row, transcript: decodeFilingEntities(row.transcript) }
    : row;
}

/**
 * GET /api/transcripts?ticker=AAPL&year=2025&quarter=3
 * GET /api/transcripts?ticker=AAPL  (list cached quarters)
 */
export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const ticker = params.get("ticker");
    const year = params.get("year");
    const quarter = params.get("quarter");
    const list = params.get("list"); // "quarters" to list cached quarters

    if (!ticker) {
      // Return all transcript summaries
      const summaries = getTranscriptsSummary(db, {
        limit: parseInt(params.get("limit") || "50", 10),
      });
      return NextResponse.json({ success: true, data: summaries });
    }

    if (list === "quarters") {
      const quarters = getCachedQuarters(db, ticker);
      return NextResponse.json({ success: true, data: quarters });
    }

    if (year && quarter) {
      const transcript = getCachedTranscript(
        db,
        ticker,
        parseInt(year, 10),
        parseInt(quarter, 10)
      );
      if (!transcript) {
        return NextResponse.json(
          { success: false, error: "Transcript not cached. Use POST to fetch." },
          { status: 404 }
        );
      }
      return NextResponse.json({
        success: true,
        data: withDecodedTranscript(transcript),
      });
    }

    // Default: return summaries for this ticker
    const summaries = getTranscriptsSummary(db, { ticker });
    return NextResponse.json({ success: true, data: summaries });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/transcripts  { ticker, year?, quarter? }
 * Triggers fetch + cache pipeline for a transcript.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { ticker, year, quarter } = body;

    if (!ticker) {
      return NextResponse.json(
        { success: false, error: "Missing required field: ticker" },
        { status: 400 }
      );
    }

    const result = await fetchTranscript(
      db,
      ticker,
      year ? parseInt(year, 10) : undefined,
      quarter ? parseInt(quarter, 10) : undefined
    );

    if (!result) {
      return NextResponse.json(
        {
          success: false,
          error: `No transcript found for ${ticker}. The company may not have reported recently.`,
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: withDecodedTranscript(result.transcript),
      fromCache: result.fromCache,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

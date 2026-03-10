import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getNotesFiltered, getSecurityIdBySymbol } from "@/lib/queries/notes";
import { createNote, updateNote, deleteNote } from "@/lib/mutations/notes";
import type { NoteType, NoteSentiment } from "@/lib/types";

const VALID_TYPES: NoteType[] = ["journal", "earnings", "trade_thesis"];
const VALID_SENTIMENTS: NoteSentiment[] = [
  "bullish",
  "bearish",
  "neutral",
  "cautious",
  "confident",
];

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    const noteType = params.get("type") as NoteType | null;
    const symbol = params.get("symbol");
    const search = params.get("search");
    const startDate = params.get("start_date");
    const endDate = params.get("end_date");
    const sentiment = params.get("sentiment");
    const limit = params.get("limit");

    let securityId: number | undefined;
    if (symbol) {
      const id = getSecurityIdBySymbol(db, symbol);
      if (id) securityId = id;
    }

    const notes = getNotesFiltered(db, {
      note_type: noteType ?? undefined,
      security_id: securityId,
      search: search ?? undefined,
      start_date: startDate ?? undefined,
      end_date: endDate ?? undefined,
      sentiment: sentiment ?? undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return NextResponse.json({ success: true, data: notes });
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
    const { note_type, content, symbol, security_id, transaction_id, event_date, tags, sentiment } = body;

    if (!note_type || !content) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: note_type, content" },
        { status: 400 }
      );
    }

    if (!VALID_TYPES.includes(note_type)) {
      return NextResponse.json(
        { success: false, error: `Invalid note_type. Must be one of: ${VALID_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    if (sentiment && !VALID_SENTIMENTS.includes(sentiment)) {
      return NextResponse.json(
        { success: false, error: `Invalid sentiment. Must be one of: ${VALID_SENTIMENTS.join(", ")}` },
        { status: 400 }
      );
    }

    // Resolve symbol to security_id if provided
    let resolvedSecurityId = security_id ?? null;
    if (symbol && !resolvedSecurityId) {
      resolvedSecurityId = getSecurityIdBySymbol(db, symbol);
    }

    const note = createNote(db, {
      note_type,
      content,
      security_id: resolvedSecurityId,
      transaction_id: transaction_id ?? null,
      event_date: event_date ?? new Date().toISOString().slice(0, 10),
      tags: tags ?? null,
      sentiment: sentiment ?? null,
    });

    return NextResponse.json({ success: true, data: note });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, content, event_date, tags, sentiment } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing required field: id" },
        { status: 400 }
      );
    }

    if (sentiment && !VALID_SENTIMENTS.includes(sentiment)) {
      return NextResponse.json(
        { success: false, error: `Invalid sentiment. Must be one of: ${VALID_SENTIMENTS.join(", ")}` },
        { status: 400 }
      );
    }

    const note = updateNote(db, id, { content, event_date, tags, sentiment });
    if (!note) {
      return NextResponse.json(
        { success: false, error: "Note not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: note });
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
    const id = request.nextUrl.searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { success: false, error: "Missing id parameter" },
        { status: 400 }
      );
    }

    const result = deleteNote(db, parseInt(id, 10));
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}

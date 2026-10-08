import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getNotesFiltered, getSecurityIdBySymbol } from "@/lib/queries/notes";
import { createNote, updateNote, deleteNote } from "@/lib/mutations/notes";
import { NOTE_TYPES, NOTE_SENTIMENTS, type NoteType } from "@/lib/types";
import { coerceNoteType, coerceNoteSentiment } from "@/lib/notes/coerce";
import { todayET } from "@/lib/calendar/date-utils";

const VALID_TYPES = NOTE_TYPES;
const VALID_SENTIMENTS = NOTE_SENTIMENTS;

// The Earnings tab files notes under per-security headers, so an earnings
// note with no security would be saved and then shown nowhere on that tab.
const EARNINGS_NEEDS_SECURITY = "An earnings note needs a security. Pick one, then save.";

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    // ?type= and ?sentiment= are user-editable and shareable, so an unknown
    // value (notably the guessable "all") must fall back to "no filter"
    // rather than being cast straight through — a bogus value matches no
    // row and renders an empty-notebook state over a full one.
    const noteType = coerceNoteType(params.get("type"));
    const symbol = params.get("symbol");
    const search = params.get("search");
    const startDate = params.get("start_date");
    const endDate = params.get("end_date");
    const sentiment = coerceNoteSentiment(params.get("sentiment"));
    const limit = params.get("limit");

    let securityId: number | undefined;
    if (symbol) {
      const id = getSecurityIdBySymbol(db, symbol);
      if (id) securityId = id;
    }

    const notes = getNotesFiltered(db, {
      note_type: noteType,
      security_id: securityId,
      search: search ?? undefined,
      start_date: startDate ?? undefined,
      end_date: endDate ?? undefined,
      sentiment,
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

    if (note_type === "earnings" && !resolvedSecurityId) {
      return NextResponse.json(
        { success: false, error: EARNINGS_NEEDS_SECURITY },
        { status: 400 }
      );
    }

    const note = createNote(db, {
      note_type,
      content,
      security_id: resolvedSecurityId,
      transaction_id: transaction_id ?? null,
      // ET-anchor: a 9pm ET quick-note must file under today, not UTC-tomorrow.
      // || not ??: a cleared date input submits "" — an empty-string
      // event_date renders an "undefined NaN," date header and sorts last.
      event_date: event_date || todayET(),
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
    const { id, content, event_date, tags, sentiment, note_type, security_id } = body;

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

    // note_type / security_id: an absent key leaves the column alone;
    // security_id null clears the link. Validate before anything is written.
    let noteType: NoteType | undefined;
    if (note_type !== undefined) {
      noteType = coerceNoteType(typeof note_type === "string" ? note_type : null);
      if (!noteType) {
        return NextResponse.json(
          { success: false, error: `Invalid note_type. Must be one of: ${VALID_TYPES.join(", ")}` },
          { status: 400 }
        );
      }
    }
    if (security_id !== undefined && security_id !== null) {
      if (typeof security_id !== "number" || !Number.isInteger(security_id) || security_id <= 0) {
        return NextResponse.json(
          { success: false, error: "Invalid security_id. Must be null or a positive integer" },
          { status: 400 }
        );
      }
      const exists = db.prepare("SELECT 1 FROM securities WHERE id = ?").get(security_id);
      if (!exists) {
        return NextResponse.json(
          { success: false, error: "Security not found" },
          { status: 404 }
        );
      }
    }

    // An edit may not move a note INTO "earnings, no security". An older
    // row already in that state keeps an editable text (nothing it sends
    // changes either column), and may still be moved out of it.
    if (noteType !== undefined || security_id !== undefined) {
      const current = db
        .prepare("SELECT note_type, security_id FROM notes WHERE id = ?")
        .get(id) as { note_type: string; security_id: number | null } | undefined;
      if (current) {
        const nextType = noteType ?? current.note_type;
        const nextSecurityId = security_id !== undefined ? security_id : current.security_id;
        const changed =
          nextType !== current.note_type || nextSecurityId !== current.security_id;
        if (changed && nextType === "earnings" && nextSecurityId == null) {
          return NextResponse.json(
            { success: false, error: EARNINGS_NEEDS_SECURITY },
            { status: 400 }
          );
        }
      }
    }

    // || undefined: an empty-string event_date must mean "leave unchanged",
    // never overwrite a real date with "" (same header-corruption class as POST).
    const note = updateNote(db, id, {
      content,
      event_date: event_date || undefined,
      tags,
      sentiment,
      note_type: noteType,
      security_id,
    });
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

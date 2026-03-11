import type Database from "better-sqlite3";

// ─── Filter types ─────────────────────────────────────────────────

export interface NotesFilters {
  note_type?: "journal" | "earnings" | "trade_thesis";
  security_id?: number;
  search?: string;
  start_date?: string;
  end_date?: string;
  sentiment?: string;
  limit?: number;
}

// ─── Result types ─────────────────────────────────────────────────

export interface NoteWithContext {
  id: number;
  note_type: string;
  content: string;
  event_date: string;
  tags: string | null;
  sentiment: string | null;
  created_at: string;
  updated_at: string;
  security_id: number | null;
  transaction_id: number | null;
  symbol: string | null;
  security_name: string | null;
  transaction_type: string | null;
  transaction_date: string | null;
}

export interface EarningsTimelineEntry {
  symbol: string;
  security_name: string | null;
  security_id: number;
  notes: NoteWithContext[];
}

// ─── Query functions ──────────────────────────────────────────────

const NOTE_SELECT = `
  SELECT
    n.id, n.note_type, n.content, n.event_date, n.tags, n.sentiment,
    n.created_at, n.updated_at, n.security_id, n.transaction_id,
    s.symbol, s.name AS security_name,
    t.type AS transaction_type, t.trade_date AS transaction_date
  FROM notes n
  LEFT JOIN securities s ON s.id = n.security_id
  LEFT JOIN transactions t ON t.id = n.transaction_id
`;

export function getNotesFiltered(
  db: Database.Database,
  filters: NotesFilters = {}
): NoteWithContext[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.note_type) {
    conditions.push("n.note_type = ?");
    params.push(filters.note_type);
  }
  if (filters.security_id) {
    conditions.push("n.security_id = ?");
    params.push(filters.security_id);
  }
  if (filters.search) {
    conditions.push("n.content LIKE '%' || ? || '%'");
    params.push(filters.search);
  }
  if (filters.start_date) {
    conditions.push("n.event_date >= ?");
    params.push(filters.start_date);
  }
  if (filters.end_date) {
    conditions.push("n.event_date <= ?");
    params.push(filters.end_date);
  }
  if (filters.sentiment) {
    conditions.push("n.sentiment = ?");
    params.push(filters.sentiment);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;

  return db
    .prepare(`${NOTE_SELECT} ${where} ORDER BY n.event_date DESC, n.created_at DESC LIMIT ?`)
    .all(...params, limit) as NoteWithContext[];
}

export function getNotesForSecurity(
  db: Database.Database,
  securityId: number
): NoteWithContext[] {
  return db
    .prepare(`${NOTE_SELECT} WHERE n.security_id = ? ORDER BY n.event_date ASC, n.created_at ASC`)
    .all(securityId) as NoteWithContext[];
}

export function getEarningsTimeline(
  db: Database.Database,
  securityId?: number
): EarningsTimelineEntry[] {
  const where = securityId
    ? "WHERE n.note_type = 'earnings' AND n.security_id = ?"
    : "WHERE n.note_type = 'earnings' AND n.security_id IS NOT NULL";
  const params = securityId ? [securityId] : [];

  const notes = db
    .prepare(`${NOTE_SELECT} ${where} ORDER BY s.symbol ASC, n.event_date ASC`)
    .all(...params) as NoteWithContext[];

  // Group by security
  const grouped = new Map<number, EarningsTimelineEntry>();
  for (const note of notes) {
    if (!note.security_id) continue;
    let entry = grouped.get(note.security_id);
    if (!entry) {
      entry = {
        symbol: note.symbol ?? "???",
        security_name: note.security_name,
        security_id: note.security_id,
        notes: [],
      };
      grouped.set(note.security_id, entry);
    }
    entry.notes.push(note);
  }

  return Array.from(grouped.values());
}

export function getRecentNotes(
  db: Database.Database,
  limit: number = 20
): NoteWithContext[] {
  return db
    .prepare(`${NOTE_SELECT} ORDER BY n.created_at DESC, n.id DESC LIMIT ?`)
    .all(limit) as NoteWithContext[];
}

export function getNoteById(
  db: Database.Database,
  id: number
): NoteWithContext | undefined {
  return db
    .prepare(`${NOTE_SELECT} WHERE n.id = ?`)
    .get(id) as NoteWithContext | undefined;
}

/**
 * Resolve a security symbol to its ID. Returns null if not found.
 */
export function getSecurityIdBySymbol(
  db: Database.Database,
  symbol: string
): number | null {
  const row = db
    .prepare("SELECT id FROM securities WHERE symbol = ? LIMIT 1")
    .get(symbol) as { id: number } | undefined;
  return row?.id ?? null;
}

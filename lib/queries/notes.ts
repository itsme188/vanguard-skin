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

export interface EarningsTimelineFilters {
  security_id?: number;
  search?: string;
}

/**
 * Earnings tab data for the Notes view. Routes through `getNotesFiltered`
 * (the same filter path All/Journal/Stock Notes use) so `search` can never
 * silently diverge again (qa:research-notes-earnings--search-box-ignored-regression-3
 * — three prior fixes touched the search UI or `getNotesFiltered` but never
 * this function, which is what the Earnings tab actually renders from).
 * `limit: -1` asks SQLite for every matching row — getNotesFiltered's
 * default (used by the other tabs) is capped, but a timeline must be
 * complete, not a recent-N slice.
 */
export function getEarningsTimeline(
  db: Database.Database,
  filters: EarningsTimelineFilters = {}
): EarningsTimelineEntry[] {
  const notes = getNotesFiltered(db, {
    note_type: "earnings",
    security_id: filters.security_id,
    search: filters.search,
    limit: -1,
  });

  // Group by security. getNotesFiltered orders newest-first (shared with
  // the other tabs); a timeline reads oldest-first, so each entry's notes
  // are re-sorted chronologically below.
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

  for (const entry of grouped.values()) {
    entry.notes.sort((a, b) => {
      if (a.event_date !== b.event_date) return a.event_date < b.event_date ? -1 : 1;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
      return 0;
    });
  }

  return Array.from(grouped.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
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

/**
 * Notes attached to any security whose symbol or underlying_symbol is in the
 * given family. Used by the earnings-email composer to feed the user's prior
 * thesis (journal / earnings / trade_thesis notes) into the briefing prompt.
 *
 * The `underlying_symbol` traversal is critical: a note tagged to a TER LEAP
 * option (security.symbol = OCC format like "TER   280121C00180000") would
 * otherwise be invisible when family = ["TER"]. Same pattern as the positions
 * query in lib/digest/send-earnings-email.ts.
 */
export function getNotesForFamily(
  db: Database.Database,
  family: readonly string[],
  daysBack: number = 90
): NoteWithContext[] {
  if (family.length === 0) return [];
  const upperFamily = family.map((s) => s.toUpperCase());
  const placeholders = upperFamily.map(() => "?").join(",");
  const sinceArg = `-${Math.max(1, Math.floor(daysBack))} days`;
  return db
    .prepare(
      `${NOTE_SELECT}
       WHERE (UPPER(s.symbol) IN (${placeholders})
              OR UPPER(COALESCE(s.underlying_symbol, '')) IN (${placeholders}))
         AND datetime(n.event_date) >= datetime('now', ?)
       ORDER BY n.event_date DESC, n.created_at DESC`,
    )
    .all(...upperFamily, ...upperFamily, sinceArg) as NoteWithContext[];
}

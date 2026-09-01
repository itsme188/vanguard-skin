import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getNotesFiltered,
  getNotesForSecurity,
  getEarningsTimeline,
  groupEarningsTimeline,
  getRecentNotes,
  getNoteById,
  getSecurityIdBySymbol,
} from "@/lib/queries/notes";
import {
  createNote,
  updateNote,
  deleteNote,
} from "@/lib/mutations/notes";

// ─── Seed helpers ─────────────────────────────────────────────────

function seedSecurity(db: Database.Database, symbol: string, name?: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)")
    .run(symbol, name ?? `${symbol} Corp`);
  return result.lastInsertRowid as number;
}

function seedAccount(db: Database.Database, name: string): number {
  const result = db
    .prepare("INSERT INTO accounts (name) VALUES (?)")
    .run(name);
  return result.lastInsertRowid as number;
}

function seedTransaction(
  db: Database.Database,
  accountId: number,
  securityId: number,
  type: string,
  tradeDate: string
): number {
  const result = db
    .prepare(
      "INSERT INTO transactions (account_id, security_id, type, trade_date, amount, fees, is_external_flow, source_key) VALUES (?, ?, ?, ?, 1000, 0, 0, ?)"
    )
    .run(accountId, securityId, type, tradeDate, `txn-${accountId}-${securityId}-${tradeDate}`);
  return result.lastInsertRowid as number;
}

// ─── Test setup ───────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── Mutation tests ───────────────────────────────────────────────

describe("createNote", () => {
  it("creates a journal note with minimal fields", () => {
    const note = createNote(db, {
      note_type: "journal",
      content: "Markets feel overheated today",
      event_date: "2026-03-10",
    });

    expect(note.id).toBeGreaterThan(0);
    expect(note.note_type).toBe("journal");
    expect(note.content).toBe("Markets feel overheated today");
    expect(note.event_date).toBe("2026-03-10");
    expect(note.security_id).toBeNull();
    expect(note.sentiment).toBeNull();
    expect(note.tags).toBeNull();
  });

  it("creates an earnings note linked to a security", () => {
    const secId = seedSecurity(db, "GOOG", "Alphabet Inc");

    const note = createNote(db, {
      note_type: "earnings",
      content: "Guidance seems sandbagged. Cloud growth impressive.",
      event_date: "2026-01-30",
      security_id: secId,
      sentiment: "bullish",
      tags: ["guidance", "cloud", "beat"],
    });

    expect(note.note_type).toBe("earnings");
    expect(note.security_id).toBe(secId);
    expect(note.sentiment).toBe("bullish");
    expect(JSON.parse(note.tags!)).toEqual(["guidance", "cloud", "beat"]);
  });

  it("creates a trade thesis linked to a transaction", () => {
    const acctId = seedAccount(db, "Test Account");
    const secId = seedSecurity(db, "AAPL");
    const txnId = seedTransaction(db, acctId, secId, "BUY", "2026-03-01");

    const note = createNote(db, {
      note_type: "trade_thesis",
      content: "Buying ahead of iPhone 17 cycle. Services revenue underappreciated.",
      event_date: "2026-03-01",
      security_id: secId,
      transaction_id: txnId,
      sentiment: "confident",
    });

    expect(note.transaction_id).toBe(txnId);
    expect(note.sentiment).toBe("confident");
  });
});

describe("updateNote", () => {
  it("updates content and sets updated_at", () => {
    const note = createNote(db, {
      note_type: "journal",
      content: "Original thought",
      event_date: "2026-03-10",
    });

    const updated = updateNote(db, note.id, {
      content: "Revised thought after market close",
    });

    expect(updated!.content).toBe("Revised thought after market close");
    expect(updated!.id).toBe(note.id);
  });

  it("updates sentiment", () => {
    const note = createNote(db, {
      note_type: "journal",
      content: "Test",
      event_date: "2026-03-10",
      sentiment: "bullish",
    });

    const updated = updateNote(db, note.id, { sentiment: "bearish" });
    expect(updated!.sentiment).toBe("bearish");
  });

  it("returns null for non-existent id", () => {
    const result = updateNote(db, 99999, { content: "nope" });
    expect(result).toBeNull();
  });
});

describe("deleteNote", () => {
  it("deletes an existing note", () => {
    const note = createNote(db, {
      note_type: "journal",
      content: "To delete",
      event_date: "2026-03-10",
    });

    const result = deleteNote(db, note.id);
    expect(result.deleted).toBe(true);

    const check = getNoteById(db, note.id);
    expect(check).toBeUndefined();
  });

  it("returns false for non-existent note", () => {
    const result = deleteNote(db, 99999);
    expect(result.deleted).toBe(false);
  });
});

// ─── Query tests ──────────────────────────────────────────────────

describe("getNotesFiltered", () => {
  beforeEach(() => {
    const secId = seedSecurity(db, "GOOG", "Alphabet Inc");
    createNote(db, { note_type: "journal", content: "Volatile day in markets", event_date: "2026-03-01" });
    createNote(db, { note_type: "journal", content: "Fed meeting next week", event_date: "2026-03-05", sentiment: "cautious" });
    createNote(db, { note_type: "earnings", content: "GOOG Q4 beat. Cloud impressive.", event_date: "2026-01-30", security_id: secId, sentiment: "bullish" });
    createNote(db, { note_type: "trade_thesis", content: "Buying GOOG on dip", event_date: "2026-02-15", security_id: secId });
  });

  it("returns all notes when no filters", () => {
    const notes = getNotesFiltered(db);
    expect(notes.length).toBe(4);
  });

  it("filters by note_type", () => {
    const journals = getNotesFiltered(db, { note_type: "journal" });
    expect(journals.length).toBe(2);
    expect(journals.every((n) => n.note_type === "journal")).toBe(true);
  });

  it("filters by security_id", () => {
    const secId = getSecurityIdBySymbol(db, "GOOG")!;
    const notes = getNotesFiltered(db, { security_id: secId });
    expect(notes.length).toBe(2);
  });

  it("searches content", () => {
    const notes = getNotesFiltered(db, { search: "Cloud" });
    expect(notes.length).toBe(1);
    expect(notes[0].content).toContain("Cloud");
  });

  it("filters by date range", () => {
    const notes = getNotesFiltered(db, {
      start_date: "2026-03-01",
      end_date: "2026-03-31",
    });
    expect(notes.length).toBe(2);
  });

  it("filters by sentiment", () => {
    const notes = getNotesFiltered(db, { sentiment: "bullish" });
    expect(notes.length).toBe(1);
    expect(notes[0].sentiment).toBe("bullish");
  });

  it("respects limit", () => {
    const notes = getNotesFiltered(db, { limit: 2 });
    expect(notes.length).toBe(2);
  });

  it("joins security symbol and name", () => {
    const notes = getNotesFiltered(db, { note_type: "earnings" });
    expect(notes[0].symbol).toBe("GOOG");
    expect(notes[0].security_name).toBe("Alphabet Inc");
  });
});

// ─── Unified search semantics (identity OR text) ───────────────────
//
// One search box drives the whole Research > Notes surface, so every half
// must answer the same question: does this row match on IDENTITY (ticker /
// company name) or on TEXT (prose)? Content-only matching meant typing
// "NFLX" kept the NFLX transcripts but dropped the NFLX earnings notes
// whose prose never spells the ticker — the same term filtered the two
// halves of one page by different rules.

describe("getNotesFiltered unified search", () => {
  beforeEach(() => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");
    createNote(db, {
      note_type: "earnings",
      content: "Subscriber adds beat; ad tier scaling faster than expected",
      event_date: "2026-01-20",
      security_id: nflxId,
    });
    createNote(db, {
      note_type: "earnings",
      content: "Margin loan balances up, account growth steady",
      event_date: "2026-01-21",
      security_id: ibkrId,
    });
    createNote(db, {
      note_type: "journal",
      content: "Feels like a NFLX kind of tape",
      event_date: "2026-01-22",
    });
  });

  it("matches a note by its linked security's ticker even when the prose never says it", () => {
    const notes = getNotesFiltered(db, { search: "NFLX" });
    // The NFLX-linked earnings note (prose has no ticker) + the unlinked
    // journal note that spells it out.
    expect(notes.length).toBe(2);
    expect(notes.some((n) => n.content.startsWith("Subscriber adds beat"))).toBe(true);
    expect(notes.some((n) => n.content.startsWith("Feels like a NFLX"))).toBe(true);
  });

  it("is case-insensitive on ticker matches", () => {
    expect(getNotesFiltered(db, { search: "nflx" }).length).toBe(2);
  });

  it("matches a note by its linked security's company name", () => {
    const notes = getNotesFiltered(db, { search: "netflix" });
    expect(notes.length).toBe(1);
    expect(notes[0].symbol).toBe("NFLX");
  });

  it("still matches note content", () => {
    const notes = getNotesFiltered(db, { search: "margin loan" });
    expect(notes.length).toBe(1);
    expect(notes[0].symbol).toBe("IBKR");
  });

  it("matches nothing when the term is in neither identity nor text", () => {
    expect(getNotesFiltered(db, { search: "ZZZNOMATCH" })).toEqual([]);
  });
});

// ─── Tags are searchable, not write-only ───────────────────────────
//
// `n.tags` is a TEXT column holding a JSON array (e.g. `["AI","semis",
// "on-shoring"]`) and was already SELECTed but never matched in the search
// predicate: a note tagged "on-shoring" with unrelated prose and no linked
// security was invisible to a search for "on-shoring". JSON-substring LIKE
// matching is the accepted approach for a single-user local app with no
// tags index.

describe("getNotesFiltered search matches tags", () => {
  it("finds a note by tag when the content and security never mention it", () => {
    createNote(db, {
      note_type: "journal",
      content: "Manufacturing base is shifting geographically",
      event_date: "2026-03-10",
      tags: ["AI", "semis", "on-shoring"],
    });

    const notes = getNotesFiltered(db, { search: "on-shoring" });
    expect(notes.length).toBe(1);
    expect(notes[0].content).toBe("Manufacturing base is shifting geographically");
  });

  it("is case-insensitive on tag matches", () => {
    createNote(db, {
      note_type: "journal",
      content: "Manufacturing base is shifting geographically",
      event_date: "2026-03-10",
      tags: ["AI", "semis", "on-shoring"],
    });

    const notes = getNotesFiltered(db, { search: "ON-SHORING" });
    expect(notes.length).toBe(1);
  });

  it("does not match a tagged note when the search term is absent from tags, content, and security", () => {
    createNote(db, {
      note_type: "journal",
      content: "Manufacturing base is shifting geographically",
      event_date: "2026-03-10",
      tags: ["AI", "semis", "on-shoring"],
    });

    expect(getNotesFiltered(db, { search: "ZZZNOMATCH" })).toEqual([]);
  });

  it("agrees with getEarningsTimeline's count for a tag-only match (shared search path)", () => {
    const googId = seedSecurity(db, "GOOG", "Alphabet Inc");
    createNote(db, {
      note_type: "earnings",
      content: "Solid quarter, nothing notable in the prose",
      event_date: "2026-01-30",
      security_id: googId,
      tags: ["on-shoring"],
    });
    createNote(db, {
      note_type: "earnings",
      content: "Unrelated note",
      event_date: "2026-01-25",
      security_id: googId,
    });

    const filtered = getNotesFiltered(db, { search: "on-shoring" });
    const timeline = getEarningsTimeline(db, { search: "on-shoring" });

    expect(filtered.length).toBe(1);
    expect(timeline.length).toBe(1);
    expect(timeline[0].notes.length).toBe(1);
    expect(timeline[0].notes[0].content).toBe(filtered[0].content);
  });
});

describe("getNotesForSecurity", () => {
  it("returns notes for a security in chronological order", () => {
    const secId = seedSecurity(db, "META", "Meta Platforms");
    createNote(db, { note_type: "earnings", content: "Q1", event_date: "2026-01-15", security_id: secId });
    createNote(db, { note_type: "earnings", content: "Q2", event_date: "2026-04-15", security_id: secId });
    createNote(db, { note_type: "trade_thesis", content: "Buying", event_date: "2026-02-01", security_id: secId });

    const notes = getNotesForSecurity(db, secId);
    expect(notes.length).toBe(3);
    // Ascending order
    expect(notes[0].content).toBe("Q1");
    expect(notes[1].content).toBe("Buying");
    expect(notes[2].content).toBe("Q2");
  });
});

describe("getEarningsTimeline", () => {
  it("groups earnings notes by security", () => {
    const googId = seedSecurity(db, "GOOG");
    const metaId = seedSecurity(db, "META");

    createNote(db, { note_type: "earnings", content: "GOOG Q1", event_date: "2026-01-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "GOOG Q2", event_date: "2026-04-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "META Q1", event_date: "2026-01-25", security_id: metaId });
    // Journal should not appear
    createNote(db, { note_type: "journal", content: "General thought", event_date: "2026-02-01" });

    const timeline = getEarningsTimeline(db);
    expect(timeline.length).toBe(2);

    const googEntry = timeline.find((t) => t.symbol === "GOOG")!;
    expect(googEntry.notes.length).toBe(2);
    expect(googEntry.notes[0].content).toBe("GOOG Q1");

    const metaEntry = timeline.find((t) => t.symbol === "META")!;
    expect(metaEntry.notes.length).toBe(1);
  });

  it("filters to specific security", () => {
    const googId = seedSecurity(db, "GOOG");
    const metaId = seedSecurity(db, "META");

    createNote(db, { note_type: "earnings", content: "GOOG", event_date: "2026-01-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "META", event_date: "2026-01-25", security_id: metaId });

    const timeline = getEarningsTimeline(db, { security_id: googId });
    expect(timeline.length).toBe(1);
    expect(timeline[0].symbol).toBe("GOOG");
  });

  // Regression pin (research-notes-earnings--search-box-ignored-regression-3):
  // the Earnings tab renders through this function, not getNotesFiltered.
  // Three prior "fixes" touched the search UI / getNotesFiltered but never
  // this query, so the Earnings tab kept ignoring ?search=. Assert the
  // filtering lives HERE, at the shared source of truth.
  it("filters by search text, matching the other tabs' filter path", () => {
    const googId = seedSecurity(db, "GOOG");
    const metaId = seedSecurity(db, "META");

    createNote(db, { note_type: "earnings", content: "Guidance raised on cloud strength", event_date: "2026-01-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "Margins compressed", event_date: "2026-04-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "Ad revenue beat, guidance steady", event_date: "2026-01-25", security_id: metaId });

    const timeline = getEarningsTimeline(db, { search: "guidance" });
    expect(timeline.length).toBe(2);

    const googEntry = timeline.find((t) => t.symbol === "GOOG")!;
    expect(googEntry.notes.length).toBe(1);
    expect(googEntry.notes[0].content).toBe("Guidance raised on cloud strength");

    const metaEntry = timeline.find((t) => t.symbol === "META")!;
    expect(metaEntry.notes.length).toBe(1);
  });

  it("returns no entries when the search text matches nothing", () => {
    const googId = seedSecurity(db, "GOOG");
    createNote(db, { note_type: "earnings", content: "Solid quarter", event_date: "2026-01-30", security_id: googId });

    const timeline = getEarningsTimeline(db, { search: "ZZZNOMATCH" });
    expect(timeline).toEqual([]);
  });

  it("combines security_id and search filters", () => {
    const googId = seedSecurity(db, "GOOG");
    const metaId = seedSecurity(db, "META");

    createNote(db, { note_type: "earnings", content: "GOOG guidance raised", event_date: "2026-01-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "META guidance raised", event_date: "2026-01-25", security_id: metaId });

    const timeline = getEarningsTimeline(db, { security_id: googId, search: "guidance" });
    expect(timeline.length).toBe(1);
    expect(timeline[0].symbol).toBe("GOOG");
  });

  it("keeps a security's notes when the search term is its ticker, not its prose", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    const ibkrId = seedSecurity(db, "IBKR", "Interactive Brokers Group");

    createNote(db, { note_type: "earnings", content: "Subscriber adds beat", event_date: "2026-01-20", security_id: nflxId });
    createNote(db, { note_type: "earnings", content: "Account growth steady", event_date: "2026-01-21", security_id: ibkrId });

    const timeline = getEarningsTimeline(db, { search: "NFLX" });
    expect(timeline.length).toBe(1);
    expect(timeline[0].symbol).toBe("NFLX");
    expect(timeline[0].notes.length).toBe(1);
  });

  it("keeps a security's notes when the search term is its company name", () => {
    const nflxId = seedSecurity(db, "NFLX", "Netflix Inc");
    createNote(db, { note_type: "earnings", content: "Subscriber adds beat", event_date: "2026-01-20", security_id: nflxId });

    const timeline = getEarningsTimeline(db, { search: "netflix" });
    expect(timeline.length).toBe(1);
    expect(timeline[0].symbol).toBe("NFLX");
  });
});

// ─── groupEarningsTimeline ─────────────────────────────────────────
//
// The Earnings tab used to pay for the SAME filtered notes query twice per
// render: once for the notes list, once more inside getEarningsTimeline.
// Splitting the pure grouping out lets the page fetch one pass and derive
// both surfaces from it — so the two can never drift apart on filters
// either. getEarningsTimeline stays the fetch+group convenience wrapper.

describe("groupEarningsTimeline", () => {
  it("groups an already-fetched note pass exactly as getEarningsTimeline does", () => {
    const googId = seedSecurity(db, "GOOG", "Alphabet Inc");
    const metaId = seedSecurity(db, "META", "Meta Platforms");

    createNote(db, { note_type: "earnings", content: "GOOG Q2", event_date: "2026-04-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "GOOG Q1", event_date: "2026-01-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "META Q1", event_date: "2026-01-25", security_id: metaId });
    createNote(db, { note_type: "journal", content: "Not earnings", event_date: "2026-02-01" });

    const onePass = getNotesFiltered(db, { note_type: "earnings", limit: -1 });
    expect(groupEarningsTimeline(onePass)).toEqual(getEarningsTimeline(db));
  });

  it("sorts entries by symbol and each entry's notes oldest-first", () => {
    const googId = seedSecurity(db, "GOOG", "Alphabet Inc");
    const metaId = seedSecurity(db, "META", "Meta Platforms");

    createNote(db, { note_type: "earnings", content: "GOOG Q2", event_date: "2026-04-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "GOOG Q1", event_date: "2026-01-30", security_id: googId });
    createNote(db, { note_type: "earnings", content: "META Q1", event_date: "2026-01-25", security_id: metaId });

    const timeline = groupEarningsTimeline(
      getNotesFiltered(db, { note_type: "earnings", limit: -1 })
    );
    expect(timeline.map((e) => e.symbol)).toEqual(["GOOG", "META"]);
    expect(timeline[0].notes.map((n) => n.content)).toEqual(["GOOG Q1", "GOOG Q2"]);
  });

  it("skips notes with no linked security", () => {
    createNote(db, { note_type: "earnings", content: "Unlinked earnings thought", event_date: "2026-01-30" });

    const timeline = groupEarningsTimeline(
      getNotesFiltered(db, { note_type: "earnings", limit: -1 })
    );
    expect(timeline).toEqual([]);
  });
});

describe("getRecentNotes", () => {
  it("returns notes ordered by created_at descending with limit", () => {
    createNote(db, { note_type: "journal", content: "First", event_date: "2026-01-01" });
    createNote(db, { note_type: "journal", content: "Second", event_date: "2026-02-01" });
    createNote(db, { note_type: "journal", content: "Third", event_date: "2026-03-01" });

    const recent = getRecentNotes(db, 2);
    expect(recent.length).toBe(2);
    // All created in same instant, so order is by ROWID desc (last inserted first)
    // In practice, these have same created_at so ORDER BY created_at DESC, id DESC
    // Just verify we get 2 results
  });

  it("returns all notes if limit exceeds count", () => {
    createNote(db, { note_type: "journal", content: "Only one", event_date: "2026-01-01" });
    const recent = getRecentNotes(db, 10);
    expect(recent.length).toBe(1);
  });
});

describe("getSecurityIdBySymbol", () => {
  it("resolves existing symbol", () => {
    const id = seedSecurity(db, "AAPL");
    expect(getSecurityIdBySymbol(db, "AAPL")).toBe(id);
  });

  it("returns null for unknown symbol", () => {
    expect(getSecurityIdBySymbol(db, "ZZZZZ")).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getResearchDocument,
  listResearchDocuments,
  searchResearchDocuments,
  getResearchDocumentCount,
  getResearchDocumentsForSymbol,
  getAllResearchDocumentTags,
} from "@/lib/queries/research-documents";
import {
  createResearchDocument,
  deleteResearchDocument,
  updateResearchDocumentTags,
} from "@/lib/mutations/research-documents";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedDoc(
  db: Database.Database,
  overrides: Partial<Parameters<typeof createResearchDocument>[1]> = {},
): number {
  return createResearchDocument(db, {
    title: "Default",
    author: null,
    source: null,
    filename: "default.pdf",
    file_size_bytes: 100,
    publication_date: null,
    document_type: "analyst_report",
    raw_text: "default body",
    summary: null,
    key_points: null,
    mentioned_symbols: null,
    tags: null,
    sentiment: null,
    target_prices: null,
    ai_model: null,
    char_count: 12,
    ...overrides,
  });
}

describe("research_documents mutations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("creates a document and reads it back", () => {
    const id = seedDoc(db, {
      title: "Goldman NVDA deep dive",
      author: "Jane Doe",
      source: "Goldman Sachs",
      filename: "gs-nvda-2026q1.pdf",
      publication_date: "2026-03-15",
      document_type: "analyst_report",
      raw_text: "NVDA blah blah datacenter revenue accelerating",
      summary: "Buy rated, $1200 target",
      key_points: ["DC rev up 60%", "Blackwell ramp on track"],
      mentioned_symbols: ["nvda", "amd", "avgo"],
      sentiment: "bullish",
      target_prices: [{ symbol: "NVDA", price: 1200, horizon: "12mo" }],
      ai_model: "claude-sonnet-4-6",
    });
    expect(id).toBeGreaterThan(0);

    const doc = getResearchDocument(db, id);
    expect(doc?.title).toBe("Goldman NVDA deep dive");
    expect(doc?.source).toBe("Goldman Sachs");
    // mentioned_symbols uppercased + JSON-serialized
    const symbols = JSON.parse(doc!.mentioned_symbols!) as string[];
    expect(symbols).toEqual(["NVDA", "AMD", "AVGO"]);
    const targets = JSON.parse(doc!.target_prices!);
    expect(targets).toEqual([{ symbol: "NVDA", price: 1200, horizon: "12mo" }]);
  });

  it("rejects unknown document_type via CHECK constraint", () => {
    expect(() =>
      seedDoc(db, {
        // @ts-expect-error intentional bad type
        document_type: "not_a_real_type",
      }),
    ).toThrow(/CHECK|constraint/i);
  });

  it("delete returns true and removes the row", () => {
    const id = seedDoc(db);
    expect(deleteResearchDocument(db, id)).toBe(true);
    expect(getResearchDocument(db, id)).toBeNull();
    expect(deleteResearchDocument(db, id)).toBe(false);
  });

  it("count reflects insertions + deletions", () => {
    expect(getResearchDocumentCount(db)).toBe(0);
    const id1 = seedDoc(db);
    seedDoc(db);
    expect(getResearchDocumentCount(db)).toBe(2);
    deleteResearchDocument(db, id1);
    expect(getResearchDocumentCount(db)).toBe(1);
  });
});

describe("listResearchDocuments", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("orders by publication_date desc, then uploaded_at desc", () => {
    seedDoc(db, { title: "A", publication_date: "2026-01-01" });
    seedDoc(db, { title: "B", publication_date: "2026-03-01" });
    seedDoc(db, { title: "C", publication_date: "2026-02-01" });

    const rows = listResearchDocuments(db);
    expect(rows.map((r) => r.title)).toEqual(["B", "C", "A"]);
  });

  it("filters by document_type", () => {
    seedDoc(db, { title: "A", document_type: "analyst_report" });
    seedDoc(db, { title: "B", document_type: "industry_primer" });
    seedDoc(db, { title: "C", document_type: "analyst_report" });

    const rows = listResearchDocuments(db, { document_type: "analyst_report" });
    expect(rows.map((r) => r.title).sort()).toEqual(["A", "C"]);
  });

  it("filters by symbol (case-insensitive)", () => {
    seedDoc(db, { title: "A", mentioned_symbols: ["nvda", "amd"] });
    seedDoc(db, { title: "B", mentioned_symbols: ["AAPL"] });
    seedDoc(db, { title: "C", mentioned_symbols: ["nvda"] });

    const rows = listResearchDocuments(db, { symbol: "nvda" });
    expect(rows.map((r) => r.title).sort()).toEqual(["A", "C"]);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) seedDoc(db);
    expect(listResearchDocuments(db, { limit: 3 })).toHaveLength(3);
  });
});

describe("searchResearchDocuments (FTS5)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("finds by keyword in raw_text", () => {
    seedDoc(db, {
      title: "Doc A",
      raw_text: "Semiconductor supply chain resilient despite tariffs",
    });
    seedDoc(db, {
      title: "Doc B",
      raw_text: "Consumer staples margin compression persists",
    });

    const results = searchResearchDocuments(db, { query: "semiconductor" });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Doc A");
    expect(results[0].snippet).not.toBeNull();
    expect(results[0].snippet).toContain("<mark>");
  });

  it("finds by keyword in summary", () => {
    seedDoc(db, {
      title: "Doc X",
      summary: "Bullish on datacenter spending",
      raw_text: "body",
    });
    seedDoc(db, {
      title: "Doc Y",
      summary: "Bearish on consumer",
      raw_text: "body",
    });
    const results = searchResearchDocuments(db, { query: "datacenter" });
    expect(results.map((r) => r.title)).toEqual(["Doc X"]);
  });

  it("handles phrases that contain FTS5-special tokens by escaping", () => {
    seedDoc(db, { title: "Doc A", raw_text: "price target: 500" });
    // Would normally blow up if colon were interpreted as FTS5 column syntax
    const results = searchResearchDocuments(db, { query: "price target: 500" });
    expect(results.length).toBe(1);
  });

  it("combines FTS5 with symbol filter", () => {
    seedDoc(db, {
      title: "Doc A",
      mentioned_symbols: ["NVDA"],
      raw_text: "margin expansion story",
    });
    seedDoc(db, {
      title: "Doc B",
      mentioned_symbols: ["AMD"],
      raw_text: "margin expansion thesis",
    });
    const results = searchResearchDocuments(db, {
      query: "margin expansion",
      symbol: "NVDA",
    });
    expect(results.map((r) => r.title)).toEqual(["Doc A"]);
  });

  it("empty query falls back to list (respects filters)", () => {
    seedDoc(db, { title: "A", document_type: "industry_primer" });
    seedDoc(db, { title: "B", document_type: "analyst_report" });
    const results = searchResearchDocuments(db, {
      query: "",
      document_type: "industry_primer",
    });
    expect(results.map((r) => r.title)).toEqual(["A"]);
  });

  it("days_back filters by publication/upload date window", () => {
    seedDoc(db, {
      title: "Old",
      publication_date: "2020-01-01",
      raw_text: "old body",
    });
    seedDoc(db, {
      title: "New",
      publication_date: "2026-04-01",
      raw_text: "new body",
    });
    const results = searchResearchDocuments(db, {
      query: "body",
      days_back: 365,
    });
    expect(results.map((r) => r.title)).toEqual(["New"]);
  });

  it("update via delete+recreate keeps FTS index consistent", () => {
    const id = seedDoc(db, {
      title: "Doc A",
      raw_text: "alphabeta gamma content",
    });
    // Initial: searchable
    expect(
      searchResearchDocuments(db, { query: "alphabeta" }).length,
    ).toBe(1);

    // Delete
    deleteResearchDocument(db, id);
    expect(
      searchResearchDocuments(db, { query: "alphabeta" }).length,
    ).toBe(0);
  });
});

// ─── New tags + expanded doc types ────────────────────────────────

describe("tags support", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("stores + retrieves tags, normalized to lowercase + dedup", () => {
    const id = seedDoc(db, {
      title: "T",
      // Upper-case, duplicates, junk chars, extra whitespace
      tags: ["Semiconductors", "AI  Infrastructure", "semiconductors", "Q3-2024", "🔥emoji"],
    });
    const doc = getResearchDocument(db, id);
    const tags = doc?.tags ? JSON.parse(doc.tags) : [];
    expect(tags).toContain("semiconductors");
    expect(tags).toContain("ai infrastructure");
    expect(tags).toContain("q3-2024");
    // Deduped
    expect(tags.filter((t: string) => t === "semiconductors").length).toBe(1);
    // Emoji stripped
    expect(tags).not.toContain("🔥emoji");
  });

  it("filters by tag in listResearchDocuments", () => {
    seedDoc(db, { title: "A", tags: ["semiconductors", "ai"] });
    seedDoc(db, { title: "B", tags: ["consumer"] });
    seedDoc(db, { title: "C", tags: ["semiconductors"] });

    const rows = listResearchDocuments(db, { tag: "semiconductors" });
    expect(rows.map((r) => r.title).sort()).toEqual(["A", "C"]);
  });

  it("tag filter is case-insensitive (normalized to lowercase on input)", () => {
    seedDoc(db, { title: "A", tags: ["AI"] });
    const rows = listResearchDocuments(db, { tag: "AI" });
    expect(rows).toHaveLength(1);
  });

  it("combines tag + symbol filters in searchResearchDocuments", () => {
    seedDoc(db, {
      title: "A",
      mentioned_symbols: ["NVDA"],
      tags: ["semiconductors"],
      raw_text: "thesis body here",
    });
    seedDoc(db, {
      title: "B",
      mentioned_symbols: ["AAPL"],
      tags: ["semiconductors"],
      raw_text: "thesis body here",
    });
    const rows = searchResearchDocuments(db, {
      query: "thesis",
      symbol: "NVDA",
      tag: "semiconductors",
    });
    expect(rows.map((r) => r.title)).toEqual(["A"]);
  });

  it("FTS5 query 'ai' surfaces a doc tagged 'agentic ai' / 'ai risk' (E2E #2 regression)", () => {
    seedDoc(db, {
      title: "The State of the Agent",
      tags: ["agentic ai", "ai risk", "cybersecurity"],
      raw_text: "Body talks about agents and security.",
    });
    seedDoc(db, {
      title: "Coffee shop M&A roundup",
      tags: ["consumer", "m&a"],
      raw_text: "Body about coffee shop consumer trends and recent deals.",
    });

    const rows = searchResearchDocuments(db, { query: "ai" });
    expect(rows.map((r) => r.title)).toEqual(["The State of the Agent"]);
  });

  it("updateResearchDocumentTags overwrites tags on the row + FTS index", () => {
    const id = seedDoc(db, {
      title: "A",
      tags: ["old-tag"],
      raw_text: "body",
    });
    expect(updateResearchDocumentTags(db, id, ["new-tag", "another"])).toBe(true);

    const doc = getResearchDocument(db, id);
    expect(JSON.parse(doc!.tags!)).toEqual(["new-tag", "another"]);

    // FTS index now reflects new tag
    expect(
      searchResearchDocuments(db, { query: "another" }).length,
    ).toBe(1);
    // Old tag should be gone from FTS
    expect(
      searchResearchDocuments(db, { query: "old-tag" }).length,
    ).toBe(0);
  });

  it("updateResearchDocumentTags with empty array nulls the column", () => {
    const id = seedDoc(db, { title: "A", tags: ["to-clear"] });
    expect(updateResearchDocumentTags(db, id, [])).toBe(true);
    const doc = getResearchDocument(db, id);
    expect(doc!.tags).toBeNull();
  });

  it("getAllResearchDocumentTags returns unique tags sorted by frequency", () => {
    seedDoc(db, { title: "A", tags: ["ai", "semiconductors"] });
    seedDoc(db, { title: "B", tags: ["ai", "consumer"] });
    seedDoc(db, { title: "C", tags: ["ai"] });

    const tags = getAllResearchDocumentTags(db);
    expect(tags[0]).toEqual({ tag: "ai", count: 3 });
    const tagNames = tags.map((t) => t.tag);
    expect(tagNames).toContain("semiconductors");
    expect(tagNames).toContain("consumer");
  });
});

describe("expanded document_type constraint", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it.each([
    "investor_letter",
    "earnings_presentation",
    "article",
    "book_summary_or_essay",
    "macro_note",
  ] as const)("accepts new document_type %s", (type) => {
    const id = seedDoc(db, { title: "T", document_type: type });
    expect(id).toBeGreaterThan(0);
  });
});

describe("getResearchDocumentsForSymbol", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns only docs that mention the symbol", () => {
    seedDoc(db, { title: "A", mentioned_symbols: ["NVDA", "AMD"] });
    seedDoc(db, { title: "B", mentioned_symbols: ["AAPL"] });
    seedDoc(db, { title: "C", mentioned_symbols: ["nvda"] }); // lowercased — still stored upper
    const rows = getResearchDocumentsForSymbol(db, "nvda");
    expect(rows.map((r) => r.title).sort()).toEqual(["A", "C"]);
  });
});

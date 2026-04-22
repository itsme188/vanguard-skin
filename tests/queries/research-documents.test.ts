import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getResearchDocument,
  listResearchDocuments,
  searchResearchDocuments,
  getResearchDocumentCount,
} from "@/lib/queries/research-documents";
import {
  createResearchDocument,
  deleteResearchDocument,
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

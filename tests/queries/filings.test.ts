import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCachedFilingSection,
  getLatestCachedSection,
} from "@/lib/queries/filings";
import { upsertFilingSection } from "@/lib/mutations/filings";
import {
  stripFilingHtml,
  extractItemSection,
} from "@/lib/apis/edgar";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("filing_sections mutations + queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("inserts a new row and reads it back", () => {
    const id = upsertFilingSection(db, {
      symbol: "aapl",
      cik: "0000320193",
      filing_type: "10-K",
      accession_number: "0000320193-25-000123",
      filing_date: "2025-11-01",
      section_name: "risk_factors",
      summary: "Apple faces competition in smartphones.",
      key_points: JSON.stringify(["Competition", "Supply chain"]),
      source_url: "https://www.sec.gov/x",
      char_count: 42000,
      model_id: "claude-sonnet-4-6",
    });
    expect(id).toBeGreaterThan(0);

    // Symbol should be normalized to uppercase
    const row = getCachedFilingSection(
      db,
      "AAPL",
      "0000320193-25-000123",
      "risk_factors",
    );
    expect(row).not.toBeNull();
    expect(row?.symbol).toBe("AAPL");
    expect(row?.summary).toContain("smartphones");
    expect(row?.model_id).toBe("claude-sonnet-4-6");
  });

  it("upsert overwrites the summary for the same (symbol, accession, section)", () => {
    upsertFilingSection(db, {
      symbol: "AAPL",
      cik: "0000320193",
      filing_type: "10-K",
      accession_number: "0000320193-25-000123",
      filing_date: "2025-11-01",
      section_name: "mda",
      summary: "v1",
      key_points: null,
      source_url: null,
      char_count: 0,
      model_id: null,
    });
    upsertFilingSection(db, {
      symbol: "AAPL",
      cik: "0000320193",
      filing_type: "10-K",
      accession_number: "0000320193-25-000123",
      filing_date: "2025-11-01",
      section_name: "mda",
      summary: "v2",
      key_points: null,
      source_url: null,
      char_count: 0,
      model_id: null,
    });
    const row = getCachedFilingSection(
      db,
      "AAPL",
      "0000320193-25-000123",
      "mda",
    );
    expect(row?.summary).toBe("v2");
  });

  it("distinguishes sections on the same accession", () => {
    const base = {
      symbol: "AAPL",
      cik: "0000320193",
      filing_type: "10-K" as const,
      accession_number: "0000320193-25-000123",
      filing_date: "2025-11-01",
      key_points: null,
      source_url: null,
      char_count: 0,
      model_id: null,
    };
    upsertFilingSection(db, { ...base, section_name: "risk_factors", summary: "risks" });
    upsertFilingSection(db, { ...base, section_name: "mda", summary: "mgmt" });
    expect(
      getCachedFilingSection(db, "AAPL", base.accession_number, "risk_factors")
        ?.summary,
    ).toBe("risks");
    expect(
      getCachedFilingSection(db, "AAPL", base.accession_number, "mda")?.summary,
    ).toBe("mgmt");
  });

  it("getLatestCachedSection picks the most recent filing_date", () => {
    const base = {
      symbol: "NVDA",
      cik: "0001045810",
      filing_type: "10-Q" as const,
      section_name: "risk_factors" as const,
      key_points: null,
      source_url: null,
      char_count: 0,
      model_id: null,
    };
    upsertFilingSection(db, {
      ...base,
      accession_number: "a-old",
      filing_date: "2025-02-01",
      summary: "older",
    });
    upsertFilingSection(db, {
      ...base,
      accession_number: "a-new",
      filing_date: "2025-08-01",
      summary: "newer",
    });
    const latest = getLatestCachedSection(db, "NVDA", "10-Q", "risk_factors");
    expect(latest?.summary).toBe("newer");
  });
});

describe("stripFilingHtml", () => {
  it("removes tags and decodes entities", () => {
    const html =
      '<p>Risk: <b>high</b>&amp;<br/>ongoing.</p><div>Second &nbsp; line.</div>';
    const out = stripFilingHtml(html);
    expect(out).not.toMatch(/<[^>]+>/);
    expect(out).toContain("high");
    expect(out).toContain("&");
    expect(out).toContain("ongoing");
    expect(out).toContain("Second");
  });

  it("collapses excess whitespace", () => {
    const html = "<p>a</p>\n\n\n\n\n\n<p>b</p>";
    const out = stripFilingHtml(html);
    expect(out.match(/\n{3,}/)).toBeNull();
  });
});

describe("extractItemSection", () => {
  it("extracts Item 1A Risk Factors body from a 10-K", () => {
    const text = [
      "PART I",
      "Item 1. Business",
      "We do stuff.",
      "Item 1A. Risk Factors",
      "A".repeat(800), // body long enough to pass TOC filter
      "Item 1B. Unresolved Staff Comments",
      "None.",
      "Item 2. Properties",
    ].join("\n\n");

    const out = extractItemSection(text, "10-K", "risk_factors");
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(600);
    expect(out!).not.toContain("Item 1B");
  });

  it("skips TOC entries where no body follows between headings", () => {
    const textWithToc = [
      "TABLE OF CONTENTS",
      "Item 1A. Risk Factors .......... 12",
      "Item 1B. Unresolved Staff Comments .......... 45",
      "Item 2. Properties .......... 46",
      "PART I",
      "Item 1A. Risk Factors",
      "B".repeat(800),
      "Item 1B. Unresolved Staff Comments",
    ].join("\n\n");

    const out = extractItemSection(textWithToc, "10-K", "risk_factors");
    expect(out).not.toBeNull();
    // Should be the body instance, not the TOC instance
    expect(out!).toContain("BBB");
  });

  it("finds MD&A Item 7 in 10-K", () => {
    const text = [
      "Item 6. [Reserved]",
      "Item 7. Management's Discussion and Analysis of Financial Condition",
      "C".repeat(900),
      "Item 7A. Quantitative and Qualitative Disclosures",
    ].join("\n\n");
    const out = extractItemSection(text, "10-K", "mda");
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(600);
  });

  it("finds MD&A Item 2 in 10-Q", () => {
    const text = [
      "Item 1. Financial Statements",
      "Balance sheet stuff.",
      "Item 2. Management's Discussion and Analysis of Operations",
      "D".repeat(900),
      "Item 3. Quantitative and Qualitative Disclosures",
    ].join("\n\n");
    const out = extractItemSection(text, "10-Q", "mda");
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(600);
  });

  it("returns null when the section isn't present", () => {
    const text = "Some unrelated text without any SEC headings at all.";
    expect(extractItemSection(text, "10-K", "risk_factors")).toBeNull();
    expect(extractItemSection(text, "10-K", "mda")).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertTranscript } from "@/lib/mutations/transcripts";
import { getTranscriptForChat } from "@/lib/transcripts/fetch";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedCached(
  db: Database.Database,
  ticker: string,
  year: number,
  quarter: number,
  source: "motley_fool" | "edgar_8k" | "api_ninjas",
  transcript: string,
) {
  upsertTranscript(db, {
    ticker,
    year,
    quarter,
    call_date: "2026-01-30",
    source,
    transcript,
    summary: "seed summary",
    guidance: null,
    risk_factors: null,
    sentiment_score: null,
    sentiment_label: null,
    participants: null,
    accession_number: source === "edgar_8k" ? "seed-accession" : null,
    filing_url: null,
    source_key: `${source}:${ticker}:${year}:${quarter}`,
  });
}

function wordy(words: number): string {
  return Array.from({ length: words }, (_, i) => `word${i}`).join(" ");
}

describe("getTranscriptForChat — excerpt vs full text", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("returns a 1000-word excerpt by default + truncated=true when source is long", async () => {
    seedCached(db, "AAPL", 2026, 1, "motley_fool", wordy(1500));
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1);
    expect(out).not.toBeNull();
    expect(out!.transcript_length_words).toBe(1500);
    expect(out!.excerpt).toMatch(/\.\.\.$/);
    expect(out!.excerpt!.split(/\s+/).length).toBeLessThanOrEqual(1001);
    expect(out!.truncated).toBe(true);
  });

  it("returns the full body when include_full_text=true", async () => {
    seedCached(db, "AAPL", 2026, 1, "motley_fool", wordy(1500));
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, {
      fullText: true,
    });
    expect(out!.excerpt).toBe(wordy(1500));
    expect(out!.truncated).toBe(false);
  });

  it("returns full text unmodified when body is already short (<1000 words)", async () => {
    const short = wordy(200);
    seedCached(db, "AAPL", 2026, 1, "motley_fool", short);
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1);
    expect(out!.excerpt).toBe(short);
    expect(out!.truncated).toBe(false);
  });

  it("legacy edgar_8k cache (<=5200 chars) is invalidated when fullText=true", async () => {
    // Seed a cache row that looks like the pre-E2 EDGAR truncation.
    const legacy = "x".repeat(4800);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", legacy);

    // Verify the legacy row was seeded via its deterministic source_key.
    const seeded = db
      .prepare("SELECT transcript FROM earnings_transcripts WHERE source_key = ?")
      .get("edgar_8k:AAPL:2026:1") as { transcript: string } | undefined;
    expect(seeded?.transcript).toBe(legacy);

    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, {
      fullText: true,
    });

    // Either the re-fetch succeeded (new content != legacy) or it failed and
    // the row is gone entirely. Both outcomes are correct — the legacy
    // short body must never be returned under a "full text" claim.
    if (out !== null) {
      expect(out.excerpt).not.toBe(legacy);
    }
    const afterRow = db
      .prepare("SELECT transcript FROM earnings_transcripts WHERE source_key = ?")
      .get("edgar_8k:AAPL:2026:1") as { transcript: string } | undefined;
    if (afterRow) {
      expect(afterRow.transcript).not.toBe(legacy);
    }
  });

  it("legacy edgar_8k cache is NOT invalidated when fullText=false (excerpt is fine)", async () => {
    const legacy = "x".repeat(4800);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", legacy);
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1);
    // Cache survived and the excerpt contains the legacy body.
    expect(out).not.toBeNull();
    const stillCached = db
      .prepare("SELECT COUNT(*) as c FROM earnings_transcripts")
      .get() as { c: number };
    expect(stillCached.c).toBe(1);
  });

  it("long edgar_8k cache (>5200 chars) is NOT re-fetched even when fullText=true", async () => {
    // An already-upgraded cache row (say 20K chars) should pass through
    // without being evicted — re-fetching would waste an EDGAR round trip.
    const modern = "x".repeat(20_000);
    seedCached(db, "AAPL", 2026, 1, "edgar_8k", modern);
    const out = await getTranscriptForChat(db, "AAPL", 2026, 1, {
      fullText: true,
    });
    expect(out!.excerpt).toBe(modern);
    const stillCached = db
      .prepare("SELECT COUNT(*) as c FROM earnings_transcripts")
      .get() as { c: number };
    expect(stillCached.c).toBe(1);
  });
});

/**
 * tests/digest/adaptive-layout.test.ts
 *
 * Tests for generateDigestSinceAdaptive — the adaptive synthesis-vs-per-source
 * composer introduced in Task 2.4.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// ---------------------------------------------------------------------------
// Mocks — must be hoisted above imports of the module under test
// ---------------------------------------------------------------------------

vi.mock("@/lib/digest/synthesize", () => ({
  synthesize: vi.fn(),
  SynthesisEmptyError: class SynthesisEmptyError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "SynthesisEmptyError";
    }
  },
}));

vi.mock("@/lib/digest/anomalies", () => ({
  computeAnomalies: vi.fn(() => []),
  formatVanguardAnomaliesBlock: vi.fn(() => ""),
}));

// ---------------------------------------------------------------------------
// Deferred imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { generateDigestSinceAdaptive } from "@/lib/digest/daily-digest";
import { synthesize, SynthesisEmptyError } from "@/lib/digest/synthesize";
import { formatVanguardAnomaliesBlock } from "@/lib/digest/anomalies";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

/** Seed a research_source + N processed articles. */
function seedArticles(count: number, sourceName = "Vital Knowledge"): void {
  const src = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)"
    )
    .run(sourceName, `${sourceName.toLowerCase().replace(/ /g, "")}@example.com`);

  const sourceId = src.lastInsertRowid as number;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at,
          source_url, mentioned_symbols)
       VALUES (?, ?, ?, ?, ?, ?, 'neutral', datetime('now'), ?, ?)`
    ).run(
      sourceId,
      `Article ${i + 1}`,
      `${sourceName.toLowerCase().replace(/ /g, "")}@example.com`,
      now,
      "Body",
      `Summary for article ${i + 1}`,
      `https://example.com/article-${i + 1}`,
      JSON.stringify(["AAPL"]),
    );
  }
}

const SYNTHESIS_RESULT = `## AAPL\nApple coverage was bullish across sources today. [Vital Knowledge](https://example.com) notes strong iPhone demand. Good synthesis here.\n\n## Also covered\nSome other items.`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateDigestSinceAdaptive — null path", () => {
  it("returns null when no articles AND no alerts", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await generateDigestSinceAdaptive(db, yesterday);
    expect(result).toBeNull();
  });
});

describe("generateDigestSinceAdaptive — per-source path (<5 articles)", () => {
  it("renders per-source headers when article count < 5", async () => {
    seedArticles(3);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await generateDigestSinceAdaptive(db, yesterday);

    expect(result).not.toBeNull();
    // Per-source layout uses uppercase source name headers
    expect(result).toContain("VITAL KNOWLEDGE");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("does NOT call synthesize when article count < 5", async () => {
    seedArticles(2);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    await generateDigestSinceAdaptive(db, yesterday);
    expect(synthesize).not.toHaveBeenCalled();
  });
});

describe("generateDigestSinceAdaptive — synthesis path (>=5 articles)", () => {
  it("calls synthesize when article count >= 5", async () => {
    vi.mocked(synthesize).mockResolvedValue(SYNTHESIS_RESULT);
    seedArticles(5);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await generateDigestSinceAdaptive(db, yesterday);

    expect(synthesize).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    // Synthesis text should appear in output
    expect(result).toContain("## AAPL");
  });

  it("includes per-source tail (source links) after synthesis text", async () => {
    vi.mocked(synthesize).mockResolvedValue(SYNTHESIS_RESULT);
    seedArticles(5);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await generateDigestSinceAdaptive(db, yesterday);

    // Per-source tail is concise link lines
    expect(result).toContain("Vital Knowledge");
    // Should contain article links from source tail
    expect(result).toContain("https://example.com/article-");
  });
});

describe("generateDigestSinceAdaptive — synthesis fallback", () => {
  it("falls back to per-source on SynthesisEmptyError and records fallback", async () => {
    const err = new SynthesisEmptyError("output too short");
    vi.mocked(synthesize).mockRejectedValue(err);
    seedArticles(5);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await generateDigestSinceAdaptive(db, yesterday);

    // Per-source layout headers appear
    expect(result).not.toBeNull();
    expect(result).toContain("VITAL KNOWLEDGE");

    // recordSynthesisFallback wrote to settings table
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'synthesis_fallbacks_last_30d'")
      .get() as { value: string } | undefined;
    expect(row).toBeDefined();
    const parsed = JSON.parse(row!.value);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed[0]).toMatchObject({ reason: expect.any(String), articleCount: 5 });
  });

  it("falls back to per-source on generic Error", async () => {
    vi.mocked(synthesize).mockRejectedValue(new Error("network timeout"));
    seedArticles(5);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await generateDigestSinceAdaptive(db, yesterday);

    expect(result).not.toBeNull();
    expect(result).toContain("VITAL KNOWLEDGE");
  });
});

describe("generateDigestSinceAdaptive — thin coverage wiring", () => {
  it("listing-only held bucket → roster line, no synthesis bucket, no stub", async () => {
    // Hold GS: seed account + security + holding (getHeldSymbols reads holdings⋈securities).
    const acctId = (() => {
      db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run("Vanguard Taxable");
      return (db.prepare("SELECT id FROM accounts WHERE name = ?").get("Vanguard Taxable") as { id: number }).id;
    })();
    const secId = db
      .prepare("INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES ('GS', 'Goldman Sachs', 'stock', 'equity', 1)")
      .run().lastInsertRowid as number;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, 100, '2026-07-20', 'test:gs')",
    ).run(acctId, secId);

    // 5 real AAPL articles (clears SYNTHESIS_MIN_ARTICLES) + 1 nine-symbol listing article naming GS.
    seedArticles(5);
    const srcId = (db.prepare("SELECT id FROM research_sources LIMIT 1").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at, mentioned_symbols)
       VALUES (?, 'Week ahead calendar', 's@example.com', datetime('now'), 'Body', 'The week''s reporters.', 'neutral', datetime('now'), ?)`,
    ).run(srcId, JSON.stringify(["MSFT", "HD", "GS", "JPM", "XOM", "RBRK", "NSC", "TXN", "VZ"]));

    (synthesize as ReturnType<typeof vi.fn>).mockResolvedValue(
      "## Overnight & Setup\n\nMacro.\n\n## AAPL (Apple)\n\nCovered.\n\n## Also covered\n\nThin.",
    );

    const out = await generateDigestSinceAdaptive(db, "2020-01-01");

    // Roster line present, placed before ## Also covered.
    expect(out).toContain("On this week's calendar: GS");
    expect(out!.indexOf("On this week's calendar: GS")).toBeLessThan(out!.indexOf("## Also covered"));
    // No GS section or stub was manufactured.
    expect(out).not.toMatch(/^## GS\b/m);
    // The listing-only GS bucket never reached the model.
    const input = (synthesize as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.buckets.map((b: { symbol: string }) => b.symbol)).not.toContain("GS");
  });
});

describe("generateDigestSinceAdaptive — anomaly block", () => {
  it("includes anomaly block when includeAnomalies is true AND anomalies exist", async () => {
    vi.mocked(formatVanguardAnomaliesBlock).mockReturnValue(
      "## Significant Moves in Vanguard Holdings (vs. expected)\n\n- **NVDA** +5.1% — expected +1.2%.\n"
    );
    seedArticles(2);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const result = await generateDigestSinceAdaptive(db, yesterday, { includeAnomalies: true });

    expect(result).not.toBeNull();
    expect(result).toContain("Significant Moves");
    expect(result).toContain("NVDA");
  });

  it("omits anomaly block when includeAnomalies is false", async () => {
    vi.mocked(formatVanguardAnomaliesBlock).mockReturnValue(
      "## Significant Moves in Vanguard Holdings (vs. expected)\n\n- **NVDA** +5.1%.\n"
    );
    seedArticles(2);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    // Default opts (includeAnomalies defaults to false)
    const result = await generateDigestSinceAdaptive(db, yesterday);

    expect(result).not.toBeNull();
    expect(result).not.toContain("Significant Moves");
    // formatVanguardAnomaliesBlock should not have been called
    expect(formatVanguardAnomaliesBlock).not.toHaveBeenCalled();
  });
});

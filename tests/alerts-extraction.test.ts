import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  buildExtractionPrompt,
  parseExtractionResponse,
  getRelevantSymbols,
  isImplausibleLevelPrice,
  type ArticleInput,
  type RelevantSymbol,
} from "@/lib/alerts/extract-newsletter-levels";

// ─── Prompt builder ─────────────────────────────────────────────

describe("buildExtractionPrompt", () => {
  const article: ArticleInput = {
    id: 1,
    source_name: "Eliant Capital",
    subject: "Weekend levels",
    received_at: "2026-04-20T08:00:00Z",
    raw_text: "SPY looks vulnerable below 580. QQQ resistance at 505. Above 510 is blue sky.",
  };
  const symbols: RelevantSymbol[] = [
    { symbol: "SPY", security_id: 1, current_price: 583, relationship: "held", security_type: "ETF" },
    { symbol: "QQQ", security_id: 2, current_price: 502, relationship: "watchlist", security_type: "ETF" },
  ];

  it("includes article metadata + tracked symbols + current prices", () => {
    const prompt = buildExtractionPrompt(article, symbols);
    expect(prompt).toContain("Eliant Capital");
    expect(prompt).toContain("Weekend levels");
    expect(prompt).toContain("SPY (current $583.00) [held]");
    expect(prompt).toContain("QQQ (current $502.00) [watchlist]");
  });

  it("embeds the article raw_text in the prompt", () => {
    const prompt = buildExtractionPrompt(article, symbols);
    expect(prompt).toContain("SPY looks vulnerable below 580");
    expect(prompt).toContain("QQQ resistance at 505");
  });

  it("truncates articles over 25k chars", () => {
    const bigArticle = { ...article, raw_text: "x".repeat(30_000) };
    const prompt = buildExtractionPrompt(bigArticle, symbols);
    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(30_000);
  });

  it("instructs Claude to return JSON array with no preamble", () => {
    const prompt = buildExtractionPrompt(article, symbols);
    expect(prompt).toContain("Return a JSON array");
    expect(prompt).toContain("no markdown fence, no preamble");
    expect(prompt).toContain("Return ONLY the JSON array");
  });

  it("enforces tracked-symbol scoping and confidence grading", () => {
    const prompt = buildExtractionPrompt(article, symbols);
    expect(prompt).toContain("Only extract levels for the tracked symbols");
    expect(prompt).toContain('"confidence": "high" | "medium" | "low"');
  });

  it("tells Claude to skip past-tense references + vague commentary", () => {
    const prompt = buildExtractionPrompt(article, symbols);
    expect(prompt).toContain("Past performance references");
    expect(prompt).toContain("Vague commentary");
  });

  it("handles empty tracked-symbol list gracefully", () => {
    const prompt = buildExtractionPrompt(article, []);
    expect(prompt).toContain("(none — the user tracks no relevant symbols)");
  });
});

// ─── Response parser ────────────────────────────────────────────

describe("parseExtractionResponse", () => {
  it("parses a clean JSON array", () => {
    const raw = JSON.stringify([
      {
        symbol: "SPY",
        level_type: "support",
        price: 580,
        direction: "bearish",
        action_hint: "trim",
        thesis: "Breakdown signals bearish",
        timeframe: "week",
        confidence: "high",
      },
    ]);
    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("SPY");
    expect(result[0].price).toBe(580);
  });

  it("strips markdown code fences", () => {
    const raw = "```json\n[{\"symbol\":\"SPY\",\"level_type\":\"support\",\"price\":580,\"confidence\":\"high\"}]\n```";
    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
  });

  it("strips bare code fences too", () => {
    const raw = "```\n[{\"symbol\":\"SPY\",\"level_type\":\"support\",\"price\":580,\"confidence\":\"high\"}]\n```";
    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
  });

  it("returns [] on invalid JSON", () => {
    expect(parseExtractionResponse("not json")).toEqual([]);
    expect(parseExtractionResponse("")).toEqual([]);
  });

  it("returns [] when top-level is not an array", () => {
    expect(parseExtractionResponse('{"symbol":"SPY"}')).toEqual([]);
  });

  it("drops entries with invalid level_type", () => {
    const raw = JSON.stringify([
      { symbol: "SPY", level_type: "breakdown", price: 580, confidence: "high" },
      { symbol: "QQQ", level_type: "support", price: 500, confidence: "high" },
    ]);
    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("QQQ");
  });

  it("drops entries with non-positive price", () => {
    const raw = JSON.stringify([
      { symbol: "SPY", level_type: "support", price: 0, confidence: "high" },
      { symbol: "QQQ", level_type: "support", price: -10, confidence: "high" },
      { symbol: "DIA", level_type: "support", price: 400, confidence: "high" },
    ]);
    const result = parseExtractionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("DIA");
  });

  it("drops entries with unknown confidence", () => {
    const raw = JSON.stringify([
      { symbol: "SPY", level_type: "support", price: 580, confidence: "very high" },
    ]);
    expect(parseExtractionResponse(raw)).toEqual([]);
  });

  it("normalizes null/invalid direction to null", () => {
    const raw = JSON.stringify([
      { symbol: "SPY", level_type: "support", price: 580, direction: "sideways", confidence: "high" },
    ]);
    const result = parseExtractionResponse(raw);
    expect(result[0].direction).toBeNull();
  });

  it("normalizes invalid action_hint to null", () => {
    const raw = JSON.stringify([
      { symbol: "SPY", level_type: "support", price: 580, action_hint: "freak_out", confidence: "high" },
    ]);
    const result = parseExtractionResponse(raw);
    expect(result[0].action_hint).toBeNull();
  });

  it("truncates thesis at 500 chars", () => {
    const longThesis = "x".repeat(1000);
    const raw = JSON.stringify([
      { symbol: "SPY", level_type: "support", price: 580, thesis: longThesis, confidence: "high" },
    ]);
    const result = parseExtractionResponse(raw);
    expect(result[0].thesis.length).toBe(500);
  });
});

// ─── isImplausibleLevelPrice ────────────────────────────────────

describe("isImplausibleLevelPrice", () => {
  it("flags a level >50% above the current price (SPX-on-SPY scale error)", () => {
    expect(isImplausibleLevelPrice(7100, { current_price: 748, security_type: "ETF" })).toBe(true);
    expect(isImplausibleLevelPrice(7150, { current_price: 748, security_type: "ETF" })).toBe(true);
  });

  it("flags a level >50% below the current price (inverted scale error)", () => {
    expect(isImplausibleLevelPrice(71, { current_price: 748, security_type: "ETF" })).toBe(true);
  });

  it("passes normal levels within the band", () => {
    expect(isImplausibleLevelPrice(715, { current_price: 748, security_type: "ETF" })).toBe(false);
    expect(isImplausibleLevelPrice(1000, { current_price: 700, security_type: "stock" })).toBe(false); // +43%
    expect(isImplausibleLevelPrice(360, { current_price: 700, security_type: "stock" })).toBe(false); // −49%
  });

  it("exempts options (premiums legitimately double/halve)", () => {
    expect(isImplausibleLevelPrice(25, { current_price: 8, security_type: "Option" })).toBe(false);
    expect(isImplausibleLevelPrice(25, { current_price: 8, security_type: "option" })).toBe(false);
  });

  it("passes when no current price is known (review gate still applies)", () => {
    expect(isImplausibleLevelPrice(7100, { current_price: null, security_type: "ETF" })).toBe(false);
    expect(isImplausibleLevelPrice(7100, { current_price: 0, security_type: "ETF" })).toBe(false);
  });
});

// ─── getRelevantSymbols ─────────────────────────────────────────

describe("getRelevantSymbols", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedSec(symbol: string): number {
    const r = db.prepare(
      "INSERT INTO securities (symbol, security_type, asset_class, multiplier) VALUES (?, 'stock', 'equity', 1)"
    ).run(symbol);
    return r.lastInsertRowid as number;
  }

  function seedAccount(name: string): number {
    // Seed migration (002) inserts standard account names. Reuse if present.
    const existing = db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number } | undefined;
    if (existing) return existing.id;
    const r = db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name);
    return r.lastInsertRowid as number;
  }

  it("returns held securities", () => {
    const acct = seedAccount("IBKR");
    const aapl = seedSec("AAPL");
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 100, '2026-04-20')"
    ).run(acct, aapl);

    const result = getRelevantSymbols(db);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("AAPL");
    expect(result[0].relationship).toBe("held");
  });

  it("returns watchlist securities", () => {
    const tsla = seedSec("TSLA");
    db.prepare("INSERT INTO watchlist (security_id) VALUES (?)").run(tsla);

    const result = getRelevantSymbols(db);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe("TSLA");
    expect(result[0].relationship).toBe("watchlist");
  });

  it("deduplicates securities that are both held and watchlisted (prefers held)", () => {
    const acct = seedAccount("IBKR");
    const aapl = seedSec("AAPL");
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, 100, '2026-04-20')"
    ).run(acct, aapl);
    db.prepare("INSERT INTO watchlist (security_id) VALUES (?)").run(aapl);

    const result = getRelevantSymbols(db);
    expect(result).toHaveLength(1);
    expect(result[0].relationship).toBe("held");
  });

  it("includes latest price when available", () => {
    const aapl = seedSec("AAPL");
    db.prepare("INSERT INTO watchlist (security_id) VALUES (?)").run(aapl);
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-04-20', 180.25, 'manual')"
    ).run(aapl);

    const result = getRelevantSymbols(db);
    expect(result[0].current_price).toBe(180.25);
  });

  it("excludes securities that are neither held nor watchlisted", () => {
    seedSec("NVDA");  // no holdings, no watchlist
    expect(getRelevantSymbols(db)).toEqual([]);
  });

  it("ignores inactive watchlist items", () => {
    const aapl = seedSec("AAPL");
    db.prepare(
      "INSERT INTO watchlist (security_id, is_active) VALUES (?, 0)"
    ).run(aapl);

    expect(getRelevantSymbols(db)).toEqual([]);
  });
});

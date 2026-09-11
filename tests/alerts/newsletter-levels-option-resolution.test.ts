/**
 * Newsletter level extraction must never attach a SHARE-priced level to an
 * OCC OPTION row.
 *
 * Regression: a share-price exit level quoted by a newsletter landed on a
 * held call of a dual-class issuer, where it was compared against the option
 * premium and could never fire, and the deliberate option exemption from the
 * plausibility band hid the absurdity. The fix folds every option in the
 * tracked set into its underlying equity (issuer-family aware) before the
 * prompt is built.
 *
 * Every ticker/price below is synthetic or a public market symbol with an
 * invented price — no account data.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

import { runMigrations } from "@/lib/db/migrate";
import {
  buildExtractionPrompt,
  extractLevelsFromArticle,
  getRelevantSymbols,
  getTrackedSecurities,
  type ArticleInput,
} from "@/lib/alerts/extract-newsletter-levels";
import {
  classifyOptionAttachedLevel,
  indexTrackedSymbols,
  resolveEquityForUnderlying,
  resolveTrackedSymbolsToEquities,
  underlyingSymbolOf,
  appendProvenance,
  repairProvenanceNote,
} from "@/lib/alerts/option-level-resolution";

// Reset in afterEach (not beforeEach) — matches the repo's other AI-mocking
// tests (vitest tinyspy phantom-rejection rationale).
afterEach(() => generateTextMock.mockReset());

// ─── Fixture helpers ────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedEquity(
  db: Database.Database,
  symbol: string,
  opts: { type?: string | null; price?: number | null } = {},
): number {
  const type = opts.type === undefined ? "Stock" : opts.type;
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, security_type, asset_class, multiplier) VALUES (?, ?, 'equity', 1)",
    )
    .run(symbol, type);
  const id = r.lastInsertRowid as number;
  if (opts.price != null) {
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-04', ?, 'manual')",
    ).run(id, opts.price);
  }
  return id;
}

function seedOption(
  db: Database.Database,
  symbol: string,
  underlying: string | null,
  premium: number | null,
): number {
  const r = db
    .prepare(
      `INSERT INTO securities (symbol, security_type, asset_class, underlying_symbol, multiplier)
       VALUES (?, 'Option', 'equity', ?, 100)`,
    )
    .run(symbol, underlying);
  const id = r.lastInsertRowid as number;
  if (premium != null) {
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-04', ?, 'manual')",
    ).run(id, premium);
  }
  return id;
}

function accountId(db: Database.Database): number {
  const existing = db.prepare("SELECT id FROM accounts LIMIT 1").get() as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  return db.prepare("INSERT INTO accounts (name) VALUES ('TEST')").run()
    .lastInsertRowid as number;
}

function hold(db: Database.Database, securityId: number, qty = 1): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, '2026-09-04')",
  ).run(accountId(db), securityId, qty);
}

function watch(db: Database.Database, securityId: number): void {
  db.prepare("INSERT INTO watchlist (security_id) VALUES (?)").run(securityId);
}

function seedArticle(db: Database.Database, rawText: string): ArticleInput {
  const sourceId = db
    .prepare("INSERT INTO research_sources (name) VALUES ('Test Letter')")
    .run().lastInsertRowid as number;
  const r = db
    .prepare(
      `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text)
       VALUES (?, '2026-09-04T12:00:00Z', 'Levels', 'letter@example.com', ?)`,
    )
    .run(sourceId, rawText);
  return {
    id: r.lastInsertRowid as number,
    source_name: "Test Letter",
    subject: "Levels",
    received_at: "2026-09-04T12:00:00Z",
    raw_text: rawText,
  };
}

function modelReturns(levels: Array<Record<string, unknown>>): void {
  generateTextMock.mockResolvedValue({ text: JSON.stringify(levels) });
}

function levelsInDb(db: Database.Database) {
  return db
    .prepare(
      `SELECT l.id, l.security_id, s.symbol, s.security_type, l.level_type, l.price
         FROM security_levels l JOIN securities s ON s.id = l.security_id
        ORDER BY l.id`,
    )
    .all() as Array<{
    id: number;
    security_id: number;
    symbol: string;
    security_type: string | null;
    level_type: string;
    price: number;
  }>;
}

// ─── (a) option-only holding, equity exists in `securities` ─────────

describe("option-only holding folds into the underlying equity", () => {
  it("lands the level on the equity id, never on the contract", async () => {
    const db = makeDb();
    // The user is long the contract only — no share position, no watchlist row.
    const optId = seedOption(db, "ZZZ   270618C00030000", "ZZZ", 4.15);
    hold(db, optId);
    const equityId = seedEquity(db, "ZZZ", { price: 41.2 });

    const tracked = getRelevantSymbols(db);
    expect(tracked.map((s) => s.symbol)).toEqual(["ZZZ"]);
    expect(tracked[0].security_id).toBe(equityId);
    expect(tracked[0].relationship).toBe("held_via_option");
    expect(tracked[0].current_price).toBe(41.2);

    const article = seedArticle(db, "ZZZ: trimming at 52.");
    const prompt = buildExtractionPrompt(article, tracked);
    // The prompt lists the underlying ticker, not the OCC string.
    expect(prompt).toContain("ZZZ (current $41.20) [held via option]");
    expect(prompt).not.toContain("270618C00030000");

    modelReturns([
      { symbol: "ZZZ", level_type: "exit", price: 52, direction: "bearish", confidence: "high" },
    ]);
    const res = await extractLevelsFromArticle(db, article, tracked);

    expect(res.inserted).toBe(1);
    const rows = levelsInDb(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].security_id).toBe(equityId);
    expect(rows[0].security_type).toBe("Stock");
    expect(rows[0].price).toBe(52);
    expect(optId).not.toBe(equityId);
  });
});

// ─── (b) option + equity both tracked ───────────────────────────────

describe("option + equity both tracked", () => {
  it("produces ONE prompt entry and puts the level on the equity", async () => {
    const db = makeDb();
    const equityId = seedEquity(db, "ZZZ", { price: 100 });
    hold(db, equityId, 50);
    const optId = seedOption(db, "ZZZ   270115C00120000", "ZZZ", 8.4);
    hold(db, optId);

    const raw = getTrackedSecurities(db);
    expect(raw).toHaveLength(2); // both rows come out of the DB

    const tracked = getRelevantSymbols(db);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].security_id).toBe(equityId);
    expect(tracked[0].relationship).toBe("held"); // the real share position wins

    const article = seedArticle(db, "ZZZ support at 90.");
    modelReturns([
      { symbol: "ZZZ", level_type: "support", price: 90, direction: "bullish", confidence: "high" },
    ]);
    const res = await extractLevelsFromArticle(db, article, tracked);

    expect(res.inserted).toBe(1);
    const rows = levelsInDb(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].security_id).toBe(equityId);
    expect(optId).not.toBe(equityId);
  });
});

// ─── (c) issuer-sibling fold ────────────────────────────────────────

describe("issuer-sibling fold (dual-class)", () => {
  it("folds a held FOXA contract into the tracked FOX share row", async () => {
    const db = makeDb();
    const foxId = seedEquity(db, "FOX", { price: 41.2 });
    hold(db, foxId, 10);
    const optId = seedOption(db, "FOXA  270618C00030000", "FOXA", 4.15);
    hold(db, optId);

    const tracked = getRelevantSymbols(db);
    expect(tracked).toHaveLength(1);
    expect(tracked[0].symbol).toBe("FOX");
    expect(tracked[0].security_id).toBe(foxId);

    const article = seedArticle(db, "Trimmed FOXA at 52.");
    // The model echoes the newsletter's spelling (FOXA) even though the
    // prompt listed FOX — same issuer, so it must still resolve.
    modelReturns([
      { symbol: "FOXA", level_type: "exit", price: 52, direction: "bearish", confidence: "high" },
    ]);
    const res = await extractLevelsFromArticle(db, article, tracked);

    expect(res.inserted).toBe(1);
    const rows = levelsInDb(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbol).toBe("FOX");
    expect(rows[0].security_id).toBe(foxId);
  });

  it("prefers a same-class equity over a sibling when both are tracked", () => {
    const db = makeDb();
    const foxaId = seedEquity(db, "FOXA", { price: 41.2 });
    hold(db, foxaId, 10);
    const foxId = seedEquity(db, "FOX", { price: 40.9 });
    hold(db, foxId, 10);
    hold(db, seedOption(db, "FOXA  270618C00030000", "FOXA", 4.15));

    const tracked = getRelevantSymbols(db);
    expect(tracked.map((s) => s.symbol).sort()).toEqual(["FOX", "FOXA"]);
    const bySymbol = indexTrackedSymbols(tracked);
    expect(bySymbol.get("FOXA")!.security_id).toBe(foxaId);
    expect(bySymbol.get("FOX")!.security_id).toBe(foxId);
  });
});

// ─── (d) no equity anywhere → dropped ───────────────────────────────

describe("option with no equity row anywhere", () => {
  it("drops the contract, writes no level, and warns once", async () => {
    const db = makeDb();
    const optId = seedOption(db, "QQZ   270618C00030000", "QQZ", 12.5);
    hold(db, optId);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fold = resolveTrackedSymbolsToEquities(db, getTrackedSecurities(db));
      expect(fold.symbols).toEqual([]);
      expect(fold.dropped).toEqual([
        {
          optionSymbol: "QQZ   270618C00030000",
          underlying: "QQZ",
          reason: "no_equity_security",
        },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("no equity security exists for underlying QQZ");
    } finally {
      warn.mockRestore();
    }

    expect(getRelevantSymbols(db)).toEqual([]);

    // And the extraction path writes nothing even if a caller hands the option
    // row straight to extractLevelsFromArticle.
    const article = seedArticle(db, "QQZ exit at 52.");
    modelReturns([
      { symbol: "QQZ", level_type: "exit", price: 52, direction: "bearish", confidence: "high" },
    ]);
    const guardWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await extractLevelsFromArticle(db, article, [
        {
          symbol: "QQZ   270618C00030000",
          security_id: optId,
          current_price: 12.5,
          relationship: "held",
          security_type: "Option",
        },
      ]);
      expect(res.inserted).toBe(0);
    } finally {
      guardWarn.mockRestore();
    }
    expect(levelsInDb(db)).toEqual([]);
  });

  it("drops a contract whose symbol yields no underlying at all", () => {
    const db = makeDb();
    const optId = db
      .prepare(
        "INSERT INTO securities (symbol, security_type, asset_class, multiplier) VALUES ('MYSTERY-CONTRACT', 'Option', 'equity', 100)",
      )
      .run().lastInsertRowid as number;
    hold(db, optId);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fold = resolveTrackedSymbolsToEquities(db, getTrackedSecurities(db));
      expect(fold.symbols).toEqual([]);
      expect(fold.dropped[0].reason).toBe("no_underlying");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

// ─── (e) plain equities are untouched ───────────────────────────────

describe("plain equity tracked sets are unchanged", () => {
  it("passes held + watchlist equities through with their relationships", () => {
    const db = makeDb();
    const heldId = seedEquity(db, "AAA", { price: 10 });
    hold(db, heldId, 5);
    const watchedId = seedEquity(db, "BBB", { type: "ETF", price: 20 });
    watch(db, watchedId);

    const tracked = getRelevantSymbols(db);
    expect(tracked).toHaveLength(2);
    const bySymbol = new Map(tracked.map((s) => [s.symbol, s]));
    expect(bySymbol.get("AAA")!.relationship).toBe("held");
    expect(bySymbol.get("BBB")!.relationship).toBe("watchlist");
    expect(bySymbol.get("BBB")!.security_type).toBe("ETF");
  });
});

// ─── resolveEquityForUnderlying ranking ─────────────────────────────

describe("resolveEquityForUnderlying", () => {
  it("prefers a typed, priced sibling over an untyped unpriced stub", () => {
    const db = makeDb();
    // Mirrors a real shape: a bare ticker stub with no type or price sits
    // alongside a typed, priced sibling row for the same issuer.
    const stubId = seedEquity(db, "FOXA", { type: null, price: null });
    const realId = seedEquity(db, "FOX", { price: 41.2 });

    const target = resolveEquityForUnderlying(db, "FOXA");
    expect(target).not.toBeNull();
    expect(target!.security_id).toBe(realId);
    expect(target!.symbol).toBe("FOX");
    expect(target!.current_price).toBe(41.2);
    expect(stubId).not.toBe(realId);
  });

  it("returns the exact-symbol row when both candidates are equal quality", () => {
    const db = makeDb();
    seedEquity(db, "FOX", { price: 40.9 });
    const foxaId = seedEquity(db, "FOXA", { price: 41.2 });
    expect(resolveEquityForUnderlying(db, "FOXA")!.security_id).toBe(foxaId);
  });

  it("never returns an option row", () => {
    const db = makeDb();
    seedOption(db, "ZZZ   270618C00030000", "ZZZ", 12);
    expect(resolveEquityForUnderlying(db, "ZZZ")).toBeNull();
  });

  it("returns an unpriced equity rather than nothing", () => {
    const db = makeDb();
    const id = seedEquity(db, "ZZZ", { price: null });
    const target = resolveEquityForUnderlying(db, "ZZZ");
    expect(target!.security_id).toBe(id);
    expect(target!.current_price).toBeNull();
  });
});

// ─── underlyingSymbolOf ─────────────────────────────────────────────

describe("underlyingSymbolOf", () => {
  it("parses the OCC symbol", () => {
    expect(underlyingSymbolOf({ symbol: "FOXA  270618C00030000" })).toBe("FOXA");
  });

  it("parses the Vanguard-compact spelling", () => {
    expect(underlyingSymbolOf({ symbol: "NVDA 260618 C 175.00" })).toBe("NVDA");
  });

  it("prefers a stored underlying_symbol over the symbol text", () => {
    expect(
      underlyingSymbolOf({ symbol: "WEIRD-SPELLING", underlying_symbol: "zzz" }),
    ).toBe("ZZZ");
  });

  it("returns null when neither is available", () => {
    expect(underlyingSymbolOf({ symbol: "WEIRD-SPELLING" })).toBeNull();
  });
});

// ─── classifyOptionAttachedLevel ────────────────────────────────────

describe("classifyOptionAttachedLevel", () => {
  const equity = (price: number | null) => ({ symbol: "ZZZ", current_price: price });

  it("moves a share-scale level sitting on a far-away premium", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 52,
      optionPrice: 4.15,
      equity: equity(41.2),
    });
    expect(c.verdict).toBe("move");
  });

  it("leaves a genuine premium level alone", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 8.25,
      optionPrice: 8.58,
      equity: equity(null),
    });
    expect(c.verdict).toBe("leave");
  });

  it("leaves a premium level alone even when the equity price is known", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 8.25,
      optionPrice: 8.58,
      equity: equity(140),
    });
    expect(c.verdict).toBe("leave");
  });

  it("reviews when both readings are in band (deep-ITM LEAP)", () => {
    // A 2027 $45 call trading near $48 while the share is near $96: an $80
    // level is in band against BOTH.
    const c = classifyOptionAttachedLevel({
      levelPrice: 80,
      optionPrice: 47.85,
      equity: equity(95.89),
    });
    expect(c.verdict).toBe("review");
  });

  it("reviews when neither reading is in band", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 4.65,
      optionPrice: 0.01,
      equity: equity(95.89),
    });
    expect(c.verdict).toBe("review");
  });

  it("reviews when the equity price is missing and the premium is out of band", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 220,
      optionPrice: 8.58,
      equity: equity(null),
    });
    expect(c.verdict).toBe("review");
  });

  it("reviews when the option has no price to rule the premium reading out", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 100,
      optionPrice: null,
      equity: equity(96),
    });
    expect(c.verdict).toBe("review");
  });

  it("reviews when no equity exists at all", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 100,
      optionPrice: 5,
      equity: null,
    });
    expect(c.verdict).toBe("review");
    expect(c.reason).toContain("no equity security");
  });

  it("reviews when neither side has a price", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 100,
      optionPrice: null,
      equity: equity(null),
    });
    expect(c.verdict).toBe("review");
  });

  it("reports duplicate instead of move when the equity already carries the row", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 52,
      optionPrice: 4.15,
      equity: equity(41.2),
      duplicateOnEquity: true,
    });
    expect(c.verdict).toBe("duplicate");
  });

  it("does not turn a leave into a duplicate", () => {
    const c = classifyOptionAttachedLevel({
      levelPrice: 8.25,
      optionPrice: 8.58,
      equity: equity(140),
      duplicateOnEquity: true,
    });
    expect(c.verdict).toBe("leave");
  });
});

// ─── provenance ─────────────────────────────────────────────────────

describe("provenance note", () => {
  it("is stable for the same contract + date (idempotent re-runs)", () => {
    const note = repairProvenanceNote("ZZZ   270618C00030000", "2026-09-08");
    expect(note).toBe(
      "re-pointed from ZZZ   270618C00030000 by repair-option-attached-levels on 2026-09-08",
    );
    expect(repairProvenanceNote("ZZZ   270618C00030000", "2026-09-08")).toBe(note);
  });

  it("appends to existing notes without duplicating itself", () => {
    const note = repairProvenanceNote("ZZZ   270618C00030000", "2026-09-08");
    expect(appendProvenance(null, note)).toBe(note);
    expect(appendProvenance("author said so", note)).toBe(`author said so\n${note}`);
    expect(appendProvenance(`author said so\n${note}`, note)).toBe(`author said so\n${note}`);
  });
});

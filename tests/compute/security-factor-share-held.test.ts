import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeSecurityFactorShare,
  computeSecurityFactorShareView,
} from "@/lib/compute/factors";
import { anchorIndex } from "../helpers/source-anchor";

/**
 * Security hub · Factor Profile · Block 3 (portfolio-share contribution).
 *
 * Three QA findings, one rule each:
 *  - a contract that is NOT held never borrows its underlying's share;
 *  - a short is described as a short (covering adds), never a negative "cut";
 *  - a held position with no price has an UNKNOWN contribution, never ~0%.
 *
 * All symbols and numbers here are synthetic.
 */

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1,
      underlying_symbol TEXT,
      expiration_date TEXT,
      maturity_date TEXT,
      currency TEXT NOT NULL DEFAULT 'USD'
    );
    CREATE TABLE fx_rates (
      currency TEXT PRIMARY KEY,
      usd_per_unit REAL NOT NULL,
      as_of TEXT NOT NULL,
      source TEXT
    );
    CREATE TABLE security_factors (
      security_id INTEGER PRIMARY KEY REFERENCES securities(id),
      interest_rate_sensitive TEXT,
      growth_vs_value TEXT,
      cyclical TEXT,
      international_exposure TEXT,
      geopolitical_onshoring TEXT,
      tariff_exposure TEXT,
      ai_exposure TEXT,
      crypto_adjacent TEXT,
      regulatory_risk TEXT,
      factor_source TEXT DEFAULT 'csv_import'
    );
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      as_of_date TEXT NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL
    );
    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      UNIQUE(security_id, date)
    );
    INSERT INTO accounts (id, name) VALUES (1, 'Test'), (2, 'Other');
  `);
  return db;
}

const D1 = "2026-01-02";
const D2 = "2026-01-05";
const FAR_EXPIRY = "2099-01-15";
const PAST_EXPIRY = "2020-01-17";

function addStock(db: Database.Database, id: number, symbol: string, ai: string | null = "High") {
  db.prepare("INSERT INTO securities (id, symbol, name) VALUES (?, ?, ?)").run(id, symbol, symbol);
  if (ai) {
    db.prepare("INSERT INTO security_factors (security_id, ai_exposure) VALUES (?, ?)").run(id, ai);
  }
}

function addOption(
  db: Database.Database,
  id: number,
  symbol: string,
  underlying: string,
  expiration: string
) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, multiplier, underlying_symbol, expiration_date)
     VALUES (?, ?, ?, 'option', 100, ?, ?)`
  ).run(id, symbol, symbol, underlying, expiration);
}

function hold(
  db: Database.Database,
  securityId: number,
  quantity: number,
  opts: { account?: number; date?: string; price?: number | null; costBasis?: number | null } = {}
) {
  const date = opts.date ?? D1;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, cost_basis) VALUES (?, ?, ?, ?, ?)"
  ).run(opts.account ?? 1, securityId, date, quantity, opts.costBasis ?? null);
  const price = opts.price === undefined ? 100 : opts.price;
  if (price !== null) {
    db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
      securityId,
      date,
      price
    );
  }
}

describe("computeSecurityFactorShare — held means THIS security is held", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("an option with no holdings row does not inherit its held underlying's share", () => {
    addStock(db, 1, "AAA");
    hold(db, 1, 50);
    addOption(db, 2, "AAA 990115C00010000", "AAA", PAST_EXPIRY);

    expect(computeSecurityFactorShare(db, 2)).toEqual([]);
    const view = computeSecurityFactorShareView(db, 2);
    expect(view.held).toBe(false);
    expect(view.entries).toEqual([]);
    // The underlying itself still gets its card.
    expect(computeSecurityFactorShare(db, 1)).toHaveLength(1);
  });

  it("a position closed by a quantity-0 tombstone is not held", () => {
    addStock(db, 1, "AAA");
    addStock(db, 2, "BBB");
    hold(db, 1, 50);
    hold(db, 2, 50);
    hold(db, 2, 0, { date: D2, price: null });

    expect(computeSecurityFactorShare(db, 2)).toEqual([]);
    expect(computeSecurityFactorShareView(db, 2).held).toBe(false);
  });

  it("an expired option whose holdings row still lingers is not held", () => {
    addStock(db, 1, "AAA");
    hold(db, 1, 50);
    addOption(db, 2, "AAA 200117C00010000", "AAA", PAST_EXPIRY);
    hold(db, 2, 3, { price: 2 });
    // Legacy compact spelling of an expired date is expired too.
    addOption(db, 3, "AAA 200117P00010000", "AAA", "20200117");
    hold(db, 3, 3, { price: 2 });

    expect(computeSecurityFactorShare(db, 2)).toEqual([]);
    expect(computeSecurityFactorShare(db, 3)).toEqual([]);
  });

  it("a live held option gets its own row, with factors inherited from the underlying", () => {
    addStock(db, 1, "AAA");
    hold(db, 1, 50);
    addOption(db, 2, "AAA 990115C00010000", "AAA", FAR_EXPIRY);
    hold(db, 2, 1, { price: 50 }); // 1 × 50 × 100 = 5,000, same value as the stock

    const view = computeSecurityFactorShareView(db, 2);
    expect(view.held).toBe(true);
    const ai = view.entries.find((e) => e.factor === "ai_exposure")!;
    expect(ai.positionSide).toBe("long");
    expect(ai.sharePct).toBeCloseTo(50, 1);
  });

  it("an unheld share class names the held sibling class instead of showing a share", () => {
    addStock(db, 1, "GOOGL");
    hold(db, 1, 50);
    addStock(db, 2, "GOOG");

    const view = computeSecurityFactorShareView(db, 2);
    expect(view.held).toBe(false);
    expect(view.entries).toEqual([]);
    expect(view.siblingHeldSymbols).toEqual(["GOOGL"]);
    // A sibling that is not held is not named.
    expect(computeSecurityFactorShareView(db, 1).siblingHeldSymbols).toEqual([]);
  });

  it("respects the account scope when deciding held", () => {
    addStock(db, 1, "AAA");
    addStock(db, 2, "BBB");
    hold(db, 1, 50, { account: 1 });
    hold(db, 2, 50, { account: 2 });

    expect(computeSecurityFactorShareView(db, 2, [1]).held).toBe(false);
    expect(computeSecurityFactorShareView(db, 2, [2]).held).toBe(true);
  });
});

describe("computeSecurityFactorShare — a short is held, and described as a short", () => {
  it("a net short carries positionSide 'short' and a negative contribution", () => {
    const db = createTestDb();
    addStock(db, 1, "AAA");
    addStock(db, 2, "BBB");
    hold(db, 1, 300); // +30,000
    hold(db, 2, -100); // −10,000

    const view = computeSecurityFactorShareView(db, 2);
    expect(view.held).toBe(true);
    const ai = view.entries.find((e) => e.factor === "ai_exposure")!;
    expect(ai.positionSide).toBe("short");
    // weight = −10,000 / 20,000 = −50%; contribution = −50 × 0.75 = −37.5 pp.
    expect(ai.deltaPp).toBeCloseTo(-37.5, 4);
    // bucket = (150 − 50) × 0.75 = 75; share = −50%.
    expect(ai.sharePct).toBeCloseTo(-50, 4);

    const long = computeSecurityFactorShare(db, 1).find((e) => e.factor === "ai_exposure")!;
    expect(long.positionSide).toBe("long");
    expect(long.deltaPp).toBeGreaterThan(0);
  });

  it("gives no share when the bucket total is not positive (a ratio of it means nothing)", () => {
    const db = createTestDb();
    addStock(db, 1, "AAA", null); // long, no factor
    addStock(db, 2, "BBB"); // the only AI name, and it is short
    hold(db, 1, 300);
    hold(db, 2, -100);

    const ai = computeSecurityFactorShare(db, 2).find((e) => e.factor === "ai_exposure")!;
    expect(ai.positionSide).toBe("short");
    expect(ai.bucketTotalExposure).toBeLessThan(0);
    expect(ai.sharePct).toBeNull();
    expect(ai.deltaPp).toBeCloseTo(-37.5, 4);
  });
});

describe("computeSecurityFactorShare — an unpriced held position is unknown, not zero", () => {
  it("returns null figures when the held security has no price and no cost basis", () => {
    const db = createTestDb();
    addStock(db, 1, "AAA");
    hold(db, 1, 50);
    addOption(db, 2, "AAA 990115C00010000", "AAA", FAR_EXPIRY);
    hold(db, 2, 4, { price: null });

    const view = computeSecurityFactorShareView(db, 2);
    expect(view.held).toBe(true);
    expect(view.entries.length).toBeGreaterThan(0);
    for (const e of view.entries) {
      expect(e.sharePct).toBeNull();
      expect(e.deltaPp).toBeNull();
      expect(e.securityContribution).toBeNull();
      expect(e.positionSide).toBe("long");
    }
  });

  it("a priced position worth exactly zero keeps a real 0", () => {
    const db = createTestDb();
    addStock(db, 1, "AAA");
    hold(db, 1, 50);
    addOption(db, 2, "AAA 990115C00010000", "AAA", FAR_EXPIRY);
    hold(db, 2, 4, { price: 0 });

    const ai = computeSecurityFactorShare(db, 2).find((e) => e.factor === "ai_exposure")!;
    expect(ai.sharePct).toBe(0);
    expect(ai.deltaPp).toBe(0);
  });

  it("an unpriced position valued at cost basis (the heatmap's own fallback) keeps its figure", () => {
    const db = createTestDb();
    addStock(db, 1, "AAA");
    hold(db, 1, 50); // 5,000
    addStock(db, 2, "BBB");
    hold(db, 2, 10, { price: null, costBasis: 5000 });

    const ai = computeSecurityFactorShare(db, 2).find((e) => e.factor === "ai_exposure")!;
    expect(ai.sharePct).toBeCloseTo(50, 4);
  });
});

describe("FactorProfileSection — Block 3 copy (source pin)", () => {
  const src = readFileSync(
    join(process.cwd(), "app/dashboard/security/[id]/FactorProfileSection.tsx"),
    "utf8"
  );
  const block3 = src.slice(
    anchorIndex(src, "{/* Block 3 — Portfolio-share contribution."),
    anchorIndex(src, "function BlockLabel(")
  );

  it("states 'not held' on its own when the page says the security is not held", () => {
    expect(block3).toContain("positionHeld === false");
    expect(block3).toContain("Not held");
    // Never a figure in the not-held branch: it comes before any <Pct>.
    expect(anchorIndex(block3, "positionHeld === false")).toBeLessThan(anchorIndex(block3, "<Pct value="));
  });

  it("says the contribution is unknown when there is no price, with no figure", () => {
    expect(block3).toContain("contribution unknown (no price)");
    expect(block3).toContain("entry.deltaPp === null");
  });

  it("describes a short as covering/adds and never renders a signed figure", () => {
    expect(block3).toContain('entry.positionSide === "short"');
    expect(block3).toContain("covering adds");
    expect(block3).toContain("selling cuts the bucket");
    // Every portfolio-derived figure is an absolute value inside <Pct>.
    const pcts = block3.match(/<Pct value=[^>]*>/g) ?? [];
    expect(pcts.length).toBeGreaterThan(0);
    for (const p of pcts) expect(p).toContain("Math.abs(");
    expect(block3).not.toMatch(/\.toFixed\(/);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDataConfidence, copyText, type CopyPart } from "@/lib/queries/data-confidence";

/**
 * Owner ruling (2026-10-08): the Holdings dimension is the VALUE-WEIGHTED
 * average of each position's age bucket (<=1 day 100, <=7 80, <=30 50,
 * <=90 20, else 0), not the single stalest position's bucket. Weight is the
 * position's absolute market value in USD; an unpriced position weighs by its
 * absolute cost basis; a position with neither counts as fully stale at 1% of
 * the valued total each (all such rows together capped at 10%). An account
 * with no holdings does not enter the score.
 *
 * Every figure below is invented. runMigrations seeds Vanguard Taxable = 1,
 * Vanguard Roth IRA = 2, IBKR = 3.
 */

const NOW = new Date("2026-08-21T16:00:00Z"); // 2026-08-21 in ET
const TODAY = "2026-08-21";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertSecurity(
  db: Database.Database,
  symbol: string,
  opts: { securityType?: string | null; currency?: string | null } = {}
): number {
  db.prepare(`INSERT INTO securities (symbol, security_type) VALUES (?, ?)`).run(
    symbol,
    opts.securityType ?? "Stock"
  );
  const id = (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
  if (opts.currency) db.prepare(`UPDATE securities SET currency = ? WHERE id = ?`).run(opts.currency, id);
  return id;
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis: number | null = null
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis, asOfDate, `test:${accountId}:${securityId}:${asOfDate}`);
}

function insertPrice(db: Database.Database, securityId: number, closePrice: number): void {
  db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)`).run(
    securityId,
    TODAY,
    closePrice
  );
}

/** A priced position: `quantity` shares at $100. */
function priced(
  db: Database.Database,
  accountId: number,
  symbol: string,
  quantity: number,
  asOfDate: string
): void {
  const sec = insertSecurity(db, symbol);
  insertPrice(db, sec, 100);
  insertHolding(db, accountId, sec, quantity, asOfDate);
}

const publicText = (parts: CopyPart[]) => parts.filter((p): p is string => typeof p === "string").join("");
const privateText = (parts: CopyPart[]) =>
  parts.filter((p): p is { private: string } => typeof p !== "string").map(p => p.private).join("|");

describe("data-confidence Holdings score is weighted by value", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("one tiny stale row among large fresh ones scores high", () => {
    priced(db, 1, "ZZA", 100, TODAY); //        $10,000, 0 days   -> 100
    priced(db, 2, "ZZB", 100, TODAY); //        $10,000, 0 days   -> 100
    priced(db, 3, "ZZC", 5, "2026-04-01"); //   $500,    142 days -> 0
    // (10,000*100 + 10,000*100 + 500*0) / 20,500 = 97.56 -> 98
    // (the old weakest-link rule scored this book 0)
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(98);
    // 500 / 20,500 = 2.44% of the book is more than a day old.
    expect(holdingsRecency.staleValueShare).toBeCloseTo(500 / 20500, 6);
  });

  it("one large stale position scores low", () => {
    priced(db, 1, "ZZA", 100, "2026-06-01"); // $10,000, 81 days -> 20
    priced(db, 2, "ZZB", 10, TODAY); //         $1,000,  0 days  -> 100
    // (10,000*20 + 1,000*100) / 11,000 = 27.27 -> 27
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(27);
  });

  it("a short weighs by its absolute value", () => {
    priced(db, 3, "ZZA", 10, TODAY); //         $1,000 long,  0 days  -> 100
    priced(db, 3, "ZZB", -40, "2026-08-01"); // $4,000 short, 20 days -> 50
    // (1,000*100 + 4,000*50) / 5,000 = 60
    // (a signed weight would give (100,000 - 200,000) / -3,000 = 33)
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(60);
  });

  it("an unpriced position weighs by its cost basis", () => {
    priced(db, 1, "ZZA", 10, TODAY); // $1,000, 0 days -> 100
    const zzb = insertSecurity(db, "ZZB");
    insertHolding(db, 1, zzb, 7, "2026-08-10", 4000); // no price, basis $4,000, 11 days -> 50
    // (1,000*100 + 4,000*50) / 5,000 = 60
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(60);
  });

  it("an unpriced short weighs by the size of its (negative) cost basis", () => {
    priced(db, 3, "ZZA", 10, TODAY); // $1,000, 0 days -> 100
    const zzb = insertSecurity(db, "ZZB");
    insertHolding(db, 3, zzb, -7, "2026-08-10", -4000); // short proceeds stored negative, 11 days -> 50
    // (1,000*100 + 4,000*50) / 5,000 = 60
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(60);
  });

  it("a position with neither price nor cost basis counts as fully stale at 1% of the valued total", () => {
    priced(db, 1, "ZZA", 100, "2026-08-18"); // $10,000, 3 days -> 80
    const zzb = insertSecurity(db, "ZZB");
    insertHolding(db, 1, zzb, 7, TODAY); // dated today, but nothing to value it with -> 0 at weight 100
    // (10,000*80 + 100*0) / 10,100 = 79.21 -> 79
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(79);
  });

  it("unvalued positions together never weigh more than 10% of the valued total", () => {
    priced(db, 1, "ZZA", 100, TODAY); // $10,000, 0 days -> 100
    for (let i = 0; i < 20; i++) {
      insertHolding(db, 1, insertSecurity(db, `ZZU${String.fromCharCode(65 + i)}`), 7, TODAY);
    }
    // 20 unvalued rows at 1% each would be 20% of $10,000; capped at 10% = $1,000.
    // (10,000*100 + 1,000*0) / 11,000 = 90.91 -> 91   (uncapped: 10,000/12,000 -> 83)
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(91);
    // Every row is dated today: the wording stays "current", and says why the
    // score is short of 100. The count is a private run.
    expect(holdingsRecency.guidance).toContain("Holdings are current across accounts");
    expect(privateText(holdingsRecency.guidanceParts!)).toContain("20");
    expect(publicText(holdingsRecency.guidanceParts!)).not.toMatch(/\d/);
    expect(holdingsRecency.guidanceActionable).toBe(false);
  });

  it("an account with no holdings does not affect the score", () => {
    priced(db, 1, "ZZA", 100, TODAY); // only Taxable holds anything; Roth and IBKR are empty
    // 10,000*100 / 10,000 = 100   (the old rule read each empty account as 999 days -> 0)
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(100);
    expect(holdingsRecency.guidance).toBe("Holdings are current across accounts.");
    // The empty accounts are still listed, with no age.
    expect(holdingsRecency.perAccount.find(a => a.name === "IBKR")!.daysOld).toBeNull();
  });

  it("no holdings anywhere keeps the old result (score 0)", () => {
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(0);
    expect(holdingsRecency.staleValueShare).toBeNull();
  });

  it("a foreign position weighs in USD, not in its own currency", () => {
    db.prepare(
      `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.01, ?, 'ibkr_ledger')`
    ).run(TODAY);
    const jp = insertSecurity(db, "ZZJ", { currency: "JPY" });
    insertPrice(db, jp, 1000); // 1,000 yen
    insertHolding(db, 3, jp, 1000, "2026-04-01"); // 1,000,000 yen = $10,000, 142 days -> 0
    priced(db, 1, "ZZA", 100, TODAY); //             $10,000, 0 days -> 100
    // (10,000*0 + 10,000*100) / 20,000 = 50   (unconverted: 10,000/1,010,000 -> 1)
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(50);
  });

  it("a bond weighs at price/100 of face, the same adjusted value the rest of the app uses", () => {
    const bond = insertSecurity(db, "ZZBOND", { securityType: "Bond" });
    insertPrice(db, bond, 100);
    insertHolding(db, 1, bond, 10000, "2026-04-01"); // $10,000 face at par = $10,000, 142 days -> 0
    priced(db, 1, "ZZA", 100, TODAY); //                $10,000, 0 days -> 100
    // (10,000*0 + 10,000*100) / 20,000 = 50   (face x price: 10,000/1,010,000 -> 1)
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(50);
  });

  it("a book with nothing to value falls back to the stalest position, skipping empty accounts", () => {
    // No price and no cost basis anywhere: there are no weights to average.
    insertHolding(db, 1, insertSecurity(db, "ZZA"), 10, TODAY); //        0 days
    insertHolding(db, 1, insertSecurity(db, "ZZB"), 10, "2026-08-14"); // 7 days -> 80
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(80);
    expect(holdingsRecency.staleValueShare).toBeNull();
  });
});

describe("data-confidence Holdings guidance names the stale share of book value", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("names the share as a private run and still names the stalest position", () => {
    priced(db, 1, "ZZA", 100, TODAY); //      $10,000 current
    priced(db, 2, "ZZB", 60, TODAY); //       $6,000  current
    priced(db, 3, "ZZC", 40, "2026-08-18"); // $4,000, 3 days -> 80
    // Stale share: 4,000 / 20,000 = 20%.  Score: (16,000*100 + 4,000*80) / 20,000 = 96.
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(96);
    expect(holdingsRecency.guidance).not.toContain("current across accounts");
    expect(holdingsRecency.guidance).toContain("20% of book value");
    expect(holdingsRecency.guidance).toContain("ZZC");
    expect(holdingsRecency.guidance).toContain("IBKR");
    // The percent and the ticker are portfolio-derived: private runs only.
    expect(privateText(holdingsRecency.guidanceParts!)).toContain("20%");
    expect(publicText(holdingsRecency.guidanceParts!)).not.toContain("20%");
    expect(publicText(holdingsRecency.guidanceParts!)).not.toContain("ZZC");
    expect(copyText(holdingsRecency.guidanceParts!)).toBe(holdingsRecency.guidance);
    // A high score with a named gap must not read as "nothing to do".
    expect(holdingsRecency.guidanceActionable).toBe(true);
  });

  it("stays actionable for a row older than 7 days however small its share", () => {
    priced(db, 1, "ZZA", 1000, TODAY); //      $100,000 current
    priced(db, 1, "ZZB", 1, "2026-08-01"); //  $100, 20 days -> 50
    // Share: 100 / 100,100 = 0.1% -> shown as "<1%".  Score: 10,005,000 / 100,100 = 99.95 -> 100.
    const { holdingsRecency, actions } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(100);
    expect(holdingsRecency.guidanceActionable).toBe(true);
    expect(holdingsRecency.guidance).toContain("<1% of book value");
    expect(holdingsRecency.guidance).not.toContain("current across accounts");
    expect(actions.find(a => a.message.includes("more than a day old"))).toBeDefined();
  });

  it("every row a day old or less keeps the reassurance, with no private run", () => {
    priced(db, 1, "ZZA", 100, TODAY);
    priced(db, 2, "ZZB", 100, "2026-08-20"); // 1 day
    priced(db, 3, "ZZC", 100, TODAY);
    const { holdingsRecency } = getDataConfidence(db, NOW);
    expect(holdingsRecency.score).toBe(100);
    expect(holdingsRecency.staleValueShare).toBe(0);
    expect(holdingsRecency.guidance).toBe("Holdings are current across accounts.");
    expect(privateText(holdingsRecency.guidanceParts!)).toBe("");
    expect(holdingsRecency.guidanceActionable).toBe(false);
  });
});

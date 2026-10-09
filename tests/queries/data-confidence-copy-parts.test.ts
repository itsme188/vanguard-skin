import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { stampTaxLotsConvention } from "@/lib/compute/tax-convention";
import { getDataConfidence, copyText, type CopyPart } from "@/lib/queries/data-confidence";

/**
 * Unit B24 — the data-confidence popover.
 *
 * 1. Hide amounts masked every sentence in the popover because each string
 *    was one opaque blob. Each string now also comes as runs: plain wording
 *    (stays readable) and private runs (held counts, tickers, dollars).
 * 2. The stale-holdings action called a whole account N days old when only
 *    a few carried rows lagged. It now names the lagging positions.
 * 3. A score capped by a position/lot drift is reported as a count so the
 *    popover can offer the Tax Lots route.
 *
 * Full migrated schema; runMigrations seeds Vanguard Taxable=1, Vanguard
 * Roth IRA=2, IBKR=3. All symbols and figures are invented.
 */

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertSecurity(
  db: Database.Database,
  symbol: string,
  opts: { securityType?: string | null; ibConId?: number | null } = {}
): number {
  db.prepare(`INSERT INTO securities (symbol, security_type, ib_con_id) VALUES (?, ?, ?)`).run(
    symbol,
    opts.securityType ?? null,
    opts.ibConId ?? null
  );
  return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  asOfDate: string,
  sourceKey: string,
  quantity = 10
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, sourceKey);
}

function insertPrice(db: Database.Database, securityId: number, date: string): void {
  db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, 100)`).run(securityId, date);
}

function insertDailyValuation(
  db: Database.Database,
  accountId: number,
  date: string,
  holdingsCount: number,
  pricedCount: number
): void {
  db.prepare(
    `INSERT INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
     VALUES (?, ?, 0, 0, 0, ?, ?)`
  ).run(accountId, date, holdingsCount, pricedCount);
}

const NOW = new Date("2026-08-21T16:00:00Z");
const TODAY = "2026-08-21";

const publicText = (parts: CopyPart[]) => parts.filter((p): p is string => typeof p === "string").join("");
const privateText = (parts: CopyPart[]) =>
  parts.filter((p): p is { private: string } => typeof p !== "string").map(p => p.private).join("|");

/** A book with a gap in every dimension: 7 held in Taxable (2 unpriced,
 *  3 with no contract id, 1 lagging row), valuation covering 5 of 7. */
function seedGappyBook(db: Database.Database): void {
  for (let i = 0; i < 7; i++) {
    const sym = `QQ${String.fromCharCode(65 + i)}Z`;
    const sec = insertSecurity(db, sym, { securityType: "Stock", ibConId: i < 4 ? 1000 + i : null });
    const date = i === 6 ? "2026-07-31" : TODAY;
    insertHolding(db, 1, sec, date, `canonical:hold:TAX:${sym}:${date}`);
    if (i < 5) insertPrice(db, sec, TODAY);
  }
  insertDailyValuation(db, 1, TODAY, 7, 5);
}

describe("data-confidence copy runs", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("every dimension's runs flatten to exactly the plain string", () => {
    seedGappyBook(db);
    const c = getDataConfidence(db, NOW);
    for (const dim of [
      c.priceFreshness,
      c.holdingsRecency,
      c.cashAccuracy,
      c.enrichmentCompleteness,
      c.valuationCoverage,
    ]) {
      expect(dim.detailParts, dim.detail).toBeDefined();
      expect(dim.guidanceParts, dim.guidance).toBeDefined();
      expect(copyText(dim.detailParts!)).toBe(dim.detail);
      expect(copyText(dim.guidanceParts!)).toBe(dim.guidance);
    }
    expect(c.actions.length).toBeGreaterThanOrEqual(4);
    for (const a of c.actions) {
      expect(copyText(a.messageParts!)).toBe(a.message);
      expect(copyText(a.fixParts!)).toBe(a.fix);
    }
  });

  it("an all-clear book flattens too, and its reassurance carries no private run", () => {
    const sec = insertSecurity(db, "QQAZ", { securityType: "Stock", ibConId: 1 });
    for (const accountId of [1, 2, 3]) {
      insertHolding(db, accountId, sec, TODAY, `test:${accountId}`);
      insertDailyValuation(db, accountId, TODAY, 1, 1);
    }
    insertPrice(db, sec, TODAY);
    const c = getDataConfidence(db, NOW);
    for (const dim of [c.priceFreshness, c.holdingsRecency, c.enrichmentCompleteness, c.valuationCoverage]) {
      expect(copyText(dim.detailParts!)).toBe(dim.detail);
      expect(copyText(dim.guidanceParts!)).toBe(dim.guidance);
      expect(privateText(dim.guidanceParts!), dim.guidance).toBe("");
    }
    expect(publicText(c.priceFreshness.guidanceParts!)).toBe("Prices are fresh — nothing to do.");
  });

  it("generic wording stays public; held counts and tickers sit in private runs", () => {
    seedGappyBook(db);
    const c = getDataConfidence(db, NOW);

    // Prices: 5 of 7 priced.
    expect(publicText(c.priceFreshness.detailParts!)).toBe(" securities have recent prices");
    expect(privateText(c.priceFreshness.detailParts!)).toBe("5/7");
    expect(publicText(c.priceFreshness.guidanceParts!)).toBe(
      " no recent price — run Quick Refresh, or connect TWS for live quotes."
    );

    // Enrichment: 3 missing a contract id.
    expect(publicText(c.enrichmentCompleteness.guidanceParts!)).toBe(" — click Enrich (requires TWS running).");
    expect(publicText(c.enrichmentCompleteness.detailParts!)).toBe(" enriched —  missing conId");

    // Valuation: 2 unpriced.
    expect(publicText(c.valuationCoverage.guidanceParts!)).toBe("Run Quick Refresh to price the remaining .");

    // Holdings: the account name and dates are public, the ticker is not.
    expect(publicText(c.holdingsRecency.detailParts!)).toContain("Vanguard Taxable: latest: 2026-08-21");
    expect(publicText(c.holdingsRecency.detailParts!)).not.toContain("QQGZ");
    expect(privateText(c.holdingsRecency.detailParts!)).toContain("QQGZ");
    expect(publicText(c.holdingsRecency.guidanceParts!)).not.toContain("QQGZ");
    // The stale share of book value is portfolio-derived: a private run.
    expect(privateText(c.holdingsRecency.guidanceParts!)).toMatch(/\d+%/);
    expect(publicText(c.holdingsRecency.guidanceParts!)).not.toMatch(/\d/);
    expect(publicText(c.holdingsRecency.guidanceParts!)).toContain(" of book value is in positions more than a day old");

    // No public run anywhere names a held ticker.
    const everyPublic = [
      c.priceFreshness,
      c.holdingsRecency,
      c.cashAccuracy,
      c.enrichmentCompleteness,
      c.valuationCoverage,
    ]
      .flatMap(d => [publicText(d.detailParts!), publicText(d.guidanceParts!)])
      .concat(c.actions.flatMap(a => [publicText(a.messageParts!), publicText(a.fixParts!)]))
      .join("\n");
    expect(everyPublic).not.toMatch(/QQ[A-G]Z/);
  });

  it("action titles read without their private runs; fix text keeps its tickers private", () => {
    seedGappyBook(db);
    const { actions } = getDataConfidence(db, NOW);

    const price = actions.find(a => a.message.includes("no price from the last"))!;
    expect(publicText(price.messageParts!)).toBe(" no price from the last 3 days");
    expect(publicText(price.fixParts!)).toBe("Run Quick Refresh to update all prices (~2 min)");

    const enrich = actions.find(a => a.message.includes("missing TWS contract data"))!;
    expect(publicText(enrich.messageParts!)).toBe(" missing TWS contract data");
    expect(publicText(enrich.fixParts!)).toBe("Enrich to enable price fetching: ");
    expect(privateText(enrich.fixParts!)).toMatch(/QQ[A-G]Z/);

    const valuation = actions.find(a => a.message.includes("in latest valuation"))!;
    expect(publicText(valuation.messageParts!)).toBe("Only  holdings in latest valuation");
  });

  it("a singular count does not show through the public wording", () => {
    // One security, no contract id: "1 security is missing a TWS contract ID".
    const sec = insertSecurity(db, "QQAZ", { securityType: "Stock" });
    insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:QQAZ:${TODAY}`);
    const one = getDataConfidence(db, NOW).enrichmentCompleteness;
    expect(one.guidance).toBe("1 security is missing a TWS contract ID — click Enrich (requires TWS running).");

    const sec2 = insertSecurity(db, "QQBZ", { securityType: "Stock" });
    insertHolding(db, 1, sec2, TODAY, `canonical:hold:TAX:QQBZ:${TODAY}`);
    const two = getDataConfidence(db, NOW).enrichmentCompleteness;

    expect(publicText(one.guidanceParts!)).toBe(publicText(two.guidanceParts!));
  });
});

describe("data-confidence stale-holdings action names the lagging positions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  /** Gives each listed account one position dated today, so only the account
   *  under test is stale (an account with no holdings reads as unknown age). */
  function seedCurrent(accountIds: number[]): void {
    for (const id of accountIds) {
      insertHolding(db, id, insertSecurity(db, `CUR${id}Z`), TODAY, `plaid:${id}:CUR${id}Z:${TODAY}`);
    }
  }

  it("a few carried rows behind a current account are named; the account is not called N days old", () => {
    // Taxable: 4 rows today, 2 statement-carried rows 21 days back.
    seedCurrent([2, 3]);
    for (const sym of ["QQAZ", "QQBZ", "QQCZ", "QQDZ"]) {
      insertHolding(db, 1, insertSecurity(db, sym), TODAY, `plaid:1:${sym}:${TODAY}`);
    }
    for (const sym of ["SWPAZ", "SWPBZ"]) {
      // 5 shares each (the current rows hold 10).
      insertHolding(db, 1, insertSecurity(db, sym), "2026-07-31", `canonical:hold:TAX:${sym}:2026-07-31`, 5);
    }
    // Every security priced at $100, so each row has a value to weigh by.
    for (const { id } of db.prepare(`SELECT id FROM securities`).all() as { id: number }[]) {
      insertPrice(db, id, TODAY);
    }
    const c = getDataConfidence(db, NOW);

    const taxable = c.holdingsRecency.perAccount.find(a => a.name === "Vanguard Taxable")!;
    expect(taxable.heldCount).toBe(6);
    expect(taxable.stalePositions.map(p => p.symbol).sort()).toEqual(["SWPAZ", "SWPBZ"]);
    // The account's age is still the stalest row's.
    expect(taxable.daysOld).toBe(21);
    // Deliberately changed by the 2026-10-08 ruling (was 50, the stalest
    // row's bucket). Value-weighted: 6 current rows of $1,000 -> 100, 2
    // carried rows of $500 at 21 days -> 50.
    // (6,000*100 + 1,000*50) / 7,000 = 92.86 -> 93
    expect(c.holdingsRecency.score).toBe(93);

    const action = c.actions.find(a => a.message.startsWith("Vanguard Taxable"))!;
    expect(action).toBeDefined();
    expect(action.message).not.toMatch(/holdings are \d+ days old/);
    // Two rows share the oldest date, so their order is not pinned.
    expect(action.message).toMatch(
      /^Vanguard Taxable: 2 of 6 positions are more than a day old — (SWPAZ, SWPBZ|SWPBZ, SWPAZ), oldest dated 2026-07-31 \(21 days, statement\); the rest are current \(latest 2026-08-21\)$/
    );
    expect(copyText(action.messageParts!)).toBe(action.message);
    expect(publicText(action.messageParts!)).toBe(
      "Vanguard Taxable:  more than a day old — , oldest dated 2026-07-31 (21 days, statement); " +
        "the rest are current (latest 2026-08-21)"
    );
  });

  it("one lagging row reads in the singular; a long list is cut to three with a count of the rest", () => {
    seedCurrent([3]);
    insertHolding(db, 2, insertSecurity(db, "QQAZ"), TODAY, `plaid:2:QQAZ:${TODAY}`);
    insertHolding(db, 2, insertSecurity(db, "SWPAZ"), "2026-07-31", "canonical:hold:ROTH:SWPAZ:2026-07-31");
    insertHolding(db, 1, insertSecurity(db, "QQBZ"), TODAY, `plaid:1:QQBZ:${TODAY}`);
    for (const sym of ["LGAZ", "LGBZ", "LGCZ", "LGDZ", "LGEZ"]) {
      insertHolding(db, 1, insertSecurity(db, sym), "2026-08-10", `canonical:hold:TAX:${sym}:2026-08-10`);
    }
    const { actions } = getDataConfidence(db, NOW);
    const row = actions.find(a => a.message.includes("more than a day old"))!;
    expect(row.message).toContain(
      "Vanguard Roth IRA: 1 of 2 positions is more than a day old — SWPAZ, dated 2026-07-31 (21 days, statement); " +
        "the rest are current (latest 2026-08-21)"
    );
    expect(row.message).toMatch(/Vanguard Taxable: 5 of 6 positions are more than a day old — LG[A-E]Z, LG[A-E]Z, LG[A-E]Z \+2 more, oldest dated 2026-08-10 \(11 days, statement\)/);
  });

  it("an account whose every row shares one old date keeps the account-level wording", () => {
    seedCurrent([1, 2]);
    for (const sym of ["QQAZ", "QQBZ"]) {
      insertHolding(db, 3, insertSecurity(db, sym), "2026-08-14", `tws-3-${sym}-2026-08-14`);
    }
    const { actions } = getDataConfidence(db, NOW);
    const row = actions.find(a => a.message.includes("holdings are"))!;
    expect(row.message).toBe("IBKR (live) holdings are 7 days old");
    expect(copyText(row.messageParts!)).toBe(row.message);
  });

  it("every row stale but on different dates: no 'the rest are current' tail", () => {
    seedCurrent([1, 2]);
    insertHolding(db, 3, insertSecurity(db, "QQAZ"), "2026-08-14", "tws-3-QQAZ-2026-08-14");
    insertHolding(db, 3, insertSecurity(db, "QQBZ"), "2026-08-01", "tws-3-QQBZ-2026-08-01");
    const { actions } = getDataConfidence(db, NOW);
    const row = actions.find(a => a.message.startsWith("IBKR"))!;
    expect(row.message).toBe(
      "IBKR: 2 of 2 positions are more than a day old — QQBZ, QQAZ, oldest dated 2026-08-01 (20 days, live)"
    );
  });
});

describe("data-confidence reports a lot-drift cap as a count", () => {
  it("counts critical position/lot drift hits; zero when the scan has not run or is clean", () => {
    const db = createTestDb();
    const sec = insertSecurity(db, "QQAZ", { securityType: "Stock" });
    insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:QQAZ:${TODAY}`, 100);
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (1, ?, '2026-08-01', 10, 40, 40, 400)`
    ).run(sec);

    const unchecked = getDataConfidence(db, NOW);
    expect(unchecked.integrity.lotDriftChecked).toBe(false);
    expect(unchecked.lotDriftCriticalCount).toBe(0);

    stampTaxLotsConvention(db);
    const capped = getDataConfidence(db, NOW);
    expect(capped.capReason).toContain("position/lot drift");
    expect(capped.lotDriftCriticalCount).toBe(1);
  });

  it("a cap from another integrity check is not counted as lot drift", () => {
    const db = createTestDb();
    stampTaxLotsConvention(db);
    const sec = insertSecurity(db, "QQAZ", { securityType: "Bond" });
    insertHolding(db, 1, sec, TODAY, `canonical:hold:TAX:QQAZ:${TODAY}`);
    const buy = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
       VALUES (1, ?, '2026-01-05', 'BUY', 10, -100)`
    );
    for (let i = 0; i < 12; i++) buy.run(sec);
    const c = getDataConfidence(db, NOW);
    expect(c.capReason).toContain("type contradicts");
    // The same security may also drift; the count only ever reads lot-drift keys.
    expect(c.lotDriftCriticalCount).toBe(
      c.integrity.critical.filter(h => h.key.startsWith("lot-drift:")).length
    );
  });
});

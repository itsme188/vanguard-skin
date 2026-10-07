import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCrossSourceDiscrepancies,
  getDataHealthSummary,
  getSectorDisagreements,
  getSectorCheckMissingSector,
  getSnapshotReconciliation,
} from "@/lib/queries/data-health";

/**
 * Count-equals-list identities for the data-health panels touched by the
 * 2026-10-07 QA unit. A headline number and the rows listed beneath it must
 * come from the same predicate. All figures are synthetic.
 */

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSnapshot(accountId: number, date: string, total: number, source = "statement") {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, date, total, source);
}

function seedValuation(accountId: number, date: string, total: number) {
  db.prepare(
    `INSERT INTO daily_valuations
       (account_id, valuation_date, holdings_value, cash_balance, total_value, holdings_count, priced_count)
     VALUES (?, ?, ?, 0, ?, 1, 1)`,
  ).run(accountId, date, total, total);
}

// ── Recon Flags card vs Snapshot Reconciliation rows ──────────────
// QA finding data-health-recon-flags--zero-count-ignores-115-unreconciled-snapshots

describe("Recon Flags — never-compared snapshots are counted, not dropped", () => {
  function seedMixedBook() {
    const acct = seedAccount("Recon Test");
    // clean: compared, inside 2%
    seedSnapshot(acct, "2025-01-31", 10_000);
    seedValuation(acct, "2025-01-31", 10_050);
    // flagged: compared, 10% off
    seedSnapshot(acct, "2025-02-28", 10_000);
    seedValuation(acct, "2025-02-28", 11_000);
    // never compared: no computed value on the statement date
    seedSnapshot(acct, "2025-03-31", 10_000);
    seedSnapshot(acct, "2025-04-30", 10_000);
    seedSnapshot(acct, "2025-05-31", 10_000);
    return acct;
  }

  it("zero flags with uncompared snapshots does not read as a clean zero", () => {
    const acct = seedAccount("Recon Test");
    seedSnapshot(acct, "2025-01-31", 10_000);
    seedValuation(acct, "2025-01-31", 10_000);
    seedSnapshot(acct, "2025-02-28", 10_000);
    seedSnapshot(acct, "2025-03-31", 10_000);

    const summary = getDataHealthSummary(db);
    expect(summary.totalReconciliationFlags).toBe(0);
    expect(summary.totalReconciliationUnchecked).toBe(2);
    expect(summary.totalReconciliationSnapshots).toBe(3);
  });

  it("the card's counts equal the rows the panel lists (same predicate, same window)", () => {
    seedMixedBook();
    const rows = getSnapshotReconciliation(db);
    const summary = getDataHealthSummary(db);

    const flaggedRows = rows.filter((r) => r.diffPct !== null && Math.abs(r.diffPct) > 2);
    const uncheckedRows = rows.filter((r) => r.diffPct === null);

    expect(summary.totalReconciliationFlags).toBe(flaggedRows.length);
    expect(summary.totalReconciliationUnchecked).toBe(uncheckedRows.length);
    expect(summary.totalReconciliationSnapshots).toBe(rows.length);
    expect(flaggedRows.length).toBe(1);
    expect(uncheckedRows.length).toBe(3);
  });

  it("every listed row is exactly one of flagged / unchecked / clean", () => {
    seedMixedBook();
    const rows = getSnapshotReconciliation(db);
    const summary = getDataHealthSummary(db);
    const cleanRows = rows.filter((r) => r.diffPct !== null && Math.abs(r.diffPct) <= 2);

    expect(
      summary.totalReconciliationFlags + summary.totalReconciliationUnchecked + cleanRows.length,
    ).toBe(summary.totalReconciliationSnapshots);
  });

  it("a live (Plaid/TWS) snapshot is outside the panel, so it is not 'unchecked' either", () => {
    const acct = seedAccount("Recon Test");
    seedSnapshot(acct, "2025-01-31", 10_000);
    seedSnapshot(acct, "2025-02-03", 10_000, "plaid");

    const summary = getDataHealthSummary(db);
    expect(summary.totalReconciliationSnapshots).toBe(getSnapshotReconciliation(db).length);
    expect(summary.totalReconciliationUnchecked).toBe(1);
  });

  it("a compared snapshot whose statement total is zero has no percentage and counts as unchecked", () => {
    const acct = seedAccount("Recon Test");
    seedSnapshot(acct, "2025-01-31", 0);
    seedValuation(acct, "2025-01-31", 500);

    const rows = getSnapshotReconciliation(db);
    expect(rows[0].diffPct).toBeNull();
    expect(getDataHealthSummary(db).totalReconciliationUnchecked).toBe(1);
  });
});

// ── Cross-Source Discrepancies rows carry the security id ─────────
// QA finding data-health--47-symbol-cells-dead-text-while-siblings-link-to-hub

describe("getCrossSourceDiscrepancies — rows carry securityId for the hub link", () => {
  it("returns the id of the security each row is about", () => {
    const aaa = db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAA', 'AAA Inc', 'Stock')")
      .run().lastInsertRowid as number;
    const bbb = db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('BBB', 'BBB Inc', 'Stock')")
      .run().lastInsertRowid as number;
    for (const [id, close] of [
      [aaa, 100],
      [bbb, 100],
    ] as const) {
      db.prepare(
        "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2025-03-03', ?, 'statement')",
      ).run(id, close);
    }
    const bar = db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, '2025-03-03', '1 day', ?, ?, ?, ?, 1000)`,
    );
    bar.run(aaa, 110, 110, 110, 110); // 10% off
    bar.run(bbb, 150, 150, 150, 150); // 50% off

    const rows = getCrossSourceDiscrepancies(db);
    expect(rows.map((r) => [r.symbol, r.securityId])).toEqual([
      ["BBB", bbb],
      ["AAA", aaa],
    ]);
  });
});

// ── Sector disagreements vs "missing a sector" ────────────────────
// QA finding data-health-sector-disagreements--null-sectors-listed-as-disagreements

describe("Sector disagreements — a missing sector is not a disagreement", () => {
  function seedSectorBook() {
    const ins = db.prepare(
      "INSERT INTO securities (symbol, security_type, sector, fund_category, industry, source_key) VALUES (?, 'Stock', ?, ?, ?, ?)",
    );
    ins.run("AAA", "Consumer Staples", "US Sector Equity (Health Care)", "Biotechnology", "t:aaa"); // real disagreement
    ins.run("BBB", null, "US Sector Equity (Technology)", "Software", "t:bbb"); // NULL sector
    ins.run("CCC", "", "US Sector Equity (Energy)", null, "t:ccc"); // empty sector
    ins.run("DDD", "   ", "US Sector Equity (Utilities)", null, "t:ddd"); // whitespace sector
    ins.run("EEE", "Energy", "US Sector Equity (Energy)", null, "t:eee"); // agrees
    ins.run("FFF", null, "US Sector Equity (Semiconductors)", null, "t:fff"); // implied is finer than GICS: outside the check
    ins.run("GGG", null, "International Equity", null, "t:ggg"); // not sector-shaped: outside the check
    ins.run("HHH", null, "US Sector Equity (Technology)", null, "t:hhh"); // verified below: suppressed
    db.prepare(
      "UPDATE securities SET sector_verified_at = datetime('now') WHERE symbol = 'HHH'",
    ).run();
  }

  it("the disagreements list holds only rows that HAVE a sector", () => {
    seedSectorBook();
    const rows = getSectorDisagreements(db);
    expect(rows.map((r) => r.symbol)).toEqual(["AAA"]);
    expect(rows.every((r) => r.sector !== null && r.sector.trim() !== "")).toBe(true);
  });

  it("NULL, empty and whitespace sectors are listed as missing instead", () => {
    seedSectorBook();
    expect(getSectorCheckMissingSector(db).map((r) => r.symbol)).toEqual(["BBB", "CCC", "DDD"]);
  });

  it("the two lists are disjoint and together are every unverified row the check covers", () => {
    seedSectorBook();
    const disagreements = getSectorDisagreements(db).map((r) => r.symbol);
    const missing = getSectorCheckMissingSector(db).map((r) => r.symbol);

    expect(disagreements.filter((s) => missing.includes(s))).toEqual([]);
    // AAA..DDD are the four rows the old single list rendered.
    expect([...disagreements, ...missing].sort()).toEqual(["AAA", "BBB", "CCC", "DDD"]);
  });

  it("both lists carry securityId so the page can link the symbol to the hub", () => {
    seedSectorBook();
    const idOf = (symbol: string) =>
      (db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as { id: number }).id;

    expect(getSectorDisagreements(db)[0].securityId).toBe(idOf("AAA"));
    expect(getSectorCheckMissingSector(db)[0].securityId).toBe(idOf("BBB"));
  });
});

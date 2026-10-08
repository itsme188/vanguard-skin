import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAccountCoverage,
  getDataHealthSummary,
  getSectorCheckMissingSector,
  getSectorDisagreements,
} from "@/lib/queries/data-health";
import {
  groupIntegrityHits,
  integrityCheckIdOf,
  INTEGRITY_CHECK_LABELS,
  type IntegrityHit,
} from "@/lib/queries/integrity-checks";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // accounts 1, 2, 3 are seeded by the migrations.
});

function addStock(symbol: string, sector: string | null, fundCategory: string | null = null): number {
  return Number(
    db
      .prepare(
        "INSERT INTO securities (symbol, security_type, sector, fund_category, source_key) VALUES (?, 'Stock', ?, ?, ?)",
      )
      .run(symbol, sector, fundCategory, `t:${symbol}`).lastInsertRowid,
  );
}

function hold(accountId: number, securityId: number, quantity: number, asOf = "2026-04-30") {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(accountId, securityId, asOf, quantity, `t:${accountId}:${securityId}:${asOf}`);
}

// QA finding data-health-sector-disagreements--all-rows-unheld-and-untagged-regression-3
// (recommended option 1: held + watchlist only, both sector tags required).
describe("Sector check covers only stocks the portfolio touches", () => {
  const DISAGREE = ["Consumer Staples", "US Sector Equity (Health Care)"] as const;

  it("an unheld, unwatched disagreement is not listed", () => {
    addStock("AAA", ...DISAGREE);
    expect(getSectorDisagreements(db)).toEqual([]);
    expect(getSectorCheckMissingSector(db)).toEqual([]);
  });

  it("a currently held disagreement is listed — long or short", () => {
    hold(1, addStock("AAA", ...DISAGREE), 10);
    hold(3, addStock("BBB", ...DISAGREE), -5);
    expect(getSectorDisagreements(db).map((r) => r.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("a sold position (latest quantity 0) drops out, even with older non-zero rows", () => {
    const id = addStock("AAA", ...DISAGREE);
    hold(1, id, 10, "2026-03-31");
    hold(1, id, 0, "2026-04-30");
    expect(getSectorDisagreements(db)).toEqual([]);
  });

  it("a stock on the active watchlist is listed without being held; an inactive entry is not", () => {
    const watched = addStock("AAA", ...DISAGREE);
    const dropped = addStock("BBB", ...DISAGREE);
    db.prepare("INSERT INTO watchlist (security_id, is_active) VALUES (?, 1)").run(watched);
    db.prepare("INSERT INTO watchlist (security_id, is_active) VALUES (?, 0)").run(dropped);
    expect(getSectorDisagreements(db).map((r) => r.symbol)).toEqual(["AAA"]);
  });

  it("a stock both held and watched is listed once", () => {
    const id = addStock("AAA", ...DISAGREE);
    hold(1, id, 10);
    hold(2, id, 4);
    db.prepare("INSERT INTO watchlist (security_id, is_active) VALUES (?, 1)").run(id);
    expect(getSectorDisagreements(db).map((r) => r.symbol)).toEqual(["AAA"]);
  });

  it("the missing-sector count follows the same scope", () => {
    hold(1, addStock("AAA", null, "US Sector Equity (Energy)"), 10);
    addStock("BBB", null, "US Sector Equity (Energy)"); // not in the portfolio
    expect(getSectorCheckMissingSector(db).map((r) => r.symbol)).toEqual(["AAA"]);
    expect(getSectorDisagreements(db)).toEqual([]);
  });
});

// QA finding data-health--headline-distinct-securities-vs-account-rows-pairs-no-grain-label
describe("Price Coverage headline vs Account Coverage rows: same rows, two grains", () => {
  it("counts the securities held in more than one account, which is the whole gap", () => {
    const today = todayET();
    const a = addStock("AAA", null);
    const b = addStock("BBB", null);
    const c = addStock("CCC", null);
    hold(1, a, 10);
    hold(2, a, 5); // AAA in two accounts
    hold(1, b, 10);
    hold(2, b, 5);
    hold(3, b, 1); // BBB in three accounts
    hold(3, c, 7);
    for (const id of [a, b, c]) {
      db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 10, 'tws')").run(id, today);
    }

    const summary = getDataHealthSummary(db);
    expect(summary.totalSecurities).toBe(3); // distinct
    expect(summary.securitiesHeldInMultipleAccounts).toBe(2);

    const positions = getAccountCoverage(db).reduce((n, ac) => n + ac.totalHoldings, 0);
    expect(positions).toBe(6); // account × security
    // The rows exceed the headline exactly by the extra accounts (AAA +1, BBB +2).
    expect(positions - summary.totalSecurities).toBe(3);
  });

  it("is zero when no security is shared, and the two grains then agree", () => {
    hold(1, addStock("AAA", null), 10);
    hold(2, addStock("BBB", null), 10);
    const summary = getDataHealthSummary(db);
    expect(summary.securitiesHeldInMultipleAccounts).toBe(0);
    expect(getAccountCoverage(db).reduce((n, ac) => n + ac.totalHoldings, 0)).toBe(summary.totalSecurities);
  });

  it("a sold leg does not count as a second account", () => {
    const a = addStock("AAA", null);
    hold(1, a, 10);
    hold(2, a, 5, "2026-03-31");
    hold(2, a, 0, "2026-04-30");
    expect(getDataHealthSummary(db).securitiesHeldInMultipleAccounts).toBe(0);
  });
});

// QA findings data-health--full-audit-destination-never-mentions-the-integrity-cap-behind-the-badge
// and header-dataconfidence--full-audit-link-lands-on-page-without-integrity-notes
describe("groupIntegrityHits", () => {
  const hit = (key: string, severity: IntegrityHit["severity"] = "warning"): IntegrityHit => ({
    key, severity, reason: `reason for ${key}`,
  });

  it("names the check from the key the scanner minted", () => {
    expect(integrityCheckIdOf("type-contradiction:7")).toBe("type-contradiction");
    expect(integrityCheckIdOf("cash-residual:1:2026-04-30")).toBe("cash-residual");
    expect(integrityCheckIdOf("lot-drift:1:7")).toBe("lot-drift");
    expect(integrityCheckIdOf("reconcile-delta:3")).toBe("reconcile-delta");
    expect(integrityCheckIdOf("something-new:1")).toBe("other");
  });

  it("groups in scan order, keeps each group's order, and drops no hit", () => {
    const hits = [
      hit("lot-drift:1:9"), hit("reconcile-delta:3"), hit("lot-drift:1:2"),
      hit("type-contradiction:7"), hit("something-new:1"),
    ];
    const groups = groupIntegrityHits(hits);
    expect(groups.map((g) => g.check)).toEqual(["type-contradiction", "lot-drift", "reconcile-delta", "other"]);
    expect(groups[1].hits.map((h) => h.key)).toEqual(["lot-drift:1:9", "lot-drift:1:2"]);
    expect(groups.reduce((n, g) => n + g.hits.length, 0)).toBe(hits.length);
    expect(groups[1].label).toBe(INTEGRITY_CHECK_LABELS["lot-drift"]);
  });

  it("returns no groups for no hits", () => {
    expect(groupIntegrityHits([])).toEqual([]);
  });

  it("every label is plain words, never a key or a file name", () => {
    for (const label of Object.values(INTEGRITY_CHECK_LABELS)) {
      expect(label).not.toMatch(/[-_:.]|\.ts/);
    }
  });
});

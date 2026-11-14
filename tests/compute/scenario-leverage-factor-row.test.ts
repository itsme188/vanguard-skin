import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * QA finding dashboard-analysis-view-diagnostics-scope-ibkr-build-custom-scenario-
 * result-card-custom-scenario-prints-udow-…: a leveraged fund's row showed
 * "β1.0" beside a -30% move on a -10% market move. The impact row now carries
 * the signed factor that produced the move so the card can print it.
 * Synthetic symbols and round figures only.
 */
describe("custom scenario: the impact row carries the leverage factor it applied", () => {
  let db: Database.Database;
  const BULL = 21;
  const BEAR = 22;
  const PLAIN = 23;
  const NO_FACTOR = 24;
  const today = todayET();

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
    const sec = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, leverage_factor)
       VALUES (?, ?, ?, ?, 'Technology', ?, ?)`,
    );
    sec.run(BULL, "ZZU", "ZZ ULTRAPRO 3X BULL ETF", "ETF", "Leveraged/Inverse", 3);
    sec.run(BEAR, "ZZD", "ZZ ULTRAPRO 3X BEAR ETF", "ETF", "Leveraged/Inverse", -3);
    sec.run(PLAIN, "AAA", "AAA Corp", "Stock", null, null);
    sec.run(NO_FACTOR, "ZZN", "ZZ 2X LONG FUND", "ETF", "Leveraged/Inverse", null);
    const px = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 50, 'test')`);
    const h = db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 100, ?)`,
    );
    for (const id of [BULL, BEAR, PLAIN, NO_FACTOR]) {
      px.run(id, today);
      h.run(id, today, `h-${id}`);
    }
  });

  const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;

  it("names the signed factor on a modelled leveraged or inverse fund only", () => {
    const res = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.1 });
    expect(rowOf(res, BULL).leverageFactor).toBe(3);
    expect(rowOf(res, BEAR).leverageFactor).toBe(-3);
    expect(rowOf(res, PLAIN).leverageFactor).toBeUndefined();
    // A flagged fund with no stored factor takes no figure and names none.
    expect(rowOf(res, NO_FACTOR).leverageFactor).toBeUndefined();
    expect(rowOf(res, NO_FACTOR).leveragedFundUnmodelled).toBe(true);
    // The factor really is what produced the move the row shows.
    expect(rowOf(res, BULL).changePercent).toBeCloseTo(3 * rowOf(res, PLAIN).changePercent, 10);
  });
});

/**
 * B4 — fixed Performance periods (1Y / 3Y / 5Y) end at the last statement
 * anchor and cover the FULL span.
 *
 * Owner ruling: "1Y" used to start a calendar year before TODAY while its
 * monthly chain could only reach the last STATEMENT, so with the newest
 * statement a month or two behind, "1Y" covered about eleven months. A fixed
 * period is now a full span ending at the last statement-grade month-end
 * anchor for the scope: end = anchor, start = anchor minus the period.
 * YTD and All are unchanged.
 *
 * Every figure below is invented (round, synthetic).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";
import {
  resolvePerformanceWindow,
  latestStatementAnchor,
  newestStatementInScope,
  performanceWindowCaption,
  shiftYearsMonthEndAware,
} from "@/lib/compute/performance-window";
import { anchorIndex } from "@/tests/helpers/source-anchor";

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  source = "canonical",
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, monthEndDate, totalValue, source);
}

describe("resolvePerformanceWindow — the one window rule", () => {
  const today = "2026-10-08";

  it("1Y is the full year ending at the last statement anchor", () => {
    expect(resolvePerformanceWindow("1y", { today, lastStatementAnchor: "2026-09-30" })).toEqual({
      startDate: "2025-09-30",
      endDate: "2026-09-30",
      endsAtStatement: true,
      chainStartDate: "2025-10-01",
    });
  });

  it("3Y and 5Y shift the same anchor back three and five years", () => {
    const three = resolvePerformanceWindow("3y", { today, lastStatementAnchor: "2026-09-30" });
    const five = resolvePerformanceWindow("5y", { today, lastStatementAnchor: "2026-09-30" });
    expect([three.startDate, three.endDate]).toEqual(["2023-09-30", "2026-09-30"]);
    expect([five.startDate, five.endDate]).toEqual(["2021-09-30", "2026-09-30"]);
    expect(three.endsAtStatement && five.endsAtStatement).toBe(true);
  });

  it("the start is month-end aware", () => {
    // A leap-day anchor lands on Feb 28 a year earlier.
    expect(shiftYearsMonthEndAware("2024-02-29", 1)).toBe("2023-02-28");
    // A month-end anchor stays a month-end: a year before Feb 28, 2025 is the
    // leap-year month-end Feb 29, 2024 — the day the opening statement is dated.
    expect(shiftYearsMonthEndAware("2025-02-28", 1)).toBe("2024-02-29");
    expect(shiftYearsMonthEndAware("2026-09-30", 1)).toBe("2025-09-30");
    // Not a month-end: same day of the month.
    expect(shiftYearsMonthEndAware("2026-03-15", 3)).toBe("2023-03-15");
  });

  it("with no statement anchor a fixed period falls back to rolling with today", () => {
    expect(resolvePerformanceWindow("1y", { today, lastStatementAnchor: null })).toEqual({
      startDate: "2025-10-08",
      endDate: "2026-10-08",
      endsAtStatement: false,
      chainStartDate: "2025-10-08",
    });
  });

  it("YTD stays Jan 1 to today and All stays unbounded, whatever the anchor", () => {
    expect(resolvePerformanceWindow("ytd", { today, lastStatementAnchor: "2026-09-30" })).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-10-08",
      endsAtStatement: false,
      chainStartDate: "2026-01-01",
    });
    expect(resolvePerformanceWindow("all", { today, lastStatementAnchor: "2026-09-30" })).toEqual({
      startDate: undefined,
      endDate: "2026-10-08",
      endsAtStatement: false,
      chainStartDate: undefined,
    });
  });
});

describe("performanceWindowCaption", () => {
  const today = "2026-10-08";

  it("a fixed period names its end date and that it is the last statement", () => {
    const w = resolvePerformanceWindow("1y", { today, lastStatementAnchor: "2026-09-30" });
    expect(performanceWindowCaption("1y", w)).toBe(
      "1Y to Sep 30, 2026 (last statement) — measured from Sep 30, 2025, or from the start of this scope's history if that is later.",
    );
  });

  it("the fallback says the period rolls with today because there is no statement", () => {
    const w = resolvePerformanceWindow("3y", { today, lastStatementAnchor: null });
    expect(performanceWindowCaption("3y", w)).toBe(
      "3Y to Oct 8, 2026 (today) — this scope has no statement yet, so the period rolls with today.",
    );
  });

  it("YTD and All carry no caption", () => {
    for (const p of ["ytd", "all"] as const) {
      const w = resolvePerformanceWindow(p, { today, lastStatementAnchor: "2026-09-30" });
      expect(performanceWindowCaption(p, w)).toBeNull();
    }
  });
});

describe("latestStatementAnchor — statement-grade, full coverage", () => {
  let db: Database.Database;
  let ids: number[];

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    ids = (db.prepare("SELECT id FROM accounts ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it("returns null when the scope has no statement snapshot", () => {
    expect(latestStatementAnchor(db, undefined, "2026-10-08")).toBeNull();
    seedSnapshot(db, ids[0], "2026-10-07", 500, "plaid");
    expect(latestStatementAnchor(db, [ids[0]], "2026-10-08")).toBeNull();
  });

  it("ignores live (plaid / tws) snapshots — only a statement can be the anchor", () => {
    seedSnapshot(db, ids[0], "2026-08-31", 1000);
    seedSnapshot(db, ids[0], "2026-10-07", 1100, "plaid");
    seedSnapshot(db, ids[0], "2026-10-08", 1100, "tws");
    expect(latestStatementAnchor(db, [ids[0]], "2026-10-08")).toBe("2026-08-31");
  });

  it("a multi-account scope anchors on the latest month EVERY account has a statement for", () => {
    seedSnapshot(db, ids[0], "2026-07-31", 1000);
    seedSnapshot(db, ids[0], "2026-08-31", 1000);
    seedSnapshot(db, ids[0], "2026-09-30", 1000);
    seedSnapshot(db, ids[1], "2026-07-31", 2000);
    seedSnapshot(db, ids[1], "2026-08-31", 2000);
    // ids[1]'s September statement has not arrived.
    expect(latestStatementAnchor(db, [ids[0], ids[1]], "2026-10-08")).toBe("2026-08-31");
    expect(latestStatementAnchor(db, undefined, "2026-10-08")).toBe("2026-08-31");
    // Each account alone anchors on its own latest statement.
    expect(latestStatementAnchor(db, [ids[0]], "2026-10-08")).toBe("2026-09-30");
    expect(latestStatementAnchor(db, [ids[1]], "2026-10-08")).toBe("2026-08-31");
  });

  it("an empty scope has no anchor (never widens to every account)", () => {
    seedSnapshot(db, ids[0], "2026-08-31", 1000);
    expect(latestStatementAnchor(db, [], "2026-10-08")).toBeNull();
  });
});

describe("worked example — a full twelve-month 1Y chain", () => {
  // One account, statements at every month-end from Aug 31, 2025 to
  // Aug 31, 2026, no deposits or withdrawals. September 2026's statement has
  // NOT arrived; today is Oct 8, 2026.
  //
  //   Aug 31, 2025   100,000   (opening anchor)
  //   Sep 30, 2025   110,000   +10%
  //   Oct 2025 … Jul 2026   110,000 each   0% x 10 months
  //   Aug 31, 2026   121,000   +10%   (last statement anchor)
  //
  // NEW 1Y window: Aug 31, 2025 -> Aug 31, 2026, twelve monthly links:
  //   TWR = 1.10 x 1.00^10 x 1.10 - 1 = 21.00%, over 365 days
  //   annualized = 1.21^(365.25/365) - 1 = 21.0158%
  //   XIRR: -100,000 on Aug 31, 2025, +121,000 on Aug 31, 2026
  //         = 1.21^(365.25/365) - 1 = 21.0158% (same window, no flows)
  //
  // OLD 1Y window: start = today minus a year = Oct 8, 2025. The first
  // statement on or after that is Oct 31, chained off Sep 30, so September
  // 2025's +10% is dropped: eleven links, 1.00^10 x 1.10 - 1 = 10.00%.
  let db: Database.Database;
  const ACCT = 1;
  const today = "2026-10-08";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedSnapshot(db, ACCT, "2025-08-31", 100000);
    seedSnapshot(db, ACCT, "2025-09-30", 110000);
    for (const d of [
      "2025-10-31", "2025-11-30", "2025-12-31", "2026-01-31", "2026-02-28",
      "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31",
    ]) {
      seedSnapshot(db, ACCT, d, 110000);
    }
    seedSnapshot(db, ACCT, "2026-08-31", 121000);
    // A live current-value row after the last statement must not move the anchor.
    seedSnapshot(db, ACCT, "2026-10-07", 125000, "plaid");
  });

  it("the window is the full year ending at the last statement", () => {
    const anchor = latestStatementAnchor(db, [ACCT], today);
    expect(anchor).toBe("2026-08-31");
    const w = resolvePerformanceWindow("1y", { today, lastStatementAnchor: anchor });
    expect(w.startDate).toBe("2025-08-31");
    expect(w.endDate).toBe("2026-08-31");
  });

  it("TWR chains all twelve months: 21%, 365 days, opening on the anchor a year back", () => {
    const w = resolvePerformanceWindow("1y", {
      today,
      lastStatementAnchor: latestStatementAnchor(db, [ACCT], today),
    });
    const twr = computeTwr(db, { startDate: w.chainStartDate, endDate: w.endDate, accountId: ACCT });
    expect(twr).not.toBeNull();
    expect(twr!.perAccount[0].monthsIncluded).toBe(12);
    expect(twr!.totalReturn).toBeCloseTo(0.21, 10);
    expect(twr!.measurementStartDate).toBe(w.startDate);
    expect(twr!.endDate).toBe(w.endDate);
    expect(twr!.totalDays).toBe(365);
    expect(twr!.annualizedReturn).toBeCloseTo(Math.pow(1.21, 365.25 / 365) - 1, 10);
    expect(twr!.isPartial).toBe(false);
  });

  it("XIRR describes the same window: opening value on the start, closing value on the end", () => {
    const w = resolvePerformanceWindow("1y", {
      today,
      lastStatementAnchor: latestStatementAnchor(db, [ACCT], today),
    });
    const xirr = computeXirr(db, { startDate: w.chainStartDate, endDate: w.endDate, accountId: ACCT });
    expect(xirr).not.toBeNull();
    expect(xirr!.startDate).toBe(w.startDate);
    expect(xirr!.endDate).toBe(w.endDate);
    expect(xirr!.currentValue).toBe(121000);
    expect(xirr!.xirr).toBeCloseTo(Math.pow(1.21, 365.25 / 365) - 1, 5);
  });

  it("the old rolling start dropped a month: eleven links and 10%", () => {
    const old = computeTwr(db, { startDate: "2025-10-08", accountId: ACCT });
    expect(old!.perAccount[0].monthsIncluded).toBe(11);
    expect(old!.totalReturn).toBeCloseTo(0.1, 10);
  });
});

describe("PerformanceView feeds every consumer the one window", () => {
  // The view is a server component that opens the production db at import and
  // the repo has no DOM harness, so the wiring is pinned by reading the source.
  const view = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");
  const flat = view.replace(/\s+/g, " ");

  it("the window comes from the shared rule and the shared anchor lookup", () => {
    expect(view).toContain('from "@/lib/compute/performance-window"');
    expect(flat).toContain("resolvePerformanceWindow(activePeriod, { today,");
    expect(flat).toContain("lastStatementAnchor: latestStatementAnchor(db, scopeAccountIds, today),");
    // The caption can say why a multi-account period ends early.
    expect(flat).toContain("newestScopeStatement: newestStatementInScope(db, scopeAccountIds, today),");
    // The old rolling rule is gone.
    expect(view).not.toContain("startDateForPeriod");
    expect(view).not.toContain("setUTCFullYear");
  });

  it("TWR and XIRR take the same start and end", () => {
    expect(flat).toContain(
      "computeTwr(db, { startDate: chainStart, endDate: chainEnd, accountId: twrAccountId, accountIds: twrAccountIds, })",
    );
    expect(flat).toContain("computeXirr(db, { startDate: chainStart, endDate: chainEnd, accountId })");
    // A fixed period is bounded at the statement; YTD / All keep their old
    // open end (the compute layer's own default).
    expect(flat).toContain("const chainEnd = perfWindow.endsAtStatement ? perfWindow.endDate : undefined;");
  });

  it("risk metrics, the curve, the benchmark rows and the attribution share the window end", () => {
    expect(flat).toContain("const dailyEnd = perfWindow.endDate;");
    const riskAt = anchorIndex(flat, "computeRiskMetrics(db, {");
    expect(flat.slice(riskAt, riskAt + 120)).toContain("startDate, endDate: dailyEnd,");
    expect(flat).toContain(
      "getDailyValuationsByAccount(db, accountId, { startDate: effectiveStart, endDate: dailyEnd })",
    );
    const combinedAt = anchorIndex(flat, "getDailyValuationsCombined(db, {");
    expect(flat.slice(combinedAt, combinedAt + 120)).toContain("startDate: effectiveStart, endDate: dailyEnd,");
    expect(flat).toContain(".all(BENCHMARK_SYMBOL, effectiveStart, dailyEnd)");
    const attrAt = anchorIndex(flat, "attribution = computePeriodAttribution(");
    expect(flat.slice(attrAt, attrAt + 200)).toContain("effectiveStart, dailyEnd, BENCHMARK_SYMBOL,");
  });

  it("renders the window caption under the period selector", () => {
    expect(flat).toContain("const windowCaption = performanceWindowCaption(activePeriod, perfWindow);");
    expect(flat).toContain("{windowCaption && (");
  });
});

describe("a scope held back by an account whose statements stopped says so", () => {
  let db: Database.Database;
  let ids: number[];
  const today = "2026-10-08";
  const CLAUSE = "Not every account in this scope has a statement after Sep 30, 2025, so the period ends there.";

  /** Month-ends from `from` (YYYY-MM) through `to` (YYYY-MM), inclusive. */
  function monthEnds(from: string, to: string): string[] {
    const out: string[] = [];
    let [y, m] = from.split("-").map(Number);
    const [ty, tm] = to.split("-").map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      out.push(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10));
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return out;
  }

  function seedThrough(accountId: number, to: string): void {
    for (const d of monthEnds("2024-06", to)) seedSnapshot(db, accountId, d, 1000);
  }

  function captionFor(scope: number[] | undefined): string | null {
    const window = resolvePerformanceWindow("1y", {
      today,
      lastStatementAnchor: latestStatementAnchor(db, scope, today),
      newestScopeStatement: newestStatementInScope(db, scope, today),
    });
    return performanceWindowCaption("1y", window);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    ids = (db.prepare("SELECT id FROM accounts ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });

  it("three accounts, one stopped a year earlier: the anchor is unchanged and the caption names the cause", () => {
    seedThrough(ids[0], "2026-09");
    seedThrough(ids[1], "2026-09");
    seedThrough(ids[2], "2025-09");
    const scope = [ids[0], ids[1], ids[2]];
    // The anchor rule is NOT changed: the latest month every account has.
    expect(latestStatementAnchor(db, scope, today)).toBe("2025-09-30");
    expect(newestStatementInScope(db, scope, today)).toBe("2026-09-30");
    expect(captionFor(scope)).toBe(
      `1Y to Sep 30, 2025 (last statement) — measured from Sep 30, 2024, or from the start of this scope's history if that is later. ${CLAUSE}`,
    );
    expect(captionFor(undefined)).toContain(CLAUSE);
  });

  it("all three current: no clause", () => {
    for (const id of ids.slice(0, 3)) seedThrough(id, "2026-09");
    const scope = ids.slice(0, 3);
    expect(newestStatementInScope(db, scope, today)).toBe("2026-09-30");
    expect(captionFor(scope)).toBe("1Y to Sep 30, 2026 (last statement) — measured from Sep 30, 2025, or from the start of this scope's history if that is later.");
  });

  it("one account a single statement behind (inside 62 days): no clause", () => {
    seedThrough(ids[0], "2026-09");
    seedThrough(ids[1], "2026-09");
    seedThrough(ids[2], "2026-08");
    const caption = captionFor([ids[0], ids[1], ids[2]])!;
    expect(caption).toBe("1Y to Aug 31, 2026 (last statement) — measured from Aug 31, 2025, or from the start of this scope's history if that is later.");
  });

  it("a single account: no clause, whatever the other accounts have", () => {
    seedThrough(ids[0], "2026-09");
    seedThrough(ids[2], "2025-09");
    expect(captionFor([ids[2]])).toBe("1Y to Sep 30, 2025 (last statement) — measured from Sep 30, 2024, or from the start of this scope's history if that is later.");
    expect(captionFor([ids[0]])).toBe("1Y to Sep 30, 2026 (last statement) — measured from Sep 30, 2025, or from the start of this scope's history if that is later.");
  });

  it("the newest statement ignores live rows, rows after today and mid-month rows; an empty scope has none", () => {
    seedThrough(ids[0], "2026-08");
    seedSnapshot(db, ids[0], "2026-10-07", 1000, "plaid");
    seedSnapshot(db, ids[0], "2026-09-15", 1000);
    seedSnapshot(db, ids[0], "2026-10-31", 1000);
    expect(newestStatementInScope(db, [ids[0]], today)).toBe("2026-08-31");
    expect(newestStatementInScope(db, [], today)).toBeNull();
  });

  it("a window resolved without the newest statement (today's callers) keeps the old caption", () => {
    const window = resolvePerformanceWindow("1y", { today, lastStatementAnchor: "2025-09-30" });
    expect(window).toEqual({
      startDate: "2024-09-30",
      endDate: "2025-09-30",
      endsAtStatement: true,
      chainStartDate: "2024-10-01",
    });
    expect("newestScopeStatement" in window).toBe(false);
    expect(performanceWindowCaption("1y", window)).toBe(
      "1Y to Sep 30, 2025 (last statement) — measured from Sep 30, 2024, or from the start of this scope's history if that is later.",
    );
  });
});

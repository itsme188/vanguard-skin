/**
 * U13 — the Performance caption names the start date the return is actually
 * measured from, so it agrees with the "Period window" card below it.
 *
 * Defect: the caption printed the window's opening date (the statement a
 * full period back, e.g. Sep 30) while the card printed the date the chained
 * return opens on. For an account whose statements carry a stored monthly
 * return, the chain opens on the first day of the first month (Oct 1): a
 * one-day gap between two labels for one window.
 *
 * Caption-only fix: no return computation changes. These tests also PIN what
 * the computation does at both branches, so a later change to it is seen.
 *
 * Every figure is invented.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTwr } from "@/lib/compute/twr";
import {
  resolvePerformanceWindow,
  latestStatementAnchor,
  performanceWindowCaption,
} from "@/lib/compute/performance-window";
import { performanceCaptionMeasuredFrom } from "@/lib/compute/performance-window-caption";

const ACCT = 1;
const today = "2026-10-08";

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

describe("performanceCaptionMeasuredFrom", () => {
  const window = resolvePerformanceWindow("1y", { today, lastStatementAnchor: "2026-09-30" });

  it("the base caption still carries the clause this helper replaces", () => {
    // If this wording changes in performance-window.ts, update the helper.
    expect(performanceWindowCaption("1y", window)).toBe(
      "1Y to Sep 30, 2026 (last statement) — measured from Sep 30, 2025, or from the start of this scope's history if that is later.",
    );
  });

  it("prints the date the return is measured from when it is the day after the opening statement", () => {
    expect(performanceCaptionMeasuredFrom("1y", window, "2025-10-01")).toBe(
      "1Y to Sep 30, 2026 (last statement) — measured from Oct 1, 2025.",
    );
  });

  it("prints the opening statement date when the return opens on it", () => {
    expect(performanceCaptionMeasuredFrom("1y", window, "2025-09-30")).toBe(
      "1Y to Sep 30, 2026 (last statement) — measured from Sep 30, 2025.",
    );
  });

  it("a shorter history names the real start and the date the period opens", () => {
    expect(performanceCaptionMeasuredFrom("1y", window, "2026-03-31")).toBe(
      "1Y to Sep 30, 2026 (last statement) — measured from Mar 31, 2026, the nearest date this scope's return can start from (the period opens Sep 30, 2025).",
    );
  });

  it("keeps the held-back sentence", () => {
    const held = resolvePerformanceWindow("1y", {
      today,
      lastStatementAnchor: "2025-09-30",
      newestScopeStatement: "2026-09-30",
    });
    expect(performanceCaptionMeasuredFrom("1y", held, "2024-10-01")).toBe(
      "1Y to Sep 30, 2025 (last statement) — measured from Oct 1, 2024. Not every account in this scope has a statement after Sep 30, 2025, so the period ends there.",
    );
  });

  it("with no measured date, or for YTD / All / a scope with no statement, the base caption is unchanged", () => {
    expect(performanceCaptionMeasuredFrom("1y", window, null)).toBe(performanceWindowCaption("1y", window));
    const ytd = resolvePerformanceWindow("ytd", { today, lastStatementAnchor: "2026-09-30" });
    expect(performanceCaptionMeasuredFrom("ytd", ytd, "2026-01-01")).toBeNull();
    const rolling = resolvePerformanceWindow("1y", { today, lastStatementAnchor: null });
    expect(performanceCaptionMeasuredFrom("1y", rolling, "2025-10-08")).toBe(
      performanceWindowCaption("1y", rolling),
    );
  });
});

describe("what the return computation uses as its start (pinned, not changed)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seed(storedMonthlyReturn: number | null): void {
    // Thirteen flat-growth statements, 2025-09 through 2026-09: 1% a month.
    let value = 100000;
    for (const d of monthEnds("2025-09", "2026-09")) {
      db.prepare(
        `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, twr)
         VALUES (?, ?, ?, 'canonical', ?)`,
      ).run(ACCT, d, value, storedMonthlyReturn);
      value = Math.round(value * 1.01 * 100) / 100;
    }
  }

  function oneYear() {
    const w = resolvePerformanceWindow("1y", {
      today,
      lastStatementAnchor: latestStatementAnchor(db, [ACCT], today),
    });
    const twr = computeTwr(db, { startDate: w.chainStartDate, endDate: w.endDate, accountId: ACCT })!;
    return { w, twr };
  }

  it("statements WITHOUT a stored monthly return: opens on the opening statement, 365 days", () => {
    seed(null);
    const { w, twr } = oneYear();
    expect(w.startDate).toBe("2025-09-30");
    expect(twr.measurementStartDate).toBe("2025-09-30");
    expect(twr.totalDays).toBe(365);
    expect(twr.totalReturn).toBeCloseTo(Math.pow(1.01, 12) - 1, 6);
    expect(twr.annualizedReturn).toBeCloseTo(Math.pow(1.01, 12 * (365.25 / 365)) - 1, 6);
    expect(performanceCaptionMeasuredFrom("1y", w, twr.measurementStartDate)).toContain(
      "measured from Sep 30, 2025.",
    );
  });

  it("statements WITH a stored monthly return: opens one day later, 364 days, same total return", () => {
    seed(0.01);
    const { w, twr } = oneYear();
    expect(w.startDate).toBe("2025-09-30");
    expect(twr.measurementStartDate).toBe("2025-10-01");
    expect(twr.totalDays).toBe(364);
    // The same twelve months and the same total return as the branch above:
    // only the day count, and so the annualized figure, differs.
    expect(twr.totalReturn).toBeCloseTo(Math.pow(1.01, 12) - 1, 10);
    expect(twr.annualizedReturn).toBeCloseTo(Math.pow(1.01, 12 * (365.25 / 364)) - 1, 10);
    // The caption now prints the date the card prints.
    expect(performanceCaptionMeasuredFrom("1y", w, twr.measurementStartDate)).toContain(
      "measured from Oct 1, 2025.",
    );
  });
});

describe("PerformanceView captions the measured start", () => {
  const flat = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8").replace(/\s+/g, " ");

  it("the caption is built after the return, from the date the Period window card shows", () => {
    expect(flat).toContain(
      "performanceCaptionMeasuredFrom( activePeriod, perfWindow, twrResult?.measurementStartDate ?? null, )",
    );
    expect(flat).toContain("{fmtDate(twrResult?.measurementStartDate)}");
  });
});

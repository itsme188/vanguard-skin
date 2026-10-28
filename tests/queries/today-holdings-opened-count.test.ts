/**
 * The Today IBKR line's "N opened that session" chip is titled "Measured from
 * what they cost"; its count therefore holds only the opened rows that WERE
 * measured from cost. An opened row with no usable cost is counted once,
 * under "with no cost, left out", never in both chips (QA
 * dashboard-today-one-line-ibkr-snapshot-ibkr-line-counts-...-twice).
 */
import { describe, it, expect } from "vitest";
import { summarizeIbkrDayMove, type TodayHolding } from "@/lib/queries/today-holdings";

function row(o: Partial<TodayHolding>): TodayHolding {
  return {
    symbol: "ZZZ",
    opened_today: false,
    added_today_qty: 0,
    added_cost_unknown: false,
    change_undated: false,
    day_move_basis: "prior_close",
    day_move_base: null,
    today_gain: 0,
    today_pct: 0,
    current_value: 1000,
    ...o,
  } as TodayHolding;
}

describe("summarizeIbkrDayMove — opened rows are counted once", () => {
  it("an opened row with no usable cost is only 'left out', not also 'opened'", () => {
    const rows = [
      row({ symbol: "ZAA", today_gain: 10, current_value: 1010 }),
      row({ symbol: "ZBB", opened_today: true, day_move_basis: "excluded", today_gain: null, today_pct: null }),
    ];
    const s = summarizeIbkrDayMove(rows);
    expect(s.openedTodayCount).toBe(0);
    expect(s.excludedCount).toBe(1);
  });

  it("an opened row measured from its cost counts as opened and not as left out", () => {
    const rows = [
      row({ symbol: "ZBB", opened_today: true, day_move_basis: "cost", day_move_base: 500, today_gain: 20, current_value: 520 }),
    ];
    const s = summarizeIbkrDayMove(rows);
    expect(s.openedTodayCount).toBe(1);
    expect(s.excludedCount).toBe(0);
  });
});

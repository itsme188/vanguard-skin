import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";

// Beta/alpha pairs run over consecutive BENCHMARK sessions. daily_valuations
// carries a row for every calendar day (weekends included), and those rows
// must never break a Friday-to-Monday pair. All values are synthetic.

/** Fixed invented calendar day in January 2025 (2025-01-06 is a Monday). */
const jan = (d: number) => new Date(Date.UTC(2025, 0, d)).toISOString().slice(0, 10);
const isWeekday = (d: number) => {
  const dow = new Date(Date.UTC(2025, 0, d)).getUTCDay();
  return dow !== 0 && dow !== 6;
};
const compound = (rets: number[]) => rets.reduce((p, r) => p * (1 + r), 1) - 1;

// Varied benchmark returns so the regression has variance.
const BENCH_CYCLE = [0.01, -0.005, 0.008, 0.002, -0.003, 0.006, 0.001, -0.004, 0.009, -0.002];

describe("computePeriodAttribution — beta pairs across weekends", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  /**
   * Seed calendar days firstDay..lastDay of January 2025. A session day (in
   * `sessions`) gets a benchmark close; every calendar day gets a valuation
   * row unless listed in `skipValuation`. Each session after the first moves
   * the benchmark by the next BENCH_CYCLE return and the portfolio by
   * 1.2 × that + 0.001. A flow is booked on its calendar day and shows in
   * that day's valuation; it joins the portfolio at the end of the pair it
   * falls in (the decomposition's convention: the pair return is value change
   * minus flow, over the previous session's value), so it earns no return.
   * Returns the per-pair benchmark and portfolio returns applied.
   */
  const seed = (opts: {
    firstDay: number;
    lastDay: number;
    sessions: Set<number>;
    skipValuation?: Set<number>;
    flows?: Record<number, number>;
  }) => {
    let bench = 400;
    let port = 100000;
    let pending = 0;
    let k = 0;
    let seenSession = false;
    const benchRets: number[] = [];
    const portRets: number[] = [];
    for (let d = opts.firstDay; d <= opts.lastDay; d++) {
      const flow = opts.flows?.[d] ?? 0;
      if (opts.sessions.has(d)) {
        if (seenSession) {
          const b = BENCH_CYCLE[k % BENCH_CYCLE.length];
          k++;
          const p = 1.2 * b + 0.001;
          bench *= 1 + b;
          port = port * (1 + p) + pending;
          pending = 0;
          benchRets.push(b);
          portRets.push(p);
        }
        seenSession = true;
        db.prepare(
          `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
        ).run(jan(d), bench);
      }
      if (flow !== 0) {
        if (opts.sessions.has(d)) port += flow;
        else pending += flow;
        db.prepare(
          `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key) VALUES (2, ?, 'DEPOSIT', ?, 1, ?)`,
        ).run(jan(d), flow, `flow-${d}`);
      }
      if (!opts.skipValuation?.has(d)) {
        db.prepare(
          `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (2, ?, 0, ?, ?)`,
        ).run(jan(d), port + pending, port + pending);
      }
    }
    return { benchRets, portRets };
  };

  const weekdaysBetween = (a: number, b: number) => {
    const s = new Set<number>();
    for (let d = a; d <= b; d++) if (isWeekday(d)) s.add(d);
    return s;
  };

  it("pairs Friday with Monday across weekend valuation rows and ends at the last common session", () => {
    // Mon 6 Jan .. Mon 20 Jan: 11 weekday sessions → 10 session pairs.
    const sessions = weekdaysBetween(6, 20);
    expect(sessions.size).toBe(11);
    const { benchRets, portRets } = seed({ firstDay: 6, lastDay: 20, sessions });

    const r = computePeriodAttribution(db, 2, jan(6), jan(20), "SPY");
    expect(r.decomposedReturn).not.toBeNull();
    expect(r.decomposedReturn!.observations).toBe(10);
    expect(r.betaWindow).toEqual({ start: jan(6), end: jan(20) });
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo(compound(portRets), 10);
    // beta is exactly 1.2 by construction, so betaContribution = 1.2 × the
    // benchmark compounded over every session pair (Mondays included).
    expect(r.betaVsAlpha.betaContribution).toBeCloseTo(1.2 * compound(benchRets), 10);
  });

  it("skips a Monday with no valuation without breaking the surrounding pairs", () => {
    const sessions = weekdaysBetween(6, 20);
    seed({ firstDay: 6, lastDay: 20, sessions, skipValuation: new Set([13]) });

    const r = computePeriodAttribution(db, 2, jan(6), jan(20), "SPY");
    // Week 1: 4 pairs. Fri 10 → Mon 13 and Mon 13 → Tue 14 are dropped (Monday
    // has no valuation; Tuesday's previous SESSION is Monday, so no Friday →
    // Tuesday pair). Tue 14 → Fri 17: 3 pairs. Fri 17 → Mon 20: 1 pair.
    expect(r.decomposedReturn!.observations).toBe(8);
    expect(r.betaWindow).toEqual({ start: jan(6), end: jan(20) });
  });

  it("does not pair two sessions more than a week apart (benchmark hole)", () => {
    // Sessions 6–10 Jan, then nothing until Tue 21 Jan (11 days later).
    const sessions = new Set([...weekdaysBetween(6, 10), ...weekdaysBetween(21, 24)]);
    seed({ firstDay: 6, lastDay: 24, sessions });

    const r = computePeriodAttribution(db, 2, jan(6), jan(24), "SPY");
    // 4 pairs in the first week + 3 pairs (21→22→23→24); 10 → 21 is skipped.
    expect(r.decomposedReturn!.observations).toBe(7);
    expect(r.betaWindow).toEqual({ start: jan(6), end: jan(24) });
  });

  it("subtracts a flow dated on the Saturday from the Friday-to-Monday pair", () => {
    const sessions = weekdaysBetween(6, 20);
    const { portRets } = seed({ firstDay: 6, lastDay: 20, sessions, flows: { 11: 5000 } });

    const r = computePeriodAttribution(db, 2, jan(6), jan(20), "SPY");
    expect(r.decomposedReturn!.observations).toBe(10);
    // The deposit is not return: the compounded figure matches the pure
    // per-session returns exactly.
    expect(r.decomposedReturn!.portfolioReturn).toBeCloseTo(compound(portRets), 10);
  });
});

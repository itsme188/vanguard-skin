import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";
import { computePositionRisk } from "@/lib/compute/risk";

/**
 * Position-Level Risk must put each close on today's share basis using the
 * recorded import-mode split before it computes returns (qa:
 * dashboard-analysis-view-diagnostics-scope-ibkr-all-position-level-risk-table-top-10-basket-vol-risk-narrative).
 *
 * The split-signature guard alone only catches a pair whose ratio is within
 * 2% of an integer. A 4:1 split whose straddling closes also carry a small
 * real move (ratio 3.88 here) slipped through and one fake -135% log return
 * made the name read a triple-digit annualized volatility. Synthetic symbols
 * and round-number prices only.
 */
const IBKR = 3; // seeded by migration 002
const AS_OF = "2026-06-30";
const DAYS = 60;
const SPLIT_INDEX = 30; // effective date = dates[SPLIT_INDEX], still a pre-split close
const GAP_MOVE = 4 / 3.88; // real move across the split: raw ratio 3.88, not near 4

let db: Database.Database;
let dates: string[];

/** The last DAYS weekdays ending on AS_OF, oldest first. */
function tradingDates(): string[] {
  const out: string[] = [];
  let d = AS_OF;
  while (out.length < DAYS) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

/** A post-split-basis series near 200: alternating +/-1% days plus the gap move. */
function adjustedSeries(): number[] {
  const out = [200];
  for (let i = 1; i < DAYS; i++) {
    const r = i === SPLIT_INDEX + 1 ? GAP_MOVE : i % 2 === 0 ? 1.01 : 0.99;
    out.push(out[i - 1] * r);
  }
  return out;
}

/** A second name with gentle alternating moves. */
function otherSeries(): number[] {
  const out = [100];
  for (let i = 1; i < DAYS; i++) out.push(out[i - 1] * (i % 3 === 0 ? 1.005 : 0.998));
  return out;
}

function seedSecurity(symbol: string, closes: number[], qty: number): number {
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, 'Stock', 1)")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  const ins = db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
  );
  closes.forEach((c, i) => ins.run(id, dates[i], c));
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(IBKR, id, qty, AS_OF, `tws:${IBKR}:${id}:${AS_OF}`);
  return id;
}

function recordSplit(securityId: number): void {
  db.prepare(
    `INSERT INTO corporate_actions
       (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, source)
     VALUES (?, 'SPLIT', ?, 4, 1, 'import')`,
  ).run(securityId, dates[SPLIT_INDEX]);
}

function aaaVol(): number {
  const risk = computePositionRisk(db, { accountIds: [IBKR], asOfDate: AS_OF });
  const aaa = risk.positions.find((p) => p.symbol === "AAA");
  expect(aaa).toBeDefined();
  expect(aaa!.annualizedVol).not.toBeNull();
  return aaa!.annualizedVol!;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  dates = tradingDates();
});

describe("computePositionRisk adjusts closes for recorded import splits", () => {
  it("an unadjusted series with a 4:1 import split reads the same volatility as the adjusted one", () => {
    // Reference: the same name stored fully adjusted, no split row.
    seedSecurity("AAA", adjustedSeries(), 100);
    seedSecurity("ZZZ", otherSeries(), 100);
    const reference = aaaVol();
    expect(reference).toBeLessThan(0.5);

    // Fresh DB: stored pre-split before (and on) the effective date.
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const raw = adjustedSeries().map((c, i) => (i <= SPLIT_INDEX ? c * 4 : c));
    // The straddling pair is NOT split-shaped, so the fallback guard misses it.
    const ratio = raw[SPLIT_INDEX] / raw[SPLIT_INDEX + 1];
    expect(ratio).toBeCloseTo(3.88, 6);
    const aaa = seedSecurity("AAA", raw, 100);
    seedSecurity("ZZZ", otherSeries(), 100);
    recordSplit(aaa);

    const vol = aaaVol();
    expect(vol).toBeLessThan(1.0);
    expect(vol).toBeCloseTo(reference, 6);
  });

  it("a series already stored on the post-split basis is not adjusted twice", () => {
    const aaa = seedSecurity("AAA", adjustedSeries(), 100);
    seedSecurity("ZZZ", otherSeries(), 100);
    const before = computePositionRisk(db, { accountIds: [IBKR], asOfDate: AS_OF });
    recordSplit(aaa);
    const after = computePositionRisk(db, { accountIds: [IBKR], asOfDate: AS_OF });
    expect(after).toEqual(before);
    expect(aaaVol()).toBeLessThan(0.5);
  });

  it("a manual (rewrite-mode) split row is not applied", () => {
    const raw = adjustedSeries().map((c, i) => (i <= SPLIT_INDEX ? c * 4 : c));
    const aaa = seedSecurity("AAA", raw, 100);
    seedSecurity("ZZZ", otherSeries(), 100);
    const before = computePositionRisk(db, { accountIds: [IBKR], asOfDate: AS_OF });
    db.prepare(
      `INSERT INTO corporate_actions
         (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, source)
       VALUES (?, 'SPLIT', ?, 4, 1, 'manual')`,
    ).run(aaa, dates[SPLIT_INDEX]);
    const after = computePositionRisk(db, { accountIds: [IBKR], asOfDate: AS_OF });
    expect(after).toEqual(before);
  });
});

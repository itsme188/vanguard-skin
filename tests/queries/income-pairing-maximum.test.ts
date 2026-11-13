/**
 * Reinvestment pairing is a MAXIMUM matching (ruling 2026-11-12, revised).
 *
 * Within one account and security: first the most pairs under the
 * unchanged rules (one-to-one, within 3 calendar days, same sign, gross to
 * the cent or net of ONE withholding row dated on the dividend's or the
 * reinvestment's day; a withholding row serves at most one pair); then the
 * smallest total day gap; then the fewest net pairs. A brute-force
 * enumeration over thousands of small random books proves the optimum.
 *
 * Synthetic figures only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getIncomeSummaryForChat } from "@/lib/queries/chat-tools";
import { getIncomeSummary, accountIncomeTotal } from "@/lib/queries/income";
import {
  INCOME_PAIR_MAX_GAP_DAYS,
  loadIncomeLegs,
  pairIncomeLegsWithStatus,
  pairIncomeLegs,
  type IncomeLeg,
  type IncomePair,
} from "@/lib/queries/income-sql";

const IBKR = 3;
const BASE = Date.UTC(2026, 6, 10); // 2026-07-10 is day 0
const dateOf = (day: number) => new Date(BASE + day * 86_400_000).toISOString().slice(0, 10);
const dayOf = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - BASE) / 86_400_000);
const cents = (a: number) => Math.round(Math.abs(a) * 100);

let db: Database.Database;
let sec: number;
let n = 0;

function txn(type: string, amount: number, day: number): number {
  n += 1;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(IBKR, sec, dateOf(day), type, amount, `max-${n}`).lastInsertRowid as number;
}

function expectDividends(expected: number) {
  for (const group_by of ["type", "account", "symbol", "month"] as const) {
    const rows = getIncomeSummaryForChat(db, { period: "all_time", group_by });
    expect(rows.reduce((s, r) => s + r.total_dividends, 0)).toBeCloseTo(expected, 6);
  }
  const dash = getIncomeSummary(db, "2000-01-01", "2099-12-31");
  expect(dash.totalDividends).toBeCloseTo(expected, 6);
  expect(dash.byAccount.reduce((s, a) => s + accountIncomeTotal(a), 0)).toBeCloseTo(dash.netIncome, 6);
}

// Every fixture here pairs exactly: the search budget is never hit.
afterEach(() => {
  expect(pairIncomeLegsWithStatus(loadIncomeLegs(db)).approximate).toEqual([]);
});

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sec = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZF', 'ZZF', 'ETF')").run()
    .lastInsertRowid as number;
});

describe("the reviewer's reproductions (a greedy pass lost a pair)", () => {
  it("R0 day -2, D1 day 1, R1 day 2, D2 day 3: two pairs, income 100", () => {
    const r0 = txn("REINVESTMENT", 50, -2);
    const d1 = txn("DIVIDEND", 50, 1);
    const r1 = txn("REINVESTMENT", 50, 2);
    const d2 = txn("DIVIDEND", 50, 3);
    expect(pairIncomeLegs(loadIncomeLegs(db))).toEqual([
      { reinvestmentId: r0, dividendId: d1, withholdingId: null },
      { reinvestmentId: r1, dividendId: d2, withholdingId: null },
    ]);
    expectDividends(100);
  });

  it("dividends on days 0-29, reinvestments on days 1-30: thirty pairs", () => {
    db.transaction(() => {
      for (let d = 0; d < 30; d++) txn("DIVIDEND", 1, d);
      for (let d = 1; d <= 30; d++) txn("REINVESTMENT", 1, d);
    })();
    expect(pairIncomeLegs(loadIncomeLegs(db))).toHaveLength(30);
    expectDividends(30);
  });

  it("the most pairs still prefers same-day when it costs no pair", () => {
    const d = txn("DIVIDEND", 50, 0);
    const r = txn("REINVESTMENT", 50, 0);
    txn("REINVESTMENT", 50, 2); // could take d, but that would lose the same-day pair's gap
    expect(pairIncomeLegs(loadIncomeLegs(db))).toEqual([{ reinvestmentId: r, dividendId: d, withholdingId: null }]);
  });
});

describe("a withholding row serves at most one pair", () => {
  it("two dividends, two reinvestments that each need the one withholding row: one pair", () => {
    txn("DIVIDEND", 30, 0);
    txn("DIVIDEND", 30, 0);
    const w = txn("TAX_WITHHELD", -10, 0);
    txn("REINVESTMENT", 20, 0);
    txn("REINVESTMENT", 20, 1); // another class, so the flow alone would use w twice
    const pairs = pairIncomeLegs(loadIncomeLegs(db));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].withholdingId).toBe(w);
    expectDividends(60 + 20);
  });

  it("a contested withholding goes where it buys a pair that a gross match cannot", () => {
    // r20 day 0 can pair gross with d20, or net with d30 - w10. r20 day 1
    // can only pair net with d30 - w10. Maximum: both (gross + net).
    txn("DIVIDEND", 20, 0);
    txn("DIVIDEND", 30, 0);
    txn("TAX_WITHHELD", -10, 0);
    txn("REINVESTMENT", 20, 0);
    txn("REINVESTMENT", 20, 1);
    const pairs = pairIncomeLegs(loadIncomeLegs(db));
    expect(pairs).toHaveLength(2);
    expect(pairs.filter((p) => p.withholdingId != null)).toHaveLength(1);
    expectDividends(50);
  });
});

describe("a negative DIVIDEND reduces income and never hides a reinvestment", () => {
  it("a dividend charged on a short, with a positive reinvestment of the same size: no pair", () => {
    txn("DIVIDEND", -40, 0);
    txn("REINVESTMENT", 40, 0);
    expect(pairIncomeLegs(loadIncomeLegs(db))).toHaveLength(0);
    expectDividends(0); // -40 charged, +40 unpaired reinvestment
  });

  it("a negative dividend beside a paid one: the reinvestment pairs with the paid one", () => {
    const paid = txn("DIVIDEND", 40, 0);
    txn("DIVIDEND", -40, 0);
    const r = txn("REINVESTMENT", 40, 0);
    expect(pairIncomeLegs(loadIncomeLegs(db))).toEqual([{ reinvestmentId: r, dividendId: paid, withholdingId: null }]);
    expectDividends(0);
  });

  it("a negative dividend is never paired net of withholding", () => {
    txn("DIVIDEND", -100, 0);
    txn("TAX_WITHHELD", 15, 0);
    txn("REINVESTMENT", 85, 0);
    expect(pairIncomeLegs(loadIncomeLegs(db))).toHaveLength(0);
    expectDividends(-15);
  });

  it("a reversal of both legs (negative dividend, negative reinvestment) still reduces income", () => {
    txn("DIVIDEND", 40, 0);
    txn("REINVESTMENT", 40, 0);
    txn("DIVIDEND", -40, 5);
    txn("REINVESTMENT", -40, 5);
    expect(pairIncomeLegs(loadIncomeLegs(db))).toHaveLength(2);
    expectDividends(0);
    const [row] = getIncomeSummaryForChat(db, { period: "all_time", group_by: "account" });
    expect(row.unpaired_reinvestment_count).toBe(0);
  });
});

describe("bounded on pathological one-day books (1,000 rows of each type)", () => {
  const book = (d: (i: number) => number, w: (i: number) => number, r: (i: number) => number): IncomeLeg[] => {
    const legs: IncomeLeg[] = [];
    let id = 0;
    for (let i = 0; i < 1000; i++) {
      const base = { account_id: 1, security_id: 1, trade_date: "2026-07-01" };
      legs.push({ id: ++id, type: "DIVIDEND", amount: d(i), ...base });
      legs.push({ id: ++id, type: "TAX_WITHHELD", amount: w(i), ...base });
      legs.push({ id: ++id, type: "REINVESTMENT", amount: r(i), ...base });
    }
    return legs;
  };
  it.each([
    ["all net, one amount", book(() => 50, () => -7.5, () => 42.5)],
    ["net and gross over 90 amounts", book((i) => 10 + (i % 90), () => -1, (i) => 9 + (i % 90))],
    ["all gross, one amount", book(() => 50, () => -1, () => 50)],
  ])("%s", (_label, legs) => {
    const t0 = performance.now();
    const pairs = pairIncomeLegs(legs);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(pairs).toHaveLength(1000);
  });
});

// ---------------------------------------------------------------------------
// Brute force: every valid one-to-one pairing of a small book, scored by
// (most pairs, smallest total gap, fewest net pairs).

type Score = [number, number, number];

/**
 * Direction by meaning, written out independently of the code under test:
 * a dividend +1 payment / -1 charge; a reinvestment +1 purchase / -1
 * reversal, where the Vanguard PDF and export importers store a purchase
 * negative and every other row stores it positive.
 */
const direction = (l: IncomeLeg) => {
  const s = Math.sign(l.amount);
  if (l.type !== "REINVESTMENT") return s;
  const cashEffect = /^vanguard-(pdf|export):/.test(l.source_key ?? "");
  return cashEffect ? -s : s;
};
const better = (a: Score, b: Score) => a[0] > b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));

function bruteForce(legs: IncomeLeg[]): Score {
  const r = legs.filter((l) => l.type === "REINVESTMENT");
  const d = legs.filter((l) => l.type === "DIVIDEND");
  const w = legs.filter((l) => l.type === "TAX_WITHHELD");
  const usedD = new Set<number>();
  const usedW = new Set<number>();
  let best: Score = [0, 0, 0];
  const walk = (i: number, score: Score) => {
    if (better(score, best)) best = [...score];
    if (i === r.length) return;
    walk(i + 1, score); // leave r[i] unpaired
    const ri = r[i];
    const rDay = dayOf(ri.trade_date);
    for (const di of d) {
      if (usedD.has(di.id)) continue;
      const gap = Math.abs(dayOf(di.trade_date) - rDay);
      if (gap > INCOME_PAIR_MAX_GAP_DAYS || direction(di) !== direction(ri)) continue;
      usedD.add(di.id);
      if (cents(di.amount) === cents(ri.amount)) {
        walk(i + 1, [score[0] + 1, score[1] + gap, score[2]]);
      } else if (direction(di) > 0 && direction(ri) > 0) {
        for (const wi of w) {
          if (usedW.has(wi.id) || cents(wi.amount) === 0) continue;
          if (wi.trade_date !== di.trade_date && wi.trade_date !== ri.trade_date) continue;
          if (cents(di.amount) - cents(wi.amount) !== cents(ri.amount)) continue;
          usedW.add(wi.id);
          walk(i + 1, [score[0] + 1, score[1] + gap, score[2] + 1]);
          usedW.delete(wi.id);
        }
      }
      usedD.delete(di.id);
    }
  };
  walk(0, [0, 0, 0]);
  return best;
}

/** Check every pair obeys the rules and no row is used twice; return its score. */
function scoreOf(legs: IncomeLeg[], pairs: IncomePair[]): Score {
  const byId = new Map(legs.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const score: Score = [0, 0, 0];
  for (const p of pairs) {
    for (const key of [`r${p.reinvestmentId}`, `d${p.dividendId}`, ...(p.withholdingId != null ? [`w${p.withholdingId}`] : [])]) {
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    const r = byId.get(p.reinvestmentId)!;
    const d = byId.get(p.dividendId)!;
    expect(r.type).toBe("REINVESTMENT");
    expect(d.type).toBe("DIVIDEND");
    expect(direction(d)).toBe(direction(r));
    const gap = Math.abs(dayOf(d.trade_date) - dayOf(r.trade_date));
    expect(gap).toBeLessThanOrEqual(INCOME_PAIR_MAX_GAP_DAYS);
    if (p.withholdingId == null) {
      expect(cents(d.amount)).toBe(cents(r.amount));
    } else {
      const w = byId.get(p.withholdingId)!;
      expect(w.type).toBe("TAX_WITHHELD");
      expect(direction(d)).toBe(1);
      expect(direction(r)).toBe(1);
      expect([d.trade_date, r.trade_date]).toContain(w.trade_date);
      expect(cents(d.amount) - cents(w.amount)).toBe(cents(r.amount));
      score[2] += 1;
    }
    score[0] += 1;
    score[1] += gap;
  }
  return score;
}

function randomBook(seed: number): IncomeLeg[] {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const legs: IncomeLeg[] = [];
  let id = 0;
  const add = (type: IncomeLeg["type"], amount: number, source_key = "canonical:txn") =>
    legs.push({ id: ++id, type, amount, source_key, account_id: 1, security_id: 1, trade_date: dateOf(Math.floor(rand() * 8)) });
  const nD = Math.floor(rand() * 6);
  const nR = Math.floor(rand() * 6);
  const nW = Math.floor(rand() * 4);
  for (let i = 0; i < nD; i++) add("DIVIDEND", pick([10, 20, 30, 30, -10]));
  for (let i = 0; i < nW; i++) add("TAX_WITHHELD", pick([10, -10, 20, -20]));
  // Reinvestments from both conventions: a cash-effect importer stores the
  // same purchase with the opposite sign.
  for (let i = 0; i < nR; i++) {
    const amount = pick([10, 20, 20, 30, -10]);
    if (rand() < 0.4) add("REINVESTMENT", -amount, pick(["vanguard-pdf:txn", "vanguard-export:txn"]));
    else add("REINVESTMENT", amount);
  }
  // Shuffle ids so row order carries no hint.
  return legs.sort(() => rand() - 0.5).map((l, i) => ({ ...l, id: i + 1 }));
}

describe("brute force: the pairing is the true optimum", () => {
  it("4,000 random small books: most pairs, then smallest total gap, then fewest net pairs", () => {
    let paired = 0;
    for (let seed = 1; seed <= 4000; seed++) {
      const legs = randomBook(seed);
      const pairs = pairIncomeLegs(legs);
      const got = scoreOf(legs, pairs);
      expect({ seed, score: got }).toEqual({ seed, score: bruteForce(legs) });
      // The one-integer cost encoding and the tuple path agree exactly.
      expect(pairIncomeLegs(legs, { costMode: "tuple" })).toEqual(pairs);
      expect(pairIncomeLegsWithStatus(legs).approximate).toEqual([]);
      paired += pairs.length;
    }
    expect(paired).toBeGreaterThan(2000); // the books are not trivially empty
  });
});

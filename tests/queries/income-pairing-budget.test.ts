/**
 * The pairing search has a deterministic work budget (arc scans, never the
 * clock). A pathological book returns a VALID pairing quickly and is reported
 * as approximate; realistic books never hit the budget.
 *
 * Synthetic figures only.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getIncomeSummary } from "@/lib/queries/income";
import {
  INCOME_PAIR_MAX_GAP_DAYS,
  pairIncomeLegsWithStatus,
  reinvestmentIsPurchase,
  type IncomeLeg,
  type IncomePair,
} from "@/lib/queries/income-sql";

const dateOf = (d: number) => new Date(Date.UTC(2026, 6, 1) + d * 86_400_000).toISOString().slice(0, 10);
const dayOf = (s: string) => Math.round(Date.parse(`${s}T00:00:00Z`) / 86_400_000);
const cents = (a: number) => Math.round(Math.abs(a) * 100);

/** The review's shape: competing withholding amounts over 7 days, one security. */
function pathological(rows: number): IncomeLeg[] {
  const legs: IncomeLeg[] = [];
  let id = 0;
  for (let i = 0; legs.length < rows; i++) {
    const d = 100 + (i % 7);
    const base = { account_id: 1, security_id: 1 };
    legs.push({ id: ++id, type: "DIVIDEND", trade_date: dateOf(i % 7), amount: d, ...base });
    legs.push({ id: ++id, type: "REINVESTMENT", trade_date: dateOf((i + 1) % 7), amount: d - (i % 4), ...base });
    legs.push({ id: ++id, type: "TAX_WITHHELD", trade_date: dateOf((i * 3) % 7), amount: -(1 + (i % 3)), ...base });
  }
  return legs;
}

/** Every pair obeys every rule and no row serves twice. */
function expectValid(legs: IncomeLeg[], pairs: IncomePair[]) {
  const byId = new Map(legs.map((l) => [l.id, l]));
  const used = new Set<string>();
  for (const p of pairs) {
    for (const k of [`r${p.reinvestmentId}`, `d${p.dividendId}`, ...(p.withholdingId != null ? [`w${p.withholdingId}`] : [])]) {
      expect(used.has(k)).toBe(false);
      used.add(k);
    }
    const r = byId.get(p.reinvestmentId)!;
    const d = byId.get(p.dividendId)!;
    expect([r.type, d.type]).toEqual(["REINVESTMENT", "DIVIDEND"]);
    expect([r.account_id, r.security_id]).toEqual([d.account_id, d.security_id]);
    expect(Math.abs(dayOf(r.trade_date) - dayOf(d.trade_date))).toBeLessThanOrEqual(INCOME_PAIR_MAX_GAP_DAYS);
    const purchase = reinvestmentIsPurchase(r.amount, r.source_key);
    expect(d.amount > 0).toBe(purchase);
    if (p.withholdingId == null) {
      expect(cents(d.amount)).toBe(cents(r.amount));
    } else {
      const w = byId.get(p.withholdingId)!;
      expect(w.type).toBe("TAX_WITHHELD");
      expect(purchase).toBe(true);
      expect([d.trade_date, r.trade_date]).toContain(w.trade_date);
      expect(cents(d.amount) - cents(w.amount)).toBe(cents(r.amount));
    }
  }
}

afterEach(() => vi.restoreAllMocks());

describe("a pathological book is bounded and still valid", () => {
  it.each([900, 3000])("%i rows: under 2 seconds, valid, reported approximate", (rows) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const legs = pathological(rows);
    const t0 = performance.now();
    const result = pairIncomeLegsWithStatus(legs);
    expect(performance.now() - t0).toBeLessThan(2000);
    expectValid(legs, result.pairs);
    expect(result.pairs.length).toBeGreaterThan(0);
    expect(result.approximate).toEqual([{ accountId: 1, securityId: 1 }]);
  });

  it("the answer is deterministic (budget by work, not time)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const legs = pathological(900);
    expect(pairIncomeLegsWithStatus(legs)).toEqual(pairIncomeLegsWithStatus(legs));
  });

  it("warns once per call, with account and security ids only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legs = [...pathological(300), ...pathological(300).map((l) => ({ ...l, id: l.id + 1000, security_id: 2 }))];
    pairIncomeLegsWithStatus(legs);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("1/1");
    expect(message).toContain("1/2");
    expect(message).not.toMatch(/\d+\.\d|10[0-6]\b/); // no amounts
  });

  it("a tiny forced budget on a contested small book still returns a valid pairing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const base = { account_id: 1, security_id: 1, trade_date: "2026-07-01" };
    const legs: IncomeLeg[] = [
      { id: 1, type: "DIVIDEND", amount: 30, ...base },
      { id: 2, type: "DIVIDEND", amount: 30, ...base },
      { id: 3, type: "TAX_WITHHELD", amount: -10, ...base },
      { id: 4, type: "REINVESTMENT", amount: 20, ...base },
      { id: 5, type: "REINVESTMENT", amount: 20, ...base, trade_date: "2026-07-02" },
    ];
    const exact = pairIncomeLegsWithStatus(legs);
    expect(exact.approximate).toEqual([]);
    const cut = pairIncomeLegsWithStatus(legs, { componentWork: 1 });
    expect(cut.approximate).toEqual([{ accountId: 1, securityId: 1 }]);
    expectValid(legs, cut.pairs);
    expect(cut.pairs).toHaveLength(1); // the repaired relaxation is already optimal here
  });

  it("the dashboard reader passes the flag through", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const sec = db.prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZF', 'ZZF', 'ETF')").run()
      .lastInsertRowid as number;
    const insert = db.prepare(
      "INSERT INTO transactions (account_id, security_id, trade_date, type, amount, source_key) VALUES (3, ?, ?, ?, ?, ?)"
    );
    expect(getIncomeSummary(db, "2000-01-01", "2099-12-31").pairingApproximate).toEqual([]);
    db.transaction(() => {
      for (const l of pathological(900)) insert.run(sec, l.trade_date, l.type, l.amount, `budget-${l.id}`);
    })();
    expect(getIncomeSummary(db, "2000-01-01", "2099-12-31").pairingApproximate).toEqual([
      { accountId: 3, securityId: sec },
    ]);
  });
});

describe("realistic books never hit the budget", () => {
  it("a 20,000-row book: exact, fast", () => {
    const legs: IncomeLeg[] = [];
    let id = 0;
    for (let i = 0; i < 5000; i++) {
      const s = i % 50;
      const day = `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
      const amt = 10 + (i % 90);
      const base = { account_id: 3, security_id: s, trade_date: day };
      legs.push({ id: ++id, type: "DIVIDEND", amount: amt, ...base });
      legs.push({ id: ++id, type: "TAX_WITHHELD", amount: -1, ...base });
      legs.push({ id: ++id, type: "REINVESTMENT", amount: amt - 1, ...base });
      legs.push({ id: ++id, type: "TAX_WITHHELD", amount: 0, ...base }); // 4th row; zero, ignored
    }
    const t0 = performance.now();
    const result = pairIncomeLegsWithStatus(legs);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(result.approximate).toEqual([]);
    expect(result.pairs).toHaveLength(5000);
  });
});

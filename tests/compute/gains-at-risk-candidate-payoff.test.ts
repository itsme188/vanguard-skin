import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeGainsAtRisk, GAINS_AT_RISK_CASE_KEYS, type GainsAtRiskInput } from "@/lib/compute/gains-at-risk";

// Gains at risk step 3 (D11, T31): hand-worked payoffs, independent of a
// second engine run. The valuation date is the candidate's own expiry (that
// day's close), so a bought option is worth its exercise value at the moved
// underlying, and its figure is (intrinsic - price paid) x contracts x 100,
// worked by hand below. ZZQ is both the driver and the underlying (beta 1):
// an index driver for the puts, a single-name driver for the calls.
// Synthetic ticker, invented figures; clock 2026-11-10 15:00 UTC.

const NOW = "2026-11-10T15:00:00Z";
const TODAY = "2026-11-10";
const EXPIRY = "2026-12-18";

let db: Database.Database;
let zzq: number;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  zzq = 100;
  db.prepare(
    "INSERT INTO securities (id, symbol, name, security_type, currency, multiplier, ib_con_id) VALUES (?, 'ZZQ', NULL, 'ETF', 'USD', 1, 6001)",
  ).run(zzq);
  // S0 = 100: the stored price and the price the entry was taken at.
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-09', 100, 'test')").run(zzq);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("T31 hand-worked expiry payoffs", () => {
  it.each([
    // S0 = 100, pricePaid 3.00, 2 contracts. Figure = (intrinsic - 3.00) x 2 x 100, worked by hand:
    ["put 95,  move -10% (S=90)", { right: "put" as const, strike: 95, move: -0.1 }, (5 - 3) * 200], //  400
    ["put 95,  move   0  (S=100)", { right: "put" as const, strike: 95, move: 0 }, (0 - 3) * 200], // -600
    ["call 105, move +10% (S=110)", { right: "call" as const, strike: 105, move: 0.1 }, (5 - 3) * 200], //  400 (single-name driver)
    ["call 105, move   0", { right: "call" as const, strike: 105, move: 0 }, (0 - 3) * 200], // -600
  ])("T31 %s", (_label, c, expected) => {
    const singleName = c.right === "call";
    const moves = singleName ? [0, 0.1] : [-0.1, 0];
    const input: GainsAtRiskInput = {
      driverSymbol: "ZZQ",
      valuationDate: EXPIRY,
      moves,
      volChangePoints: 0,
      selectedMove: c.move,
      accountIds: [],
      ...(singleName ? { driver: { kind: "single-name" as const, symbol: "ZZQ", securityId: zzq } } : {}),
      candidates: [
        {
          id: "7001",
          position: {
            kind: "option",
            id: "7001",
            underlyingSecurityId: zzq,
            right: c.right,
            side: "buy",
            expiry: EXPIRY,
            strike: c.strike,
            contracts: 2,
            pricePaid: 3,
            entryUnderlyingPrice: 100,
            valuationPriceAtEntry: 100,
            // Any recorded volatility: on its expiry the value is exercise value whatever it is.
            entryVolatility: 0.3,
            brokerContractId: 7001,
          },
        },
      ],
    };
    const r = computeGainsAtRisk(db, input);
    const cand = r.candidates?.[0];
    expect(cand?.refusal).toBeUndefined();
    expect(cand?.cost).toEqual({ kind: "premium-paid", usd: 600 });
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      const cs = cand?.cases?.[k];
      expect(cs?.beta).toBe(1);
      expect(Math.abs((cs?.atSelectedMoveUsd as number) - expected)).toBeLessThan(0.005);
      // The no-move figure is the same hand-worked loss of the whole premium for these out-of-the-money strikes.
      expect(Math.abs((cs?.atZeroMoveUsd as number) - (0 - 3) * 200)).toBeLessThan(0.005);
    }
  });
});

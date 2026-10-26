/**
 * Ruling R1 (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * §1A, Task 5): a lot that is not ordinary-open (pending for any reason, or an
 * expired option awaiting its closing entry) carries `current_value = NULL`
 * and `unrealized_gain = NULL` in the Tax Lots read model itself, not merely
 * unrendered. The same lot is checked across the expiry boundary.
 *
 * Every expected state and figure is written by hand. Synthetic symbols and
 * small round numbers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getExpiredOptionLotsAwaitingClose,
  getOpenTaxLots,
  getTaxLotSummary,
  type TaxLotWithSecurity,
} from "@/lib/queries/tax-lots";
import { createPendingTestDb, seedHold, seedPx } from "../setup/pending-statement-fixtures";

const ACCT = 3;
const EXPIRATION = "2026-11-20";
const DAY_AFTER = "2026-11-21";

let db: Database.Database;
let seq = 0;

function seedOpt(symbol: string, expiration = EXPIRATION): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date)
         VALUES (?, ?, 'option', 100, ?)`
      )
      .run(symbol, `${symbol} contract`, expiration).lastInsertRowid
  );
}

/** amount NULL, so the engine's dollars are qty x price x 100. */
function txn(sec: number, date: string, type: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`
  ).run(ACCT, sec, date, type, qty, price, `nooo-${seq++}`);
}

const pick = (l: TaxLotWithSecurity) => ({
  symbol: l.symbol,
  is_short: l.is_short,
  quantity_remaining: l.quantity_remaining,
  adjusted_cost_basis: l.adjusted_cost_basis,
  current_value: l.current_value,
  unrealized_gain: l.unrealized_gain,
  pending_statement: l.pending_statement,
  pending_statement_reason: l.pending_statement_reason,
  pending_figure_kind: l.pending_figure_kind,
  expired_option: l.expired_option,
});

let longOpt: number;
let shortOpt: number;

beforeEach(() => {
  db = createPendingTestDb();
  // Long option: 2 contracts bought at 3.00 → basis 600. Short option: 1
  // contract sold at 4.00 → proceeds 400. Both flat in live data only.
  longOpt = seedOpt("ZZUV  261120C00010000");
  shortOpt = seedOpt("ZZUW  261120P00010000");
  txn(longOpt, "2026-06-01", "BUY_TO_OPEN", 2, 3);
  txn(shortOpt, "2026-06-01", "SELL_TO_OPEN", 1, 4);
  seedPx(db, longOpt, "2026-10-20", 5);
  seedPx(db, shortOpt, "2026-10-20", 1);
  computeTaxLots(db);
});

describe("positive control: an ordinary open option is valued", () => {
  it("with no flat evidence both options carry a value and a gain", () => {
    const lots = getOpenTaxLots(db, undefined, { today: EXPIRATION }).map(pick);
    expect(lots).toEqual([
      {
        symbol: "ZZUV  261120C00010000",
        is_short: 0,
        quantity_remaining: 2,
        adjusted_cost_basis: 600,
        current_value: 1000, // 2 x 5.00 x 100
        unrealized_gain: 400, // 1000 - 600
        pending_statement: false,
        pending_statement_reason: null,
        pending_figure_kind: null,
        expired_option: false,
      },
      {
        symbol: "ZZUW  261120P00010000",
        is_short: 1,
        quantity_remaining: 1,
        adjusted_cost_basis: 400,
        current_value: 100, // 1 x 1.00 x 100
        unrealized_gain: 300, // -(100 - 400)
        pending_statement: false,
        pending_statement_reason: null,
        pending_figure_kind: null,
        expired_option: false,
      },
    ]);
  });
});

describe("R1 across the expiry boundary", () => {
  beforeEach(() => {
    seedHold(db, ACCT, longOpt, "2026-10-20", "live-zero");
    seedHold(db, ACCT, shortOpt, "2026-10-20", "live-zero");
  });

  it("on the expiration day: pending, value null, gain null; not in the expired reader", () => {
    const opts = { today: EXPIRATION };
    expect(getOpenTaxLots(db, undefined, opts).map(pick)).toEqual([
      {
        symbol: "ZZUV  261120C00010000",
        is_short: 0,
        quantity_remaining: 2,
        adjusted_cost_basis: 600,
        current_value: null,
        unrealized_gain: null,
        pending_statement: true,
        pending_statement_reason: "awaiting_statement",
        pending_figure_kind: "cost_basis",
        expired_option: false,
      },
      {
        symbol: "ZZUW  261120P00010000",
        is_short: 1,
        quantity_remaining: 1,
        adjusted_cost_basis: 400,
        current_value: null,
        unrealized_gain: null,
        pending_statement: true,
        pending_statement_reason: "awaiting_statement",
        pending_figure_kind: "short_sale_proceeds",
        expired_option: false,
      },
    ]);
    expect(getExpiredOptionLotsAwaitingClose(db, opts)).toEqual([]);
  });

  it("on the next Eastern day: in the expired reader, not pending, value null, gain null", () => {
    const opts = { today: DAY_AFTER };
    expect(getOpenTaxLots(db, undefined, opts)).toEqual([]);
    expect(getExpiredOptionLotsAwaitingClose(db, opts).map(pick)).toEqual([
      {
        symbol: "ZZUV  261120C00010000",
        is_short: 0,
        quantity_remaining: 2,
        adjusted_cost_basis: 600,
        current_value: null,
        unrealized_gain: null,
        pending_statement: false,
        pending_statement_reason: null,
        pending_figure_kind: null,
        expired_option: true,
      },
      {
        symbol: "ZZUW  261120P00010000",
        is_short: 1,
        quantity_remaining: 1,
        adjusted_cost_basis: 400,
        current_value: null,
        unrealized_gain: null,
        pending_statement: false,
        pending_statement_reason: null,
        pending_figure_kind: null,
        expired_option: true,
      },
    ]);
  });

  it("never both flags, on either day", () => {
    for (const today of [EXPIRATION, DAY_AFTER]) {
      const all = [
        ...getOpenTaxLots(db, undefined, { today }),
        ...getExpiredOptionLotsAwaitingClose(db, { today }),
      ];
      expect(all).toHaveLength(2);
      expect(all.filter((l) => l.pending_statement && l.expired_option)).toEqual([]);
    }
  });
});

describe("an expired option with a price and no flat evidence is unvalued", () => {
  it("held per the statement, priced, past expiration: value and gain are null", () => {
    seedHold(db, ACCT, longOpt, "2026-10-31", "stmt", 2);
    seedHold(db, ACCT, shortOpt, "2026-10-31", "stmt", -1);
    const opts = { today: DAY_AFTER };
    const expired = getExpiredOptionLotsAwaitingClose(db, opts);
    expect(expired.map((l) => [l.symbol, l.current_value, l.unrealized_gain, l.pending_statement])).toEqual([
      ["ZZUV  261120C00010000", null, null, false],
      ["ZZUW  261120P00010000", null, null, false],
    ]);
    // The summary already left expired contracts out of unrealized; it still does.
    const s = getTaxLotSummary(db, undefined, opts);
    expect(s.totalUnrealizedGain).toBe(0);
    expect(s.expiredOptionLotsAwaitingClose).toBe(2);
    expect(s.pendingStatement).toEqual([]);
  });

  it("a security-scoped expired read is unvalued too", () => {
    const [lot] = getExpiredOptionLotsAwaitingClose(db, { today: DAY_AFTER, securityId: longOpt });
    expect(lot.current_value).toBeNull();
    expect(lot.unrealized_gain).toBeNull();
    expect(lot.expired_option).toBe(true);
  });
});

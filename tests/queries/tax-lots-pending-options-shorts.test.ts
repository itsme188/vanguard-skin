/**
 * Tax Lots readers and summary over pending OPTIONS and SHORTS (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 5; rulings R1, R2, R11; spec
 * docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md).
 *
 * Every lot's expected state is written by hand (F6) and the classifier is
 * checked against it first. Synthetic symbols and small round numbers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getExpiredOptionLotsAwaitingClose,
  getOpenTaxLots,
  getTaxLotSummary,
} from "@/lib/queries/tax-lots";
import { getPendingStatementPairs } from "@/lib/queries/pending-statement";
import { reducePendingDisclosure, type PendingDisclosureInput } from "@/lib/queries/pending-statement-types";
import { createPendingTestDb, seedHold, seedPx, seedSec } from "../setup/pending-statement-fixtures";

const ACCT = 3;
const EXPIRATION = "2026-11-20";
const DAY_AFTER = "2026-11-21";

let db: Database.Database;
let seq = 0;

function seedOpt(symbol: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date)
         VALUES (?, ?, 'option', 100, ?)`
      )
      .run(symbol, `${symbol} contract`, EXPIRATION).lastInsertRowid
  );
}

/** amount NULL, so the engine's dollars are qty x price (x 100 for an option). */
function txn(sec: number, date: string, type: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`
  ).run(ACCT, sec, date, type, qty, price, `tlpos-${seq++}`);
}

/*
 * Hand-written fixture (account 3):
 *  ZZHL  long stock 10 @ 100, statement row +10, price 120   → ordinary open, gain +200
 *  ZZHS  short stock 5 @ 20, statement row -5, price 10      → ordinary open (short), gain -(50 - 100) = +50
 *  ZZSS  short stock 10 @ 50, statement ZERO 06-30, price 40 → closing_entry_missing, short, proceeds 500
 *  ZZLO  long option 2 @ 3.00, live zero 10-20, price 5      → awaiting_statement, long, basis 600
 *  ZZSO  short option 1 @ 4.00, live zero 10-20, price 1     → awaiting_statement, short, proceeds 400
 */
const EXPECTED: Record<string, { reason: string | null; kind: string | null; figure: number }> = {
  ZZHL: { reason: null, kind: null, figure: 1000 },
  ZZHS: { reason: null, kind: null, figure: 100 },
  ZZSS: { reason: "closing_entry_missing", kind: "short_sale_proceeds", figure: 500 },
  "ZZLO  261120C00010000": { reason: "awaiting_statement", kind: "cost_basis", figure: 600 },
  "ZZSO  261120P00010000": { reason: "awaiting_statement", kind: "short_sale_proceeds", figure: 400 },
};

beforeEach(() => {
  db = createPendingTestDb();
  const hl = seedSec(db, "ZZHL");
  txn(hl, "2026-05-01", "BUY", 10, 100);
  seedHold(db, ACCT, hl, "2026-09-30", "stmt", 10);
  seedPx(db, hl, "2026-10-20", 120);

  const hs = seedSec(db, "ZZHS");
  txn(hs, "2026-05-01", "SHORT_SELL", 5, 20);
  seedHold(db, ACCT, hs, "2026-09-30", "stmt", -5);
  seedPx(db, hs, "2026-10-20", 10);

  const ss = seedSec(db, "ZZSS");
  txn(ss, "2026-06-01", "SHORT_SELL", 10, 50);
  seedHold(db, ACCT, ss, "2026-06-30", "stmt-zero");
  seedPx(db, ss, "2026-10-20", 40);

  const lo = seedOpt("ZZLO  261120C00010000");
  txn(lo, "2026-06-01", "BUY_TO_OPEN", 2, 3);
  seedHold(db, ACCT, lo, "2026-10-20", "live-zero");
  seedPx(db, lo, "2026-10-20", 5);

  const so = seedOpt("ZZSO  261120P00010000");
  txn(so, "2026-06-01", "SELL_TO_OPEN", 1, 4);
  seedHold(db, ACCT, so, "2026-10-20", "live-zero");
  seedPx(db, so, "2026-10-20", 1);

  computeTaxLots(db);
});

describe("the classifier agrees with the hand-written states", () => {
  it("pending sides on the expiration day", () => {
    const pairs = getPendingStatementPairs(db, undefined, { today: EXPIRATION });
    expect(pairs.map((p) => [p.symbol, p.side, p.reason, p.open_figure])).toEqual([
      ["ZZLO  261120C00010000", "long", "awaiting_statement", 600],
      ["ZZSO  261120P00010000", "short", "awaiting_statement", 400],
      ["ZZSS", "short", "closing_entry_missing", 500],
    ]);
  });
});

describe("getOpenTaxLots: reason and figure kind per lot", () => {
  it("every lot carries the hand-written reason, kind and figure; pending lots are unvalued", () => {
    const lots = getOpenTaxLots(db, undefined, { today: EXPIRATION });
    expect(lots).toHaveLength(5);
    for (const l of lots) {
      const e = EXPECTED[l.symbol];
      expect([l.symbol, l.pending_statement_reason, l.pending_figure_kind]).toEqual([l.symbol, e.reason, e.kind]);
      expect(l.adjusted_cost_basis).toBe(e.figure);
      expect(l.pending_statement).toBe(e.reason != null);
      if (e.reason != null) {
        expect(l.current_value).toBeNull();
        expect(l.unrealized_gain).toBeNull();
      }
    }
  });

  it("a short pending lot has pending_figure_kind short_sale_proceeds", () => {
    const lots = getOpenTaxLots(db, undefined, { today: EXPIRATION });
    const shortPending = lots.filter((l) => l.pending_statement && l.is_short === 1);
    expect(shortPending.map((l) => l.symbol).sort()).toEqual(["ZZSO  261120P00010000", "ZZSS"]);
    expect(shortPending.every((l) => l.pending_figure_kind === "short_sale_proceeds")).toBe(true);
  });

  it("ordinary open shorts and longs stay valued with the side sign", () => {
    const lots = getOpenTaxLots(db, undefined, { today: EXPIRATION });
    const hl = lots.find((l) => l.symbol === "ZZHL")!;
    const hs = lots.find((l) => l.symbol === "ZZHS")!;
    expect([hl.current_value, hl.unrealized_gain]).toEqual([1200, 200]);
    expect([hs.current_value, hs.unrealized_gain]).toEqual([50, 50]);
  });
});

describe("getTaxLotSummary: one list, never a cross-side sum", () => {
  it("on the expiration day: three (reason, side) rows; pending groups leave Unrealized", () => {
    const s = getTaxLotSummary(db, undefined, { today: EXPIRATION });
    expect(s.totalOpenLots).toBe(5);
    expect(s.totalUnrealizedGain).toBe(250); // ZZHL +200, ZZHS +50
    expect(s.pendingStatement).toEqual([
      { reason: "awaiting_statement", side: "long", positions: 1, lots: 1, figure: 600, figureKind: "cost_basis" },
      { reason: "awaiting_statement", side: "short", positions: 1, lots: 1, figure: 400, figureKind: "short_sale_proceeds" },
      { reason: "closing_entry_missing", side: "short", positions: 1, lots: 1, figure: 500, figureKind: "short_sale_proceeds" },
    ]);
    expect(s.expiredOptionLotsAwaitingClose).toBe(0);
  });

  it("on the next Eastern day the options are expired, not pending; the short stock stays", () => {
    const s = getTaxLotSummary(db, undefined, { today: DAY_AFTER });
    expect(s.totalOpenLots).toBe(3);
    expect(s.totalUnrealizedGain).toBe(250);
    expect(s.expiredOptionLotsAwaitingClose).toBe(2);
    expect(s.pendingStatement).toEqual([
      { reason: "closing_entry_missing", side: "short", positions: 1, lots: 1, figure: 500, figureKind: "short_sale_proceeds" },
    ]);
  });

  it.each([[EXPIRATION], [DAY_AFTER]])(
    "summary list equals the reducer over the same lots read one by one (today %s)",
    (today) => {
      const inputs: PendingDisclosureInput[] = getOpenTaxLots(db, undefined, { today })
        .filter((l) => l.pending_statement && !l.currency_conversion)
        .map((l) => ({
          account_id: l.account_id,
          security_id: l.security_id,
          is_short: l.is_short,
          reason: l.pending_statement_reason!,
          lotCount: 1,
          figure: l.adjusted_cost_basis,
        }));
      expect(getTaxLotSummary(db, undefined, { today }).pendingStatement).toEqual(reducePendingDisclosure(inputs));
    }
  );
});

describe("T-NO-DOUBLE-FLAG (readers)", () => {
  it.each([[EXPIRATION], [DAY_AFTER]])("no lot is in both readers or carries both flags (today %s)", (today) => {
    const open = getOpenTaxLots(db, undefined, { today });
    const expired = getExpiredOptionLotsAwaitingClose(db, { today });
    const openIds = new Set(open.map((l) => l.id));
    expect(expired.filter((l) => openIds.has(l.id))).toEqual([]);
    expect(open.length + expired.length).toBe(5);
    for (const l of [...open, ...expired]) {
      expect(l.pending_statement && l.expired_option).toBe(false);
      if (l.expired_option) {
        expect([l.pending_statement_reason, l.pending_figure_kind, l.current_value, l.unrealized_gain]).toEqual([
          null,
          null,
          null,
          null,
        ]);
      }
    }
  });
});

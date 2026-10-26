/**
 * A closing entry in ANOTHER account for a pending option or short side
 * (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 8, rulings R4, R13, OPEN-11). Every scenario runs the real engine
 * (`computeTaxLots`) first, so "unabsorbed" is the engine's own matching.
 * Each expected lot state is written by hand and checked before the scan.
 *
 * Accounts (runMigrations seed): A = 3 (IBKR) holds the pending short;
 * B = 1 (Vanguard Taxable) holds the other entries. Synthetic symbols and
 * small round numbers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { getPendingStatementPairs } from "@/lib/queries/pending-statement";
import {
  findClosingEntryAccountCandidates,
  scanClosingEntryAccountHits,
} from "@/lib/queries/closing-entry-account-mismatch";
import { createPendingTestDb, seedHold, seedImportSplit, seedSec } from "../setup/pending-statement-fixtures";

const OPTS = { today: "2026-10-26" };
const A = 3;
const B = 1;

let db: Database.Database;
let seq = 0;
let sec: number;

/** Ledger row with amount NULL, so the engine's dollars are qty x price. */
function txn(
  account: number,
  date: string,
  type: string,
  qty: number | null,
  price: number | null,
  evidence?: "O" | "C" | "O;C"
): number {
  const notes = evidence ? ibkrTradeDirectionNote(evidence, "") : null;
  return Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`
      )
      .run(account, sec, date, type, qty, price, notes, `cea-${seq++}`).lastInsertRowid
  );
}

/** [account, is_short, acquired, remaining] for every lot of the security. */
function lots(): Array<[number, number, number, number]> {
  return (
    db
      .prepare(
        "SELECT account_id, is_short, quantity_acquired, quantity_remaining FROM tax_lots WHERE security_id = ? ORDER BY id"
      )
      .all(sec) as Array<{ account_id: number; is_short: number; quantity_acquired: number; quantity_remaining: number }>
  ).map((l) => [l.account_id, l.is_short, l.quantity_acquired, l.quantity_remaining]);
}

function pairs() {
  return getPendingStatementPairs(db, undefined, OPTS);
}

beforeEach(() => {
  db = createPendingTestDb();
  sec = seedSec(db, "ZZXA");
  // A: a short of 100 opened on 03-02; A's statement says flat on 06-30, and
  // no closing entry was ever imported in A.
  txn(A, "2026-03-02", "SHORT_SELL", 100, 50);
  seedHold(db, A, sec, "2026-06-30", "stmt-zero");
});

function expectAPendingShort(): void {
  const p = pairs().filter((x) => x.account_id === A);
  expect(p.map((x) => [x.side, x.reason, x.flat_date])).toEqual([["short", "closing_entry_missing", "2026-06-30"]]);
}

describe("Codex scenarios (R4, R13)", () => {
  it("false negative: B covers on day 10 with nothing open, opens an equal short on day 20 → hit", () => {
    const cover = txn(B, "2026-04-10", "BUY_TO_COVER", 100, 40);
    txn(B, "2026-04-20", "SHORT_SELL", 100, 45);
    computeTaxLots(db);
    // Hand: A's short 100 still open; B's cover matched nothing; B's new short 100 open.
    expect(lots()).toEqual([
      [A, 1, 100, 100],
      [B, 1, 100, 100],
    ]);
    expectAPendingShort();

    const cands = findClosingEntryAccountCandidates(db, pairs());
    expect(cands.map((c) => [c.transactionId, c.role, c.certainty, c.engineLoads, c.unabsorbed])).toEqual([
      [cover, "close", "certain", true, 100],
    ]);
    const hits = scanClosingEntryAccountHits(db, pairs());
    expect(hits).toEqual([
      {
        key: `closing-entry-account:${A}:${B}:${sec}:short`,
        severity: "critical",
        kind: "closing-entry-account-mismatch",
        reason:
          "ZZXA: a closing entry in Vanguard Taxable (2026-04-10) matched no open lot there, while IBKR still carries the short lots its records show closed: the entry may be booked to the wrong account or a transfer may be missing",
      },
    ]);
  });

  it("false positive: B's old unmatched cover BEFORE A's acquisition plus a fully matched round trip after it → no hit", () => {
    txn(B, "2026-01-10", "BUY_TO_COVER", 50, 40);
    txn(B, "2026-04-01", "SHORT_SELL", 30, 50);
    const roundTripCover = txn(B, "2026-04-15", "BUY_TO_COVER", 30, 45);
    computeTaxLots(db);
    // Hand: A's short open; B's round-trip short opened and fully covered.
    expect(lots()).toEqual([
      [A, 1, 100, 100],
      [B, 1, 30, 0],
    ]);
    expectAPendingShort();

    const cands = findClosingEntryAccountCandidates(db, pairs());
    // The old cover is outside the window; the round-trip cover is fully absorbed.
    expect(cands.map((c) => [c.transactionId, c.unabsorbed])).toEqual([[roundTripCover, 0]]);
    expect(scanClosingEntryAccountHits(db, pairs())).toEqual([]);
  });

  it("split units: B opens before an import split and covers after it, fully matched by the engine → no hit", () => {
    txn(B, "2026-04-01", "SHORT_SELL", 10, 50);
    seedImportSplit(db, sec, "2026-04-10"); // 2:1
    txn(B, "2026-04-20", "BUY_TO_COVER", 20, 25);
    computeTaxLots(db);
    // Hand: the split doubles every open lot of the security (A's too); B's 20 covered.
    expect(lots()).toEqual([
      [A, 1, 200, 200],
      [B, 1, 20, 0],
    ]);
    // A split never ends pending (R2).
    expectAPendingShort();
    expect(scanClosingEntryAccountHits(db, pairs())).toEqual([]);
  });

  it("routing: B's cover is a BUY with close-only evidence and nothing to close → hit", () => {
    const cover = txn(B, "2026-04-10", "BUY", 100, 40, "C");
    computeTaxLots(db);
    expect(lots()).toEqual([[A, 1, 100, 100]]); // hand: the BUY closed nothing and opened nothing
    const cands = findClosingEntryAccountCandidates(db, pairs());
    expect(cands.map((c) => [c.transactionId, c.role, c.unabsorbed])).toEqual([[cover, "close", 100]]);
    const hits = scanClosingEntryAccountHits(db, pairs());
    expect(hits.map((h) => [h.key, h.severity])).toEqual([[`closing-entry-account:${A}:${B}:${sec}:short`, "critical"]]);
  });

  it("routing: B's row is a plain BUY → not a candidate, no hit", () => {
    txn(B, "2026-04-10", "BUY", 100, 40);
    computeTaxLots(db);
    // Hand: the plain BUY opened a separate long lot in B; it never covers a short.
    expect(lots()).toEqual([
      [A, 1, 100, 100],
      [B, 0, 100, 100],
    ]);
    expect(findClosingEntryAccountCandidates(db, pairs())).toEqual([]);
    expect(scanClosingEntryAccountHits(db, pairs())).toEqual([]);
  });

  it("mixed evidence in B whose possible closing side is short, inside the window → the undecidable warning IS raised, no critical", () => {
    const mixed = txn(B, "2026-04-10", "BUY", 100, 40, "O;C");
    computeTaxLots(db);
    // Hand: nothing open on B's short side, so the engine refused the mixed trade.
    expect(lots()).toEqual([[A, 1, 100, 100]]);
    const cands = findClosingEntryAccountCandidates(db, pairs());
    expect(cands.map((c) => [c.transactionId, c.role, c.certainty, c.unabsorbed])).toEqual([
      [mixed, "mixed", "needs_replay", null],
    ]);
    const hits = scanClosingEntryAccountHits(db, pairs());
    expect(hits).toEqual([
      {
        key: `closing-entry-account-undecidable:${A}:${B}:${sec}:short`,
        severity: "warning",
        kind: "closing-entry-account-undecidable",
        reason:
          "ZZXA: a closing entry in Vanguard Taxable (2026-04-10) cannot be checked against the short lots IBKR still carries (a mixed open-and-close trade, or an entry with no price or quantity)",
      },
    ]);
  });

  it("B's cover has no price → undecidable warning, no critical", () => {
    const cover = txn(B, "2026-04-10", "BUY_TO_COVER", 100, null);
    computeTaxLots(db);
    expect(lots()).toEqual([[A, 1, 100, 100]]);
    const cands = findClosingEntryAccountCandidates(db, pairs());
    expect(cands.map((c) => [c.transactionId, c.engineLoads, c.unabsorbed])).toEqual([[cover, false, null]]);
    const hits = scanClosingEntryAccountHits(db, pairs());
    expect(hits.map((h) => [h.severity, h.kind])).toEqual([["warning", "closing-entry-account-undecidable"]]);
  });

  it("B covers part of a short after a 2:1 split of it, fully matched → unabsorbed exactly 0 (close units, no residual-lot term)", () => {
    txn(B, "2026-04-01", "SHORT_SELL", 10, 50);
    seedImportSplit(db, sec, "2026-04-10"); // 2:1: B's 10 becomes 20
    const cover = txn(B, "2026-04-20", "BUY_TO_COVER", 15, 25);
    computeTaxLots(db);
    // Hand: B's split-adjusted short 20, 15 covered, 5 still open.
    expect(lots()).toEqual([
      [A, 1, 200, 200],
      [B, 1, 20, 5],
    ]);
    const sold = (
      db.prepare("SELECT SUM(quantity_sold) AS q FROM tax_lot_sales WHERE sale_transaction_id = ?").get(cover) as {
        q: number;
      }
    ).q;
    expect(sold).toBe(15); // the engine records the cover in its own (post-split) units
    const cands = findClosingEntryAccountCandidates(db, pairs());
    expect(cands.map((c) => [c.transactionId, c.unabsorbed])).toEqual([[cover, 0]]);
    expect(scanClosingEntryAccountHits(db, pairs())).toEqual([]);
  });
});

describe("window, sides and classes", () => {
  it("an unmatched cover dated after A's flat date is outside the window → no hit", () => {
    txn(B, "2026-07-01", "BUY_TO_COVER", 100, 40);
    computeTaxLots(db);
    expect(findClosingEntryAccountCandidates(db, pairs())).toEqual([]);
  });

  it("the window includes both ends (acquisition day and flat day)", () => {
    const onAcq = txn(B, "2026-03-02", "BUY_TO_COVER", 1, 40);
    const onFlat = txn(B, "2026-06-30", "BUY_TO_COVER", 1, 40);
    computeTaxLots(db);
    const cands = findClosingEntryAccountCandidates(db, pairs());
    expect(cands.map((c) => [c.transactionId, c.unabsorbed])).toEqual([
      [onAcq, 1],
      [onFlat, 1],
    ]);
  });

  it("a long-side close in B (SELL) is not a candidate for a pending SHORT side", () => {
    txn(B, "2026-04-10", "SELL", 100, 40);
    computeTaxLots(db);
    expect(findClosingEntryAccountCandidates(db, pairs())).toEqual([]);
  });

  it("a long STOCK pending side is never checked (long stock keeps its synthetic-close path)", () => {
    const longSec = seedSec(db, "ZZXL");
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-03-02', 'BUY', 10, 10, NULL, 0, 'cea-long-buy')`
    ).run(A, longSec);
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-04-10', 'SELL', 10, 12, NULL, 0, 'cea-long-sell-b')`
    ).run(B, longSec);
    seedHold(db, A, longSec, "2026-07-10", "live-zero");
    computeTaxLots(db);
    const longPairs = pairs().filter((p) => p.security_id === longSec);
    expect(longPairs.map((p) => [p.side, p.reason])).toEqual([["long", "awaiting_statement"]]);
    expect(findClosingEntryAccountCandidates(db, longPairs)).toEqual([]);
  });
});

describe("OPEN-11: a side-agnostic unmatched close when A has BOTH sides pending", () => {
  it("one hit per pending side, each naming the same one row; the row's quantity is not split", () => {
    const opt = Number(
      db
        .prepare(
          `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date)
           VALUES ('ZZXO  270115C00010000', 'ZZXO contract', 'option', 100, '2027-01-15')`
        )
        .run().lastInsertRowid
    );
    sec = opt;
    txn(A, "2026-03-02", "BUY_TO_OPEN", 1, 3);
    txn(A, "2026-03-03", "SELL_TO_OPEN", 1, 4);
    seedHold(db, A, opt, "2026-06-30", "stmt-zero");
    const expired = txn(B, "2026-05-01", "EXPIRED", 1, null);
    computeTaxLots(db);
    // Hand: A holds one long and one short contract, both open; B's expiry closed nothing.
    expect(lots()).toEqual([
      [A, 0, 1, 1],
      [A, 1, 1, 1],
    ]);
    const optPairs = pairs().filter((p) => p.security_id === opt);
    expect(optPairs.map((p) => [p.side, p.reason])).toEqual([
      ["long", "closing_entry_missing"],
      ["short", "closing_entry_missing"],
    ]);
    const cands = findClosingEntryAccountCandidates(db, optPairs);
    expect(cands.map((c) => [c.side, c.transactionId, c.role, c.unabsorbed])).toEqual([
      ["long", expired, "close_either", 1],
      ["short", expired, "close_either", 1],
    ]);
    const hits = scanClosingEntryAccountHits(db, optPairs);
    expect(hits.map((h) => h.key)).toEqual([
      `closing-entry-account:${A}:${B}:${opt}:long`,
      `closing-entry-account:${A}:${B}:${opt}:short`,
    ]);
    for (const h of hits) {
      expect(h.reason).toContain("a closing entry in Vanguard Taxable (2026-05-01)");
      expect(h.reason).toContain("may be booked to the wrong account");
    }
  });
});

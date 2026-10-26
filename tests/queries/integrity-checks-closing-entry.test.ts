/**
 * The integrity scan over the side-aware pending read model (plan
 * docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 8, rulings R4, R12 and its continuation, R13, OPEN-4).
 *
 *  - A pair the pending index lists gets exactly ONE pending warning, whatever
 *    its signed drift; it never caps the score.
 *  - The pair's independent findings (real drift, roll-back uncertainty) sit
 *    beside it under `:drift`; its fallback pending disclosures are dropped.
 *  - A closing entry the engine matched to nothing in another account is a
 *    CRITICAL hit that names both accounts and the side; it can cap the score.
 *
 * Every scenario runs the real engine first; expected lot states are written
 * by hand. Synthetic symbols and small round numbers only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { runIntegrityChecks, integrityCheckIdOf, type IntegrityHit } from "@/lib/queries/integrity-checks";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import { createPendingTestDb, seedHold, seedSec } from "../setup/pending-statement-fixtures";

// A synthetic re-symbol mapping replaces the real constant for this file.
const MAPPING = vi.hoisted(() => [
  {
    fromSymbol: "ZZRS  270115C00100000",
    toSymbol: "ZZRS  270115C00050000",
    tradeDate: "2026-05-01",
    type: "BUY_TO_OPEN",
    preQty: 1,
    ratio: 2,
  },
]);
vi.mock("@/lib/securities/option-resymbol-targets", () => ({
  OPTION_RESYMBOL_TARGETS: MAPPING,
  resymbolTargetsFrom: (fromSymbol: string) => MAPPING.filter((t) => t.fromSymbol === fromSymbol),
}));

const OPTS = { today: "2026-10-26" };
const A = 3; // IBKR
const B = 1; // Vanguard Taxable

let db: Database.Database;
let seq = 0;

beforeEach(() => {
  db = createPendingTestDb();
});

function seedOpt(symbol: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date)
         VALUES (?, ?, 'option', 100, '2027-01-15')`
      )
      .run(symbol, `${symbol} contract`).lastInsertRowid
  );
}

function txn(account: number, sec: number, date: string, type: string, qty: number, price: number | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`
      )
      .run(account, sec, date, type, qty, price, `icce-${seq++}`).lastInsertRowid
  );
}

/** [is_short, acquired, remaining] for every lot of the security in account A. */
function lotsOf(sec: number, account = A): Array<[number, number, number]> {
  return (
    db
      .prepare(
        "SELECT is_short, quantity_acquired, quantity_remaining FROM tax_lots WHERE security_id = ? AND account_id = ? ORDER BY id"
      )
      .all(sec, account) as Array<{ is_short: number; quantity_acquired: number; quantity_remaining: number }>
  ).map((l) => [l.is_short, l.quantity_acquired, l.quantity_remaining]);
}

function hitsFor(list: IntegrityHit[], account: number, sec: number): IntegrityHit[] {
  return list.filter((h) => h.key === `lot-drift:${account}:${sec}` || h.key.startsWith(`lot-drift:${account}:${sec}:`));
}

describe("pending pairs: one warning each, never a cap", () => {
  it("closing_entry_missing pair: one warning, never caps", () => {
    const opt = seedOpt("ZZCE  270115C00010000");
    txn(A, opt, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    seedHold(db, A, opt, "2026-06-30", "stmt-zero");
    computeTaxLots(db);
    expect(lotsOf(opt)).toEqual([[0, 2, 2]]); // hand: open, no closing entry

    const { critical, warnings, lotDriftChecked } = runIntegrityChecks(db, OPTS);
    expect(lotDriftChecked).toBe(true);
    expect(critical).toEqual([]);
    expect(hitsFor(warnings, A, opt)).toEqual([
      {
        key: `lot-drift:${A}:${opt}`,
        severity: "warning",
        kind: "closing-entry-missing",
        pendingReasons: ["closing_entry_missing"],
        reason:
          "ZZCE  270115C00010000 (IBKR): long side: statement shows the position closed but its closing entry is not imported — lots not valued",
      },
    ]);
    expect(getDataConfidence(db).capReason).toBeNull();
  });

  it("re-symbol: old option with one open lot, a statement holding of one, then a live zero, replacement held in the same account → exactly one warning, kind resymbol-repair-pending (not a ledger gap)", () => {
    const oldOpt = seedOpt("ZZRS  270115C00100000");
    const newOpt = seedOpt("ZZRS  270115C00050000");
    txn(A, oldOpt, "2026-04-01", "BUY_TO_OPEN", 1, 6);
    seedHold(db, A, oldOpt, "2026-06-30", "stmt", 1);
    seedHold(db, A, oldOpt, "2026-07-10", "live-zero");
    txn(A, newOpt, "2026-07-09", "BUY_TO_OPEN", 2, 3);
    seedHold(db, A, newOpt, "2026-07-10", "tws", 2);
    computeTaxLots(db);
    expect(lotsOf(oldOpt)).toEqual([[0, 1, 1]]);
    expect(lotsOf(newOpt)).toEqual([[0, 2, 2]]);

    const { critical, warnings } = runIntegrityChecks(db, OPTS);
    expect(critical).toEqual([]);
    const old = hitsFor(warnings, A, oldOpt);
    expect(old).toHaveLength(1); // the step-4 fallback would otherwise add a statement-lag hit
    expect(old[0].kind).toBe("resymbol-repair-pending");
    expect(old[0].pendingReasons).toEqual(["resymbol_repair_pending"]);
    expect(old[0].reason).toContain("renamed to a new contract after a split and still held under it");
    expect(old[0].reason).not.toMatch(/script/i);
    // The replacement contract reconciles: nothing reported for it.
    expect(hitsFor(warnings, A, newOpt)).toEqual([]);
  });

  it("ordinary awaiting-statement pair (statement agrees with the lots, newest row a live zero) → exactly one warning, statement-lag, today's shape", () => {
    const opt = seedOpt("ZZAW  270115C00010000");
    txn(A, opt, "2026-06-01", "BUY_TO_OPEN", 1, 5);
    seedHold(db, A, opt, "2026-06-30", "stmt", 1);
    seedHold(db, A, opt, "2026-07-10", "live-zero");
    computeTaxLots(db);
    const { warnings, critical } = runIntegrityChecks(db, OPTS);
    expect(critical).toEqual([]);
    expect(hitsFor(warnings, A, opt)).toEqual([
      {
        key: `lot-drift:${A}:${opt}`,
        severity: "warning",
        kind: "statement-lag",
        reason: "ZZAW  270115C00010000 (IBKR): closed per live data — awaiting statement",
      },
    ]);
  });

  it("two reasons on one pair: one hit, both in pendingReasons, both named", () => {
    const opt = seedOpt("ZZTW  270115C00010000");
    txn(A, opt, "2026-06-01", "BUY_TO_OPEN", 1, 5);
    seedHold(db, A, opt, "2026-06-30", "stmt-zero");
    txn(A, opt, "2026-07-05", "SELL_TO_OPEN", 1, 4); // a short side opened after the statement zero
    seedHold(db, A, opt, "2026-07-10", "live-zero");
    computeTaxLots(db);
    // Hand: one long lot (statement zero, no closing entry) and one short lot opened later.
    expect(lotsOf(opt)).toEqual([
      [0, 1, 1],
      [1, 1, 1],
    ]);
    const { warnings, critical } = runIntegrityChecks(db, OPTS);
    expect(critical).toEqual([]);
    const hits = hitsFor(warnings, A, opt);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("closing-entry-missing"); // precedence over awaiting
    expect(hits[0].pendingReasons).toEqual(["awaiting_statement", "closing_entry_missing"]);
    expect(hits[0].reason).toBe(
      "ZZTW  270115C00010000 (IBKR): long side: statement shows the position closed but its closing entry is not imported — lots not valued; short side: closed per live data — awaiting statement"
    );
  });
});

describe("cancelling sides and independent drift (R12)", () => {
  it("one long and one short contract of the same live option, statement zero, no closing entries → both sides closing_entry_missing; signed total 0; exactly one pending warning", () => {
    const opt = seedOpt("ZZEQ  270115C00010000");
    txn(A, opt, "2026-06-01", "BUY_TO_OPEN", 1, 5);
    txn(A, opt, "2026-06-02", "SELL_TO_OPEN", 1, 6);
    seedHold(db, A, opt, "2026-06-30", "stmt-zero");
    computeTaxLots(db);
    expect(lotsOf(opt)).toEqual([
      [0, 1, 1],
      [1, 1, 1],
    ]); // hand: signed total 1 - 1 = 0
    const { warnings, critical } = runIntegrityChecks(db, OPTS);
    expect(critical).toEqual([]);
    expect(hitsFor(warnings, A, opt)).toEqual([
      {
        key: `lot-drift:${A}:${opt}`,
        severity: "warning",
        kind: "closing-entry-missing",
        pendingReasons: ["closing_entry_missing"],
        reason:
          "ZZEQ  270115C00010000 (IBKR): long side: statement shows the position closed but its closing entry is not imported — lots not valued; short side: statement shows the position closed but its closing entry is not imported — lots not valued",
      },
    ]);
  });

  it("pending pair plus a real drift on the same pair → the pending hit and a :drift hit", () => {
    const opt = seedOpt("ZZDR  270115C00010000");
    txn(A, opt, "2026-06-01", "BUY_TO_OPEN", 3, 5);
    seedHold(db, A, opt, "2026-06-30", "stmt", 1); // the statement says 1; the lots hold 3
    seedHold(db, A, opt, "2026-07-10", "live-zero");
    computeTaxLots(db);
    expect(lotsOf(opt)).toEqual([[0, 3, 3]]);
    const { warnings, critical } = runIntegrityChecks(db, OPTS);
    expect(hitsFor(warnings, A, opt).map((h) => [h.key, h.kind])).toEqual([[`lot-drift:${A}:${opt}`, "statement-lag"]]);
    expect(hitsFor(critical, A, opt)).toEqual([
      {
        key: `lot-drift:${A}:${opt}:drift`,
        severity: "critical",
        reason: "ZZDR  270115C00010000 (IBKR): position/lot drift 66.7%",
      },
    ]);
    expect(integrityCheckIdOf(`lot-drift:${A}:${opt}:drift`)).toBe("lot-drift");
  });

  it("roll-back uncertainty on a pending pair → the pending hit plus one :drift warning carrying the roll-back reason", () => {
    const opt = seedOpt("ZZRB  270115C00010000");
    txn(A, opt, "2026-06-01", "BUY_TO_OPEN", 1, 5);
    seedHold(db, A, opt, "2026-06-30", "stmt", 1);
    txn(A, opt, "2026-07-05", "SPINOFF", 1, 0); // a ledger row the roll-back cannot undo
    seedHold(db, A, opt, "2026-07-10", "live-zero");
    computeTaxLots(db);
    expect(lotsOf(opt)).toEqual([[0, 1, 1]]);
    const { warnings, critical } = runIntegrityChecks(db, OPTS);
    expect(critical).toEqual([]);
    expect(hitsFor(warnings, A, opt)).toEqual([
      {
        key: `lot-drift:${A}:${opt}`,
        severity: "warning",
        kind: "statement-lag",
        reason: "ZZRB  270115C00010000 (IBKR): closed per live data — awaiting statement",
      },
      {
        key: `lot-drift:${A}:${opt}:drift`,
        severity: "warning",
        kind: "statement-lag",
        reason:
          "ZZRB  270115C00010000 (IBKR): tax lots cannot be checked against the statement (a corporate action dated after the statement) — pending statement",
      },
    ]);
  });
});

describe("T-XACCT (scan part): a closing entry in another account", () => {
  function seedShortStockTwin(): number {
    const stk = seedSec(db, "ZZXS");
    txn(A, stk, "2026-03-02", "SHORT_SELL", 100, 50);
    seedHold(db, A, stk, "2026-06-30", "stmt-zero");
    txn(B, stk, "2026-05-01", "BUY_TO_COVER", 100, 40); // B had nothing open
    return stk;
  }
  function seedShortOptionTwin(): number {
    const opt = seedOpt("ZZXP  270115P00010000");
    txn(A, opt, "2026-03-02", "SELL_TO_OPEN", 2, 3);
    seedHold(db, A, opt, "2026-06-30", "stmt-zero");
    txn(B, opt, "2026-05-01", "BUY_TO_CLOSE", 2, 1); // B had nothing open
    return opt;
  }

  it("short stock and short option twins: one critical hit each naming A and B, keyed with the side; A's pending hit still present", () => {
    const stk = seedShortStockTwin();
    const opt = seedShortOptionTwin();
    computeTaxLots(db);
    expect(lotsOf(stk)).toEqual([[1, 100, 100]]);
    expect(lotsOf(opt)).toEqual([[1, 2, 2]]);
    expect(lotsOf(stk, B)).toEqual([]);
    expect(lotsOf(opt, B)).toEqual([]);

    const { critical, warnings } = runIntegrityChecks(db, OPTS);
    const mismatch = critical.filter((h) => h.kind === "closing-entry-account-mismatch");
    expect(mismatch.map((h) => h.key).sort()).toEqual(
      [`closing-entry-account:${A}:${B}:${stk}:short`, `closing-entry-account:${A}:${B}:${opt}:short`].sort()
    );
    for (const h of mismatch) {
      expect(h.reason).toContain("Vanguard Taxable");
      expect(h.reason).toContain("IBKR");
      expect(h.reason).toContain("the entry may be booked to the wrong account or a transfer may be missing");
      expect(integrityCheckIdOf(h.key)).toBe("closing-entry-account");
    }
    // Raised in addition to A's pending reason, never instead of it.
    expect(hitsFor(warnings, A, stk).map((h) => h.kind)).toEqual(["closing-entry-missing"]);
    expect(hitsFor(warnings, A, opt).map((h) => h.kind)).toEqual(["closing-entry-missing"]);
    // The lot-drift critical count does not include the mismatch hits.
    expect(getDataConfidence(db).lotDriftCriticalCount).toBe(0);
  });

  it("the mismatch check is dark while the tax-lot results are stale", () => {
    seedShortStockTwin();
    // No computeTaxLots: the convention marker is absent, tax_lot_sales is not trusted.
    const { critical, lotDriftChecked } = runIntegrityChecks(db, OPTS);
    expect(lotDriftChecked).toBe(false);
    expect(critical.filter((h) => h.key.startsWith("closing-entry-account"))).toEqual([]);
  });
});

describe("capReason (Codex)", () => {
  it("the mismatch hit is in getDataConfidence(...).integrity.critical; capReason names it when it is the first critical hit", () => {
    const stk = seedSec(db, "ZZCP");
    txn(A, stk, "2026-03-02", "SHORT_SELL", 100, 50);
    seedHold(db, A, stk, "2026-06-30", "stmt-zero");
    txn(B, stk, "2026-05-01", "BUY_TO_COVER", 100, 40);
    computeTaxLots(db);
    const conf = getDataConfidence(db);
    const mismatch = conf.integrity.critical.find((h) => h.key === `closing-entry-account:${A}:${B}:${stk}:short`);
    expect(mismatch).toBeDefined();
    expect(conf.integrity.critical[0]).toBe(mismatch);
    expect(conf.capReason).toBe(mismatch!.reason);
  });

  it("with an earlier critical hit seeded (a type contradiction), capReason names that one and the mismatch is still in the list", () => {
    const stk = seedSec(db, "ZZCQ");
    txn(A, stk, "2026-03-02", "SHORT_SELL", 100, 50);
    seedHold(db, A, stk, "2026-06-30", "stmt-zero");
    txn(B, stk, "2026-05-01", "BUY_TO_COVER", 100, 40);
    // A held bond-typed security whose fund category says sector equity: a held type contradiction.
    const bond = Number(
      db
        .prepare(
          `INSERT INTO securities (symbol, name, security_type, fund_category, currency)
           VALUES ('ZZBD', 'ZZBD Fund', 'Bond', 'US Sector Equity Synthetic', 'USD')`
        )
        .run().lastInsertRowid
    );
    seedHold(db, 2, bond, "2026-06-30", "tws", 10);
    computeTaxLots(db);
    const conf = getDataConfidence(db);
    expect(conf.integrity.critical[0].key).toBe(`type-contradiction:${bond}`);
    expect(conf.capReason).toBe(conf.integrity.critical[0].reason);
    expect(conf.integrity.critical.some((h) => h.key === `closing-entry-account:${A}:${B}:${stk}:short`)).toBe(true);
  });
});

describe("review fixes (Wave 3): no-statement-book pairs, expired options, the day of `now`", () => {
  const ROTH = 2; // carries no statement-grade row in these fixtures

  function seedNoBookOption(symbol: string, expiration = "2027-01-15"): number {
    return Number(
      db
        .prepare(
          `INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date)
           VALUES (?, ?, 'option', 100, ?)`
        )
        .run(symbol, `${symbol} contract`, expiration).lastInsertRowid
    );
  }

  it("W1b: long option pending under a live -2 row, the held short of 2 imported, no statement book → only the pending warning", () => {
    const opt = seedNoBookOption("ZZWB  270115C00010000");
    txn(ROTH, opt, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    txn(ROTH, opt, "2026-06-05", "SELL_TO_OPEN", 2, 4);
    seedHold(db, ROTH, opt, "2026-07-10", "tws", -2);
    computeTaxLots(db);
    expect(lotsOf(opt, ROTH)).toEqual([
      [0, 2, 2],
      [1, 2, 2],
    ]); // hand: long 2 (pending, flat under the short row), short 2 (held)
    const { critical, warnings } = runIntegrityChecks(db, OPTS);
    expect(hitsFor(critical, ROTH, opt)).toEqual([]);
    expect(hitsFor(warnings, ROTH, opt)).toEqual([
      {
        key: `lot-drift:${ROTH}:${opt}`,
        severity: "warning",
        kind: "statement-lag",
        reason: "ZZWB  270115C00010000 (Vanguard Roth IRA): closed per live data — awaiting statement",
      },
    ]);
  });

  it("W1: the held short's opening is not imported → a genuine gap stays a critical :drift hit", () => {
    const opt = seedNoBookOption("ZZWA  270115C00010000");
    txn(ROTH, opt, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    seedHold(db, ROTH, opt, "2026-07-10", "tws", -2);
    computeTaxLots(db);
    expect(lotsOf(opt, ROTH)).toEqual([[0, 2, 2]]);
    const { critical, warnings } = runIntegrityChecks(db, OPTS);
    expect(hitsFor(warnings, ROTH, opt).map((h) => h.kind)).toEqual(["statement-lag"]);
    expect(hitsFor(critical, ROTH, opt)).toEqual([
      {
        key: `lot-drift:${ROTH}:${opt}:drift`,
        severity: "critical",
        reason: "ZZWA  270115C00010000 (Vanguard Roth IRA): position/lot drift 100.0%",
      },
    ]);
  });

  it("W1c: a held short that only partly matches the live short row is still a :drift hit, measured on the held lots", () => {
    const opt = seedNoBookOption("ZZWC  270115C00010000");
    txn(ROTH, opt, "2026-06-01", "BUY_TO_OPEN", 2, 3);
    txn(ROTH, opt, "2026-06-05", "SELL_TO_OPEN", 1, 4);
    seedHold(db, ROTH, opt, "2026-07-10", "tws", -2);
    computeTaxLots(db);
    const { critical } = runIntegrityChecks(db, OPTS);
    expect(hitsFor(critical, ROTH, opt).map((h) => [h.key, h.reason])).toEqual([
      [`lot-drift:${ROTH}:${opt}:drift`, "ZZWC  270115C00010000 (Vanguard Roth IRA): position/lot drift 50.0%"],
    ]);
  });

  function seedExpiringAwaiting(): number {
    const opt = seedNoBookOption("ZZEP  260717C00010000", "2026-07-17");
    txn(A, opt, "2026-06-01", "BUY_TO_OPEN", 1, 5);
    seedHold(db, A, opt, "2026-06-30", "stmt", 1);
    seedHold(db, A, opt, "2026-07-10", "live-zero");
    computeTaxLots(db);
    return opt;
  }

  it("an option past expiry with a live zero reads expired, awaiting its closing entry, across the boundary", () => {
    const opt = seedExpiringAwaiting();
    const onExpiry = runIntegrityChecks(db, { today: "2026-07-17" });
    expect(hitsFor(onExpiry.warnings, A, opt).map((h) => h.reason)).toEqual([
      "ZZEP  260717C00010000 (IBKR): closed per live data — awaiting statement",
    ]);
    const dayAfter = runIntegrityChecks(db, { today: "2026-07-18" });
    expect(hitsFor(dayAfter.warnings, A, opt)).toEqual([
      {
        key: `lot-drift:${A}:${opt}`,
        severity: "warning",
        kind: "statement-lag",
        reason: "ZZEP  260717C00010000 (IBKR): expired — awaiting its closing entry",
      },
    ]);
    expect(dayAfter.critical).toEqual([]);
  });

  it("getDataConfidence passes the Eastern day of `now` to the integrity scan", () => {
    const opt = seedExpiringAwaiting();
    // 23:30 Eastern on the expiration day is already the next UTC day.
    const lateOnExpiry = getDataConfidence(db, new Date("2026-07-18T03:30:00Z"));
    expect(hitsFor(lateOnExpiry.integrity.warnings, A, opt).map((h) => h.reason)).toEqual([
      "ZZEP  260717C00010000 (IBKR): closed per live data — awaiting statement",
    ]);
    const nextDay = getDataConfidence(db, new Date("2026-07-18T16:00:00Z"));
    expect(hitsFor(nextDay.integrity.warnings, A, opt).map((h) => h.reason)).toEqual([
      "ZZEP  260717C00010000 (IBKR): expired — awaiting its closing entry",
    ]);
  });
});

/**
 * Task 9 (reconciler hardening, spec docs/superpowers/specs/2026-08-30-reconciler-hardening-design.md):
 * cross-cutting integration proof of the whole tombstone lifecycle.
 *
 * Unlike the per-task unit suites (tests/import/engine-hardening.test.ts,
 * tests/mutations/closed-equity*.test.ts, tests/plaid/refresh-hardening.test.ts,
 * tests/api/import-undo-recovery.test.ts), which each pin ONE module's half of
 * the design, this file drives the REAL functions across module boundaries and
 * asserts the layers actually agree with each other:
 *
 *  - `commitImport` mints/supersedes a tombstone
 *  - `computeTaxLots` reacts to it (RECONCILE_CLOSE synthesizes/disappears)
 *  - `getTaxConventionState` reacts to THAT (filing-readiness goes pending)
 *  - `undoImport` / `restoreImportBatch` rebuild the tombstone layer, and the
 *    tax-lot layer above it stays in sync across the rebuild
 *  - a live writer (`writePlaidHoldings`) participates in the same contract
 *
 * Every scenario is driven through real functions (never mocked) except the
 * two fault-injection tests, which use a module mock of
 * `@/lib/mutations/closed-equity` with a per-test throw flag — the same idiom
 * as tests/import/engine-hardening.test.ts. Synthetic symbols only.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { RECON_HOLDING_SOURCE_PREFIX } from "@/lib/db/holding-sources";
import {
  getTaxInputGeneration,
  getTaxConventionState,
  stampBrokerAcceptance,
} from "@/lib/compute/tax-convention";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import type {
  ParsedImportResult,
  ParsedSecurity,
  ParsedTransaction,
  ParsedHolding,
} from "@/lib/import/types";
import type { PlaidMapResult, MappedPlaidPosition } from "@/lib/plaid/map-holdings";

// ── module mock (fault-injection tests only; passthrough otherwise) ──────
const hoisted = vi.hoisted(() => ({ removeOrphanedThrows: false }));

vi.mock("@/lib/mutations/closed-equity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mutations/closed-equity")>();
  return {
    ...actual,
    removeOrphanedReconTombstones: (
      ...args: Parameters<typeof actual.removeOrphanedReconTombstones>
    ) => {
      if (hoisted.removeOrphanedThrows) {
        throw new Error("SQLITE_BUSY: injected fault for undo-refusal fault-injection test");
      }
      return actual.removeOrphanedReconTombstones(...args);
    },
  };
});

// Imported AFTER the mock so engine.ts / recovery.ts / plaid refresh.ts all
// resolve `@/lib/mutations/closed-equity` through the mocked module.
import { commitImport, undoImport } from "@/lib/import/engine";
import { undoImportWithRecovery, restoreImportBatch, readRecoveryManifest } from "@/lib/import/recovery";
import { writePlaidHoldings } from "@/lib/plaid/refresh";
import { reconcileClosedEquityHoldings } from "@/lib/mutations/closed-equity";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.removeOrphanedThrows = false;
});

// ── fixture builders ──────────────────────────────────────────────────────

function acct(name: string): number {
  return (
    db
      .prepare(
        `INSERT INTO accounts (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = name RETURNING id`,
      )
      .get(name) as { id: number }
  ).id;
}

function secId(symbol: string): number {
  return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
}

function stockSecurity(symbol: string): ParsedSecurity {
  return { symbol, name: `${symbol} Corp`, securityType: "Stock" };
}

function buyTxn(
  account: string,
  symbol: string,
  date: string,
  qty: number,
  price: number,
): ParsedTransaction {
  return {
    accountName: account,
    tradeDate: date,
    type: "BUY",
    symbol,
    quantity: qty,
    pricePerShare: price,
    amount: -(qty * price),
    sourceKey: `test:buy:${account}:${symbol}:${date}`,
  };
}

let holdingSeq = 0;
function statementHolding(account: string, symbol: string, date: string, qty: number): ParsedHolding {
  holdingSeq++;
  return {
    accountName: account,
    symbol,
    quantity: qty,
    asOfDate: date,
    sourceKey: `canonical:hold:${account}:${symbol}:${date}:${holdingSeq}`,
  };
}

function parsedResult(overrides: Partial<ParsedImportResult> = {}): ParsedImportResult {
  return {
    sourceType: "canonical-csv",
    sourceName: "synthetic-fixture.csv",
    transactions: [],
    securities: [],
    holdings: [],
    prices: [],
    snapshots: [],
    corporateActions: [],
    errors: [],
    warnings: [],
    ...overrides,
  };
}

// ── read helpers ─────────────────────────────────────────────────────────

interface HoldingRow {
  quantity: number;
  as_of_date: string;
  source_key: string;
  import_batch_id: number | null;
}

function latestRow(accountId: number, symbol: string): HoldingRow | undefined {
  return db
    .prepare(
      `SELECT quantity, as_of_date, source_key, import_batch_id FROM holdings
        WHERE account_id = ? AND security_id = ? ORDER BY as_of_date DESC LIMIT 1`,
    )
    .get(accountId, secId(symbol)) as HoldingRow | undefined;
}

function reconCloseTrades(accountId: number, symbol: string): { trade_date: string }[] {
  return db
    .prepare(
      `SELECT trade_date FROM transactions
        WHERE account_id = ? AND security_id = ? AND type = 'RECONCILE_CLOSE'`,
    )
    .all(accountId, secId(symbol)) as { trade_date: string }[];
}

function reconRowsFor(accountId: number): HoldingRow[] {
  return db
    .prepare(
      `SELECT quantity, as_of_date, source_key, import_batch_id FROM holdings
        WHERE account_id = ? AND source_key LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'`,
    )
    .all(accountId) as HoldingRow[];
}

// ═══════════════════════════════════════════════════════════════════════
// Scenario A — RECONCILE_CLOSE lifecycle: appears on tombstone, disappears
// on same-date supersession.
// ═══════════════════════════════════════════════════════════════════════

describe("RECONCILE_CLOSE lifecycle", () => {
  it("appears when the reconciler tombstones an orphaned open lot, disappears on same-date supersession", () => {
    const A = "Recon Lifecycle A";
    acct(A);

    // 1. Open a real FIFO lot: BUY 100 ZINTA @ $10, with a statement snapshot
    //    establishing the position.
    const buy = commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZINTA")],
        transactions: [buyTxn(A, "ZINTA", "2026-01-10", 100, 10)],
        holdings: [statementHolding(A, "ZINTA", "2026-01-10", 100)],
      }),
    );
    expect(buy.newTransactions).toBe(1);

    // 2. A later statement omits ZINTA (sold, but no matching SELL imported
    //    yet) — the post-commit reconcile tombstones it automatically.
    const bad = commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZKEEP")],
        holdings: [statementHolding(A, "ZKEEP", "2026-02-10", 5)],
      }),
    );
    const accountId = acct(A);
    expect(reconRowsFor(accountId)).toHaveLength(1);
    const tomb = latestRow(accountId, "ZINTA")!;
    expect(tomb.quantity).toBe(0);
    expect(tomb.as_of_date).toBe("2026-02-10");
    expect(tomb.import_batch_id).toBe(bad.batchId);

    // 3. computeTaxLots must synthesize a RECONCILE_CLOSE at the tombstone
    //    date — the ledger still shows an open lot, the broker says flat.
    computeTaxLots(db);
    expect(reconCloseTrades(accountId, "ZINTA")).toEqual([{ trade_date: "2026-02-10" }]);

    // 4. A corrected same-date statement restores the position. Because it
    //    lands in the SAME (account, security, as_of_date) slot as the
    //    tombstone, this is a genuine supersession (counted as a real
    //    change), not a duplicate.
    const fixed = commitImport(
      db,
      parsedResult({
        holdings: [statementHolding(A, "ZINTA", "2026-02-10", 100)],
      }),
    );
    expect(fixed.newHoldings).toBe(1);
    expect(reconRowsFor(accountId)).toHaveLength(0);
    expect(latestRow(accountId, "ZINTA")!.quantity).toBe(100);

    // 5. The synthetic close must vanish — the broker no longer says flat.
    computeTaxLots(db);
    expect(reconCloseTrades(accountId, "ZINTA")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario B — newer-date re-buy removes the synthetic close, and the live
// writer's own bump covers the tax-generation invalidation (no accompanying
// same-date supersession to piggyback on).
// ═══════════════════════════════════════════════════════════════════════

describe("newer-date re-buy via a live writer", () => {
  it("writePlaidHoldings' non-zero write over an OLDER tombstone removes the synthetic close and bumps the generation itself", () => {
    const B = "Recon Newer-Date B";
    const accountId = acct(B);

    commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZBUYB")],
        transactions: [buyTxn(B, "ZBUYB", "2026-01-05", 50, 20)],
        holdings: [statementHolding(B, "ZBUYB", "2026-01-05", 50)],
      }),
    );
    // Later statement omits ZBUYB (an older tombstone — the live write below
    // lands on a NEWER date, not the same slot).
    commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZKEEPB")],
        holdings: [statementHolding(B, "ZKEEPB", "2026-02-05", 5)],
      }),
    );
    expect(latestRow(accountId, "ZBUYB")!.quantity).toBe(0);

    computeTaxLots(db);
    expect(reconCloseTrades(accountId, "ZBUYB")).toEqual([{ trade_date: "2026-02-05" }]);

    const genBefore = getTaxInputGeneration(db);

    // Live writer re-buys ZBUYB on a NEWER date, reporting its FULL book
    // (ZKEEPB included, unchanged) — otherwise the live-snapshot-diff pass
    // would read ZKEEPB's absence from this sync as a second, unrelated
    // closure and confound the assertion below. No same-date tombstone is
    // consumed here — the newer-date-supersession detector is the only
    // thing that can see the ZBUYB transition, so if it didn't fire the
    // generation would stay stale.
    const mapped: PlaidMapResult = {
      positions: [
        { plaidAccountId: "pB", symbol: "ZBUYB", name: null, securityType: "Stock", quantity: 30 } as MappedPlaidPosition,
        { plaidAccountId: "pB", symbol: "ZKEEPB", name: null, securityType: "Stock", quantity: 5 } as MappedPlaidPosition,
      ],
      cashByAccount: {},
      totalByAccount: {},
      unmatched: [],
      mutualFundPrices: [],
    };
    writePlaidHoldings(db, mapped, { pB: accountId }, "2026-03-01");

    expect(latestRow(accountId, "ZBUYB")).toMatchObject({ quantity: 30, as_of_date: "2026-03-01" });
    expect(getTaxInputGeneration(db)).toBe(genBefore + 1); // the live writer's own bump

    computeTaxLots(db);
    expect(reconCloseTrades(accountId, "ZBUYB")).toEqual([]); // synthetic close gone
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario C — filing-readiness STATE (not just the generation counter)
// goes pending when the reconciler mints a tombstone.
// ═══════════════════════════════════════════════════════════════════════

describe("filing-readiness state on tombstone events", () => {
  it("a stamped broker acceptance goes stale the moment a tombstone is minted", () => {
    const C = "Recon Filing C";
    const accountId = acct(C);

    commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZFILE")],
        transactions: [buyTxn(C, "ZFILE", "2026-01-01", 10, 5)],
        holdings: [statementHolding(C, "ZFILE", "2026-01-01", 10)],
      }),
    );
    computeTaxLots(db); // stamps tax_lots_convention at the current generation
    stampBrokerAcceptance(db, [{ accountId, taxYear: 2026 }]);

    const before = getTaxConventionState(db);
    expect(before.recomputeCurrent).toBe(true);
    expect(before.acceptance.current).toBe(true);

    // Seed the later statement snapshot DIRECTLY (bypassing commitImport) so
    // the ONLY generation-affecting event that follows is the reconciler's
    // own tombstone mint — isolates the claim "minting a tombstone alone is
    // what invalidates filing-readiness," not some incidental import bump.
    // ZFILE stays absent from this later statement (phantom); a second,
    // still-held security (ZKEEPC) keeps the statement shrink guard clear.
    const zkeepId = (
      db.prepare(`INSERT INTO securities (symbol, security_type) VALUES ('ZKEEPC', 'Stock') RETURNING id`).get() as {
        id: number;
      }
    ).id;
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 5, '2026-02-01', ?)`,
    ).run(accountId, zkeepId, `canonical:hold:${C}:ZKEEPC:2026-02-01`);

    expect(reconcileClosedEquityHoldings(db)).toBe(1); // ZFILE tombstoned, unowned

    const after = getTaxConventionState(db);
    expect(after.recomputeCurrent).toBe(false);
    expect(after.acceptance.current).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario D — bad-A → corrected-B → undo-B: A's tombstone is re-derived at
// A's ORIGINAL date, and the tax-lot layer follows it back.
// ═══════════════════════════════════════════════════════════════════════

describe("undo of a correcting import re-derives the original tombstone", () => {
  it("re-derives at the original date and RECONCILE_CLOSE reappears there", () => {
    const D = "Recon Undo-Rederive D";
    const accountId = acct(D);

    commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZBADA")],
        transactions: [buyTxn(D, "ZBADA", "2026-01-01", 20, 8)],
        holdings: [statementHolding(D, "ZBADA", "2026-01-01", 20)],
      }),
    );
    const bad = commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZOTHERD")],
        holdings: [statementHolding(D, "ZOTHERD", "2026-02-01", 3)],
      }),
    );
    expect(latestRow(accountId, "ZBADA")!.quantity).toBe(0); // tombstoned at 2026-02-01
    computeTaxLots(db);
    expect(reconCloseTrades(accountId, "ZBADA")).toEqual([{ trade_date: "2026-02-01" }]);

    const fixed = commitImport(
      db,
      parsedResult({
        holdings: [statementHolding(D, "ZBADA", "2026-02-01", 20)], // same date, corrected
      }),
    );
    expect(fixed.newHoldings).toBe(1);
    expect(reconRowsFor(accountId)).toHaveLength(0);
    computeTaxLots(db);
    expect(reconCloseTrades(accountId, "ZBADA")).toEqual([]);

    const genBeforeUndo = getTaxInputGeneration(db);
    undoImport(db, fixed.batchId);

    const tomb = latestRow(accountId, "ZBADA")!;
    expect(tomb.quantity).toBe(0);
    expect(tomb.as_of_date).toBe("2026-02-01"); // A's ORIGINAL date, not "today"
    expect(tomb.source_key.startsWith(RECON_HOLDING_SOURCE_PREFIX)).toBe(true);
    expect(tomb.source_key.endsWith(":stmt")).toBe(true);
    expect(tomb.import_batch_id).toBeNull(); // re-derived by the unowned sweep
    expect(getTaxInputGeneration(db)).toBeGreaterThan(genBeforeUndo);

    // The tax-lot layer follows the reconciler back: the synthetic close
    // reappears at the same original date.
    computeTaxLots(db);
    expect(reconCloseTrades(accountId, "ZBADA")).toEqual([{ trade_date: "2026-02-01" }]);
    // bad's own snapshot row is untouched by undoing fixed.
    expect(latestRow(accountId, "ZOTHERD")!.import_batch_id).toBe(bad.batchId);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario E (controller-carried extra test) — undo refuses whole when the
// tombstone rebuild fails: fault-inject removeOrphanedReconTombstones to
// throw inside undoImport's outer transaction.
// ═══════════════════════════════════════════════════════════════════════

describe("undo-refusal fault injection", () => {
  it("a rebuild failure rolls back the whole undo — batch and its holdings survive", () => {
    const E = "Recon Undo-Refusal E";
    const accountId = acct(E);

    commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZUNDO")],
        transactions: [buyTxn(E, "ZUNDO", "2026-01-01", 40, 6)],
        holdings: [statementHolding(E, "ZUNDO", "2026-01-01", 40)],
      }),
    );
    const bad = commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZOTHERE")],
        holdings: [statementHolding(E, "ZOTHERE", "2026-02-01", 7)],
      }),
    );
    // Precondition: the batch owns two rows (ZOTHERE's write + ZUNDO's
    // tombstone), and the batch row itself exists.
    const ownedBefore = (
      db.prepare(`SELECT COUNT(*) c FROM holdings WHERE import_batch_id = ?`).get(bad.batchId) as {
        c: number;
      }
    ).c;
    expect(ownedBefore).toBe(2);
    expect(db.prepare(`SELECT id FROM import_batches WHERE id = ?`).get(bad.batchId)).toBeDefined();

    hoisted.removeOrphanedThrows = true;
    expect(() => undoImport(db, bad.batchId)).toThrow(/injected fault/);

    // The outer transaction must have rolled back EVERYTHING — the batch row
    // and every holdings row it owned.
    expect(db.prepare(`SELECT id FROM import_batches WHERE id = ?`).get(bad.batchId)).toBeDefined();
    const ownedAfter = (
      db.prepare(`SELECT COUNT(*) c FROM holdings WHERE import_batch_id = ?`).get(bad.batchId) as {
        c: number;
      }
    ).c;
    expect(ownedAfter).toBe(ownedBefore);
    expect(latestRow(accountId, "ZOTHERE")).toBeDefined();
    expect(latestRow(accountId, "ZUNDO")!.quantity).toBe(0); // tombstone also survived
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario F — cross-account: a batch touching account 1 never owns account
// 2's tombstones, and undoing it never disturbs them.
// ═══════════════════════════════════════════════════════════════════════

describe("cross-account ownership isolation", () => {
  it("a commit's global reconcile pass never owns another account's tombstone, and undo never disturbs it", () => {
    const F1 = "Recon Cross F1";
    const F2 = "Recon Cross F2";
    const acct1 = acct(F1);
    const acct2 = acct(F2);

    commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZCROSS1")],
        transactions: [buyTxn(F1, "ZCROSS1", "2026-01-01", 15, 12)],
        holdings: [statementHolding(F1, "ZCROSS1", "2026-01-01", 15)],
      }),
    );
    commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZCROSS2")],
        transactions: [buyTxn(F2, "ZCROSS2", "2026-01-01", 25, 7)],
        holdings: [statementHolding(F2, "ZCROSS2", "2026-01-01", 25)],
      }),
    );

    // F2's LATER statement snapshot lands DIRECTLY via SQL (bypassing
    // commitImport, so it belongs to no batch) — F2 now has an
    // as-yet-unreconciled phantom (ZCROSS2) sitting in the book at the
    // moment F1's commit below runs.
    const zother2Id = (
      db.prepare(`INSERT INTO securities (symbol, security_type) VALUES ('ZOTHER2', 'Stock') RETURNING id`).get() as {
        id: number;
      }
    ).id;
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 4, '2026-02-01', ?)`,
    ).run(acct2, zother2Id, `canonical:hold:${F2}:ZOTHER2:2026-02-01`);

    // F1's own bad import. Its post-commit reconcile runs GLOBALLY (every
    // account with holdings rows, not just F1's) — so it is the SAME call
    // that discovers BOTH F1's own phantom (ZCROSS1) AND F2's pre-existing,
    // not-yet-reconciled phantom (ZCROSS2). This is the real hazard: one
    // commit's reconcile pass minting tombstones across account boundaries
    // in a single run, and the ownership stamp having to sort them out
    // correctly right there.
    const f1Bad = commitImport(
      db,
      parsedResult({
        securities: [stockSecurity("ZOTHER1")],
        holdings: [statementHolding(F1, "ZOTHER1", "2026-02-01", 6)],
      }),
    );

    const f1Tomb = latestRow(acct1, "ZCROSS1")!;
    const f2Tomb = latestRow(acct2, "ZCROSS2")!;
    expect(f1Tomb.quantity).toBe(0);
    expect(f2Tomb.quantity).toBe(0);
    // F1's OWN phantom, minted for an account F1's batch actually imported,
    // is owned.
    expect(f1Tomb.import_batch_id).toBe(f1Bad.batchId);
    // F2's phantom was minted by the SAME reconcile call (triggered by F1's
    // commit) but for an account F1's batch never imported — it must stay
    // unowned, never mis-stamped with F1's batch id.
    expect(f2Tomb.import_batch_id).toBeNull();

    computeTaxLots(db);
    expect(reconCloseTrades(acct1, "ZCROSS1")).toEqual([{ trade_date: "2026-02-01" }]);
    expect(reconCloseTrades(acct2, "ZCROSS2")).toEqual([{ trade_date: "2026-02-01" }]);

    // Undo F1's batch. F2's tombstone (unowned, sync/incidental-style) must
    // be completely unaffected — same quantity, same date, same (null) owner.
    undoImport(db, f1Bad.batchId);

    const f2After = latestRow(acct2, "ZCROSS2")!;
    expect(f2After).toEqual(f2Tomb);

    // F1's own position: tombstone superseded/orphaned away (its only
    // justifying statement snapshot, ZOTHER1, went with the undone batch),
    // reverting to the last real non-zero row.
    const f1After = latestRow(acct1, "ZCROSS1")!;
    expect(f1After.quantity).toBe(15);
    expect(f1After.as_of_date).toBe("2026-01-01");

    // The tax-lot layer follows: F1's synthetic close is gone, F2's is
    // untouched.
    computeTaxLots(db);
    expect(reconCloseTrades(acct1, "ZCROSS1")).toEqual([]);
    expect(reconCloseTrades(acct2, "ZCROSS2")).toEqual([{ trade_date: "2026-02-01" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario G — full round trip through restoreImportBatch: undo (with a
// recovery manifest) then restore re-derives the tombstone from scratch,
// never from the manifest verbatim.
// ═══════════════════════════════════════════════════════════════════════

describe("undo-with-recovery then restore round trip", () => {
  it("restore re-derives the tombstone (never re-inserted from the manifest) and the synthetic close follows", () => {
    const G = "Recon Restore G";
    const accountId = acct(G);
    const dir = mkdtempSync(join(tmpdir(), "reconciler-hardening-restore-"));
    try {
      commitImport(
        db,
        parsedResult({
          securities: [stockSecurity("ZRESTG")],
          transactions: [buyTxn(G, "ZRESTG", "2026-01-01", 60, 4)],
          holdings: [statementHolding(G, "ZRESTG", "2026-01-01", 60)],
        }),
      );
      const bad = commitImport(
        db,
        parsedResult({
          securities: [stockSecurity("ZOTHERG")],
          holdings: [statementHolding(G, "ZOTHERG", "2026-02-01", 9)],
        }),
      );
      computeTaxLots(db);
      expect(reconCloseTrades(accountId, "ZRESTG")).toEqual([{ trade_date: "2026-02-01" }]);

      const { manifestPath } = undoImportWithRecovery(db, bad.batchId, { manifestDir: dir });

      // Both the tombstone AND its justifying evidence (ZOTHERG) went with
      // the undo — nothing later than 2026-01-01 remains, so no phantom.
      expect(latestRow(accountId, "ZRESTG")!.quantity).toBe(60);
      computeTaxLots(db);
      expect(reconCloseTrades(accountId, "ZRESTG")).toEqual([]);

      const manifest = readRecoveryManifest(manifestPath);
      const result = restoreImportBatch(db, manifest);
      expect(result.batchId).toBe(bad.batchId);

      // ZOTHERG restored verbatim from the manifest.
      expect(latestRow(accountId, "ZOTHERG")!.quantity).toBe(9);

      // ZRESTG's tombstone is back — but RE-DERIVED by the post-restore
      // reconcile, never copied from the manifest. NULL batch ownership is
      // the tell: a verbatim manifest re-insert would carry `bad`'s id.
      const tomb = latestRow(accountId, "ZRESTG")!;
      expect(tomb.quantity).toBe(0);
      expect(tomb.as_of_date).toBe("2026-02-01");
      expect(tomb.source_key.startsWith(RECON_HOLDING_SOURCE_PREFIX)).toBe(true);
      expect(tomb.import_batch_id).toBeNull();
      // Exactly one row at that slot — no duplicate from a manifest insert
      // followed by a re-reconcile insert.
      expect(reconRowsFor(accountId)).toHaveLength(1);

      computeTaxLots(db);
      expect(reconCloseTrades(accountId, "ZRESTG")).toEqual([{ trade_date: "2026-02-01" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

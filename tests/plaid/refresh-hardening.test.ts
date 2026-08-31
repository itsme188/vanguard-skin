/**
 * Tests for lib/plaid/refresh.ts's directional-supersession + transaction
 * hardening (spec 2026-08-31 reconciler-hardening, T5).
 *
 * Drives `writePlaidHoldings` directly (the exported DB-only writer, not the
 * async `refreshVanguardHoldingsFromPlaid` wrapper) with hand-built
 * `PlaidMapResult` fixtures — the same idiom the brief's Step 1 calls for.
 * Mirrors tests/plaid/refresh.test.ts's DB-seeding style, adapted for
 * tombstone scenarios via lib/mutations/closed-equity's exported constants.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import {
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_STMT_SUFFIX,
  RECON_LIVE_SUFFIX,
} from "@/lib/db/holding-sources";

vi.mock("@/lib/mutations/closed-equity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mutations/closed-equity")>();
  return {
    ...actual,
    // Default: delegate to the real implementation. Individual tests can
    // override with mockImplementationOnce to inject a mid-transaction throw.
    reconcileClosedEquityHoldings: vi.fn(actual.reconcileClosedEquityHoldings),
  };
});

import { writePlaidHoldings } from "@/lib/plaid/refresh";
import { reconcileClosedEquityHoldings } from "@/lib/mutations/closed-equity";
import type { PlaidMapResult, MappedPlaidPosition } from "@/lib/plaid/map-holdings";

const TODAY = "2026-07-10";
const D_MINUS_5 = "2026-07-05";
const D_MINUS_10 = "2026-06-30";

let db: Database.Database;
let taxableId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
  taxableId = (
    db.prepare(`SELECT id FROM accounts WHERE name = 'Vanguard Taxable'`).get() as { id: number }
  ).id;
  vi.mocked(reconcileClosedEquityHoldings).mockClear();
});

/** A plain (non-tombstone) holdings row — the pre-existing "held earlier" state. */
function hold(a: number, s: number, qty: number, date: string, sourceKey?: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(a, s, qty, date, sourceKey ?? `seed:${a}:${s}:${date}`);
}

/** A recon-prefixed tombstone row, with the given origin suffix ("" = legacy unsuffixed). */
function holdTombstone(a: number, s: number, date: string, suffix: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, 0, 0, ?, ?)`,
  ).run(a, s, date, `${RECON_HOLDING_SOURCE_PREFIX}${a}:${s}:${date}${suffix}`);
}

function latestHoldingRow(
  a: number,
  s: number,
): { quantity: number; source_key: string; as_of_date: string } {
  return db
    .prepare(
      `SELECT quantity, source_key, as_of_date FROM holdings
        WHERE account_id = ? AND security_id = ? ORDER BY as_of_date DESC LIMIT 1`,
    )
    .get(a, s) as { quantity: number; source_key: string; as_of_date: string };
}

function rowAt(a: number, s: number, date: string): { quantity: number; source_key: string } | undefined {
  return db
    .prepare(`SELECT quantity, source_key FROM holdings WHERE account_id=? AND security_id=? AND as_of_date=?`)
    .get(a, s, date) as { quantity: number; source_key: string } | undefined;
}

function mappedResult(positions: MappedPlaidPosition[]): PlaidMapResult {
  return {
    positions,
    cashByAccount: {},
    totalByAccount: {},
    unmatched: [],
    mutualFundPrices: [],
  };
}

function pos(symbol: string, quantity: number): MappedPlaidPosition {
  return { plaidAccountId: "pTax", symbol, name: null, securityType: "Stock", quantity };
}

describe("writePlaidHoldings — directional supersession + transaction bumps", () => {
  it("plaid supersedes a same-date :live tombstone", () => {
    const xId = upsertSecurity(db, { symbol: "X", securityType: "Stock" });
    hold(taxableId, xId, 5, D_MINUS_10);
    holdTombstone(taxableId, xId, TODAY, RECON_LIVE_SUFFIX);

    const genBefore = getTaxInputGeneration(db);
    writePlaidHoldings(db, mappedResult([pos("X", 4)]), { pTax: taxableId }, TODAY);
    const genAfter = getTaxInputGeneration(db);

    const row = rowAt(taxableId, xId, TODAY);
    expect(row?.quantity).toBe(4);
    expect(row?.source_key.startsWith("plaid:")).toBe(true);
    expect(genAfter).toBe(genBefore + 1);
  });

  it("plaid does NOT supersede a same-date :stmt tombstone", () => {
    const xId = upsertSecurity(db, { symbol: "X", securityType: "Stock" });
    hold(taxableId, xId, 5, D_MINUS_10);
    holdTombstone(taxableId, xId, TODAY, RECON_STMT_SUFFIX);

    const genBefore = getTaxInputGeneration(db);
    writePlaidHoldings(db, mappedResult([pos("X", 4)]), { pTax: taxableId }, TODAY);
    const genAfter = getTaxInputGeneration(db);

    const row = rowAt(taxableId, xId, TODAY);
    expect(row?.quantity).toBe(0);
    expect(row?.source_key).toBe(`${RECON_HOLDING_SOURCE_PREFIX}${taxableId}:${xId}:${TODAY}${RECON_STMT_SUFFIX}`);
    expect(genAfter).toBe(genBefore);
  });

  it("plaid bumps on newer-date supersession (re-bought position)", () => {
    const xId = upsertSecurity(db, { symbol: "X", securityType: "Stock" });
    // X's latest row is a tombstone dated D-5 (closed a while ago).
    holdTombstone(taxableId, xId, D_MINUS_5, RECON_LIVE_SUFFIX);

    const genBefore = getTaxInputGeneration(db);
    writePlaidHoldings(db, mappedResult([pos("X", 7)]), { pTax: taxableId }, TODAY);
    const genAfter = getTaxInputGeneration(db);

    const row = rowAt(taxableId, xId, TODAY);
    expect(row?.quantity).toBe(7);
    expect(row?.source_key.startsWith("plaid:")).toBe(true);
    expect(genAfter).toBe(genBefore + 1);
  });

  it("routine plaid sync (no tombstoned securities touched) does not bump", () => {
    const yId = upsertSecurity(db, { symbol: "Y", securityType: "Stock" });
    hold(taxableId, yId, 10, D_MINUS_5, `plaid:${taxableId}:${yId}:${D_MINUS_5}`);

    const genBefore = getTaxInputGeneration(db);
    writePlaidHoldings(db, mappedResult([pos("Y", 12)]), { pTax: taxableId }, TODAY);
    const genAfter = getTaxInputGeneration(db);

    const row = rowAt(taxableId, yId, TODAY);
    expect(row?.quantity).toBe(12);
    expect(genAfter).toBe(genBefore);
  });

  it("plaid does NOT supersede a legacy unsuffixed tombstone (statement-grade), and does not bump", () => {
    const xId = upsertSecurity(db, { symbol: "X", securityType: "Stock" });
    hold(taxableId, xId, 5, D_MINUS_10);
    holdTombstone(taxableId, xId, TODAY, ""); // legacy: no origin suffix

    const genBefore = getTaxInputGeneration(db);
    writePlaidHoldings(db, mappedResult([pos("X", 4)]), { pTax: taxableId }, TODAY);
    const genAfter = getTaxInputGeneration(db);

    const row = rowAt(taxableId, xId, TODAY);
    expect(row?.quantity).toBe(0);
    expect(row?.source_key).toBe(`${RECON_HOLDING_SOURCE_PREFIX}${taxableId}:${xId}:${TODAY}`);
    expect(genAfter).toBe(genBefore);
  });

  it("a throw inside the per-account transaction rolls back writes AND bump together", () => {
    // Z is a brand-new security with NO pre-existing holdings row: its write
    // is a plain unconditional INSERT, never gated by the upsert's WHERE
    // clause. This is what makes the test discriminating — a scenario gated
    // by the WHERE clause (like superseding a :live tombstone) would also
    // "pass" against the OLD, non-transactional code whenever that same
    // WHERE clause happens to block the write for an unrelated reason,
    // which proves nothing about atomicity (see task-3-report.md's callout
    // of exactly this false-green trap). Z's insert has no such gate: under
    // the old code (no transaction wrap) it auto-commits the instant
    // upsertHolding.run() executes and survives a later throw; only the new
    // transaction wrap can undo it.
    const zId = upsertSecurity(db, { symbol: "Z", securityType: "Stock" });
    // X supersedes a same-date :live tombstone in the SAME account/call, so
    // the would-be generation bump is genuinely in flight when the throw
    // hits — proving the bump rolls back WITH the writes, not just that an
    // unrelated write survives.
    const xId = upsertSecurity(db, { symbol: "X", securityType: "Stock" });
    hold(taxableId, xId, 5, D_MINUS_10);
    holdTombstone(taxableId, xId, TODAY, RECON_LIVE_SUFFIX);

    vi.mocked(reconcileClosedEquityHoldings).mockImplementationOnce(() => {
      throw new Error("boom — injected reconcile failure");
    });

    const genBefore = getTaxInputGeneration(db);
    expect(() =>
      writePlaidHoldings(
        db,
        mappedResult([pos("Z", 10), pos("X", 4)]),
        { pTax: taxableId },
        TODAY,
      ),
    ).toThrow("boom");
    const genAfter = getTaxInputGeneration(db);

    // Z's otherwise-unconditional write must be gone — the discriminating
    // assertion (fails against the pre-transaction-wrap code).
    expect(rowAt(taxableId, zId, TODAY)).toBeUndefined();

    // X's row (which would have superseded the :live tombstone) also rolled
    // back — same transaction, same fate.
    const row = latestHoldingRow(taxableId, xId);
    expect(row.as_of_date).toBe(TODAY);
    expect(row.quantity).toBe(0);
    expect(row.source_key).toBe(
      `${RECON_HOLDING_SOURCE_PREFIX}${taxableId}:${xId}:${TODAY}${RECON_LIVE_SUFFIX}`,
    );

    // The generation bump that Z+X's writes would have earned never landed.
    expect(genAfter).toBe(genBefore);
  });
});

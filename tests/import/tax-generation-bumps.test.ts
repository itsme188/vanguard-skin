/**
 * Task 2 (number-trust durable fixes, WS1): tax input generation bumps at
 * every material mutation site. The generation counter (lib/compute/
 * tax-convention.ts, Task 1) advances whenever a mutation can change tax-lot
 * inputs — transactions, corporate actions, donation links/lots, or a
 * security's multiplier/security_type identity — so a stale
 * recompute/acceptance stamp can never survive new data. A fully-deduped
 * no-op (re-import of an identical file, an upsert with no actual change)
 * must NOT bump — the generation is a "did tax inputs change" signal, not
 * "did a mutation function run".
 *
 * Covers: import commit, import commit no-op, import undo, donation link,
 * donation unlink, donation lot assignment, donation reversal, and security
 * multiplier/security_type identity changes (bump only when tax_lots exist
 * for that security; no bump on a no-change upsert or when no tax_lots
 * exist). The "Repair applies" site (scripts/repair-security-type-
 * corruption.ts's CLI apply path) is wired the same way but is not covered
 * here — `main()` is not exported and isn't unit-tested elsewhere in this
 * codebase (tests/scripts/repair-security-type-corruption.test.ts only
 * exercises applyTypeRepairs/applyRehomes directly, never the CLI driver) —
 * see task-2-report.md for the concern note.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import {
  linkDonationLegs,
  unlinkDonationLegs,
  assignDonationLots,
} from "@/lib/mutations/donation-links";
import { markDonationReversed } from "@/lib/mutations/donations";
import { upsertSecurity } from "@/lib/mutations/securities";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

// Migration 002 seeds accounts 1='Vanguard Taxable', 2='Vanguard Roth IRA', 3='IBKR'.

const CANONICAL_TXN_HEADER =
  "account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes";

/** 2 BUY rows via the canonical-csv format — the smallest fixture that
 *  exercises the import engine's real commit path (matches the brief's
 *  "commitSmallFixtureImport ... 2 BUY rows" helper). */
async function commitSmallFixtureImport(db: Database.Database) {
  const csv = `${CANONICAL_TXN_HEADER}
Vanguard Taxable,2025-06-15,,BUY,AAPL,Apple Inc,Stock,10,150.25,-1502.50,4.95,
Vanguard Taxable,2025-06-20,,BUY,MSFT,Microsoft Corp,Stock,5,400.00,-2000.00,1.00,`;
  const parsed = await parseImport(csv, "tax-gen-fixture.csv");
  return commitImport(db, parsed);
}

function seedSecurity(
  db: Database.Database,
  id: number,
  symbol: string,
  securityType: string,
  multiplier: number | null
) {
  db.prepare(
    "INSERT INTO securities (id, symbol, security_type, multiplier) VALUES (?, ?, ?, ?)"
  ).run(id, symbol, securityType, multiplier);
}

interface TaxLotSeed {
  id: number;
  accountId: number;
  securityId: number;
  acquisitionTxnId: number;
  acquisitionDate: string;
  quantityAcquired: number;
  quantityRemaining: number;
  costBasis: number;
}
function seedTaxLot(db: Database.Database, l: TaxLotSeed) {
  db.prepare(
    `INSERT INTO tax_lots (id, account_id, security_id, acquisition_transaction_id, acquisition_date,
       acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    l.id,
    l.accountId,
    l.securityId,
    l.acquisitionTxnId,
    l.acquisitionDate,
    l.costBasis / l.quantityAcquired,
    l.quantityAcquired,
    l.quantityRemaining,
    l.costBasis
  );
}

interface TxnSeed {
  id: number;
  accountId: number;
  securityId: number | null;
  tradeDate: string;
  type: string;
  quantity: number | null;
}
function seedTxn(db: Database.Database, t: TxnSeed) {
  db.prepare(
    `INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(t.id, t.accountId, t.securityId, t.tradeDate, t.type, t.quantity, `txn-${t.id}`);
}

interface DonationSeed {
  id: number;
  securityId: number;
  quantity: number;
  fmvUsd: number;
  receivedDate?: string;
}
function seedDonation(db: Database.Database, d: DonationSeed) {
  db.prepare(
    `INSERT INTO donations (id, source_key, kind, security_id, quantity, fmv_usd, received_date)
     VALUES (?, ?, 'stock', ?, ?, ?, ?)`
  ).run(d.id, `donation-${d.id}`, d.securityId, d.quantity, d.fmvUsd, d.receivedDate ?? "2026-01-10");
}

describe("tax input generation bumps", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = fresh();
  });

  describe("import engine", () => {
    it("import commit that inserts transactions bumps the generation", async () => {
      const before = getTaxInputGeneration(db);
      await commitSmallFixtureImport(db);
      expect(getTaxInputGeneration(db)).toBe(before + 1);
    });

    it("re-importing the identical file is a no-op and does NOT bump", async () => {
      await commitSmallFixtureImport(db);
      const before = getTaxInputGeneration(db);
      await commitSmallFixtureImport(db); // all rows dedupe on source_key
      expect(getTaxInputGeneration(db)).toBe(before);
    });

    it("import undo bumps the generation", async () => {
      const result = await commitSmallFixtureImport(db);
      const before = getTaxInputGeneration(db);
      undoImport(db, result.batchId);
      expect(getTaxInputGeneration(db)).toBe(before + 1);
    });
  });

  describe("donation links", () => {
    beforeEach(() => {
      seedSecurity(db, 1, "AAPL", "Stock", 1);
      seedDonation(db, { id: 1, securityId: 1, quantity: 10, fmvUsd: 1000 });
      seedTxn(db, { id: 101, accountId: 1, securityId: 1, tradeDate: "2026-01-10", type: "TRANSFER_OUT", quantity: 10 });
    });

    it("linking a donation's OUT leg bumps the generation", () => {
      const before = getTaxInputGeneration(db);
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101 });
      expect(getTaxInputGeneration(db)).toBe(before + 1);
    });

    it("unlinking a donation's legs bumps the generation", () => {
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101 });
      const before = getTaxInputGeneration(db);
      unlinkDonationLegs(db, 1);
      expect(getTaxInputGeneration(db)).toBe(before + 1);
    });

    it("assigning donation lots bumps the generation", () => {
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101 });
      seedTxn(db, { id: 201, accountId: 1, securityId: 1, tradeDate: "2026-01-02", type: "BUY", quantity: 10 });
      seedTaxLot(db, {
        id: 301,
        accountId: 1,
        securityId: 1,
        acquisitionTxnId: 201,
        acquisitionDate: "2026-01-02",
        quantityAcquired: 10,
        quantityRemaining: 10,
        costBasis: 1500,
      });
      const before = getTaxInputGeneration(db);
      assignDonationLots(db, 1, [{ acquisitionTransactionId: 201, quantity: 5 }]);
      expect(getTaxInputGeneration(db)).toBe(before + 1);
    });

    it("reversing a donation bumps the generation", () => {
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101 });
      const before = getTaxInputGeneration(db);
      markDonationReversed(db, 1, "2026-02-01");
      expect(getTaxInputGeneration(db)).toBe(before + 1);
    });
  });

  describe("security identity changes (upsertSecurity)", () => {
    it("changing multiplier on an existing security WITH tax lots bumps the generation", () => {
      seedSecurity(db, 1, "ZZZ", "Stock", 1);
      seedTxn(db, { id: 201, accountId: 1, securityId: 1, tradeDate: "2026-01-02", type: "BUY", quantity: 10 });
      seedTaxLot(db, {
        id: 301,
        accountId: 1,
        securityId: 1,
        acquisitionTxnId: 201,
        acquisitionDate: "2026-01-02",
        quantityAcquired: 10,
        quantityRemaining: 10,
        costBasis: 1500,
      });

      const before = getTaxInputGeneration(db);
      upsertSecurity(db, { symbol: "ZZZ", securityType: "Stock", multiplier: 5 });
      expect(getTaxInputGeneration(db)).toBe(before + 1);
    });

    it("a no-change upsert (same multiplier/type) does NOT bump", () => {
      seedSecurity(db, 1, "ZZZ", "Stock", 5);
      seedTxn(db, { id: 201, accountId: 1, securityId: 1, tradeDate: "2026-01-02", type: "BUY", quantity: 10 });
      seedTaxLot(db, {
        id: 301,
        accountId: 1,
        securityId: 1,
        acquisitionTxnId: 201,
        acquisitionDate: "2026-01-02",
        quantityAcquired: 10,
        quantityRemaining: 10,
        costBasis: 1500,
      });

      const before = getTaxInputGeneration(db);
      upsertSecurity(db, { symbol: "ZZZ", securityType: "Stock", multiplier: 5 }); // identical values
      expect(getTaxInputGeneration(db)).toBe(before);
    });

    it("changing multiplier on a security with NO tax lots does NOT bump", () => {
      seedSecurity(db, 1, "YYY", "Stock", 1);
      // No tax_lots row for security 1 — the gate requires an existing lot.

      const before = getTaxInputGeneration(db);
      upsertSecurity(db, { symbol: "YYY", securityType: "Stock", multiplier: 5 });
      expect(getTaxInputGeneration(db)).toBe(before);
    });

    it("a fresh insert (no existing row) never bumps", () => {
      const before = getTaxInputGeneration(db);
      upsertSecurity(db, { symbol: "BRAND-NEW", securityType: "Stock" });
      expect(getTaxInputGeneration(db)).toBe(before);
    });
  });
});

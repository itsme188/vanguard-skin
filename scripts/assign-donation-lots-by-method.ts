/**
 * One-off repair: derive donation lot assignments from the account's disposal
 * method — the user's records don't identify per-gift lots, but the rules do
 * (user statement, 2026-08-18): FIFO for donations before 2025-01-01,
 * Vanguard MinTax from 2025 onward.
 *
 * MinTax order (Vanguard's published hierarchy, verified 2026-08-18; each
 * bucket exhausted before the next; Vanguard applies the SAME order to
 * gifts — "MinTax does not prioritize appreciated shares when gifting"):
 *   1. Short-term loss, largest to smallest
 *   2. Long-term loss, largest to smallest
 *   3. Short-term zero gain/loss
 *   4. Long-term zero gain/loss
 *   5. Long-term gain, smallest to largest
 *   6. Short-term gain, smallest to largest
 * Within-bucket magnitude = the lot's TOTAL unrealized dollar gain/loss
 * (gainPerShare x remaining as of the donation date); ties break by
 * acquisition date then id for determinism. Gain/loss is measured at the
 * donation's own DAF FMV per share — identical to the app's lot drawer.
 *
 * Scope: confirmed (out-linked), unreversed stock donations with ZERO
 * existing donation_lots rows (idempotent — assigned donations are skipped).
 * Lots come from getOpenLotsForDonation (the drawer's query); writes go
 * through assignDonationLots + one recomputeAfterDonationMutation (the
 * drawer route's exact path), so every engine invariant applies.
 *
 * Known divergence, flagged per donation in the output: lot inventory is the
 * engine's FIFO sell-replay. A post-2025 sell of the same security BEFORE
 * the donation date really consumed lots MinTax-style at Vanguard, so the
 * engine's remaining lots may differ (as of 2026-08-18 this affects only
 * the 2026-06-22 VTI donation — three 2026 VTI sells precede it).
 *
 * Usage:
 *   npx tsx scripts/assign-donation-lots-by-method.ts           # dry-run (default)
 *   npx tsx scripts/assign-donation-lots-by-method.ts --apply   # write
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getOpenLotsForDonation, DonationLotsQueryError, type OpenLotForDonation } from "@/lib/queries/giving-view";
import { assignDonationLots, DonationLinkError } from "@/lib/mutations/donation-links";
import { recomputeAfterDonationMutation } from "@/lib/compute/donation-recompute";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");
const MINTAX_FROM = "2025-01-01"; // donations on/after this date use MinTax
const ZERO_EPS = 0.005; // |gain per share| below half a cent counts as Vanguard's "zero gain or loss"

export type DisposalMethod = "fifo" | "mintax";

export interface LotPick {
  acquisitionTransactionId: number;
  acquisitionDate: string;
  quantity: number;
  costPerShare: number;
  gainPerShare: number | null;
  isLongTerm: boolean;
}

export interface SelectionResult {
  picks: LotPick[];
  /** Unfilled quantity when open lots can't cover the donation. */
  shortfall: number;
}

function toPick(lot: OpenLotForDonation, quantity: number): LotPick {
  return {
    acquisitionTransactionId: lot.acquisitionTransactionId,
    acquisitionDate: lot.acquisitionDate,
    quantity,
    costPerShare: lot.quantityAcquired !== 0 ? lot.costBasis / lot.quantityAcquired : 0,
    gainPerShare: lot.gainPerShare,
    isLongTerm: lot.isLongTerm,
  };
}

function consume(ordered: OpenLotForDonation[], quantity: number): SelectionResult {
  const picks: LotPick[] = [];
  let needed = quantity;
  for (const lot of ordered) {
    if (needed <= 1e-9) break;
    if (lot.remainingAsOfDonationDate <= 0) continue;
    const take = Math.min(lot.remainingAsOfDonationDate, needed);
    picks.push(toPick(lot, take));
    needed -= take;
  }
  return { picks, shortfall: needed > 1e-9 ? needed : 0 };
}

export function selectLotsFifo(lots: OpenLotForDonation[], quantity: number): SelectionResult {
  const ordered = [...lots].sort(
    (a, b) =>
      a.acquisitionDate.localeCompare(b.acquisitionDate) || a.acquisitionTransactionId - b.acquisitionTransactionId
  );
  return consume(ordered, quantity);
}

/**
 * Bucket index per Vanguard's MinTax hierarchy (lower = consumed first).
 * Returns null when the lot's gain is unknowable (no FMV) — the caller must
 * treat the whole donation as unrankable rather than guess.
 */
export function mintaxBucket(lot: OpenLotForDonation): number | null {
  if (lot.gainPerShare == null) return null;
  const g = lot.gainPerShare;
  if (Math.abs(g) < ZERO_EPS) return lot.isLongTerm ? 3 : 2; // ST zero (2) before LT zero (3)
  if (g < 0) return lot.isLongTerm ? 1 : 0; // ST loss (0) before LT loss (1)
  return lot.isLongTerm ? 4 : 5; // LT gain (4) before ST gain (5)
}

export function selectLotsMinTax(lots: OpenLotForDonation[], quantity: number): SelectionResult | { unrankable: true } {
  if (lots.some((l) => l.remainingAsOfDonationDate > 0 && l.gainPerShare == null)) {
    return { unrankable: true };
  }
  const totalGain = (l: OpenLotForDonation) => (l.gainPerShare ?? 0) * l.remainingAsOfDonationDate;
  const ordered = [...lots].sort((a, b) => {
    const bucketA = mintaxBucket(a) ?? Number.MAX_SAFE_INTEGER;
    const bucketB = mintaxBucket(b) ?? Number.MAX_SAFE_INTEGER;
    if (bucketA !== bucketB) return bucketA - bucketB;
    // Losses (buckets 0-1): largest loss first = most negative total first.
    // Gains (buckets 4-5): smallest total gain first. Zero buckets: date order.
    const magnitude =
      bucketA <= 1 ? totalGain(a) - totalGain(b) : bucketA >= 4 ? totalGain(a) - totalGain(b) : 0;
    if (magnitude !== 0) return magnitude;
    return a.acquisitionDate.localeCompare(b.acquisitionDate) || a.acquisitionTransactionId - b.acquisitionTransactionId;
  });
  return consume(ordered, quantity);
}

// ─── Main ──────────────────────────────────────────────────────────────

interface DonationTarget {
  id: number;
  symbol: string;
  quantity: number;
  out_date: string;
}

/**
 * The script's whole work, importable (used by scripts/finish-donations.ts):
 * plan (and with apply=true, write + recompute) lot assignments for every
 * confirmed, unreversed, lot-less stock donation. Returns counts for the
 * caller's summary. Takes a VACUUM INTO backup itself before writing.
 */
export function runAssignment(db: Database.Database, apply: boolean): { planned: number; assigned: number; problems: number } {
  const targets = db
    .prepare(
      `SELECT d.id, COALESCE(s.symbol, d.symbol_raw) AS symbol, d.quantity, t.trade_date AS out_date
       FROM donations d
       JOIN donation_leg_links l ON l.donation_id = d.id AND l.role = 'out'
       JOIN transactions t ON t.id = l.transaction_id
       LEFT JOIN securities s ON s.id = d.security_id
       WHERE d.kind = 'stock' AND d.reversed_date IS NULL AND d.security_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM donation_lots dl WHERE dl.donation_id = d.id)
       ORDER BY t.trade_date, d.id`
    )
    .all() as DonationTarget[];

  const skippedUnconfirmed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM donations d
       WHERE d.kind = 'stock' AND d.reversed_date IS NULL
         AND NOT EXISTS (SELECT 1 FROM donation_leg_links l WHERE l.donation_id = d.id AND l.role = 'out')`
    )
    .get() as { n: number };

  const plans: { donation: DonationTarget; method: DisposalMethod; picks: LotPick[] }[] = [];
  const problems: string[] = [];

  const sellsBeforeStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM transactions t
     JOIN donations d ON d.id = ?
     WHERE t.account_id = (SELECT t2.account_id FROM donation_leg_links l2 JOIN transactions t2 ON t2.id = l2.transaction_id WHERE l2.donation_id = d.id AND l2.role = 'out')
       AND t.security_id = d.security_id AND t.type = 'SELL'
       AND t.trade_date >= '2025-01-01' AND t.trade_date < ?`
  );

  for (const donation of targets) {
    const method: DisposalMethod = donation.out_date >= MINTAX_FROM ? "mintax" : "fifo";
    let lots: OpenLotForDonation[];
    try {
      lots = getOpenLotsForDonation(db, donation.id);
    } catch (err) {
      if (err instanceof DonationLotsQueryError) {
        problems.push(`donation ${donation.id} (${donation.symbol}): ${err.message}`);
        continue;
      }
      throw err;
    }

    const result = method === "fifo" ? selectLotsFifo(lots, donation.quantity) : selectLotsMinTax(lots, donation.quantity);
    if ("unrankable" in result) {
      problems.push(`donation ${donation.id} (${donation.symbol}): MinTax needs gain-per-share but FMV is missing — not assigned`);
      continue;
    }
    if (result.shortfall > 0) {
      problems.push(
        `donation ${donation.id} (${donation.symbol} ${donation.quantity} on ${donation.out_date}): open lots cover only ${(donation.quantity - result.shortfall).toFixed(3)} of ${donation.quantity} — not assigned, needs manual review`
      );
      continue;
    }

    const divergentSells = (sellsBeforeStmt.get(donation.id, donation.out_date) as { n: number }).n;
    plans.push({ donation, method, picks: result.picks });

    console.log(
      `\ndonation ${donation.id} — ${donation.symbol} ${donation.quantity} sh on ${donation.out_date} [${method.toUpperCase()}]` +
        (divergentSells > 0
          ? `  ⚠ ${divergentSells} post-2025 sell(s) of ${donation.symbol} precede this gift — engine lot inventory may differ from Vanguard's (FIFO vs MinTax sell replay)`
          : "")
    );
    for (const p of result.picks) {
      console.log(
        `  lot acquired ${p.acquisitionDate}: take ${p.quantity} sh @ cost ${p.costPerShare.toFixed(2)}/sh` +
          (p.gainPerShare != null ? `, gain ${p.gainPerShare >= 0 ? "+" : ""}${p.gainPerShare.toFixed(2)}/sh` : "") +
          ` (${p.isLongTerm ? "LT" : "ST"})`
      );
    }
  }

  if (skippedUnconfirmed.n > 0) {
    problems.push(`${skippedUnconfirmed.n} stock donation(s) have no confirmed out link yet — confirm in Analysis › Giving, then re-run`);
  }

  console.log(`\n── Problems / skipped (report only) — ${problems.length} ──`);
  for (const p of problems) console.log(`  ${p}`);

  if (!apply) {
    console.log(`\nDry-run (default). Re-run with --apply to assign lots for ${plans.length} donation(s).`);
    return { planned: plans.length, assigned: 0, problems: problems.length };
  }
  if (plans.length === 0) {
    console.log(`\nNothing to assign.`);
    return { planned: 0, assigned: 0, problems: problems.length };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-donation-lot-assignment-${timestamp}.db`);
  db.prepare(`VACUUM INTO ?`).run(backupPath);
  console.log(`\nBackup: ${backupPath}`);

  let assigned = 0;
  for (const plan of plans) {
    try {
      assignDonationLots(
        db,
        plan.donation.id,
        plan.picks.map((p) => ({ acquisitionTransactionId: p.acquisitionTransactionId, quantity: p.quantity }))
      );
      assigned++;
    } catch (err) {
      if (err instanceof DonationLinkError) {
        console.log(`  REJECTED donation ${plan.donation.id}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  const recompute = recomputeAfterDonationMutation(db);
  console.log(`\nAssigned ${assigned} of ${plans.length} donation(s); recompute: ${JSON.stringify(recompute)}`);
  return { planned: plans.length, assigned, problems: problems.length };
}

function main() {
  const apply = process.argv.includes("--apply");
  const db = new Database(DB_PATH, { timeout: 60000 });
  db.pragma("foreign_keys = ON");
  runAssignment(db, apply);
  db.close();
}

const isDirectRun = process.argv[1]?.includes("assign-donation-lots-by-method");
if (isDirectRun) main();

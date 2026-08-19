/**
 * One-off repair: reassign the two replay-CLAMPED XMTR donations (17, 16).
 *
 * What happened (2026-08-19): the batch assigner built all its lot plans
 * up front, so donations 19 (05-13), 17 (06-22), and 16 (06-25) each
 * independently ranked the same 100-share 2025-03-11 lot (txn 10091) first
 * under MinTax (smallest total LT gain). Donation 19's write took all 100;
 * 17 and 16 were accepted under the sanctioned between-recomputes window and
 * then CLAMPED to zero consumption by the chronological replay ("donation
 * 17/16: lot from txn 10091 has 0 < assigned 50 — clamped"). The XMTR
 * ledger itself is complete (750 bought = 350 donated + 400 held).
 *
 * Fix: re-derive each donation's MinTax picks from the CURRENT drawer state
 * (getOpenLotsForDonation subtracts sibling donations' earlier-dated claims
 * directly from donation_lots), in chronological order so 16 sees 17's new
 * claim, and rewrite via assignDonationLots (replace semantics). One
 * recompute at the end; the replay must emit NO warnings for these ids.
 *
 * Usage:
 *   npx tsx scripts/reassign-clamped-donations.ts           # dry-run (default)
 *   npx tsx scripts/reassign-clamped-donations.ts --apply   # write
 */

import path from "node:path";
import Database from "better-sqlite3";
import { getOpenLotsForDonation } from "@/lib/queries/giving-view";
import { assignDonationLots } from "@/lib/mutations/donation-links";
import { recomputeAfterDonationMutation } from "@/lib/compute/donation-recompute";
import { selectLotsMinTax } from "./assign-donation-lots-by-method";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");
const DONATION_IDS = [17, 16]; // chronological: 06-22 before 06-25

function main() {
  const apply = process.argv.includes("--apply");
  const db = new Database(DB_PATH, { timeout: 60000 });
  db.pragma("foreign_keys = ON");

  for (const id of DONATION_IDS) {
    const donation = db
      .prepare("SELECT id, quantity, symbol_raw FROM donations WHERE id = ?")
      .get(id) as { id: number; quantity: number; symbol_raw: string } | undefined;
    if (!donation) {
      console.log(`donation ${id}: not found — skipping`);
      continue;
    }

    const lots = getOpenLotsForDonation(db, id);
    const result = selectLotsMinTax(lots, donation.quantity);
    if ("unrankable" in result || result.shortfall > 0) {
      console.log(`donation ${id}: cannot derive a full assignment — manual review needed`);
      continue;
    }

    console.log(`\ndonation ${id} (${donation.symbol_raw} ${donation.quantity}) — new MinTax picks:`);
    for (const p of result.picks) {
      console.log(
        `  lot acquired ${p.acquisitionDate}: take ${p.quantity} sh @ cost ${p.costPerShare.toFixed(2)}/sh` +
          (p.gainPerShare != null ? `, gain ${p.gainPerShare >= 0 ? "+" : ""}${p.gainPerShare.toFixed(2)}/sh` : "") +
          ` (${p.isLongTerm ? "LT" : "ST"})`
      );
    }

    if (apply) {
      assignDonationLots(
        db,
        id,
        result.picks.map((p) => ({ acquisitionTransactionId: p.acquisitionTransactionId, quantity: p.quantity }))
      );
      console.log(`  reassigned.`);
    }
  }

  if (apply) {
    const recompute = recomputeAfterDonationMutation(db);
    console.log(`\nRecompute: ${JSON.stringify(recompute)}`);
    const bad = (recompute.replayWarnings ?? []).filter((w) => /donation (16|17):/.test(w));
    console.log(bad.length === 0 ? `No clamp warnings for donations 17/16 — clean. ✅` : `STILL CLAMPED: ${bad.join("; ")}`);
  } else {
    console.log(`\nDry-run (default). Re-run with --apply to rewrite both assignments + recompute.`);
  }
  db.close();
}

main();

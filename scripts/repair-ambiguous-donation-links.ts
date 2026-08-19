/**
 * One-off repair: link the four AMBIGUOUS donations to their real delivery
 * legs, stamping FMV in the same stroke (linkDonationLegs amountForOutLeg).
 *
 * Why these mappings are safe (analysis 2026-08-18, user-reviewed): Vanguard
 * books a DAF gift as a lone TRANSFER_OUT on the DAF's received date, then a
 * zero-netting OUT+IN "completion rebooking" journal pair ~1 day later. The
 * reconciler can't rank same-security/same-quantity legs inside its date
 * window, but the structural rule (unpaired OUT on the received date = the
 * delivery) resolves each case uniquely:
 *   donation  6 — UBER 100 received 2024-02-15 -> leg  9209 (02-15; 02-16 pair = noise)
 *   donation 10 — SMH   35 received 2025-04-10 -> leg 10200 (04-10; 04-11 pair = noise)
 *   donation 17 — XMTR  50 received 2026-06-22 -> leg 22562 (06-22; the OTHER 06-22
 *                 OUT 22564 zero-nets against IN 22561, both already journal-stamped)
 *   donation 16 — XMTR  50 received 2026-06-25 -> leg 22583 (06-25; DAF still holds
 *                 these shares — no completed_date is expected, status stays "received")
 * The leftover noise pairs net to zero in every flow reader and stay
 * unlinked by design ("rebooking noise" — spec §7 inverse checks).
 *
 * Usage:
 *   npx tsx scripts/repair-ambiguous-donation-links.ts           # dry-run (default)
 *   npx tsx scripts/repair-ambiguous-donation-links.ts --apply   # write
 */

import path from "node:path";
import Database from "better-sqlite3";
import { linkDonationLegs, DonationLinkError } from "@/lib/mutations/donation-links";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

const MAPPINGS: { donationId: number; legId: number }[] = [
  { donationId: 6, legId: 9209 },
  { donationId: 10, legId: 10200 },
  { donationId: 17, legId: 22562 },
  { donationId: 16, legId: 22583 },
];

function main() {
  const apply = process.argv.includes("--apply");
  const db = new Database(DB_PATH, { timeout: 60000 });
  db.pragma("foreign_keys = ON");

  const donationStmt = db.prepare(
    `SELECT d.id, d.quantity, d.fmv_usd, d.received_date, COALESCE(s.symbol, d.symbol_raw) AS symbol,
            d.security_id,
            (SELECT COUNT(*) FROM donation_leg_links l WHERE l.donation_id = d.id AND l.role = 'out') AS linked
     FROM donations d LEFT JOIN securities s ON s.id = d.security_id WHERE d.id = ?`
  );
  const legStmt = db.prepare(
    `SELECT t.id, t.trade_date, t.type, t.quantity, t.amount, t.security_id,
            (SELECT COUNT(*) FROM donation_leg_links l WHERE l.transaction_id = t.id) AS linked
     FROM transactions t WHERE t.id = ?`
  );

  const writable: { donationId: number; legId: number; fmv: number; label: string }[] = [];
  const problems: string[] = [];

  for (const m of MAPPINGS) {
    const d = donationStmt.get(m.donationId) as
      | { id: number; quantity: number; fmv_usd: number; received_date: string; symbol: string; security_id: number | null; linked: number }
      | undefined;
    const leg = legStmt.get(m.legId) as
      | { id: number; trade_date: string; type: string; quantity: number; amount: number | null; security_id: number | null; linked: number }
      | undefined;

    if (!d) { problems.push(`donation ${m.donationId}: not found`); continue; }
    if (!leg) { problems.push(`leg ${m.legId}: not found`); continue; }
    if (d.linked > 0) { problems.push(`donation ${d.id} (${d.symbol}): already linked — nothing to do`); continue; }
    if (leg.linked > 0) { problems.push(`leg ${leg.id}: already linked to another donation — needs manual review`); continue; }
    if (leg.type !== "TRANSFER_OUT") { problems.push(`leg ${leg.id}: type ${leg.type}, expected TRANSFER_OUT`); continue; }
    if (d.security_id == null || leg.security_id !== d.security_id) {
      problems.push(`donation ${d.id} / leg ${leg.id}: security mismatch`); continue;
    }
    if (Math.abs(leg.quantity - d.quantity) > 1e-9) {
      problems.push(`donation ${d.id} / leg ${leg.id}: quantity ${leg.quantity} != donation ${d.quantity}`); continue;
    }
    if (leg.trade_date !== d.received_date) {
      problems.push(`donation ${d.id} / leg ${leg.id}: leg date ${leg.trade_date} != received ${d.received_date} — mapping stale, review`);
      continue;
    }

    writable.push({
      donationId: d.id,
      legId: leg.id,
      fmv: d.fmv_usd,
      label: `donation ${d.id} (${d.symbol} ${d.quantity} received ${d.received_date}) -> leg ${leg.id}, stamp amount ${d.fmv_usd.toFixed(2)} (DAF fmv_usd)`,
    });
  }

  console.log(`\n── Link + stamp (role 'out', amountForOutLeg) — ${writable.length} ──`);
  for (const w of writable) console.log(`  ${w.label}`);
  console.log(`\n── Problems / skipped — ${problems.length} ──`);
  for (const p of problems) console.log(`  ${p}`);

  if (!apply) {
    console.log(`\nDry-run (default). Re-run with --apply to link ${writable.length} donation(s).`);
    db.close();
    return;
  }

  let applied = 0;
  for (const w of writable) {
    try {
      linkDonationLegs(db, {
        donationId: w.donationId,
        outTransactionId: w.legId,
        artifactTransactionId: null,
        amountForOutLeg: w.fmv,
      });
      applied++;
    } catch (err) {
      if (err instanceof DonationLinkError) {
        console.log(`  REJECTED donation ${w.donationId}: ${err.message}`);
      } else {
        throw err;
      }
    }
  }
  console.log(`\nLinked ${applied} of ${writable.length}.`);
  db.close();
}

main();

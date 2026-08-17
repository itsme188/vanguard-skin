/**
 * repair-inkind-transfer-fmv.ts — Stamp real transfer-date FMV `amount`s onto
 * historical in-kind TRANSFER_IN/TRANSFER_OUT legs, and confirm the
 * "pair-donation" shape (a same-day zero-netting TRANSFER_OUT + TRANSFER_IN
 * of the same security/quantity) as a linked DAF stock donation.
 *
 * Root cause (donation-tracking design, 2026-08-17, spec §6): before this
 * build, in-kind transfer legs were transcribed with `amount = 0` — the
 * security moved, but no dollar value was ever recorded against the leg.
 * Every flow-consuming reader (risk metrics' flow-adjusted index, TWR,
 * XIRR, period attribution) reads `is_external_flow = 1` transaction rows to
 * know a portfolio-value change was a deposit/withdrawal/donation rather
 * than a market move. A $0 in-kind leg is invisible to that math: the
 * security's real value still leaves daily_valuations.holdings_value (the
 * `holdings` table genuinely drops between statement snapshots), but no
 * offsetting flow exists to explain it — so the drop reads as a fake
 * single-day market loss, inflating volatility, faking a drawdown, and
 * (via the alpha/beta decomposition) charging the loss to "alpha" instead
 * of recognizing it as a flow. The new convention (spec §6, enforced going
 * forward at import) stores the transfer-date FMV as a positive magnitude
 * in `amount`; this script backfills that convention onto EXISTING rows.
 *
 * Four candidate classes (spec §8), printed in separate sections:
 *
 * 1. pair-donation (WRITABLE, the main move) — a reconciliation suggestion
 *    (lib/compute/donation-reconciliation.ts::reconcileDonations) carrying
 *    BOTH a TRANSFER_OUT and its same-day zero-netting TRANSFER_IN
 *    "routing artifact" leg, matched to a DAF donation. Gated on
 *    `holdingsDeltaConfirms`: the containing statement month's `holdings`
 *    rows for (account, security) must show the position actually dropping
 *    by at least the donation quantity across the month boundary — this is
 *    the real-world evidence that shares genuinely left, as opposed to a
 *    same-day re-registration artifact that never really moved anything.
 *    Unconfirmed (or no holdings rows on either boundary) -> anomaly,
 *    never applied. When confirmed: `lib/mutations/donation-links.ts`'s
 *    `linkDonationLegs` links the OUT leg (`role='out'`) + the IN leg
 *    (`role='routing_artifact'`, `is_external_flow` demoted to 0 so it never
 *    double-counts as a second flow) + stamps the OUT leg's `amount` — all
 *    in one mutation.
 *
 * 2. fmv-stamp (WRITABLE) — every OTHER unlinked in-kind leg with
 *    `amount = 0` (a single donation-matched OUT leg with no artifact, a
 *    bounced/in-transit attempt leg, an unmatched same-day journal pair, an
 *    ACATS-era leg) gets its `amount` stamped in place via a direct UPDATE.
 *    `source_key` is left untouched — it embeds the (old, zero) amount, and
 *    re-keying would duplicate on a future re-import of the same statement
 *    line. EXCLUDED from this sweep, unconditionally: any leg that also
 *    appears in a `duplicateSuspects` group or as an `ambiguousMatches`
 *    candidate leg (class 4 below) — those legs are only ever reported, even
 *    when they'd otherwise price cleanly. A duplicate/re-import artifact may
 *    need deletion rather than a stamp, and stamping BOTH sibling legs of a
 *    duplicate pair would double-count that date's flow in every downstream
 *    metric — precisely the distortion this script exists to fix. Same
 *    reasoning for an ambiguous donation match: which leg is the real one
 *    is exactly what's undecided.
 *
 * 3. legs-missing (REPORT ONLY) — a DAF stock donation with no candidate
 *    legs at all. Never inserted: the script does not synthesize a
 *    transaction row a broker document doesn't evidence. Empty today by
 *    design (see spec §8.3).
 *
 * 4. anomaly (REPORT ONLY) — ambiguous donation matches, duplicate-suspect
 *    leg groups, and unpriceable/un-confirmable legs (see valuation
 *    precedence below). Duplicate-suspect and ambiguous-match legs require
 *    MANUAL resolution (delete the re-import artifact, or determine which
 *    candidate leg is the real donation) — they are never auto-written by
 *    this script, no matter how cleanly they'd otherwise price.
 *
 * Valuation precedence (applies to both writable classes) — ALWAYS at the
 * LEG's own trade date, never a different date's value:
 *   - Leg trade_date equals a matched donation's received_date AND the
 *     quantities match exactly -> the donation's `fmv_usd` (authoritative,
 *     same-day, no price lookup needed).
 *   - Otherwise: an EXACT-leg-date `prices` row (no as-of staleness walk —
 *     a fallback that fudges the date would inject a fabricated cross-gap
 *     return), on a USD-denominated security only, valued through
 *     `lib/valuation.ts::marketValue(qty, close, security_type, multiplier,
 *     1)` — never bare `price * qty` (misvalues bonds and options).
 *   - A pending SPLIT/REVERSE_SPLIT (`corporate_actions.effective_date >=
 *     legDate`) makes the stored price series' share basis ambiguous for
 *     that date -> anomaly, never priced through it.
 *   - No exact-date price row, or a non-USD security -> anomaly.
 *
 * Dry-run by default: prints every candidate, grouped by class, with the
 * exact proposed change. Writes nothing unless --apply is passed.
 *
 * --apply: backs up data/vanguard.db to data/backups/ (VACUUM INTO,
 * refuse-on-empty — same convention as scripts/repair-etf-types.ts /
 * scripts/repair-missing-external-flows.ts), then inside ONE transaction
 * applies every pair-donation and fmv-stamp candidate. Afterward triggers
 * `computeTaxLots` + `computeDailyValuations` (a donation consumes lots and
 * the holdings-delta evidence never changes daily_valuations shape, but the
 * newly-linked donation may now be eligible for lot assignment downstream)
 * and prints how many additional flow-dates `fetchNetFlowsByDate` finds
 * over the whole transaction history (before vs after) — the concrete
 * signal that the fake-loss days are now explained.
 *
 * Idempotent: after --apply, a second run finds zero pair-donation/fmv-stamp
 * candidates — linked donations no longer appear in
 * reconcileDonations().suggestedMatches (their donation now has a confirmed
 * `out` link), and stamped legs no longer satisfy `amount = 0`.
 *
 * Usage:
 *   npx tsx scripts/repair-inkind-transfer-fmv.ts            # dry-run (default)
 *   npx tsx scripts/repair-inkind-transfer-fmv.ts --apply     # write every candidate
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { marketValue } from "@/lib/valuation";
import { reconcileDonations } from "@/lib/compute/donation-reconciliation";
import { linkDonationLegs, DonationLinkError } from "@/lib/mutations/donation-links";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { fetchNetFlowsByDate } from "@/lib/compute/flow-adjusted";
import type { DonationRow } from "@/lib/queries/donations";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");
const EPS = 1e-9;

// ─── Types (pure, exported for tests) ──────────────────────────────────

export type InkindCandidateClass = "pair-donation" | "fmv-stamp" | "legs-missing" | "anomaly";

export interface InkindCandidate {
  cls: InkindCandidateClass;
  legId?: number;
  donationId?: number;
  artifactLegId?: number;
  /** Present only on writable classes (pair-donation, fmv-stamp). */
  proposedAmount?: number;
  /** One printable line explaining the classification/valuation. */
  reason: string;
}

// ─── Valuation precedence (shared by both writable classes) ───────────

interface LegValuationInput {
  securityId: number;
  legDate: string;
  quantity: number;
}

interface DonationMatchForValuation {
  receivedDate: string;
  quantity: number;
  fmvUsd: number;
}

type ValuationResult = { ok: true; amount: number; reason: string } | { ok: false; reason: string };

/**
 * Valuation precedence (spec §8.2): same-day exact donation match -> fmv_usd;
 * otherwise exact-leg-date `prices` row via marketValue(), guarded by a USD
 * check and a split-basis check. Exported for direct unit coverage of the
 * precedence/guard rules independent of the candidate builder.
 */
export function valuationForLeg(
  db: Database.Database,
  leg: LegValuationInput,
  donationMatch?: DonationMatchForValuation
): ValuationResult {
  if (
    donationMatch != null &&
    donationMatch.receivedDate === leg.legDate &&
    Math.abs(donationMatch.quantity - leg.quantity) <= EPS
  ) {
    return {
      ok: true,
      amount: donationMatch.fmvUsd,
      reason: `same-day exact match to donation received ${donationMatch.receivedDate} — using fmv_usd ${donationMatch.fmvUsd.toFixed(2)}`,
    };
  }

  const security = db
    .prepare(`SELECT security_type, COALESCE(multiplier, 1) AS multiplier, currency FROM securities WHERE id = ?`)
    .get(leg.securityId) as { security_type: string | null; multiplier: number; currency: string | null } | undefined;
  if (!security) {
    return { ok: false, reason: `security ${leg.securityId} not found` };
  }
  if ((security.currency ?? "USD") !== "USD") {
    return { ok: false, reason: `security ${leg.securityId} is not USD-denominated — leg-date pricing requires a USD security` };
  }

  const split = db
    .prepare(
      `SELECT 1 FROM corporate_actions
       WHERE security_id = ? AND action_type IN ('SPLIT','REVERSE_SPLIT') AND effective_date >= ?
       LIMIT 1`
    )
    .get(leg.securityId, leg.legDate);
  if (split) {
    return {
      ok: false,
      reason: `a SPLIT/REVERSE_SPLIT with effective_date >= ${leg.legDate} makes the stored price series' share basis ambiguous for this leg — skipped`,
    };
  }

  const price = db
    .prepare(`SELECT close_price FROM prices WHERE security_id = ? AND date = ?`)
    .get(leg.securityId, leg.legDate) as { close_price: number } | undefined;
  if (!price) {
    return { ok: false, reason: `no exact-date prices row for ${leg.legDate} — unpriceable` };
  }

  const amount = marketValue(leg.quantity, price.close_price, security.security_type, security.multiplier, 1);
  return {
    ok: true,
    amount,
    reason: `exact-leg-date price ${price.close_price} on ${leg.legDate} via marketValue()`,
  };
}

// ─── Holdings-delta gate for pair-donation ─────────────────────────────

/**
 * True when the containing statement month's `holdings` rows for
 * (accountId, securityId) show the position dropping by at least
 * `quantity` across the month boundary — the last snapshot strictly before
 * the leg's calendar month vs. the first snapshot on/after it. With no
 * holdings row on either boundary the delta is UNCONFIRMED (false) — never
 * guess. This is the real-world evidence that a same-day zero-netting
 * TRANSFER_OUT/TRANSFER_IN pair is a genuine donation (shares actually
 * left) rather than an internal re-registration artifact that never
 * changed the position.
 */
export function holdingsDeltaConfirms(
  db: Database.Database,
  accountId: number,
  securityId: number,
  legDate: string,
  quantity: number
): boolean {
  if (!Number.isFinite(quantity)) return false;
  const monthStart = `${legDate.slice(0, 7)}-01`;

  const before = db
    .prepare(
      `SELECT quantity FROM holdings
       WHERE account_id = ? AND security_id = ? AND as_of_date < ?
       ORDER BY as_of_date DESC LIMIT 1`
    )
    .get(accountId, securityId, monthStart) as { quantity: number } | undefined;
  const after = db
    .prepare(
      `SELECT quantity FROM holdings
       WHERE account_id = ? AND security_id = ? AND as_of_date >= ?
       ORDER BY as_of_date ASC LIMIT 1`
    )
    .get(accountId, securityId, monthStart) as { quantity: number } | undefined;

  if (!before || !after) return false;
  return before.quantity - after.quantity >= quantity - EPS;
}

// ─── Candidate builder (pure, unit-tested) ─────────────────────────────

/**
 * Every unlinked in-kind (TRANSFER_IN/TRANSFER_OUT, security-carrying) leg
 * with `amount = 0` — the raw pool the fmv-stamp sweep draws from, before
 * excluding legs already claimed by the pair-donation class.
 */
function fetchUnlinkedZeroAmountLegs(
  db: Database.Database
): { id: number; account_id: number; security_id: number; trade_date: string; quantity: number }[] {
  return db
    .prepare(
      `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.quantity
       FROM transactions t
       LEFT JOIN donation_leg_links l ON l.transaction_id = t.id
       WHERE t.type IN ('TRANSFER_IN','TRANSFER_OUT')
         AND t.security_id IS NOT NULL
         AND t.quantity IS NOT NULL
         AND COALESCE(t.amount, 0) = 0
         AND l.transaction_id IS NULL
       ORDER BY t.trade_date, t.id`
    )
    .all() as { id: number; account_id: number; security_id: number; trade_date: string; quantity: number }[];
}

/**
 * Builds the full candidate list (all four classes) from the current DB
 * state. Pure/read-only — never writes. See module header for the class
 * rules and valuation precedence.
 */
export function findInkindCandidates(db: Database.Database): InkindCandidate[] {
  const report = reconcileDonations(db);
  const candidates: InkindCandidate[] = [];
  const claimedLegIds = new Set<number>();

  // Single-leg (no artifact) suggested matches — used as the donation
  // reference for the fmv-stamp sweep's same-day-exact precedence check.
  const singleMatchByLegId = new Map<number, DonationRow>();
  for (const m of report.suggestedMatches) {
    if (m.artifactLeg == null) singleMatchByLegId.set(m.outLeg.id, m.donation);
  }

  // Class 1: pair-donation.
  for (const m of report.suggestedMatches) {
    if (m.artifactLeg == null) continue;
    const { donation, outLeg, artifactLeg } = m;
    claimedLegIds.add(outLeg.id);
    claimedLegIds.add(artifactLeg.id);

    if (!holdingsDeltaConfirms(db, outLeg.account_id, outLeg.security_id, outLeg.trade_date, donation.quantity ?? NaN)) {
      candidates.push({
        cls: "anomaly",
        legId: outLeg.id,
        donationId: donation.id,
        artifactLegId: artifactLeg.id,
        reason: `pair-donation for donation ${donation.id}: holdings-delta unconfirmed for (account ${outLeg.account_id}, security ${outLeg.security_id}) across the ${outLeg.trade_date} statement-month boundary — needs manual review, not applied`,
      });
      continue;
    }

    const val = valuationForLeg(
      db,
      { securityId: outLeg.security_id, legDate: outLeg.trade_date, quantity: outLeg.quantity },
      { receivedDate: donation.received_date, quantity: donation.quantity ?? NaN, fmvUsd: donation.fmv_usd }
    );
    if (!val.ok) {
      candidates.push({
        cls: "anomaly",
        legId: outLeg.id,
        donationId: donation.id,
        artifactLegId: artifactLeg.id,
        reason: `pair-donation for donation ${donation.id}: ${val.reason}`,
      });
      continue;
    }

    candidates.push({
      cls: "pair-donation",
      legId: outLeg.id,
      donationId: donation.id,
      artifactLegId: artifactLeg.id,
      proposedAmount: val.amount,
      reason: `pair-donation for donation ${donation.id}: link OUT leg ${outLeg.id} ('out') + artifact leg ${artifactLeg.id} ('routing_artifact', demoted), stamp amount ${val.amount.toFixed(2)} (${val.reason})`,
    });
  }

  // Class 3: legs-missing (report only — never inserted).
  for (const donation of report.legsMissing) {
    candidates.push({
      cls: "legs-missing",
      donationId: donation.id,
      reason: `donation ${donation.id} (received ${donation.received_date}) has no candidate legs at all — import the covering statement, or hand-author the leg via canonical CSV with provenance; never inserted automatically`,
    });
  }

  // Class 4 (report only): ambiguous donation matches + duplicate-suspect leg groups.
  //
  // CRITICAL (reviewer-found, live-reproduced): every leg named by either
  // group below MUST also be added to claimedLegIds before the Class-2 sweep
  // runs. Without this, a leg that the anomaly section itself flags as a
  // probable duplicate/re-import artifact (or an unresolved ambiguous
  // donation match) could ALSO satisfy the Class-2 "unlinked in-kind leg
  // with amount=0" predicate and get a WRITABLE fmv-stamp candidate —
  // --apply would then stamp a real dollar value onto a row that may need
  // deletion, and if both sibling duplicate legs end up flow-carrying with
  // amounts, that date's flow double-counts in every metric (the exact
  // distortion this script exists to fix). These legs stay VISIBLE in the
  // anomaly section — they just can never be written.
  for (const a of report.ambiguousMatches) {
    for (const leg of a.candidateLegs) claimedLegIds.add(leg.id);
    candidates.push({
      cls: "anomaly",
      donationId: a.donation.id,
      reason: `donation ${a.donation.id}: ambiguous — ${a.candidateLegs.length} candidate legs (${a.candidateLegs.map((l) => l.id).join(",")}) — never auto-resolved`,
    });
  }
  for (const group of report.duplicateSuspects) {
    for (const leg of group) claimedLegIds.add(leg.id);
    candidates.push({
      cls: "anomaly",
      legId: group[0].id,
      reason: `duplicate-suspect group sharing (account,date,security,qty,type) with differing amounts: legs ${group.map((l) => l.id).join(",")}`,
    });
  }

  // Class 2: fmv-stamp — every other unlinked in-kind leg with amount = 0.
  for (const leg of fetchUnlinkedZeroAmountLegs(db)) {
    if (claimedLegIds.has(leg.id)) continue;
    const donationMatch = singleMatchByLegId.get(leg.id);
    const val = valuationForLeg(
      db,
      { securityId: leg.security_id, legDate: leg.trade_date, quantity: leg.quantity },
      donationMatch
        ? { receivedDate: donationMatch.received_date, quantity: donationMatch.quantity ?? NaN, fmvUsd: donationMatch.fmv_usd }
        : undefined
    );
    if (!val.ok) {
      candidates.push({ cls: "anomaly", legId: leg.id, reason: `fmv-stamp leg ${leg.id} on ${leg.trade_date}: ${val.reason}` });
      continue;
    }
    candidates.push({
      cls: "fmv-stamp",
      legId: leg.id,
      proposedAmount: val.amount,
      reason: `fmv-stamp leg ${leg.id} on ${leg.trade_date}: stamp amount ${val.amount.toFixed(2)} (${val.reason})`,
    });
  }

  return candidates;
}

// ─── Apply ──────────────────────────────────────────────────────────

/**
 * Applies every writable candidate (pair-donation, fmv-stamp) inside ONE
 * transaction. legs-missing/anomaly candidates are report-only and always
 * count as skipped. A pair-donation candidate that fails linkDonationLegs's
 * own invariant checks (defensive — findInkindCandidates should never
 * produce an invalid one) is skipped rather than aborting the whole batch.
 */
export function applyInkindRepair(
  db: Database.Database,
  candidates: InkindCandidate[]
): { applied: number; skipped: number } {
  let applied = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const c of candidates) {
      if (c.cls === "pair-donation") {
        if (c.donationId == null || c.legId == null || c.artifactLegId == null || c.proposedAmount == null) {
          skipped++;
          continue;
        }
        try {
          linkDonationLegs(db, {
            donationId: c.donationId,
            outTransactionId: c.legId,
            artifactTransactionId: c.artifactLegId,
            amountForOutLeg: c.proposedAmount,
          });
          applied++;
        } catch (err) {
          if (err instanceof DonationLinkError) {
            skipped++;
          } else {
            throw err;
          }
        }
      } else if (c.cls === "fmv-stamp") {
        if (c.legId == null || c.proposedAmount == null) {
          skipped++;
          continue;
        }
        db.prepare(`UPDATE transactions SET amount = ? WHERE id = ?`).run(c.proposedAmount, c.legId);
        applied++;
      } else {
        // legs-missing / anomaly: report only, never applied.
        skipped++;
      }
    }
  });
  run();

  return { applied, skipped };
}

// ─── Backup (mirrors scripts/repair-missing-external-flows.ts::backupDatabase) ─

function backupDatabase(db: Database.Database): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-inkind-fmv-repair-${timestamp}.db`);
  db.prepare("VACUUM INTO ?").run(backupPath);
  const sizeBytes = fs.statSync(backupPath).size;
  if (sizeBytes === 0) {
    throw new Error(
      `backup at ${backupPath} is 0 bytes — aborting, refusing to write without a verified backup`
    );
  }
  return backupPath;
}

// ─── CLI driver ─────────────────────────────────────────────────────

const CLASS_LABELS: Record<InkindCandidateClass, string> = {
  "pair-donation": "Pair-donation confirmations (link + stamp + demote artifact)",
  "fmv-stamp": "FMV stamps (UPDATE amount in place)",
  "legs-missing": "Legs-missing donations (report only — never inserted)",
  anomaly: "Anomalies (report only — ambiguous / unpriceable / unconfirmed)",
};

function printCandidates(candidates: InkindCandidate[]): void {
  const byClass = new Map<InkindCandidateClass, InkindCandidate[]>();
  for (const c of candidates) {
    const list = byClass.get(c.cls) ?? [];
    list.push(c);
    byClass.set(c.cls, list);
  }

  const order: InkindCandidateClass[] = ["pair-donation", "fmv-stamp", "legs-missing", "anomaly"];
  for (const cls of order) {
    const list = byClass.get(cls) ?? [];
    console.log(`\n── ${CLASS_LABELS[cls]} — ${list.length} ──`);
    for (const c of list) console.log(`  ${c.reason}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  const db = new Database(DB_PATH, apply ? {} : { readonly: true });
  db.pragma("foreign_keys = ON");

  try {
    const candidates = findInkindCandidates(db);
    printCandidates(candidates);

    const writable = candidates.filter((c) => c.cls === "pair-donation" || c.cls === "fmv-stamp");

    if (!apply) {
      console.log(
        writable.length > 0
          ? `\nDry-run (default). Re-run with --apply to write ${writable.length} row(s).`
          : `\nDry-run (default). Nothing to write — no writable candidates found.`
      );
      return;
    }

    if (writable.length === 0) {
      console.log("\nNothing to apply — no writable candidates found.");
      return;
    }

    const flowsBefore = fetchNetFlowsByDate(db, undefined, "0000-00-00", "9999-12-31").length;

    const backupPath = backupDatabase(db);
    console.log(`\nBackup written: ${backupPath}`);

    const { applied, skipped } = applyInkindRepair(db, candidates);
    console.log(`\nApplied ${applied} candidate(s), skipped ${skipped} (report-only or invalid).`);

    computeTaxLots(db);
    computeDailyValuations(db);
    console.log("\nRecomputed tax lots and daily valuations.");

    const flowsAfter = fetchNetFlowsByDate(db, undefined, "0000-00-00", "9999-12-31").length;
    console.log(
      `\nFlow-dates gained: ${flowsAfter - flowsBefore} (fetchNetFlowsByDate over full history: ${flowsBefore} -> ${flowsAfter}).`
    );

    console.log(
      "\nAny cached AI narrative built on the old risk/TWR numbers should be force-regenerated."
    );
  } finally {
    db.close();
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-inkind-transfer-fmv.ts") ||
    process.argv[1].endsWith("repair-inkind-transfer-fmv.js"));

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

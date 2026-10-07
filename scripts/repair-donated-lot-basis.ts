/**
 * repair-donated-lot-basis.ts — correct the acquisition date and basis of
 * named DONATED lots, from a figure the owner has transcribed off a statement.
 *
 * Why: the Giving view prices a donated lot from the lot's own acquisition
 * row. An opening-snapshot row with a placeholder date and a near-zero basis
 * publishes almost the whole fair market value as "gain avoided". The view
 * now flags such a row ("basis implausible, verify") and leaves it out of the
 * year total; this script is the one-time data fix behind the flag, run by
 * the owner once the true acquisition date and basis are known (owner ruling
 * 2026-10-06).
 *
 * What it does (dry run by default; `--apply` writes, all-or-nothing, one
 * transaction):
 *   - a lot IS its acquisition transaction (`tax_lots` is rebuilt from the
 *     `transactions` table on every recompute), so the correction is an
 *     UPDATE of that one transaction: trade date, per-share price and amount
 *     (shares × basis per share, keeping the row's existing sign). The row's
 *     id does not change, so every lot assignment that points at it stays
 *     valid;
 *   - a row keyed by the canonical-file source key gets the key the corrected
 *     row would have had, so re-importing the corrected file is a no-op;
 *     any other source key is left alone;
 *   - bumps the tax input generation. The lots are stale until the owner runs
 *     the recompute — this script never recomputes.
 *
 * It changes ONLY the transactions the config names, never deletes a row, and
 * refuses the whole config (writing nothing) when any named lot:
 *   - is missing, or is not the account/symbol the config names;
 *   - is not in the state the config describes (`currentAcquisitionDate`);
 *   - is not a long share acquisition (BUY / REINVESTMENT / TRANSFER_IN) of
 *     plain shares — a short opening, an option or a bond is refused;
 *   - carries fees, or has no share count;
 *   - has no donation drawing on it;
 *   - would move to a date on or after a donation or sale that consumed it,
 *     or across a corporate action on the security;
 *   - needs repair while the stored tax-lot ledger is waiting on a
 *     recompute (the sale checks read that ledger; recompute first);
 *   - already had part of it closed by a sale — those sales' realized gain
 *     changes at the next recompute — unless the config row carries
 *     `"acknowledgeSalesAffected": true`;
 *   - sits, before or after the move, on or after the account's first
 *     monthly snapshot — unless the config row carries
 *     `"acknowledgeValuedHistory": true`. Why: from the first snapshot on, a
 *     transaction's date and amount are also inputs to the daily valuation
 *     and return history (cash stepping reads a BUY's amount; the flow
 *     series reads an external-flow transfer's amount on its trade date).
 *     This script rewrites both and rebuilds neither, so past valuation and
 *     return figures would shift on their next recompute. Before the first
 *     snapshot there is no valued history to shift. The lot data written is
 *     correct either way; the override accepts the shift.
 * Re-running after apply reports "already repaired".
 *
 * OUTPUT SHOWS REAL FIGURES (each row's date and basis, before and after) so
 * the owner can see exactly what will change. It is for the terminal only:
 * never paste it into a committed file, a test, a commit message or a PR.
 *
 * Config (gitignored — real figures): data/repair-configs/<name>.json
 *   { "source": "<which statement / page the figures were read from>",
 *     "lots": [ { "account": "<account name>", "symbol": "<symbol>",
 *                 "acquisitionTransactionId": <id>,
 *                 "currentAcquisitionDate": "YYYY-MM-DD",
 *                 "acquisitionDate": "YYYY-MM-DD",
 *                 "basisPerShare": <dollars per share>,
 *                 "acknowledgeSalesAffected": true,     (optional, see above)
 *                 "acknowledgeValuedHistory": true } ] } (optional, see above)
 *
 * Usage (FROM THE REPO ROOT — tsx resolves the `@/` alias off the cwd):
 *   REPAIR_CONFIG_PATH=data/repair-configs/x.json npx tsx scripts/repair-donated-lot-basis.ts
 *   REPAIR_DB_PATH=/tmp/rehearsal.db REPAIR_CONFIG_PATH=… npx tsx scripts/repair-donated-lot-basis.ts --apply
 *   REPAIR_CONFIG_PATH=… npx tsx scripts/repair-donated-lot-basis.ts --apply      # live
 * Always rehearse `--apply` on a copy first, then run the tax-lot recompute.
 */

import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { bumpTaxGenerationIfPresent, isTaxConventionPending } from "../lib/compute/tax-convention";
import { todayET } from "../lib/calendar/date-utils";
import { marketValue } from "../lib/valuation";

export interface DonatedLotBasisTarget {
  account: string;
  symbol: string;
  acquisitionTransactionId: number;
  /** The date the row carries NOW — proves the config names the row it means to. */
  currentAcquisitionDate: string;
  /** The true acquisition date. May equal `currentAcquisitionDate` (basis-only fix). */
  acquisitionDate: string;
  /** True basis in dollars per share. */
  basisPerShare: number;
  /** Required when sales already closed part of the lot: their realized gain will change. */
  acknowledgeSalesAffected?: boolean;
  /** Required when the row sits in the account's valued history: past valuation/return figures will shift. */
  acknowledgeValuedHistory?: boolean;
}

export interface DonatedLotBasisConfig {
  source: string;
  lots: DonatedLotBasisTarget[];
}

export interface DonatedLotPlan {
  transactionId: number;
  status: "repair" | "already-repaired" | "refused";
  reason?: string;
  dateChanges: boolean;
  basisChanges: boolean;
  sourceKeyChanges: boolean;
  /** Donations with a lot assignment on this transaction. */
  donationsAssigned: number;
  /** Sale rows that closed part of this lot; their realized gain changes at the next recompute. */
  salesAffected: number;
  /** Shares on the row, for the before/after print. */
  quantity?: number;
  /** The row as planned against, and what to write. Internal to apply. */
  expected?: { tradeDate: string; price: number | null; amount: number | null; sourceKey: string | null };
  write?: { tradeDate: string; price: number; amount: number; sourceKey: string | null };
}

export interface DonatedLotBasisPlan {
  /** False when any lot is refused — nothing may be applied. */
  ok: boolean;
  source: string;
  lots: DonatedLotPlan[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LONG_SHARE_ACQUISITIONS = new Set(["buy", "reinvestment", "transfer_in"]);

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cents(n: number): number {
  return Math.round(n * 100);
}

export function validateConfig(raw: unknown): DonatedLotBasisConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be an object");
  const c = raw as Record<string, unknown>;
  if (typeof c.source !== "string" || !c.source.trim()) throw new Error("config.source required");
  if (!Array.isArray(c.lots) || c.lots.length === 0) throw new Error("config.lots must be a non-empty array");
  const seen = new Set<number>();
  const lots = c.lots.map((l, i) => {
    if (l == null || typeof l !== "object") throw new Error(`lots[${i}] must be an object`);
    const x = l as Record<string, unknown>;
    if (typeof x.account !== "string" || !x.account.trim()) throw new Error(`lots[${i}].account required`);
    if (typeof x.symbol !== "string" || !x.symbol.trim()) throw new Error(`lots[${i}].symbol required`);
    if (
      typeof x.acquisitionTransactionId !== "number" ||
      !Number.isInteger(x.acquisitionTransactionId) ||
      x.acquisitionTransactionId <= 0
    )
      throw new Error(`lots[${i}].acquisitionTransactionId must be a positive integer`);
    if (!isRealDate(x.currentAcquisitionDate))
      throw new Error(`lots[${i}].currentAcquisitionDate must be a real YYYY-MM-DD date`);
    if (!isRealDate(x.acquisitionDate)) throw new Error(`lots[${i}].acquisitionDate must be a real YYYY-MM-DD date`);
    if (typeof x.basisPerShare !== "number" || !Number.isFinite(x.basisPerShare) || !(x.basisPerShare > 0))
      throw new Error(`lots[${i}].basisPerShare must be a number greater than 0`);
    if (seen.has(x.acquisitionTransactionId))
      throw new Error(`lots[${i}]: transaction ${x.acquisitionTransactionId} is named more than once`);
    seen.add(x.acquisitionTransactionId);
    for (const flag of ["acknowledgeSalesAffected", "acknowledgeValuedHistory"] as const) {
      if (x[flag] !== undefined && typeof x[flag] !== "boolean")
        throw new Error(`lots[${i}].${flag} must be true or false when present`);
    }
    const target: DonatedLotBasisTarget = {
      account: x.account,
      symbol: x.symbol,
      acquisitionTransactionId: x.acquisitionTransactionId,
      currentAcquisitionDate: x.currentAcquisitionDate,
      acquisitionDate: x.acquisitionDate,
      basisPerShare: x.basisPerShare,
    };
    if (typeof x.acknowledgeSalesAffected === "boolean") target.acknowledgeSalesAffected = x.acknowledgeSalesAffected;
    if (typeof x.acknowledgeValuedHistory === "boolean") target.acknowledgeValuedHistory = x.acknowledgeValuedHistory;
    return target;
  });
  return { source: c.source, lots };
}

interface LotRow {
  id: number;
  account_id: number;
  security_id: number | null;
  trade_date: string;
  type: string;
  quantity: number | null;
  price_per_share: number | null;
  amount: number | null;
  fees: number | null;
  source_key: string | null;
  account_name: string;
  symbol: string | null;
  security_type: string | null;
  multiplier: number;
}

/** The key lib/import/parsers/canonical-csv.ts derives for a row (no ordinal suffix). */
function canonicalKey(account: string, symbol: string, date: string, type: string, amount: number | null): string {
  return `canonical:txn:${account}:${symbol}:${date}:${type}:${amount == null || !Number.isFinite(amount) ? "0" : cents(amount)}`;
}

function planOne(db: Database.Database, target: DonatedLotBasisTarget, ledgerPending: boolean): DonatedLotPlan {
  const id = target.acquisitionTransactionId;
  const base = {
    transactionId: id,
    dateChanges: false,
    basisChanges: false,
    sourceKeyChanges: false,
    donationsAssigned: 0,
    salesAffected: 0,
  };
  const refuse = (reason: string, extra: Partial<DonatedLotPlan> = {}): DonatedLotPlan => ({
    ...base,
    ...extra,
    status: "refused",
    reason: `transaction ${id}: ${reason}`,
  });

  const row = db
    .prepare(
      `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type, t.quantity, t.price_per_share,
              t.amount, t.fees, t.source_key, a.name AS account_name, s.symbol,
              s.security_type, COALESCE(s.multiplier, 1) AS multiplier
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN securities s ON s.id = t.security_id
        WHERE t.id = ?`
    )
    .get(id) as LotRow | undefined;
  if (!row) return refuse("not found");
  if (row.security_id == null || row.account_name !== target.account || row.symbol !== target.symbol)
    return refuse("is not the account or symbol the config names");
  if (!LONG_SHARE_ACQUISITIONS.has(row.type.toLowerCase()))
    return refuse("is not a long share acquisition (BUY, REINVESTMENT or TRANSFER_IN)");
  // The engine's own unit convention decides: plain shares are the only kind
  // where the lot's dollars equal shares × price.
  if (marketValue(1, 1, row.security_type, row.multiplier) !== 1)
    return refuse("is not plain shares (a bond or a contract with a multiplier prices differently)");
  if (row.quantity == null || !Number.isFinite(row.quantity) || !(row.quantity > 0))
    return refuse("has no positive share count");
  if (row.fees != null && row.fees !== 0)
    return refuse("carries fees, which the engine would add on top of the stated basis");

  const donationsAssigned = (
    db
      .prepare(`SELECT COUNT(DISTINCT donation_id) AS n FROM donation_lots WHERE acquisition_transaction_id = ?`)
      .get(id) as { n: number }
  ).n;
  if (donationsAssigned === 0) return refuse("no donation draws on this lot; this script only repairs donated lots");

  const magnitude = round2(row.quantity * target.basisPerShare);
  const newAmount = row.amount != null && row.amount < 0 ? -magnitude : magnitude;
  const dateChanges = row.trade_date !== target.acquisitionDate;
  const basisChanges =
    row.price_per_share == null ||
    Math.abs(row.price_per_share - target.basisPerShare) > 1e-9 ||
    row.amount == null ||
    cents(row.amount) !== cents(newAmount);
  const salesAffected = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM tax_lot_sales ts JOIN tax_lots tl ON tl.id = ts.tax_lot_id
          WHERE tl.acquisition_transaction_id = ?`
      )
      .get(id) as { n: number }
  ).n;
  const described = { donationsAssigned, dateChanges, basisChanges, salesAffected, quantity: row.quantity };

  if (!dateChanges && !basisChanges)
    return { ...base, ...described, status: "already-repaired" };
  // The sale and lot checks below read the STORED ledger. If it is waiting on
  // a recompute, a newer sale may be missing from it and a refusal skipped.
  if (ledgerPending)
    return refuse(
      "the tax-lot ledger is waiting on a recompute, so its sales and lots cannot be trusted for this check. " +
        "Run the tax-lot recompute first, then run this script again",
      described
    );
  if (row.trade_date !== target.currentAcquisitionDate)
    return refuse("is not dated the config's currentAcquisitionDate, so it is not the row the config describes", described);

  // Valued history: on or after the account's first monthly snapshot the row
  // also feeds cash and flow figures that this script does not rebuild.
  const firstSnapshot = (
    db.prepare(`SELECT MIN(month_end_date) AS d FROM monthly_snapshots WHERE account_id = ?`).get(row.account_id) as {
      d: string | null;
    }
  ).d;
  if (
    firstSnapshot != null &&
    (row.trade_date >= firstSnapshot || target.acquisitionDate >= firstSnapshot) &&
    target.acknowledgeValuedHistory !== true
  )
    return refuse(
      "sits, before or after the move, inside the account's valued history (on or after its first monthly snapshot). " +
        "From that date on, the row's date and amount also feed the daily valuation and return history, which this " +
        "script does not rebuild, so past valuation and return figures would shift at their next recompute. The lot " +
        'correction itself is sound. To proceed, add "acknowledgeValuedHistory": true to this lot in the config, ' +
        "then recompute valuations as well as tax lots",
      described
    );

  if (salesAffected > 0 && target.acknowledgeSalesAffected !== true)
    return refuse(
      `${salesAffected} sale row(s) already closed part of this lot; their realized gain will change at the next ` +
        'recompute. To proceed, add "acknowledgeSalesAffected": true to this lot in the config',
      described
    );

  if (dateChanges) {
    const earliestGift = (
      db
        .prepare(
          `SELECT MIN(t.trade_date) AS d
             FROM donation_lots dl
             JOIN donation_leg_links l ON l.donation_id = dl.donation_id AND l.role = 'out'
             JOIN transactions t ON t.id = l.transaction_id
            WHERE dl.acquisition_transaction_id = ?`
        )
        .get(id) as { d: string | null }
    ).d;
    if (earliestGift != null && !(target.acquisitionDate < earliestGift))
      return refuse("the new date is not before every donation that draws on this lot", described);

    const earliestSale = (
      db
        .prepare(
          `SELECT MIN(ts.sale_date) AS d
             FROM tax_lot_sales ts JOIN tax_lots tl ON tl.id = ts.tax_lot_id
            WHERE tl.acquisition_transaction_id = ?`
        )
        .get(id) as { d: string | null }
    ).d;
    if (earliestSale != null && !(target.acquisitionDate < earliestSale))
      return refuse("the new date is not before every sale that closed part of this lot (no acknowledgement overrides this)", described);

    const lo = row.trade_date < target.acquisitionDate ? row.trade_date : target.acquisitionDate;
    const hi = row.trade_date < target.acquisitionDate ? target.acquisitionDate : row.trade_date;
    const actions = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM corporate_actions
            WHERE security_id = ? AND effective_date >= ? AND effective_date <= ?`
        )
        .get(row.security_id, lo, hi) as { n: number }
    ).n;
    if (actions > 0)
      return refuse(
        "a corporate action on this security falls between the old and new dates, so the share count would change basis",
        described
      );
  }

  // Source key: only a key that IS the canonical-file key of the current row
  // is re-derived; anything else (statement keys, ordinal-suffixed keys) stays.
  let newSourceKey = row.source_key;
  if (
    row.source_key != null &&
    row.source_key === canonicalKey(row.account_name, row.symbol, row.trade_date, row.type, row.amount)
  ) {
    newSourceKey = canonicalKey(row.account_name, row.symbol, target.acquisitionDate, row.type, newAmount);
    const owner = db.prepare(`SELECT id FROM transactions WHERE source_key = ?`).get(newSourceKey) as
      | { id: number }
      | undefined;
    if (owner && owner.id !== row.id)
      return refuse(`the corrected row's source key already exists on transaction ${owner.id}`, described);
  }

  return {
    ...base,
    ...described,
    sourceKeyChanges: newSourceKey !== row.source_key,
    status: "repair",
    expected: { tradeDate: row.trade_date, price: row.price_per_share, amount: row.amount, sourceKey: row.source_key },
    write: { tradeDate: target.acquisitionDate, price: target.basisPerShare, amount: newAmount, sourceKey: newSourceKey },
  };
}

/** Read-only: decides, per named lot, what would be written. */
export function planDonatedLotBasisRepair(db: Database.Database, config: DonatedLotBasisConfig): DonatedLotBasisPlan {
  const ledgerPending = isTaxConventionPending(db);
  const lots = config.lots.map((target) => planOne(db, target, ledgerPending));
  return { ok: lots.every((l) => l.status !== "refused"), source: config.source, lots };
}

/**
 * Writes the plan in ONE transaction. Throws (writing nothing) when any lot
 * was refused or a row changed since the plan was made. `today` (YYYY-MM-DD)
 * is stamped into the row's notes; it is passed in, never read from a clock.
 */
export function applyDonatedLotBasisRepair(
  db: Database.Database,
  plan: DonatedLotBasisPlan,
  today: string
): { updated: number } {
  if (!plan.ok) throw new Error("plan has a refused lot — nothing applied");
  if (!isRealDate(today)) throw new Error("today must be a real YYYY-MM-DD date");
  const repairs = plan.lots.filter((l) => l.status === "repair");
  if (repairs.length === 0) return { updated: 0 };

  const read = db.prepare(`SELECT trade_date, price_per_share, amount, source_key, notes FROM transactions WHERE id = ?`);
  const write = db.prepare(
    `UPDATE transactions SET trade_date = ?, price_per_share = ?, amount = ?, source_key = ?, notes = ? WHERE id = ?`
  );
  return db.transaction(() => {
    let updated = 0;
    for (const lot of repairs) {
      if (!lot.expected || !lot.write) throw new Error(`transaction ${lot.transactionId}: plan carries no write`);
      const now = read.get(lot.transactionId) as
        | { trade_date: string; price_per_share: number | null; amount: number | null; source_key: string | null; notes: string | null }
        | undefined;
      if (
        !now ||
        now.trade_date !== lot.expected.tradeDate ||
        now.price_per_share !== lot.expected.price ||
        now.amount !== lot.expected.amount ||
        now.source_key !== lot.expected.sourceKey
      )
        throw new Error(`transaction ${lot.transactionId}: changed since the plan was made — nothing applied`);
      const stamp =
        `Acquisition date and basis corrected ${today} by repair-donated-lot-basis.ts ` +
        `(was dated ${now.trade_date}). Source: ${plan.source}.`;
      const notes = now.notes && now.notes.trim() ? `${now.notes} | ${stamp}` : stamp;
      const result = write.run(lot.write.tradeDate, lot.write.price, lot.write.amount, lot.write.sourceKey, notes, lot.transactionId);
      if (result.changes !== 1) throw new Error(`transaction ${lot.transactionId}: update touched ${result.changes} rows`);
      updated++;
    }
    bumpTaxGenerationIfPresent(db);
    return { updated };
  })();
}

/**
 * The before → after lines for one planned repair: date, basis per share and
 * the lot's total basis. Real figures — terminal only.
 */
export function describeChange(lot: DonatedLotPlan): string[] {
  if (lot.status !== "repair" || !lot.expected || !lot.write) return [];
  const money = (n: number | null) => (n == null ? "none" : n.toFixed(4).replace(/\.?0+$/, ""));
  return [
    `acquisition date  ${lot.expected.tradeDate} -> ${lot.write.tradeDate}`,
    `basis per share   ${money(lot.expected.price)} -> ${money(lot.write.price)}`,
    `amount on the row ${money(lot.expected.amount)} -> ${money(lot.write.amount)}` +
      (lot.quantity != null ? `  (${lot.quantity} shares)` : ""),
  ];
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const dbPath = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
  const configPath = process.env.REPAIR_CONFIG_PATH;
  if (!configPath) throw new Error("REPAIR_CONFIG_PATH is required (gitignored data/repair-configs/<name>.json)");
  const config = validateConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
  const db = new BetterSqlite3(dbPath, { readonly: !apply, fileMustExist: true });
  try {
    console.log(`Donated-lot basis repair [${apply ? "APPLY" : "DRY RUN"}] — db: ${dbPath}`);
    console.log("  This output shows real figures. Do not paste it into a committed file, a commit message or a PR.");
    console.log(`  config names ${config.lots.length} lot(s)`);
    const plan = planDonatedLotBasisRepair(db, config);
    const yn = (b: boolean) => (b ? "yes" : "no");
    for (const lot of plan.lots) {
      if (lot.status === "refused") console.error(`  REFUSED  ${lot.reason}`);
      else if (lot.status === "already-repaired")
        console.log(`  ok       transaction ${lot.transactionId}: already repaired`);
      else {
        console.log(
          `  repair   transaction ${lot.transactionId}: date changes ${yn(lot.dateChanges)}, basis changes ${yn(lot.basisChanges)}, ` +
            `source key changes ${yn(lot.sourceKeyChanges)}, donations drawing on it ${lot.donationsAssigned}`
        );
        for (const line of describeChange(lot)) console.log(`           ${line}`);
      }
      if (lot.status === "repair" && lot.salesAffected > 0)
        console.log(
          `           Sales that closed part of this lot: ${lot.salesAffected}. Their realized gain will change at the next recompute.`
        );
    }
    const repairs = plan.lots.filter((l) => l.status === "repair").length;
    const refused = plan.lots.filter((l) => l.status === "refused").length;
    console.log(`  ${repairs} to repair, ${plan.lots.length - repairs - refused} already repaired, ${refused} refused`);
    if (!plan.ok) {
      console.error("  Nothing written: one refused lot refuses the whole config.");
      process.exitCode = 1;
      return;
    }
    if (repairs === 0) {
      console.log("  Nothing to do.");
      return;
    }
    if (!apply) {
      console.log("\nDry run (default). Re-run with --apply to write (REPAIR_DB_PATH for a rehearsal copy).");
      return;
    }
    const backupDir = path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `pre-donated-lot-basis-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    db.prepare("VACUUM INTO ?").run(backupPath);
    console.log(`  Backup: ${backupPath}`);
    const result = applyDonatedLotBasisRepair(db, plan, todayET());
    console.log(`  Applied: ${result.updated} transaction(s) updated; tax generation bumped — run the tax-lot recompute next.`);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] != null && /repair-donated-lot-basis\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

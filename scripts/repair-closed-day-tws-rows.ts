/**
 * Remove IBKR live-sync rows dated on a day the market was closed
 * (DECISIONS 2026-10-26 item 1).
 *
 * Before that ruling the TWS sync stamped holdings, prices and the account's
 * live snapshot with the Eastern day even on a weekend or a full NYSE holiday,
 * so a frozen tick was stored as that day's "close". The sync no longer does
 * that (lib/tws/positions.ts, lib/tws/streaming.ts). This script removes the
 * rows already written:
 *
 *   - prices            source = 'tws'
 *   - holdings          source_key from the IBKR live sync (`isTwsSourcedHolding`)
 *   - monthly_snapshots source = 'tws' (the live account snapshot)
 *
 * on every date `isMarketClosed` calls closed. Statement, Plaid, manual and
 * recon (tombstone) rows are never touched, and are counted as "kept" so the
 * operator can see them. The IBKR Web API fallback stamps the same `tws`
 * marks; its timer and quote paths never write on a closed day, and the
 * ruling's reason (a closed-day tick is not a close) applies to either writer.
 *
 * Tax inputs: the lot engine reads statement-grade holdings only, so removing
 * live holdings rows changes no tax input. A removed PRICE can (a synthetic
 * close prices off the latest price at or before a statement zero), so the
 * removed (security, date) pairs go through `bumpIfPricesAffectSyntheticCloses`
 * before the delete, exactly as the live writers do.
 *
 * After the delete, daily valuations are rebuilt (computeDailyValuations, a
 * full rebuild, the same call the other repair scripts make), inside the same
 * transaction: a failure rolls back everything.
 *
 * Output is counts per table and per date only, never a figure.
 *
 * The holiday list in lib/calendar/market-holidays.ts starts at 2026; an older
 * holiday is not detected (weekends always are).
 *
 * Usage (from the repo root; dry run is the default):
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-closed-day-tws-rows.ts
 *   REPAIR_DB_PATH=/path/to/copy.db npx tsx scripts/repair-closed-day-tws-rows.ts --apply
 *   npx tsx scripts/repair-closed-day-tws-rows.ts --db /path/to/copy.db [--apply]
 *
 * Rehearse --apply on a VACUUM copy first. A run against the live database
 * needs the owner's go, and --apply makes a VACUUM backup next to the database
 * before it writes.
 */

import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { isMarketClosed } from "../lib/calendar/market-holidays";
import {
  isTwsSourcedHolding,
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_LIVE_SUFFIX,
  RECON_STMT_SUFFIX,
} from "../lib/db/holding-sources";
import { reconcileClosedEquityHoldings } from "../lib/mutations/closed-equity";
import { LIVE_SNAPSHOT_SOURCES } from "../lib/db/live-sources";
import { bumpIfPricesAffectSyntheticCloses, getTaxInputGeneration } from "../lib/compute/tax-convention";
import { computeDailyValuations } from "../lib/compute/daily-valuation";

/** `prices.source` and `monthly_snapshots.source` stamped by the IBKR live sync. */
const TWS_SOURCE: (typeof LIVE_SNAPSHOT_SOURCES)[number] = "tws";

export interface ClosedDayDateCounts {
  date: string;
  prices: number;
  holdings: number;
  snapshots: number;
}

export interface ClosedDayTwsPlan {
  byDate: ClosedDayDateCounts[];
  totals: { prices: number; holdings: number; snapshots: number };
  /** Rows on the same closed dates that are NOT from the IBKR live sync: never removed. */
  kept: { prices: number; holdings: number; snapshots: number };
  priceRows: Array<{ id: number; securityId: number; date: string }>;
  holdingIds: number[];
  snapshotIds: number[];
  /**
   * Engine tombstones (`recon:closed-equity:`) on an (account, closed date)
   * that the delete leaves holding ONLY tombstones. Left alone, such a date
   * stays a holdings "snapshot" of zeros and computeDailyValuations values the
   * account at zero holdings until the next snapshot (reviewer, 2026-10-26).
   * Tombstones on trading days, or on closed dates that keep a real row, are
   * never touched.
   *
   *  - superseded: the pair has a later holdings row, so the tombstone is
   *    inert history; deleted.
   *  - redate: the tombstone is still the pair's newest row (the position is
   *    closed now). It is moved, same row and same origin suffix, to the
   *    account's next surviving real snapshot date: the date the reconciler
   *    would have minted it on had the closed-day snapshot never existed.
   *  - blocked: a case the script will not decide (a statement-pass tombstone,
   *    or no later trading-day snapshot to move to). --apply refuses.
   */
  tombstones: {
    superseded: Array<{ id: number; accountId: number; date: string }>;
    redate: Array<{ id: number; accountId: number; securityId: number; from: string; to: string; newKey: string }>;
    blocked: Array<{ id: number; accountId: number; date: string; reason: string }>;
  };
}

export interface ClosedDayTwsResult {
  plan: ClosedDayTwsPlan;
  applied: boolean;
  deleted: { prices: number; holdings: number; snapshots: number };
  tombstonesDeleted: number;
  tombstonesRedated: number;
  /** Positions the reconciler marked flat when run after the repair (expected 0). */
  reconcilerMarked: number;
  taxGenerationBumped: boolean;
  valuations: { datesComputed: number; accountsProcessed: number } | null;
}

function closedDatesOf(db: Database.Database, sql: string): Set<string> {
  const rows = db.prepare(sql).all() as Array<{ d: string }>;
  return new Set(rows.map((r) => r.d).filter((d) => typeof d === "string" && isMarketClosed(d)));
}

export function planClosedDayTwsRepair(db: Database.Database): ClosedDayTwsPlan {
  const priceDates = closedDatesOf(db, "SELECT DISTINCT date AS d FROM prices");
  const holdingDates = closedDatesOf(db, "SELECT DISTINCT as_of_date AS d FROM holdings");
  const snapshotDates = closedDatesOf(db, "SELECT DISTINCT month_end_date AS d FROM monthly_snapshots");

  const byDate = new Map<string, ClosedDayDateCounts>();
  const bump = (date: string, key: "prices" | "holdings" | "snapshots") => {
    const c = byDate.get(date) ?? { date, prices: 0, holdings: 0, snapshots: 0 };
    c[key] += 1;
    byDate.set(date, c);
  };
  const kept = { prices: 0, holdings: 0, snapshots: 0 };

  const priceRows: ClosedDayTwsPlan["priceRows"] = [];
  const pricesOn = db.prepare("SELECT id, security_id, source FROM prices WHERE date = ? ORDER BY id");
  for (const date of [...priceDates].sort()) {
    for (const r of pricesOn.all(date) as Array<{ id: number; security_id: number; source: string | null }>) {
      if (r.source === TWS_SOURCE) {
        priceRows.push({ id: r.id, securityId: r.security_id, date });
        bump(date, "prices");
      } else {
        kept.prices += 1;
      }
    }
  }

  const holdingIds: number[] = [];
  const touchedAccountDates = new Map<string, { accountId: number; date: string }>();
  const holdingsOn = db.prepare("SELECT id, account_id, source_key FROM holdings WHERE as_of_date = ? ORDER BY id");
  for (const date of [...holdingDates].sort()) {
    for (const r of holdingsOn.all(date) as Array<{ id: number; account_id: number; source_key: string | null }>) {
      if (isTwsSourcedHolding(r.source_key)) {
        holdingIds.push(r.id);
        touchedAccountDates.set(`${r.account_id}|${date}`, { accountId: r.account_id, date });
        bump(date, "holdings");
      } else {
        kept.holdings += 1;
      }
    }
  }

  const snapshotIds: number[] = [];
  const snapshotsOn = db.prepare("SELECT id, source FROM monthly_snapshots WHERE month_end_date = ? ORDER BY id");
  for (const date of [...snapshotDates].sort()) {
    for (const r of snapshotsOn.all(date) as Array<{ id: number; source: string | null }>) {
      if (r.source === TWS_SOURCE) {
        snapshotIds.push(r.id);
        bump(date, "snapshots");
      } else {
        kept.snapshots += 1;
      }
    }
  }

  const tombstones = planTombstones(db, touchedAccountDates, new Set(holdingIds));

  return {
    byDate: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals: { prices: priceRows.length, holdings: holdingIds.length, snapshots: snapshotIds.length },
    kept,
    priceRows,
    holdingIds,
    snapshotIds,
    tombstones,
  };
}

function isReconTombstone(sourceKey: string | null): boolean {
  return sourceKey?.startsWith(RECON_HOLDING_SOURCE_PREFIX) ?? false;
}

function originSuffix(sourceKey: string): string {
  if (sourceKey.endsWith(RECON_LIVE_SUFFIX)) return RECON_LIVE_SUFFIX;
  if (sourceKey.endsWith(RECON_STMT_SUFFIX)) return RECON_STMT_SUFFIX;
  return "";
}

function planTombstones(
  db: Database.Database,
  touched: Map<string, { accountId: number; date: string }>,
  deletedHoldingIds: Set<number>,
): ClosedDayTwsPlan["tombstones"] {
  const out: ClosedDayTwsPlan["tombstones"] = { superseded: [], redate: [], blocked: [] };
  const rowsOn = db.prepare(
    "SELECT id, security_id, source_key FROM holdings WHERE account_id = ? AND as_of_date = ? ORDER BY id",
  );
  const laterRowForPair = db.prepare(
    "SELECT 1 AS x FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date > ? LIMIT 1",
  );
  const laterRowsForAccount = db.prepare(
    "SELECT id, as_of_date, source_key FROM holdings WHERE account_id = ? AND as_of_date > ? ORDER BY as_of_date, id",
  );

  for (const { accountId, date } of [...touched.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const remaining = (
      rowsOn.all(accountId, date) as Array<{ id: number; security_id: number; source_key: string | null }>
    ).filter((r) => !deletedHoldingIds.has(r.id));
    if (remaining.length === 0 || !remaining.every((r) => isReconTombstone(r.source_key))) continue;

    // The account's next surviving real snapshot date (not a row this repair
    // deletes, not a tombstone).
    const next = (
      laterRowsForAccount.all(accountId, date) as Array<{ id: number; as_of_date: string; source_key: string | null }>
    ).find((r) => !deletedHoldingIds.has(r.id) && !isReconTombstone(r.source_key))?.as_of_date;

    for (const t of remaining) {
      const key = t.source_key as string;
      if (key.endsWith(RECON_STMT_SUFFIX)) {
        out.blocked.push({ id: t.id, accountId, date, reason: "statement-pass tombstone (a tax input)" });
      } else if (laterRowForPair.get(accountId, t.security_id, date) != null) {
        out.superseded.push({ id: t.id, accountId, date });
      } else if (next == null || isMarketClosed(next)) {
        out.blocked.push({ id: t.id, accountId, date, reason: "no later trading-day snapshot to move the closure to" });
      } else {
        out.redate.push({
          id: t.id,
          accountId,
          securityId: t.security_id,
          from: date,
          to: next,
          newKey: `${RECON_HOLDING_SOURCE_PREFIX}${accountId}:${t.security_id}:${next}${originSuffix(key)}`,
        });
      }
    }
  }
  return out;
}

export function runClosedDayTwsRepair(
  db: Database.Database,
  opts: { apply?: boolean } = {},
): ClosedDayTwsResult {
  if (!opts.apply) {
    return {
      plan: planClosedDayTwsRepair(db),
      applied: false,
      deleted: { prices: 0, holdings: 0, snapshots: 0 },
      tombstonesDeleted: 0,
      tombstonesRedated: 0,
      reconcilerMarked: 0,
      taxGenerationBumped: false,
      valuations: null,
    };
  }

  return db.transaction((): ClosedDayTwsResult => {
    const plan = planClosedDayTwsRepair(db);
    const deleted = { prices: 0, holdings: 0, snapshots: 0 };
    if (plan.priceRows.length + plan.holdingIds.length + plan.snapshotIds.length === 0) {
      return {
        plan,
        applied: true,
        deleted,
        tombstonesDeleted: 0,
        tombstonesRedated: 0,
        reconcilerMarked: 0,
        taxGenerationBumped: false,
        valuations: null,
      };
    }
    if (plan.tombstones.blocked.length > 0) {
      throw new Error(
        `refusing: ${plan.tombstones.blocked.length} tombstone(s) on a tombstone-only closed date need a decision ` +
          `(${[...new Set(plan.tombstones.blocked.map((b) => b.reason))].join("; ")}); nothing written`,
      );
    }

    // Capture BEFORE the delete (the helper's contract).
    const genBefore = getTaxInputGeneration(db);
    bumpIfPricesAffectSyntheticCloses(
      db,
      plan.priceRows.map((r) => ({ securityId: r.securityId, date: r.date })),
    );
    const taxGenerationBumped = getTaxInputGeneration(db) !== genBefore;

    const delPrice = db.prepare("DELETE FROM prices WHERE id = ? AND source = ?");
    for (const r of plan.priceRows) deleted.prices += delPrice.run(r.id, TWS_SOURCE).changes;
    const delHolding = db.prepare("DELETE FROM holdings WHERE id = ?");
    for (const id of plan.holdingIds) deleted.holdings += delHolding.run(id).changes;
    const delSnapshot = db.prepare("DELETE FROM monthly_snapshots WHERE id = ? AND source = ?");
    for (const id of plan.snapshotIds) deleted.snapshots += delSnapshot.run(id, TWS_SOURCE).changes;

    if (
      deleted.prices !== plan.totals.prices ||
      deleted.holdings !== plan.totals.holdings ||
      deleted.snapshots !== plan.totals.snapshots
    ) {
      throw new Error(
        `delete counts differ from the plan (prices ${deleted.prices}/${plan.totals.prices}, ` +
          `holdings ${deleted.holdings}/${plan.totals.holdings}, snapshots ${deleted.snapshots}/${plan.totals.snapshots}); rolled back`,
      );
    }

    // Tombstones on dates the delete left holding only tombstones.
    // Classified as tombstones in planTombstones (isReconTombstone); the
    // quantity check is a last guard that a real row is never deleted here.
    const delTomb = db.prepare("DELETE FROM holdings WHERE id = ? AND as_of_date = ? AND quantity = 0");
    let tombstonesDeleted = 0;
    for (const t of plan.tombstones.superseded) tombstonesDeleted += delTomb.run(t.id, t.date).changes;
    const redate = db.prepare(
      "UPDATE holdings SET as_of_date = ?, source_key = ? WHERE id = ? AND as_of_date = ? AND quantity = 0",
    );
    let tombstonesRedated = 0;
    for (const t of plan.tombstones.redate) tombstonesRedated += redate.run(t.to, t.newKey, t.id, t.from).changes;
    if (
      tombstonesDeleted !== plan.tombstones.superseded.length ||
      tombstonesRedated !== plan.tombstones.redate.length
    ) {
      throw new Error("tombstone changes differ from the plan; rolled back");
    }

    // The engine's own check: with the closed-day snapshots gone, the
    // reconciler must still see every moved closure as closed. Then verify
    // each moved pair ends on a zero tombstone dated on a trading day.
    const genBeforeReconcile = getTaxInputGeneration(db);
    // Scoped to the accounts whose closures moved, so the run answers only
    // that question.
    let reconcilerMarked = 0;
    for (const accountId of new Set(plan.tombstones.redate.map((t) => t.accountId))) {
      reconcilerMarked += reconcileClosedEquityHoldings(db, { accountId });
    }
    const newestRow = db.prepare(
      `SELECT quantity, as_of_date, source_key FROM holdings
        WHERE account_id = ? AND security_id = ? ORDER BY as_of_date DESC LIMIT 1`,
    );
    for (const t of plan.tombstones.redate) {
      const row = newestRow.get(t.accountId, t.securityId) as
        | { quantity: number; as_of_date: string; source_key: string | null }
        | undefined;
      if (!row || row.quantity !== 0 || !isReconTombstone(row.source_key) || isMarketClosed(row.as_of_date)) {
        throw new Error(
          `closure for account ${t.accountId} security ${t.securityId} did not end on a trading-day tombstone; rolled back`,
        );
      }
    }

    const v = computeDailyValuations(db);
    return {
      plan,
      applied: true,
      deleted,
      tombstonesDeleted,
      tombstonesRedated,
      reconcilerMarked,
      taxGenerationBumped: taxGenerationBumped || getTaxInputGeneration(db) !== genBeforeReconcile,
      valuations: { datesComputed: v.datesComputed, accountsProcessed: v.accountsProcessed },
    };
  })();
}

function printResult(result: ClosedDayTwsResult): void {
  const { plan } = result;
  const verb = result.applied ? "Removed" : "Would remove";
  console.log(
    `${verb}: prices ${plan.totals.prices}, holdings ${plan.totals.holdings}, live snapshots ${plan.totals.snapshots}`,
  );
  if (plan.byDate.length === 0) {
    console.log("No IBKR live-sync rows dated on a closed market day.");
  } else {
    console.log("Per closed date (prices / holdings / live snapshots):");
    for (const d of plan.byDate) {
      console.log(`  ${d.date}: ${d.prices} / ${d.holdings} / ${d.snapshots}`);
    }
  }
  console.log(
    `Kept on those closed dates (not from the IBKR live sync): prices ${plan.kept.prices}, ` +
      `holdings ${plan.kept.holdings}, snapshots ${plan.kept.snapshots}`,
  );
  const tb = plan.tombstones;
  console.log(
    `Tombstones on dates left tombstone-only: ${tb.superseded.length} superseded (delete), ` +
      `${tb.redate.length} still newest (move to next snapshot), ${tb.blocked.length} blocked`,
  );
  for (const r of tb.redate) console.log(`  move: account ${r.accountId} ${r.from} -> ${r.to}`);
  for (const b of tb.blocked) console.log(`  blocked: account ${b.accountId} ${b.date}: ${b.reason}`);
  if (result.applied) {
    console.log(
      `Tombstones deleted ${result.tombstonesDeleted}, moved ${result.tombstonesRedated}; ` +
        `reconciler afterwards marked ${result.reconcilerMarked}`,
    );
    console.log(`Tax input generation bumped: ${result.taxGenerationBumped ? "yes" : "no"}`);
    if (result.valuations) {
      console.log(
        `Daily valuations rebuilt: datesComputed=${result.valuations.datesComputed} ` +
          `accountsProcessed=${result.valuations.accountsProcessed}`,
      );
    }
  } else {
    console.log("Dry run (default). Re-run with --apply on a rehearsed copy to write.");
  }
}

function resolveDbPath(argv: string[]): string {
  const i = argv.indexOf("--db");
  if (i >= 0) {
    const p = argv[i + 1];
    if (!p || p.startsWith("--")) throw new Error("--db needs a path");
    return path.resolve(p);
  }
  return process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dbPath = resolveDbPath(argv);
  // Printed BEFORE the database is opened (rehearsable-repair rule).
  console.log(`[repair-closed-day-tws-rows] mode=${apply ? "APPLY" : "dry-run"}, db: ${dbPath}`);

  const db = new BetterSqlite3(dbPath, { readonly: !apply, fileMustExist: true, timeout: 60_000 });
  try {
    if (apply) {
      db.pragma("foreign_keys = ON");
      // Relative specifier: the "@/" alias is not resolved for dynamic imports
      // outside the repo cwd.
      const { ensureBackup } = await import("./rebuild-ibkr-ledger");
      const backupPath = path.join(
        path.dirname(dbPath),
        "backups",
        `pre-closed-day-tws-repair-${new Date().toISOString().replace(/:/g, "-")}.db`,
      );
      const backup = ensureBackup(db, backupPath);
      console.log(`Backup ${backup.created ? "created" : "already present"} at ${backup.path}`);
    }
    printResult(runClosedDayTwsRepair(db, { apply }));
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("repair-closed-day-tws-rows.ts")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}

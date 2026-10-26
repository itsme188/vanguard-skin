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
import { isTwsSourcedHolding } from "../lib/db/holding-sources";
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
}

export interface ClosedDayTwsResult {
  plan: ClosedDayTwsPlan;
  applied: boolean;
  deleted: { prices: number; holdings: number; snapshots: number };
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
  const holdingsOn = db.prepare("SELECT id, source_key FROM holdings WHERE as_of_date = ? ORDER BY id");
  for (const date of [...holdingDates].sort()) {
    for (const r of holdingsOn.all(date) as Array<{ id: number; source_key: string | null }>) {
      if (isTwsSourcedHolding(r.source_key)) {
        holdingIds.push(r.id);
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

  return {
    byDate: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    totals: { prices: priceRows.length, holdings: holdingIds.length, snapshots: snapshotIds.length },
    kept,
    priceRows,
    holdingIds,
    snapshotIds,
  };
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
      taxGenerationBumped: false,
      valuations: null,
    };
  }

  return db.transaction((): ClosedDayTwsResult => {
    const plan = planClosedDayTwsRepair(db);
    const deleted = { prices: 0, holdings: 0, snapshots: 0 };
    if (plan.priceRows.length + plan.holdingIds.length + plan.snapshotIds.length === 0) {
      return { plan, applied: true, deleted, taxGenerationBumped: false, valuations: null };
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

    const v = computeDailyValuations(db);
    return {
      plan,
      applied: true,
      deleted,
      taxGenerationBumped,
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
  if (result.applied) {
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

/**
 * backfill-prices-from-ohlcv.ts — Copies 1-day `ohlcv_bars` closes into the
 * `prices` table wherever a price row is MISSING, for a chosen set of
 * securities and date range.
 *
 * Why this exists: `ohlcv_bars` (the candlestick-chart historical-data
 * capture) often has daily coverage for a security that `prices` (the table
 * `computeDailyValuations` actually reads) never got — e.g. the 2025 IBKR
 * era, where 12 of 13 held names have zero `prices` rows between
 * 2024-12-31 and 2026-01-31 even though the chart road pulled daily bars for
 * them. Without a `prices` row on a date, `computeDailyValuations` can't
 * price that holding that day at all (see `getPrice` in
 * `lib/compute/daily-valuation.ts`) — the security silently drops out of
 * `holdings_value`, understating the account and (via the cash-anchor
 * residual) overstating cash. This script closes that gap using data
 * already sitting in `ohlcv_bars` — it never talks to TWS itself; bars must
 * be fetched separately via the app's chart road first.
 *
 * What it does:
 *   1. For each resolved security, counts its `ohlcv_bars` rows
 *      (`bar_size = '1 day'`) within [--from, --to]. Zero bars -> reported
 *      as "no bars — skipped" (no ground truth to backfill from).
 *   2. Among those bars, finds the dates with NO existing `prices` row for
 *      that (security_id, date).
 *   3. `--apply`: backs up `data/vanguard.db` to `data/backups/` (same
 *      VACUUM-INTO convention as `rebuild-ibkr-ledger.ts::ensureBackup` —
 *      NEVER proceeds past this step without a verified backup), then
 *      inside one transaction INSERTs a `prices` row
 *      `(security_id, date, close_price, source='tws')` for every missing
 *      date, using the bar's close.
 *
 * NEVER updates or overwrites an existing `prices` row, even when the bar's
 * close disagrees with it — statement-sourced rows always win, and existing
 * `tws` rows (from the live snapshot/AH-close-repair paths) stay as-is. Every
 * run reports, per security, how many dates already had a row (left alone)
 * vs how many were missing (backfilled).
 *
 * Idempotent: after a successful apply, every backfilled date now has a
 * `prices` row, so a re-run over the same range finds nothing missing for
 * that security (0 inserted, all "already present").
 *
 * TAX-GENERATION NOTE: this script writes `prices` directly and does NOT call
 * `bumpIfPricesAffectSyntheticCloses` — a repaired price at-or-before a
 * sold-out (tombstoned) security's zero-quantity date can move that
 * security's RECONCILE_CLOSE strike without the tax generation bumping. After
 * running `--apply` against any security that could be tombstoned, re-run
 * `scripts/reconcile-tax-report-vs-broker.ts --stamp` for the affected
 * (account, year)s before trusting a filing-ready export.
 *
 * Usage:
 *   npx tsx scripts/backfill-prices-from-ohlcv.ts --account 3 --from 2024-12-31 --to 2026-01-31
 *   npx tsx scripts/backfill-prices-from-ohlcv.ts --securities 12,45,88 --from 2025-01-01 --to 2025-12-31
 *   npx tsx scripts/backfill-prices-from-ohlcv.ts --account 3 --from 2024-12-31 --to 2026-01-31 --apply
 *   npx tsx scripts/backfill-prices-from-ohlcv.ts --db /path/to/vanguard.db --account 3 --from ... --to ...
 */

import type Database from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────

export interface SecurityBackfillReport {
  securityId: number;
  symbol: string;
  /** Count of `ohlcv_bars` (1-day) rows for this security within [from, to]. */
  barsInRangeCount: number;
  /** Dates with a bar but no existing `prices` row — always computed, even in dry-run. */
  missingCount: number;
  /** Rows actually written. 0 unless `opts.apply` is true. */
  rowsInserted: number;
  /** Dates that already had a `prices` row — left untouched. */
  rowsAlreadyPresent: number;
  /** True when the security has zero 1-day bars in range — nothing to backfill from. */
  skippedNoBars: boolean;
}

export interface BackfillResult {
  securities: SecurityBackfillReport[];
  totals: {
    /** Securities with at least one 1-day bar in range. */
    securitiesProcessed: number;
    /** Rows actually written. 0 unless `opts.apply` is true. */
    rowsInserted: number;
    rowsAlreadyPresent: number;
    /** Securities with zero 1-day bars in range. */
    securitiesSkipped: number;
  };
}

interface BackfillOpts {
  securityIds: number[];
  /** Inclusive lower bound (YYYY-MM-DD). */
  from: string;
  /** Inclusive upper bound (YYYY-MM-DD). */
  to: string;
  apply: boolean;
}

// ─── Core functions ─────────────────────────────────────────────────

/**
 * Resolves the target security id set. `opts.accountId` selects every
 * security the account has EVER held (DISTINCT security_id across all
 * `holdings` rows for that account, any `as_of_date` — a security sold
 * before the latest snapshot still needs its historical prices backfilled).
 * `opts.securityIds` is used as-is. Both may be supplied together (union).
 */
export function resolveSecurityIds(
  db: Database.Database,
  opts: { accountId?: number; securityIds?: number[] },
): number[] {
  const ids = new Set<number>();
  if (opts.securityIds) {
    for (const id of opts.securityIds) ids.add(id);
  }
  if (opts.accountId != null) {
    const rows = db
      .prepare("SELECT DISTINCT security_id FROM holdings WHERE account_id = ?")
      .all(opts.accountId) as { security_id: number }[];
    for (const r of rows) ids.add(r.security_id);
  }
  return [...ids].sort((a, b) => a - b);
}

interface MissingDateRow {
  date: string;
  close: number;
}

/**
 * Pure read: for one security, the total 1-day-bar count in range and the
 * dates within that range that have a bar but no `prices` row. Never
 * writes. Safe to call in both dry-run and apply modes for reporting.
 */
function planSecurityBackfill(
  db: Database.Database,
  securityId: number,
  from: string,
  to: string,
): { barsInRangeCount: number; missingDates: MissingDateRow[] } {
  const barsInRangeCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM ohlcv_bars
         WHERE security_id = ? AND bar_size = '1 day' AND bar_date BETWEEN ? AND ?`,
      )
      .get(securityId, from, to) as { c: number }
  ).c;

  const missingDates = db
    .prepare(
      `SELECT o.bar_date AS date, o.close AS close
       FROM ohlcv_bars o
       WHERE o.security_id = ?
         AND o.bar_size = '1 day'
         AND o.bar_date BETWEEN ? AND ?
         AND NOT EXISTS (
           SELECT 1 FROM prices p WHERE p.security_id = o.security_id AND p.date = o.bar_date
         )
       ORDER BY o.bar_date`,
    )
    .all(securityId, from, to) as MissingDateRow[];

  return { barsInRangeCount, missingDates };
}

/**
 * Backfills `prices` rows from `ohlcv_bars` for every security in
 * `opts.securityIds`, over `[opts.from, opts.to]`. `opts.apply: false`
 * computes the identical plan and returns it with every `rowsInserted` at 0
 * — nothing is written. `opts.apply: true` runs the whole backfill inside
 * one transaction.
 *
 * NEVER overwrites an existing `prices` row — the `NOT EXISTS` guard in
 * `planSecurityBackfill` excludes any (security_id, date) that already has
 * one, so a `tws`-sourced row from AH-close repair or a `manual`/statement
 * row is left exactly as-is even when the bar's close disagrees with it.
 */
export function backfillPricesFromOhlcv(db: Database.Database, opts: BackfillOpts): BackfillResult {
  const symbolStmt = db.prepare("SELECT symbol FROM securities WHERE id = ?");
  const insertStmt = db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`,
  );

  const securities: SecurityBackfillReport[] = [];
  let totalInserted = 0;
  let totalAlreadyPresent = 0;
  let securitiesProcessed = 0;
  let securitiesSkipped = 0;

  const run = () => {
    for (const securityId of opts.securityIds) {
      const symbolRow = symbolStmt.get(securityId) as { symbol: string } | undefined;
      const symbol = symbolRow?.symbol ?? `#${securityId}`;

      const { barsInRangeCount, missingDates } = planSecurityBackfill(db, securityId, opts.from, opts.to);
      const rowsAlreadyPresent = barsInRangeCount - missingDates.length;

      if (barsInRangeCount === 0) {
        securities.push({
          securityId,
          symbol,
          barsInRangeCount: 0,
          missingCount: 0,
          rowsInserted: 0,
          rowsAlreadyPresent: 0,
          skippedNoBars: true,
        });
        securitiesSkipped++;
        continue;
      }

      let rowsInserted = 0;
      if (opts.apply) {
        for (const m of missingDates) {
          insertStmt.run(securityId, m.date, m.close);
          rowsInserted++;
        }
      }

      securities.push({
        securityId,
        symbol,
        barsInRangeCount,
        missingCount: missingDates.length,
        rowsInserted,
        rowsAlreadyPresent,
        skippedNoBars: false,
      });
      securitiesProcessed++;
      totalInserted += rowsInserted;
      totalAlreadyPresent += rowsAlreadyPresent;
    }
  };

  if (opts.apply) {
    db.transaction(run)();
  } else {
    run();
  }

  return {
    securities,
    totals: {
      securitiesProcessed,
      rowsInserted: totalInserted,
      rowsAlreadyPresent: totalAlreadyPresent,
      securitiesSkipped,
    },
  };
}

// ─── CLI formatting ─────────────────────────────────────────────────

function formatSecurityReport(s: SecurityBackfillReport, apply: boolean): string {
  if (s.skippedNoBars) {
    return `  ${s.symbol.padEnd(10)} (id=${s.securityId})   no bars — skipped`;
  }
  const insertedLabel = apply ? "inserted" : "would insert";
  return (
    `  ${s.symbol.padEnd(10)} (id=${s.securityId})   ` +
    `bars=${s.barsInRangeCount}   ${insertedLabel}=${s.missingCount}   already_present=${s.rowsAlreadyPresent}`
  );
}

// ─── CLI entry point ──────────────────────────────────────────────

// Detect if this file is being run directly (not imported by tests) —
// mirrors scripts/repair-ah-closes.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("backfill-prices-from-ohlcv.ts") ||
    process.argv[1].endsWith("backfill-prices-from-ohlcv.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { runMigrations } = await import("@/lib/db/migrate");
    const { ensureBackup } = await import("@/scripts/rebuild-ibkr-ledger");
    const { todayET } = await import("@/lib/calendar/date-utils");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const args = process.argv.slice(2);
    const apply = args.includes("--apply");

    function argValue(flag: string): string | undefined {
      const eqArg = args.find((a) => a.startsWith(`${flag}=`));
      if (eqArg) return eqArg.slice(flag.length + 1);
      const idx = args.indexOf(flag);
      if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
      return undefined;
    }

    const accountArg = argValue("--account");
    const securitiesArg = argValue("--securities");
    const fromArg = argValue("--from");
    const toArg = argValue("--to");

    if (!fromArg || !/^\d{4}-\d{2}-\d{2}$/.test(fromArg)) {
      console.error(`--from is required (YYYY-MM-DD). Got: ${fromArg ?? "(missing)"}`);
      process.exit(1);
    }
    if (!toArg || !/^\d{4}-\d{2}-\d{2}$/.test(toArg)) {
      console.error(`--to is required (YYYY-MM-DD). Got: ${toArg ?? "(missing)"}`);
      process.exit(1);
    }
    if (!accountArg && !securitiesArg) {
      console.error("Either --account <id> or --securities <comma-separated ids> is required.");
      process.exit(1);
    }

    const accountId = accountArg ? Number(accountArg) : undefined;
    if (accountArg && (!Number.isFinite(accountId) || accountId! <= 0)) {
      console.error(`Invalid --account value: ${accountArg}`);
      process.exit(1);
    }

    const securityIds = securitiesArg
      ? securitiesArg.split(",").map((s) => Number(s.trim()))
      : undefined;
    if (securityIds && securityIds.some((id) => !Number.isFinite(id) || id <= 0)) {
      console.error(`Invalid --securities value: ${securitiesArg}`);
      process.exit(1);
    }

    const dataDir = process.env.VANGUARD_DB_DIR || path.default.join(process.cwd(), "data");
    const defaultDbPath = path.default.join(dataDir, "vanguard.db");
    const dbPath = argValue("--db") ?? defaultDbPath;

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Gated on --apply (mirrors repair-ah-closes.ts / repair-earnings-preview-audit.ts):
    // a dry run must never write, and runMigrations() is a write the instant a
    // pending migration exists.
    if (apply) {
      runMigrations(db);
    }

    const securityIdList = resolveSecurityIds(db, { accountId, securityIds });
    if (securityIdList.length === 0) {
      console.log("No securities resolved from --account/--securities — nothing to do.");
      db.close();
      return;
    }

    console.log(
      `Backfilling prices from ohlcv_bars for ${securityIdList.length} security(ies), ` +
        `range [${fromArg}, ${toArg}] ${apply ? "[APPLY]" : "[DRY RUN]"}`,
    );

    // Always compute the full plan first (dry-run mode internally), so both
    // modes print the identical report shape.
    const plan = backfillPricesFromOhlcv(db, {
      securityIds: securityIdList,
      from: fromArg,
      to: toArg,
      apply: false,
    });

    console.log("");
    for (const s of plan.securities) console.log(formatSecurityReport(s, false));

    const totalMissing = plan.securities.reduce((sum, s) => sum + s.missingCount, 0);
    if (totalMissing === 0) {
      console.log(
        `\nNothing to backfill — every bar in range already has a matching prices row ` +
          `(processed=${plan.totals.securitiesProcessed}, skipped=${plan.totals.securitiesSkipped}).`,
      );
      db.close();
      return;
    }

    if (!apply) {
      console.log(
        `\n${totalMissing} row(s) would be inserted across ${plan.totals.securitiesProcessed} security(ies) ` +
          `(${plan.totals.securitiesSkipped} skipped — no bars).`,
      );
      console.log("\nDry-run (default). Re-run with --apply to write.");
      db.close();
      return;
    }

    // NEVER proceed past this line without a verified backup — same
    // VACUUM-INTO convention as rebuild-ibkr-ledger.ts::ensureBackup /
    // repair-ah-closes.ts / repair-earnings-preview-audit.ts.
    const backupPath = path.default.join(
      dataDir,
      "backups",
      `pre-ohlcv-price-backfill-${todayET()}.db`,
    );
    const backup = ensureBackup(db, backupPath);
    console.log(
      `\nBackup ${backup.created ? "created" : "already present"} at ${backup.path} ` +
        `(${backup.sizeBytes.toLocaleString()} bytes).`,
    );

    const result = backfillPricesFromOhlcv(db, {
      securityIds: securityIdList,
      from: fromArg,
      to: toArg,
      apply: true,
    });

    console.log("\nApplied:");
    for (const s of result.securities) console.log(formatSecurityReport(s, true));
    console.log(
      `\nTotals: securities processed=${result.totals.securitiesProcessed}, ` +
        `rows inserted=${result.totals.rowsInserted}, ` +
        `rows already present=${result.totals.rowsAlreadyPresent}, ` +
        `securities skipped (no bars)=${result.totals.securitiesSkipped}.`,
    );

    console.log(
      "\nReminder — this script does NOT recompute downstream derived data. Run:\n" +
        "  Valuations:  POST /api/compute/valuations (with the app running), e.g.\n" +
        "               curl -X POST http://localhost:3099/api/compute/valuations\n" +
        "               (falls back to :3000 if using `npm run dev` instead of Electron)",
    );

    db.close();
  })();
}

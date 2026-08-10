/**
 * repair-ah-closes.ts — Back-fill `prices` rows poisoned by the after-hours
 * "LAST-always-wins" tick-priority bug fixed in `lib/tws/snapshot.ts`
 * (`tickPriorityFor` — qa: net-2026-08-06-ah-close-poisoning).
 *
 * Root cause: the 30-min background snapshot sync runs after market close
 * too, and (before the fix) `TICK_PRIORITY` always preferred LAST over
 * CLOSE. An after-hours trade print then got written as "the day's close"
 * via `INSERT OR REPLACE INTO prices`, permanently overwriting the real RTH
 * close for that (security, date). Verified damage: NET 2026-08-06 stored
 * 330.00 (a post-earnings AH spike) vs the real 284.43 RTH close (+15.9%
 * error); LQDT 2026-08-06 stored 44.84 vs 42.01; ~14 (symbol, date) rows
 * were >1% off across 3 weeks (NET, APP, DELL, and the KRX-listed 402340).
 * This poisoned the evening-email anomaly engine, valuations, betas, and
 * charts — the snapshot-side fix stops new damage; this script repairs the
 * rows already written.
 *
 * `ohlcv_bars` (the daily-bar historical-data capture, NOT the snapshot
 * path) is the authority here: TWS's `1 day` bars are built from the
 * official session, so a `prices` row that disagrees with its matching
 * `ohlcv_bars` row beyond `threshold` is presumed AH-poisoned. Only rows
 * with an ACTUAL matching 1-day bar are ever touched — no bar, no guess, no
 * write (a symbol with sparse `ohlcv_bars` coverage is silently skipped,
 * not "fixed" by inference).
 *
 * What it does:
 *   1. Finds `prices` rows with `source='tws'` whose close_price disagrees
 *      with the matching `ohlcv_bars` (`bar_date = date`, `bar_size='1 day'`)
 *      close by more than `threshold` (default 1.0%, `--threshold=`).
 *   2. Prints symbol, date, stored price, bar close, diff% for every match
 *      (dry-run behavior, always).
 *   3. `--apply`: backs up `data/vanguard.db` to `data/backups/` (same
 *      VACUUM-INTO convention as `rebuild-ibkr-ledger.ts::ensureBackup` —
 *      NEVER proceeds past this step without a verified backup), then
 *      inside one transaction sets `close_price` = the bar's close for
 *      every matched row.
 *
 * Idempotent: after a successful apply, the repaired rows agree with their
 * bar closes (diff 0%), so a re-run at the same threshold finds nothing.
 *
 * NOT touched: rows with no `source='tws'` (statement/canonical data is not
 * this bug's blast radius), rows with no matching 1-day bar (no ground
 * truth to repair against), and `ohlcv_bars` itself (already correct — it's
 * the reference, not the victim).
 *
 * Downstream: this script does NOT recompute valuations or betas itself —
 * see the printed reminder after `--apply` for the exact commands.
 *
 * Usage:
 *   npx tsx scripts/repair-ah-closes.ts                       # dry-run (default)
 *   npx tsx scripts/repair-ah-closes.ts --threshold=0.5        # tighter threshold (%)
 *   npx tsx scripts/repair-ah-closes.ts --since=2026-07-20     # bound the window
 *   npx tsx scripts/repair-ah-closes.ts --apply                # write
 */

import type Database from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────

export interface AhCloseMismatch {
  priceId: number;
  securityId: number;
  symbol: string;
  date: string;
  storedClose: number;
  barClose: number;
  /** (storedClose - barClose) / barClose * 100 — signed, e.g. +15.90 */
  diffPct: number;
}

export interface AhCloseRepairResult {
  mismatches: AhCloseMismatch[];
  updated: number;
}

interface RepairOpts {
  /** Percentage points, e.g. 1.0 means 1.0%. */
  thresholdPct: number;
  /** Optional inclusive lower bound on prices.date (YYYY-MM-DD). */
  since?: string;
}

// ─── Core repair functions ─────────────────────────────────────────

interface RawMismatchRow {
  priceId: number;
  securityId: number;
  symbol: string;
  date: string;
  storedClose: number;
  barClose: number;
}

/**
 * Pure read: finds every `prices` row (source='tws') whose close disagrees
 * with its matching `ohlcv_bars` 1-day close by more than `thresholdPct`.
 * Never writes. Safe to call in both dry-run and apply modes for reporting.
 */
export function findAhCloseMismatches(
  db: Database.Database,
  opts: RepairOpts,
): AhCloseMismatch[] {
  const sinceClause = opts.since ? "AND p.date >= ?" : "";
  const params: Array<string | number> = [opts.thresholdPct / 100];
  if (opts.since) params.push(opts.since);

  const rows = db
    .prepare(
      `SELECT p.id AS priceId, p.security_id AS securityId, s.symbol AS symbol,
              p.date AS date, p.close_price AS storedClose, o.close AS barClose
       FROM prices p
       JOIN securities s ON s.id = p.security_id
       JOIN ohlcv_bars o ON o.security_id = p.security_id
                         AND o.bar_date = p.date
                         AND o.bar_size = '1 day'
       WHERE p.source = 'tws'
         AND o.close > 0
         AND ABS(p.close_price - o.close) / o.close > ?
         ${sinceClause}
       ORDER BY p.date ASC, s.symbol ASC`,
    )
    .all(...params) as RawMismatchRow[];

  return rows.map((r) => ({
    ...r,
    diffPct: ((r.storedClose - r.barClose) / r.barClose) * 100,
  }));
}

/**
 * Finds mismatches (see `findAhCloseMismatches`) and, when `opts.apply` is
 * true, rewrites each matched `prices.close_price` to the bar's close
 * inside one transaction. `opts.apply: false` computes the identical plan
 * and returns it with `updated: 0` — nothing is written.
 */
export function repairAhCloses(
  db: Database.Database,
  opts: RepairOpts & { apply: boolean },
): AhCloseRepairResult {
  const mismatches = findAhCloseMismatches(db, opts);
  let updated = 0;

  if (opts.apply && mismatches.length > 0) {
    const update = db.prepare("UPDATE prices SET close_price = ? WHERE id = ?");
    const run = db.transaction(() => {
      for (const m of mismatches) {
        update.run(m.barClose, m.priceId);
        updated++;
      }
    });
    run();
  }

  return { mismatches, updated };
}

// ─── CLI entry point ──────────────────────────────────────────────

function formatMismatch(m: AhCloseMismatch): string {
  const sign = m.diffPct >= 0 ? "+" : "";
  return (
    `  ${m.symbol.padEnd(10)} ${m.date}   ` +
    `stored=${m.storedClose.toFixed(2).padStart(10)}   ` +
    `bar_close=${m.barClose.toFixed(2).padStart(10)}   ` +
    `diff=${sign}${m.diffPct.toFixed(2)}%`
  );
}

// Detect if this file is being run directly (not imported by tests) —
// mirrors scripts/repair-acats-opening-lots.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-ah-closes.ts") ||
    process.argv[1].endsWith("repair-ah-closes.js"));

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

    const thresholdArg = args.find((a) => a.startsWith("--threshold="));
    const thresholdPct = thresholdArg ? Number(thresholdArg.slice("--threshold=".length)) : 1.0;
    if (!Number.isFinite(thresholdPct) || thresholdPct <= 0) {
      console.error(`Invalid --threshold value: ${thresholdArg}`);
      process.exit(1);
    }

    const sinceArg = args.find((a) => a.startsWith("--since="));
    const since = sinceArg ? sinceArg.slice("--since=".length) : undefined;
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      console.error(`Invalid --since value (expected YYYY-MM-DD): ${since}`);
      process.exit(1);
    }

    const dataDir = process.env.VANGUARD_DB_DIR || path.default.join(process.cwd(), "data");
    const dbPath = path.default.join(dataDir, "vanguard.db");

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    // Gated on --apply (mirrors repair-acats-opening-lots.ts / rebuild-ibkr-
    // ledger.ts): a dry run against the live DB must never write to it, and
    // runMigrations() is a write the instant a pending migration exists.
    if (apply) {
      runMigrations(db);
    }

    console.log(
      `Scanning prices (source='tws') for after-hours-close contamination ` +
        `(threshold ${thresholdPct}%${since ? `, since ${since}` : ""}) ` +
        `${apply ? "[APPLY]" : "[DRY RUN]"}`,
    );

    const mismatches = findAhCloseMismatches(db, { thresholdPct, since });

    if (mismatches.length === 0) {
      console.log("\nNo mismatches found against ohlcv_bars — nothing to do.");
      db.close();
      return;
    }

    console.log("");
    for (const m of mismatches) console.log(formatMismatch(m));
    console.log(`\n${mismatches.length} mismatch(es) found.`);

    if (!apply) {
      console.log("\nDry-run (default). Re-run with --apply to write.");
      db.close();
      return;
    }

    // NEVER proceed past this line without a verified backup — same rule
    // and same data/backups/ VACUUM-INTO convention as
    // rebuild-ibkr-ledger.ts::ensureBackup (reused directly, not
    // reimplemented, so the 0-byte / corrupt-file guards stay single-source).
    const backupPath = path.default.join(
      dataDir,
      "backups",
      `pre-ah-close-repair-${todayET()}.db`,
    );
    const backup = ensureBackup(db, backupPath);
    console.log(
      `\nBackup ${backup.created ? "created" : "already present"} at ${backup.path} ` +
        `(${backup.sizeBytes.toLocaleString()} bytes).`,
    );

    const result = repairAhCloses(db, { thresholdPct, since, apply: true });
    console.log(`\nUpdated ${result.updated} price row(s) to their ohlcv_bars close.`);

    console.log(
      "\nReminder — this script does NOT recompute downstream derived data. Run:\n" +
        "  Valuations:  POST /api/compute/valuations (with the app running), e.g.\n" +
        "               curl -X POST http://localhost:3099/api/compute/valuations\n" +
        "               (falls back to :3000 if using `npm run dev` instead of Electron)\n" +
        "  Betas:       npx tsx scripts/refresh-vanguard-betas.ts",
    );

    db.close();
  })();
}

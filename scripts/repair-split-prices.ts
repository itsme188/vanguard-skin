/**
 * repair-split-prices.ts — Back-adjust an unadjusted stock split in the
 * price series (qa:analysis-position-risk--vgt-407pct-vol-unadjusted-split).
 *
 * Root cause: TWS daily rows are never back-adjusted when a split lands.
 * VGT's 8:1 (close 809.96 on 2026-04-20 → 101.57 on 2026-04-21) left an
 * exact -87.5% phantom "daily return" in `prices` and `ohlcv_bars`, which
 * inflated Position-Level Risk volatility to 407% and broke chart/MA
 * continuity. The engine guard (isSplitSignatureReturnPair in
 * lib/compute/risk.ts) defends the vol compute; this script repairs the
 * stored series so charts, MA levels, and beta regressions heal too.
 *
 * What it does per detected split (newest first, ONE per run):
 *   1. Detects the split automatically: the newest adjacent price pair whose
 *      ratio sits within tolerance of an integer multiple >= 2 (the same
 *      signature the engine guard uses — single source).
 *   2. prices: close_price /= ratio for every row strictly before the
 *      split date.
 *   3. ohlcv_bars (all bar sizes): open/high/low/close/wap /= ratio,
 *      volume *= ratio for bars strictly before the split date.
 *   4. holdings: quantity *= ratio for rows strictly before the split date —
 *      REQUIRED so every historical qty x price product (and therefore every
 *      daily valuation) is preserved exactly. cost_basis is total dollars and
 *      is deliberately untouched.
 *   5. Recomputes daily valuations and reports per-date deltas. Deltas are
 *      expected in EXACTLY one window per account: [split date, that
 *      account's next holdings row for this security) — pre-repair those
 *      dates paired the stale PRE-split quantity with POST-split prices
 *      (an already-wrong 1/ratio valuation the repair heals). Outside that
 *      window the qty x price product is preserved and deltas must be ~0
 *      (live-verified: VGT healed ~$4.4k across 2026-04-21..29, $0
 *      everywhere else).
 *
 * Idempotent: after a successful apply the split signature no longer exists,
 * so a re-run detects nothing and no-ops. Multiple splits in one series are
 * repaired newest-first across successive runs (older discontinuities keep
 * their shape when both sides scale equally).
 *
 * NOT touched: transactions / tax lots (splits there are the SPLIT
 * transaction type's job — see the CRWD 2026-07-01 TODO), watchlist targets,
 * security levels (user-entered, native scale).
 *
 * Known trade-off: re-importing a PRE-split statement after this repair
 * would write pre-split quantities/prices back over the adjusted rows
 * (statement-wins upsert). Re-run this script if that ever happens.
 *
 * Usage:
 *   npx tsx scripts/repair-split-prices.ts VGT           # dry-run (default)
 *   npx tsx scripts/repair-split-prices.ts VGT --apply   # write
 */

import Database from "better-sqlite3";
import path from "node:path";
import { isSplitSignatureReturnPair } from "../lib/compute/risk";
import { calendarDaysBetween } from "../lib/calendar/date-utils";
import { computeDailyValuations } from "../lib/compute/daily-valuation";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");
const MAX_PAIR_GAP_DAYS = 7;

interface DetectedSplit {
  preDate: string;
  splitDate: string;
  prevClose: number;
  splitClose: number;
  ratio: number;
}

function detectNewestSplit(
  db: Database.Database,
  securityId: number,
): DetectedSplit | null {
  const rows = db
    .prepare(
      `SELECT date, close_price FROM prices
       WHERE security_id = ? AND close_price > 0
       ORDER BY date ASC`,
    )
    .all(securityId) as { date: string; close_price: number }[];

  let newest: DetectedSplit | null = null;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];
    // A pair spanning a multi-week hole is a data gap, not a split print.
    if (calendarDaysBetween(prev.date, curr.date) > MAX_PAIR_GAP_DAYS) continue;
    if (!isSplitSignatureReturnPair(prev.close_price, curr.close_price)) continue;
    const raw =
      prev.close_price > curr.close_price
        ? prev.close_price / curr.close_price
        : curr.close_price / prev.close_price;
    newest = {
      preDate: prev.date,
      splitDate: curr.date,
      prevClose: prev.close_price,
      splitClose: curr.close_price,
      ratio: Math.round(raw),
    };
  }
  return newest;
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const symbol = args.find((a) => !a.startsWith("--"));

  if (!symbol) {
    console.error("Usage: npx tsx scripts/repair-split-prices.ts <SYMBOL> [--apply]");
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const sec = db
    .prepare("SELECT id, symbol, name FROM securities WHERE symbol = ?")
    .get(symbol) as { id: number; symbol: string; name: string | null } | undefined;
  if (!sec) {
    console.error(`No security found for symbol ${symbol}`);
    process.exit(1);
  }

  const split = detectNewestSplit(db, sec.id);
  if (!split) {
    console.log(
      `${sec.symbol}: no unadjusted split signature found in prices — nothing to do.`,
    );
    return;
  }

  const forward = split.prevClose > split.splitClose;
  console.log(
    `${sec.symbol}: detected ${forward ? "" : "reverse "}split signature ` +
      `${split.ratio}:1 at ${split.splitDate} ` +
      `(close ${split.prevClose} on ${split.preDate} -> ${split.splitClose}).`,
  );

  // Forward split: divide pre-split prices by ratio, multiply quantities.
  // Reverse split: the pre-split prices are LOW relative to post — multiply
  // prices, divide quantities.
  const priceFactor = forward ? 1 / split.ratio : split.ratio;
  const qtyFactor = forward ? split.ratio : 1 / split.ratio;

  const priceCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM prices WHERE security_id = ? AND date < ?")
      .get(sec.id, split.splitDate) as { n: number }
  ).n;
  const barCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM ohlcv_bars WHERE security_id = ? AND bar_date < ?",
      )
      .get(sec.id, split.splitDate) as { n: number }
  ).n;
  const holdingCount = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM holdings WHERE security_id = ? AND as_of_date < ?",
      )
      .get(sec.id, split.splitDate) as { n: number }
  ).n;

  console.log(
    `Would adjust ${priceCount} prices rows (x${priceFactor}), ` +
      `${barCount} ohlcv_bars rows, and ${holdingCount} holdings rows ` +
      `(qty x${qtyFactor}) strictly before ${split.splitDate}.`,
  );

  if (!apply) {
    console.log("Dry-run (default). Re-run with --apply to write.");
    return;
  }

  const affectedAccounts = db
    .prepare(
      "SELECT DISTINCT account_id FROM holdings WHERE security_id = ?",
    )
    .all(sec.id) as { account_id: number }[];

  const before = db
    .prepare(
      `SELECT account_id, valuation_date, total_value FROM daily_valuations
       WHERE account_id IN (${affectedAccounts.map(() => "?").join(",") || "NULL"})`,
    )
    .all(...affectedAccounts.map((a) => a.account_id)) as {
    account_id: number;
    valuation_date: string;
    total_value: number;
  }[];

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE prices SET close_price = close_price * ? WHERE security_id = ? AND date < ?",
    ).run(priceFactor, sec.id, split.splitDate);
    db.prepare(
      `UPDATE ohlcv_bars SET
         open = open * ?, high = high * ?, low = low * ?, close = close * ?,
         wap = CASE WHEN wap IS NULL THEN NULL ELSE wap * ? END,
         volume = CASE WHEN volume IS NULL THEN NULL ELSE CAST(ROUND(volume * ?) AS INTEGER) END
       WHERE security_id = ? AND bar_date < ?`,
    ).run(
      priceFactor,
      priceFactor,
      priceFactor,
      priceFactor,
      priceFactor,
      qtyFactor,
      sec.id,
      split.splitDate,
    );
    db.prepare(
      "UPDATE holdings SET quantity = quantity * ? WHERE security_id = ? AND as_of_date < ?",
    ).run(qtyFactor, sec.id, split.splitDate);
  });
  tx();

  // Verify idempotency precondition now holds: the signature must be gone.
  const residual = detectNewestSplit(db, sec.id);
  if (residual && residual.splitDate === split.splitDate) {
    console.error(
      "ERROR: split signature still present after adjustment — inspect manually.",
    );
    process.exit(1);
  }

  // Recompute valuations and verify. Outside each account's healing window
  // (see header) the qty x price product is preserved, so deltas must be ~0;
  // inside it, a delta is the repair healing the stale-quantity mispricing.
  computeDailyValuations(db);
  const healEndStmt = db.prepare(
    `SELECT MIN(as_of_date) AS d FROM holdings
      WHERE security_id = ? AND account_id = ? AND as_of_date >= ?`,
  );
  const healEnd = new Map<number, string>();
  for (const a of affectedAccounts) {
    const r = healEndStmt.get(sec.id, a.account_id, split.splitDate) as {
      d: string | null;
    };
    healEnd.set(a.account_id, r.d ?? "9999-12-31");
  }
  let maxHealDelta = 0;
  let maxOutsideDelta = 0;
  const afterStmt = db.prepare(
    "SELECT total_value FROM daily_valuations WHERE account_id = ? AND valuation_date = ?",
  );
  for (const row of before) {
    const after = afterStmt.get(row.account_id, row.valuation_date) as
      | { total_value: number }
      | undefined;
    if (!after) continue;
    const delta = Math.abs(after.total_value - row.total_value);
    const end = healEnd.get(row.account_id) ?? "9999-12-31";
    const inHealWindow =
      row.valuation_date >= split.splitDate && row.valuation_date < end;
    if (inHealWindow) maxHealDelta = Math.max(maxHealDelta, delta);
    else maxOutsideDelta = Math.max(maxOutsideDelta, delta);
  }
  console.log(
    `Applied. Healing-window valuation delta (expected — stale pre-split qty ` +
      `was mispricing those dates): up to $${maxHealDelta.toFixed(2)}. ` +
      `Outside the healing window: $${maxOutsideDelta.toFixed(2)} (expected ~0).`,
  );
  if (maxOutsideDelta > 1) {
    console.warn(
      "WARNING: valuations moved outside the healing window — the stored " +
        "daily_valuations may have been stale before this run; inspect before trusting.",
    );
  }
  if (residual) {
    console.log(
      `Note: an OLDER split signature remains at ${residual.splitDate} ` +
        `(${residual.ratio}:1). Re-run this script to repair it next.`,
    );
  }
}

main();

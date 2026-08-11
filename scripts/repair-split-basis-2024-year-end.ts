/**
 * repair-split-basis-2024-year-end.ts — Normalize the three 2024-12-31
 * IBKR year-end statement rows to post-split share basis
 * (qa:analysis-performance--ibkr-risk-series-discontinuity-96pct-drawdown,
 * residual found during the 2026-08-10 backfill verification).
 *
 * Context: the 2025 IBKR price gap was backfilled from TWS 1-day bars
 * (scripts/backfill-prices-from-ohlcv.ts). TWS historical bars are
 * SPLIT-ADJUSTED to today's share basis, but the 2024-12-31 year-end
 * statement rows (prices, source='ibkr-activity') and the matching
 * holdings snapshot (as_of_date='2024-12-31') are in the PRE-split basis
 * of their statement date. Names that split between the statement date and
 * the TWS live era therefore sit on a mixed basis: the statement-priced
 * boundary day against the next bar-priced day reads as a fake multi-day
 * portfolio cliff, and a pre-split-basis quantity times adjusted bar
 * prices mis-scales that position's whole backfilled era (detect a
 * candidate by statement price / adjusted bar close forming an integer or
 * 1/integer ratio).
 *
 * Repair doctrine (same as scripts/repair-split-prices.ts): normalize to
 * the POST-split basis and preserve every qty x price product exactly:
 *   prices.close_price   /= r   (r = post_shares / pre_shares)
 *   holdings.quantity    *= r
 * e.g. a 2:1 split at statement close 50.00 with 10 shares:
 *   10 x 50.00 = 500  ->  20 x 25.00 = 500
 * The repaired statement price is the exact division of the statement
 * value (not the bar's rounded close) so the product is preserved to the
 * penny.
 *
 * The affected symbols and their guard values are REAL portfolio data, so
 * they live outside git in data/repair-configs/split-basis-2024-year-end.json
 * (the data/ tree is gitignored); see CONFIG_EXAMPLE below for the shape.
 *
 * NOT touched: ohlcv_bars (already adjusted — that is the point),
 * transactions / tax lots (splits there are the SPLIT transaction type's
 * job — the CRWD 2026-07-01 TODO), the 2026-era holdings rows (statement
 * reporting is post-split by then; verified via UDOW 2026-03-31).
 *
 * Guarded + idempotent: each UPDATE fires only when the row still carries
 * its known pre-split value (epsilon 0.005 for prices, 0.001 for
 * quantities). After apply the guards no longer match and a re-run
 * reports nothing to do. Known trade-off (same as repair-split-prices):
 * re-importing the 2024 year-end statement would write pre-split values
 * back over these rows — re-run this script if that ever happens.
 *
 * Usage:
 *   npx tsx scripts/repair-split-basis-2024-year-end.ts            # dry-run
 *   npx tsx scripts/repair-split-basis-2024-year-end.ts --apply    # write
 *   npx tsx scripts/repair-split-basis-2024-year-end.ts --db <path>
 *
 * After applying, recompute valuations (POST /api/compute/valuations).
 */

import type Database from "better-sqlite3";

export interface SplitBasisTarget {
  symbol: string;
  /** post_shares / pre_shares — 2 for a 2:1 forward split, 0.1 for a 1:10 reverse. */
  ratio: number;
  /** Known pre-split 2024-12-31 statement close (the guard). */
  preSplitPrice: number;
  /** Known pre-split 2024-12-31 holdings quantity (the guard). */
  preSplitQty: number;
}

/** Shape of data/repair-configs/split-basis-2024-year-end.json (gitignored). */
export const CONFIG_EXAMPLE = `[
  { "symbol": "AAAA", "ratio": 2,   "preSplitPrice": 50.00, "preSplitQty": 10 },
  { "symbol": "BBBB", "ratio": 0.1, "preSplitPrice": 4.00,  "preSplitQty": -500 }
]`;

/** Validates the parsed JSON config into SplitBasisTarget[]. Throws on shape errors. */
export function parseTargetsConfig(raw: unknown): SplitBasisTarget[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("config must be a non-empty JSON array");
  }
  return raw.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (
      typeof e.symbol !== "string" ||
      typeof e.ratio !== "number" || !(e.ratio > 0) ||
      typeof e.preSplitPrice !== "number" ||
      typeof e.preSplitQty !== "number"
    ) {
      throw new Error(
        `config entry ${i} is malformed — expected shape: ${CONFIG_EXAMPLE}`,
      );
    }
    return {
      symbol: e.symbol,
      ratio: e.ratio,
      preSplitPrice: e.preSplitPrice,
      preSplitQty: e.preSplitQty,
    };
  });
}

const STATEMENT_DATE = "2024-12-31";
const PRICE_EPS = 0.005;
const QTY_EPS = 0.001;

export interface TargetReport {
  symbol: string;
  securityId: number | null;
  priceAction: string;
  qtyAction: string;
  priceChanged: boolean;
  qtyChanged: boolean;
}

/**
 * Plans and (when apply=true) executes the normalization for every target.
 * Each row is guarded on its exact known pre-split value, so a repaired
 * row is simply reported as already-normalized on re-runs.
 */
export function repairSplitBasis(
  db: Database.Database,
  targets: SplitBasisTarget[],
  opts: { apply: boolean; accountId?: number },
): TargetReport[] {
  const accountId = opts.accountId ?? 3;
  const reports: TargetReport[] = [];

  const run = () => {
    for (const t of targets) {
      const sec = db
        .prepare("SELECT id FROM securities WHERE UPPER(symbol) = ?")
        .get(t.symbol) as { id: number } | undefined;
      if (!sec) {
        reports.push({
          symbol: t.symbol, securityId: null,
          priceAction: "security not found — skipped",
          qtyAction: "security not found — skipped",
          priceChanged: false, qtyChanged: false,
        });
        continue;
      }

      // ── prices row ────────────────────────────────────────────────
      const priceRow = db
        .prepare(
          `SELECT id, close_price, source FROM prices
            WHERE security_id = ? AND date = ?`,
        )
        .get(sec.id, STATEMENT_DATE) as
        | { id: number; close_price: number; source: string }
        | undefined;

      const newPrice = t.preSplitPrice / t.ratio;
      let priceAction: string;
      let priceChanged = false;
      if (!priceRow) {
        priceAction = `no prices row on ${STATEMENT_DATE} — skipped`;
      } else if (Math.abs(priceRow.close_price - newPrice) <= PRICE_EPS) {
        priceAction = `already normalized (${priceRow.close_price})`;
      } else if (Math.abs(priceRow.close_price - t.preSplitPrice) > PRICE_EPS) {
        priceAction =
          `UNEXPECTED value ${priceRow.close_price} (guard expects ` +
          `${t.preSplitPrice}) — refusing to touch`;
      } else {
        priceAction = `${priceRow.close_price} -> ${newPrice} (${priceRow.source})`;
        priceChanged = true;
        if (opts.apply) {
          db.prepare("UPDATE prices SET close_price = ? WHERE id = ?").run(
            newPrice, priceRow.id,
          );
        }
      }

      // ── holdings row ──────────────────────────────────────────────
      const holdingRow = db
        .prepare(
          `SELECT id, quantity FROM holdings
            WHERE account_id = ? AND security_id = ? AND as_of_date = ?`,
        )
        .get(accountId, sec.id, STATEMENT_DATE) as
        | { id: number; quantity: number }
        | undefined;

      const newQty = t.preSplitQty * t.ratio;
      let qtyAction: string;
      let qtyChanged = false;
      if (!holdingRow) {
        qtyAction = `no holdings row on ${STATEMENT_DATE} — skipped`;
      } else if (Math.abs(holdingRow.quantity - newQty) <= QTY_EPS) {
        qtyAction = `already normalized (${holdingRow.quantity})`;
      } else if (Math.abs(holdingRow.quantity - t.preSplitQty) > QTY_EPS) {
        qtyAction =
          `UNEXPECTED quantity ${holdingRow.quantity} (guard expects ` +
          `${t.preSplitQty}) — refusing to touch`;
      } else {
        qtyAction = `${holdingRow.quantity} -> ${newQty}`;
        qtyChanged = true;
        if (opts.apply) {
          db.prepare("UPDATE holdings SET quantity = ? WHERE id = ?").run(
            newQty, holdingRow.id,
          );
        }
      }

      reports.push({
        symbol: t.symbol, securityId: sec.id,
        priceAction, qtyAction, priceChanged, qtyChanged,
      });
    }
  };

  db.transaction(run)();
  return reports;
}

// ─── CLI entry point ──────────────────────────────────────────────

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-split-basis-2024-year-end.ts") ||
    process.argv[1].endsWith("repair-split-basis-2024-year-end.js"));

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { ensureBackup } = await import("@/scripts/rebuild-ibkr-ledger");
    const path = await import("node:path");
    const fs = await import("node:fs");

    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const dbFlagIdx = args.indexOf("--db");
    const dataDir = process.env.VANGUARD_DB_DIR || path.default.join(process.cwd(), "data");
    const dbPath =
      dbFlagIdx !== -1 && args[dbFlagIdx + 1]
        ? args[dbFlagIdx + 1]
        : path.default.join(dataDir, "vanguard.db");

    if (!fs.default.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
      return;
    }

    const configPath = path.default.join(
      dataDir, "repair-configs", "split-basis-2024-year-end.json",
    );
    if (!fs.default.existsSync(configPath)) {
      console.error(
        `Config not found at ${configPath}\n` +
          `The affected symbols + guard values are real portfolio data and ` +
          `live outside git. Create the file as a JSON array of targets:\n` +
          `${CONFIG_EXAMPLE}\n` +
          `(ratio = post_shares / pre_shares; preSplitPrice/preSplitQty are ` +
          `the known statement-date values used as write guards.)`,
      );
      process.exit(1);
      return;
    }
    let targets: SplitBasisTarget[];
    try {
      targets = parseTargetsConfig(
        JSON.parse(fs.default.readFileSync(configPath, "utf-8")),
      );
    } catch (err) {
      console.error(`Bad config at ${configPath}: ${(err as Error).message}`);
      process.exit(1);
      return;
    }

    const db = new BetterSqlite3(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    console.log(
      `Normalizing 2024-12-31 IBKR statement rows to post-split basis ` +
        `${apply ? "[APPLY]" : "[DRY RUN]"}`,
    );

    const plan = repairSplitBasis(db, targets, { apply: false });
    for (const r of plan) {
      console.log(`  ${r.symbol.padEnd(5)} price: ${r.priceAction}`);
      console.log(`        qty:   ${r.qtyAction}`);
    }

    const anythingToDo = plan.some((r) => r.priceChanged || r.qtyChanged);
    if (!anythingToDo) {
      console.log("\nNothing to repair — all rows already normalized.");
      db.close();
      return;
    }
    if (!apply) {
      console.log("\nDry-run (default). Re-run with --apply to write.");
      db.close();
      return;
    }

    const backupPath = path.default.join(
      dataDir, "backups",
      `pre-split-basis-2024-year-end-repair.db`,
    );
    const backup = ensureBackup(db, backupPath);
    console.log(
      `\nBackup ${backup.created ? "created" : "already present"} at ${backup.path}.`,
    );

    const applied = repairSplitBasis(db, targets, { apply: true });
    for (const r of applied) {
      console.log(`  ${r.symbol.padEnd(5)} price: ${r.priceAction}`);
      console.log(`        qty:   ${r.qtyAction}`);
    }
    console.log(
      "\nDone. Recompute valuations now: curl -X POST http://localhost:3099/api/compute/valuations",
    );
    db.close();
  })();
}

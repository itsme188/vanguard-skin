/**
 * repair-mistyped-option-legs.ts — One-off repair for two Vanguard-Taxable
 * option transcription defects found in the 2026-08-19 activity-report
 * reconciliation (broker's 2018-2026 custom activity report is authoritative):
 *
 * 1. DUPLICATE option rows: 22 trades were transcribed twice under two
 *    different option-symbol spellings — a legacy spaced-strike form
 *    ("SHOP 250620 P 80.00") and the OCC form ("SHOP  250620P00080000").
 *    source_key embeds the symbol, so dedupe never collapsed them and every
 *    affected option position/realized-P&L is doubled. Fix: within each
 *    exact-duplicate group (account, security, trade_date, type, quantity,
 *    price), delete the row(s) whose source_key uses the legacy spelling,
 *    keeping exactly one OCC-keyed row (current transcription convention —
 *    re-imports of today's files dedupe against it).
 *
 * 2. MISTYPED closing legs: 7 option closes were transcribed SELL_TO_OPEN
 *    (report says "Sell to close"), which opens a phantom short lot instead
 *    of closing the long. The CSVs were corrected 2026-08-19; this rewrites
 *    the DB rows' type AND the :SELL_TO_OPEN: segment of their source_key
 *    together (repair-buy-sign-post-april precedent) so re-importing the
 *    corrected files dedups instead of duplicating. Plus one quantity fix:
 *    the GOOG 2025-05-16 EXPIRED row recorded 2 contracts; the report shows
 *    1 (2 were sold to close 05-07, 1 expired).
 *
 * USER-RUN / interactive-session script — never auto-invoked. Dry-run by
 * default; --apply takes a VACUUM INTO backup first, then runs everything in
 * one transaction and recomputes tax lots.
 *
 * Usage:
 *   npx tsx scripts/repair-mistyped-option-legs.ts            # dry-run
 *   npx tsx scripts/repair-mistyped-option-legs.ts --apply
 *   npx tsx scripts/repair-mistyped-option-legs.ts --db <path>
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/** Legacy spaced-strike option spelling inside a source_key, e.g. ":SHOP 250620 P 80.00:" */
const LEGACY_KEY_RE = /:[A-Z/.]{1,6} \d{6} [CP] [\d.]+:/;

export interface DupPlan {
  deleteId: number;
  keepId: number;
  label: string;
}

/** Find legacy-keyed duplicates of OCC-keyed rows (same account/security/date/type/qty/price). */
export function planDuplicateDeletions(db: Database.Database): DupPlan[] {
  const groups = db
    .prepare(
      `SELECT t.security_id, t.trade_date, t.type, t.quantity, t.price_per_share
         FROM transactions t
         JOIN securities s ON s.id = t.security_id
        WHERE t.account_id = 1 AND t.quantity IS NOT NULL
          AND LOWER(COALESCE(s.security_type,'')) = 'option'
        GROUP BY t.security_id, t.trade_date, t.type, t.quantity, t.price_per_share
       HAVING COUNT(*) > 1`
    )
    .all() as { security_id: number; trade_date: string; type: string; quantity: number; price_per_share: number | null }[];

  const plans: DupPlan[] = [];
  for (const g of groups) {
    const rows = db
      .prepare(
        `SELECT t.id, t.source_key, s.symbol FROM transactions t
           JOIN securities s ON s.id = t.security_id
          WHERE t.account_id = 1 AND t.security_id = ? AND t.trade_date = ?
            AND t.type = ? AND t.quantity = ?
            AND (t.price_per_share IS ? OR t.price_per_share = ?)`
      )
      .all(g.security_id, g.trade_date, g.type, g.quantity, g.price_per_share, g.price_per_share) as {
      id: number; source_key: string | null; symbol: string;
    }[];
    const legacy = rows.filter((r) => r.source_key && LEGACY_KEY_RE.test(r.source_key));
    const occ = rows.filter((r) => !r.source_key || !LEGACY_KEY_RE.test(r.source_key));
    // Only act when the group is exactly one-legacy + one-OCC — anything else
    // is not the known disease shape and is left alone (reported by caller).
    if (legacy.length === 1 && occ.length === 1) {
      plans.push({
        deleteId: legacy[0].id,
        keepId: occ[0].id,
        label: `${rows[0].symbol.trim()} ${g.trade_date} ${g.type} qty=${g.quantity}`,
      });
    }
  }
  return plans;
}

/** The 7 mistyped closing legs (values from the broker activity report). */
export const RETYPE_TARGETS = [
  { occSymbol: "GOOG  250516P00160000", tradeDate: "2025-05-07", quantity: 2 },
  { occSymbol: "VEU   250620C00060000", tradeDate: "2025-06-06", quantity: 5 },
  { occSymbol: "QQQ   250815P00556000", tradeDate: "2025-08-05", quantity: 10 },
  { occSymbol: "APP   251017P00450000", tradeDate: "2025-10-01", quantity: 1 },
  { occSymbol: "XHB   260116P00110000", tradeDate: "2025-10-09", quantity: 5 },
  { occSymbol: "XHB   260116P00110000", tradeDate: "2025-10-10", quantity: 5 },
  { occSymbol: "META  251107P00700000", tradeDate: "2025-11-04", quantity: 1 },
] as const;

export interface RetypePlan {
  id: number;
  label: string;
  newKey: string | null;
  action: string;
  ok: boolean;
}

export function planRetypes(db: Database.Database): RetypePlan[] {
  const plans: RetypePlan[] = [];
  for (const t of RETYPE_TARGETS) {
    const label = `${t.occSymbol.trim()} ${t.tradeDate} SELL_TO_OPEN→SELL_TO_CLOSE qty=${t.quantity}`;
    const rows = db
      .prepare(
        `SELECT t.id, t.source_key FROM transactions t
           JOIN securities s ON s.id = t.security_id
          WHERE t.account_id = 1 AND s.symbol = ? AND t.trade_date = ?
            AND t.type = 'SELL_TO_OPEN' AND t.quantity = ?`
      )
      .all(t.occSymbol, t.tradeDate, t.quantity) as { id: number; source_key: string | null }[];
    if (rows.length === 0) {
      // already repaired (idempotent re-run) if the CLOSE row exists
      const done = db
        .prepare(
          `SELECT COUNT(*) AS n FROM transactions t JOIN securities s ON s.id = t.security_id
            WHERE t.account_id = 1 AND s.symbol = ? AND t.trade_date = ?
              AND t.type = 'SELL_TO_CLOSE' AND t.quantity = ?`
        )
        .get(t.occSymbol, t.tradeDate, t.quantity) as { n: number };
      plans.push({ id: -1, label, newKey: null, ok: done.n > 0, action: done.n > 0 ? "already repaired" : "ROW NOT FOUND — refusing" });
      continue;
    }
    if (rows.length > 1) {
      plans.push({ id: -1, label, newKey: null, ok: false, action: `UNEXPECTED ${rows.length} matching rows — refusing` });
      continue;
    }
    const row = rows[0];
    const newKey = row.source_key ? row.source_key.replace(":SELL_TO_OPEN:", ":SELL_TO_CLOSE:") : null;
    if (newKey && newKey !== row.source_key) {
      const clash = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE source_key = ?`).get(newKey) as { n: number };
      if (clash.n > 0) {
        plans.push({ id: row.id, label, newKey, ok: false, action: "new source_key already exists — refusing" });
        continue;
      }
    }
    plans.push({ id: row.id, label, newKey, ok: true, action: "retype + key rewrite" });
  }
  return plans;
}

/**
 * IBKR ran a 4:1 share split 2025-06-18 and the broker adjusted option
 * positions in place (same OCC symbol, contracts ×4, premium basis ÷4 — the
 * report shows "+3" split legs on each contract). The split legs were never
 * transcribed, so the two pre-split BUY_TO_OPEN rows carry pre-split basis.
 * Product-preserving normalization (quantity ×4, price ÷4, amount + source_key
 * untouched) — same doctrine as scripts/repair-split-basis-audit.ts, which
 * deliberately excludes option securities.
 */
export const OPTION_SPLIT_TARGETS = [
  { occSymbol: "IBKR  250620P00140000", tradeDate: "2025-04-17", type: "BUY_TO_OPEN", preQty: 1, ratio: 4 },
  { occSymbol: "IBKR  270115C00220000", tradeDate: "2025-04-17", type: "BUY_TO_OPEN", preQty: 1, ratio: 4 },
] as const;

export interface OptionSplitPlan {
  id: number;
  label: string;
  ok: boolean;
  action: string;
  newQty?: number;
  newPrice?: number | null;
}

export function planOptionSplits(db: Database.Database, excludeIds: number[] = []): OptionSplitPlan[] {
  const plans: OptionSplitPlan[] = [];
  for (const t of OPTION_SPLIT_TARGETS) {
    const label = `${t.occSymbol.trim()} ${t.tradeDate} ${t.type} ×${t.ratio}`;
    const rows = (db
      .prepare(
        `SELECT t.id, t.quantity, t.price_per_share FROM transactions t
           JOIN securities s ON s.id = t.security_id
          WHERE t.account_id = 1 AND s.symbol = ? AND t.trade_date = ? AND t.type = ?`
      )
      .all(t.occSymbol, t.tradeDate, t.type) as { id: number; quantity: number; price_per_share: number | null }[])
      // the legacy-keyed duplicate of this same trade may still exist at
      // planning time — it is deleted in the same apply transaction
      .filter((r) => !excludeIds.includes(r.id));
    if (rows.length !== 1) {
      plans.push({ id: -1, label, ok: false, action: `expected 1 row, found ${rows.length} (run after dedup)` });
      continue;
    }
    const row = rows[0];
    if (Math.abs(row.quantity - t.preQty * t.ratio) < 1e-9) {
      plans.push({ id: row.id, label, ok: true, action: "already normalized" });
      continue;
    }
    if (Math.abs(row.quantity - t.preQty) > 1e-9) {
      plans.push({ id: row.id, label, ok: false, action: `UNEXPECTED qty ${row.quantity} — refusing` });
      continue;
    }
    plans.push({
      id: row.id, label, ok: true, action: "normalize",
      newQty: row.quantity * t.ratio,
      newPrice: row.price_per_share != null ? row.price_per_share / t.ratio : null,
    });
  }
  return plans;
}

/** GOOG 2025-05-16 EXPIRED quantity 2 → 1 (report: 1 contract expired). */
export function planExpiredQtyFix(db: Database.Database): RetypePlan {
  const label = "GOOG 250516P00160000 2025-05-16 EXPIRED qty 2→1";
  const rows = db
    .prepare(
      `SELECT t.id, t.quantity FROM transactions t JOIN securities s ON s.id = t.security_id
        WHERE t.account_id = 1 AND s.symbol = 'GOOG  250516P00160000'
          AND t.trade_date = '2025-05-16' AND t.type = 'EXPIRED'`
    )
    .all() as { id: number; quantity: number }[];
  if (rows.length !== 1) return { id: -1, label, newKey: null, ok: false, action: `expected 1 row, found ${rows.length}` };
  if (Math.abs(rows[0].quantity - 1) < 1e-9) return { id: rows[0].id, label, newKey: null, ok: true, action: "already repaired" };
  if (Math.abs(rows[0].quantity - 2) > 1e-9) return { id: rows[0].id, label, newKey: null, ok: false, action: `UNEXPECTED qty ${rows[0].quantity} — refusing` };
  return { id: rows[0].id, label, newKey: null, ok: true, action: "qty 2→1" };
}

// ─── CLI ─────────────────────────────────────────────────────────

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  /repair-mistyped-option-legs\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  (async () => {
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const dbFlagIdx = args.indexOf("--db");
    const dbPath =
      dbFlagIdx !== -1 && args[dbFlagIdx + 1]
        ? args[dbFlagIdx + 1]
        : path.join(process.cwd(), "data", "vanguard.db");
    if (!fs.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }
    const db = new BetterSqlite3(dbPath, { timeout: 60000 });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    const dups = planDuplicateDeletions(db);
    const retypes = planRetypes(db);
    const expFix = planExpiredQtyFix(db);
    const optSplits = planOptionSplits(db, dups.map((d) => d.deleteId));

    console.log(`\n── Duplicate legacy-keyed option rows: ${dups.length} ──`);
    for (const d of dups) console.log(`  delete txn ${d.deleteId} (keep ${d.keepId}): ${d.label}`);
    console.log(`\n── Mistyped closing legs ──`);
    for (const r of retypes) console.log(`  ${r.ok ? "·" : "✗"} ${r.label}: ${r.action}`);
    console.log(`  ${expFix.ok ? "·" : "✗"} ${expFix.label}: ${expFix.action}`);
    console.log(`\n── IBKR 4:1 option-split normalization ──`);
    for (const o of optSplits) {
      const detail = o.action === "normalize" ? ` (qty→${o.newQty}, px→${o.newPrice})` : "";
      console.log(`  ${o.ok ? "·" : "✗"} ${o.label}: ${o.action}${detail}`);
    }

    const refusals = [...retypes, expFix, ...optSplits].filter((r) => !r.ok);
    if (refusals.length > 0) {
      console.log(`\n${refusals.length} refusal(s) above — resolve before applying.`);
    }
    const work =
      dups.length +
      retypes.filter((r) => r.ok && r.id !== -1 && r.action !== "already repaired").length +
      (expFix.ok && expFix.action === "qty 2→1" ? 1 : 0) +
      optSplits.filter((o) => o.action === "normalize").length;
    if (work === 0) {
      console.log("\nNothing to repair — all rows already normalized.");
      db.close();
      return;
    }
    if (!apply) {
      console.log(`\nDry-run (default). Re-run with --apply to repair ${work} row(s) + recompute tax lots.`);
      db.close();
      return;
    }
    if (refusals.length > 0) {
      console.error("\nRefusing to apply while refusals stand.");
      db.close();
      process.exit(1);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `pre-mistyped-option-legs-${timestamp}.db`);
    db.prepare("VACUUM INTO ?").run(backupPath);
    console.log(`\nBackup: ${backupPath}`);

    const run = db.transaction(() => {
      // Lots are wiped + rebuilt by computeTaxLots below; clear them first so
      // FK references to the deleted duplicate rows cannot block the DELETE.
      db.prepare("DELETE FROM tax_lot_sales").run();
      db.prepare("DELETE FROM tax_lots").run();
      for (const d of dups) db.prepare("DELETE FROM transactions WHERE id = ?").run(d.deleteId);
      for (const r of retypes) {
        if (r.id === -1 || r.action !== "retype + key rewrite") continue;
        db.prepare("UPDATE transactions SET type = 'SELL_TO_CLOSE', source_key = ? WHERE id = ?").run(r.newKey, r.id);
      }
      if (expFix.action === "qty 2→1") {
        db.prepare("UPDATE transactions SET quantity = 1 WHERE id = ?").run(expFix.id);
      }
      for (const o of optSplits) {
        if (o.action !== "normalize") continue;
        db.prepare("UPDATE transactions SET quantity = ?, price_per_share = ? WHERE id = ?").run(o.newQty, o.newPrice, o.id);
      }
    });
    run();

    const { computeTaxLots } = await import("@/lib/compute/tax-lots");
    const lots = computeTaxLots(db);
    console.log(`\nRepaired. Tax lots recomputed (${lots.lotsCreated} lots).`);
    console.log("Recompute valuations next: POST /api/compute/valuations (or the audit script's apply step does it).");
    db.close();
  })();
}

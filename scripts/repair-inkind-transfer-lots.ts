/**
 * repair-inkind-transfer-lots.ts — rewrite ONE synthetic in-kind TRANSFER_IN
 * row into the true carryover lots behind it.
 *
 * Why: an in-kind distribution (a fund handing out shares) arrives as one
 * ledger row, but the fund's tax estimate lists several carryover lots with
 * their own acquisition dates and basis. The 2026-08 donation backfill
 * wrote one row for the FIRST lot with a guessed quantity; the broker's
 * activity report later showed the whole distribution reached the account.
 * The engine reads acquisition date and basis off the TRANSFER_IN rows
 * (FIFO, long-term test), so the row set has to match the estimate.
 *
 * What it does (all-or-nothing, one transaction):
 *   - UPDATEs the existing row in place to lot[0] (quantity, price, amount,
 *     notes, source_key) so every donation_lots assignment that points at
 *     its id stays valid;
 *   - INSERTs one TRANSFER_IN row per further lot under the same import
 *     batch, with the canonical source_key shape the importer derives
 *     (`canonical:txn:<account>:<symbol>:<date>:TRANSFER_IN:<cents>`) so a
 *     re-import of the corrected canonical file dedupes instead of
 *     duplicating;
 *   - bumps the tax input generation (lots are stale until the user runs
 *     the recompute).
 *
 * It refuses when the row is not a TRANSFER_IN, when the assignments
 * already pointing at it exceed lot[0], when a target source_key already
 * exists on a different row, or when the config is malformed. Re-running
 * after apply reports "already repaired".
 *
 * Config (gitignored — real figures): data/repair-configs/<name>.json
 *   { account, symbol, existingTransactionId, source,
 *     lots: [{ acquisitionDate, quantity, basisPerShare }, …] }
 *
 * Usage (from the repo root):
 *   REPAIR_CONFIG_PATH=data/repair-configs/x.json npx tsx scripts/repair-inkind-transfer-lots.ts
 *   REPAIR_DB_PATH=/tmp/rehearsal.db REPAIR_CONFIG_PATH=… npx tsx scripts/repair-inkind-transfer-lots.ts --apply
 *   REPAIR_CONFIG_PATH=… npx tsx scripts/repair-inkind-transfer-lots.ts --apply      # live
 */

import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { bumpTaxGenerationIfPresent } from "../lib/compute/tax-convention";

export interface InKindLot {
  acquisitionDate: string;
  quantity: number;
  basisPerShare: number;
}

export interface InKindLotConfig {
  account: string;
  symbol: string;
  existingTransactionId: number;
  source: string;
  lots: InKindLot[];
}

export interface InKindPlan {
  ok: boolean;
  status: "repair" | "already-repaired" | "refused";
  reason?: string;
  update?: { id: number; quantity: number; price: number; amount: number; sourceKey: string; notes: string };
  inserts?: { tradeDate: string; quantity: number; price: number; amount: number; sourceKey: string; notes: string }[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cents(amount: number): number {
  return Math.round(amount * 100);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function canonicalKey(account: string, symbol: string, date: string, amount: number): string {
  return `canonical:txn:${account}:${symbol}:${date}:TRANSFER_IN:${cents(amount)}`;
}

export function validateConfig(raw: unknown): InKindLotConfig {
  if (raw == null || typeof raw !== "object") throw new Error("config must be an object");
  const c = raw as Record<string, unknown>;
  if (typeof c.account !== "string" || !c.account) throw new Error("config.account required");
  if (typeof c.symbol !== "string" || !c.symbol) throw new Error("config.symbol required");
  if (typeof c.existingTransactionId !== "number" || !Number.isInteger(c.existingTransactionId))
    throw new Error("config.existingTransactionId must be an integer");
  if (typeof c.source !== "string" || !c.source) throw new Error("config.source required");
  if (!Array.isArray(c.lots) || c.lots.length === 0) throw new Error("config.lots must be a non-empty array");
  const lots = c.lots.map((l, i) => {
    if (l == null || typeof l !== "object") throw new Error(`lots[${i}] must be an object`);
    const x = l as Record<string, unknown>;
    if (typeof x.acquisitionDate !== "string" || !DATE_RE.test(x.acquisitionDate))
      throw new Error(`lots[${i}].acquisitionDate must be YYYY-MM-DD`);
    if (typeof x.quantity !== "number" || !(x.quantity > 0)) throw new Error(`lots[${i}].quantity must be > 0`);
    if (typeof x.basisPerShare !== "number" || !(x.basisPerShare >= 0))
      throw new Error(`lots[${i}].basisPerShare must be >= 0`);
    return { acquisitionDate: x.acquisitionDate, quantity: x.quantity, basisPerShare: x.basisPerShare };
  });
  const dates = new Set(lots.map((l) => l.acquisitionDate));
  if (dates.size !== lots.length) throw new Error("lots must have distinct acquisition dates");
  return { account: c.account, symbol: c.symbol, existingTransactionId: c.existingTransactionId, source: c.source, lots };
}

function noteFor(config: InKindLotConfig, lot: InKindLot, index: number): string {
  return (
    `In-kind distribution carryover lot ${index + 1}/${config.lots.length}: ` +
    `${lot.quantity} sh acquired ${lot.acquisitionDate} @ $${lot.basisPerShare}/sh. ` +
    `Source: ${config.source}. Rewritten 2026-09-15 by repair-inkind-transfer-lots.ts.`
  );
}

export function planInKindLots(db: Database.Database, config: InKindLotConfig): InKindPlan {
  const row = db
    .prepare(
      `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type, t.quantity, t.source_key,
              a.name AS account_name, s.symbol
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN securities s ON s.id = t.security_id
        WHERE t.id = ?`
    )
    .get(config.existingTransactionId) as
    | { id: number; account_id: number; security_id: number; trade_date: string; type: string; quantity: number; source_key: string; account_name: string; symbol: string }
    | undefined;
  if (!row) return { ok: false, status: "refused", reason: `transaction ${config.existingTransactionId} not found` };
  if (row.type.toUpperCase() !== "TRANSFER_IN") return { ok: false, status: "refused", reason: `transaction ${row.id} is ${row.type}, not TRANSFER_IN` };
  if (row.account_name !== config.account || row.symbol !== config.symbol)
    return { ok: false, status: "refused", reason: `transaction ${row.id} is ${row.account_name}/${row.symbol}, config says ${config.account}/${config.symbol}` };

  const [first, ...rest] = config.lots;
  if (row.trade_date !== first.acquisitionDate)
    return { ok: false, status: "refused", reason: `existing row is dated ${row.trade_date}; lots[0] is ${first.acquisitionDate} — lots[0] must be the existing row's lot` };

  const assigned = (db
    .prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM donation_lots WHERE acquisition_transaction_id = ?`)
    .get(row.id) as { q: number }).q;
  if (assigned > first.quantity + 1e-9)
    return { ok: false, status: "refused", reason: `donation assignments on transaction ${row.id} total ${assigned} > lots[0].quantity ${first.quantity}` };

  const firstAmount = round2(first.quantity * first.basisPerShare);
  const firstKey = canonicalKey(config.account, config.symbol, first.acquisitionDate, firstAmount);
  const inserts = rest.map((lot, i) => {
    const amount = round2(lot.quantity * lot.basisPerShare);
    return {
      tradeDate: lot.acquisitionDate,
      quantity: lot.quantity,
      price: lot.basisPerShare,
      amount,
      sourceKey: canonicalKey(config.account, config.symbol, lot.acquisitionDate, amount),
      notes: noteFor(config, lot, i + 1),
    };
  });

  // Already repaired: existing row carries lot[0] and every insert key exists on a same-shape row.
  const existingKeyRows = inserts.map(
    (ins) =>
      db.prepare(`SELECT id, quantity FROM transactions WHERE source_key = ?`).get(ins.sourceKey) as
        | { id: number; quantity: number }
        | undefined
  );
  const firstDone = Math.abs(row.quantity - first.quantity) < 1e-9 && row.source_key === firstKey;
  const allDone = existingKeyRows.every((r, i) => r && Math.abs(r.quantity - inserts[i].quantity) < 1e-9);
  if (firstDone && allDone) return { ok: true, status: "already-repaired" };

  for (const [i, r] of existingKeyRows.entries()) {
    if (r && Math.abs(r.quantity - inserts[i].quantity) > 1e-9)
      return { ok: false, status: "refused", reason: `source_key ${inserts[i].sourceKey} exists on transaction ${r.id} with quantity ${r.quantity}` };
  }
  const firstKeyOwner = db.prepare(`SELECT id FROM transactions WHERE source_key = ?`).get(firstKey) as { id: number } | undefined;
  if (firstKeyOwner && firstKeyOwner.id !== row.id)
    return { ok: false, status: "refused", reason: `source_key ${firstKey} already exists on transaction ${firstKeyOwner.id}` };

  return {
    ok: true,
    status: "repair",
    update: { id: row.id, quantity: first.quantity, price: first.basisPerShare, amount: firstAmount, sourceKey: firstKey, notes: noteFor(config, first, 0) },
    inserts: inserts.filter((_, i) => !existingKeyRows[i]),
  };
}

export function applyInKindLots(db: Database.Database, config: InKindLotConfig, plan: InKindPlan): { updated: number; inserted: number } {
  if (!plan.ok || plan.status !== "repair" || !plan.update) throw new Error("nothing to apply");
  const template = db
    .prepare(`SELECT account_id, security_id, import_batch_id, is_external_flow FROM transactions WHERE id = ?`)
    .get(plan.update.id) as { account_id: number; security_id: number; import_batch_id: number | null; is_external_flow: number | null };
  return db.transaction(() => {
    const u = db
      .prepare(
        `UPDATE transactions SET quantity = ?, price_per_share = ?, amount = ?, notes = ?, source_key = ? WHERE id = ?`
      )
      .run(plan.update!.quantity, plan.update!.price, plan.update!.amount, plan.update!.notes, plan.update!.sourceKey, plan.update!.id);
    const ins = db.prepare(
      `INSERT INTO transactions
         (account_id, security_id, import_batch_id, trade_date, settlement_date, type, quantity, amount, price_per_share, fees, is_external_flow, source_key, notes)
       VALUES (?, ?, ?, ?, NULL, 'TRANSFER_IN', ?, ?, ?, NULL, ?, ?, ?)`
    );
    let inserted = 0;
    for (const r of plan.inserts ?? []) {
      ins.run(template.account_id, template.security_id, template.import_batch_id, r.tradeDate, r.quantity, r.amount, r.price, template.is_external_flow ?? 0, r.sourceKey, r.notes);
      inserted++;
    }
    bumpTaxGenerationIfPresent(db);
    return { updated: u.changes, inserted };
  })();
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const dbPath = process.env.REPAIR_DB_PATH ?? path.join(process.cwd(), "data", "vanguard.db");
  const configPath = process.env.REPAIR_CONFIG_PATH;
  if (!configPath) throw new Error("REPAIR_CONFIG_PATH is required (gitignored data/repair-configs/<name>.json)");
  const config = validateConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
  const db = new BetterSqlite3(dbPath, { readonly: !apply });
  try {
    console.log(`In-kind transfer lot repair [${apply ? "APPLY" : "DRY RUN"}] — db: ${dbPath}`);
    console.log(`  ${config.account} / ${config.symbol} — transaction ${config.existingTransactionId} → ${config.lots.length} lot(s)`);
    const plan = planInKindLots(db, config);
    if (!plan.ok) {
      console.error(`  REFUSED: ${plan.reason}`);
      process.exitCode = 1;
      return;
    }
    if (plan.status === "already-repaired") {
      console.log("  already repaired — nothing to do");
      return;
    }
    console.log(`  update  txn ${plan.update!.id}: qty → ${plan.update!.quantity}, price → ${plan.update!.price}, amount → ${plan.update!.amount}`);
    for (const r of plan.inserts ?? []) console.log(`  insert  ${r.tradeDate} TRANSFER_IN qty ${r.quantity} @ ${r.price} = ${r.amount}`);
    if (!apply) {
      console.log("\nDry run (default). Re-run with --apply to write (REPAIR_DB_PATH for a rehearsal copy).");
      return;
    }
    const backupDir = path.join(path.dirname(dbPath), "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `pre-inkind-lots-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    db.prepare("VACUUM INTO ?").run(backupPath);
    console.log(`  Backup: ${backupPath}`);
    const result = applyInKindLots(db, config, plan);
    console.log(`  Applied: ${result.updated} updated, ${result.inserted} inserted; tax generation bumped — run the recompute next.`);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] != null && /repair-inkind-transfer-lots\.(ts|js)$/.test(process.argv[1]);
if (isMain) main();

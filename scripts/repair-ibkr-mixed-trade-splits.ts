/**
 * repair-ibkr-mixed-trade-splits.ts: splits an IBKR "mixed" trade (codes
 * C;O, closing part of one side and opening the other) into its closing leg
 * and its opening leg, so the tax-lot replay books it the way the broker did.
 *
 * The defect (owner decision 23, 2026-11-16): IBKR's activity statement can
 * list two fills of one day in an order that differs from the order its own
 * lot accounting used. Example shape (synthetic): long 500, then
 *   10:00:00 SELL 500  codes C;O
 *   10:05:00 SELL 100  codes C
 *   10:30:00 BUY  100  codes C
 * The broker's codes and basis say the SELL 100 was booked first: the SELL
 * 500 closed 400 and opened a 100 short, which the BUY 100 then covered.
 * Replayed by timestamp, `computeTaxLots` (lib/compute/tax-lots.ts, the
 * mixed-trade branch of processTrade) finds 500 long before the SELL 500,
 * cannot split it ("cannot be split from the available lots") and drops the
 * whole trade; the BUY 100 then finds no short to cover and is dropped too.
 * 400 phantom shares stay open, every later sale of the name takes the wrong
 * lots, and the broker-close pass finally books the phantom as a synthetic
 * RECONCILE_CLOSE at a month-end price.
 *
 * The repair writes what the broker's own figures show, and nothing else:
 *   - the mixed row keeps its id, source_key, date, price and broker time;
 *     its quantity, amount and fees become the CLOSING share, and its
 *     direction evidence becomes close-only;
 *   - one new row (same account, security, batch, date, type, price, time)
 *     carries the OPENING share, with source_key `<original>:split-open` and
 *     open-only direction evidence;
 *   - amount and fees of the two rows add up to the original exactly (the
 *     opening row takes the remainder), so cash is unchanged;
 *   - tax_input_generation is bumped once (the stored lots go stale until a
 *     rehearsed recompute).
 * A re-import of the same statement is a no-op (the original source_key
 * still exists), and the direction backfill refuses the changed row (its
 * quantity no longer matches the file) rather than rewriting it.
 *
 * Config (GITIGNORED, the repo is public), default
 * `data/repair-configs/ibkr-mixed-trade-splits.json`:
 *
 *   {
 *     "accountName": "<exact accounts.name>",
 *     "splits": [{
 *       "transactionId": 123, "sourceKey": "ibkr:trade:...",
 *       "symbol": "ZZA", "tradeDate": "YYYY-MM-DD", "type": "SELL",
 *       "quantity": 500, "amount": 15000, "fees": 3,
 *       "closeQuantity": 400, "openQuantity": 100,
 *       "evidence": "why the broker's own figures give this split"
 *     }]
 *   }
 *
 * Safety:
 *   - The database path is REQUIRED (`--db <path>` or REPAIR_DB_PATH) and is
 *     printed before the database is opened. There is no default.
 *   - Dry-run by default (read-only open); `--apply` writes.
 *   - Every configured row must be in its exact before-state (or already
 *     split, which is skipped). Anything else refuses the WHOLE run.
 *   - All writes happen in ONE transaction and are re-read and re-checked
 *     before commit; any mismatch rolls everything back.
 *   - Idempotent: a second run finds every row already split.
 *   - On --apply a VACUUM INTO backup is written next to the database
 *     (`<db dir>/backups/pre-ibkr-mixed-trade-splits-<ET date>_<HH-MM-SS>.db`),
 *     a fresh one on every --apply; if that file already exists the run is
 *     refused and nothing is written.
 *
 * Does NOT recompute lots. After --apply, rehearse and run the recompute
 * (scripts/recompute-tax-lots-v2.ts).
 *
 * Usage (run from the repo root):
 *   npx tsx scripts/repair-ibkr-mixed-trade-splits.ts --db /path/copy.db
 *   npx tsx scripts/repair-ibkr-mixed-trade-splits.ts --db /path/copy.db --apply
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { readIbkrTradeDirection, type IbkrTradeDirection } from "@/lib/import/ibkr-trade-direction";
import { bumpTaxGenerationIfPresent } from "@/lib/compute/tax-convention";
import { takeBackup } from "@/lib/backup/take-backup";

// ─── Types ────────────────────────────────────────────────────────

export interface SplitConfig {
  transactionId: number;
  sourceKey: string;
  symbol: string;
  tradeDate: string;
  type: string;
  quantity: number;
  amount: number;
  fees: number;
  closeQuantity: number;
  openQuantity: number;
  evidence: string;
}

export interface RepairConfig {
  accountName: string;
  splits: SplitConfig[];
}

export type SplitState = "needs-repair" | "already-repaired";

export interface PlannedSplit {
  config: SplitConfig;
  state: SplitState;
  time: string;
}

export interface RepairPlan {
  accountId: number;
  splits: PlannedSplit[];
  /** Reasons the run is refused. Non-empty = nothing may be written. */
  refusals: string[];
}

export interface RepairResult {
  plan: RepairPlan;
  applied: boolean;
  split: number;
}

const DIRECTION_PREFIX = "IBKR trade direction: ";
const QTY_TOLERANCE = 1e-8;
const MONEY_TOLERANCE = 0.005;

export function splitOpenSourceKey(sourceKey: string): string {
  return `${sourceKey}:split-open`;
}

function same(a: number | null, b: number, tol: number): boolean {
  return a != null && Math.abs(a - b) <= tol;
}

// ─── Config parsing ───────────────────────────────────────────────

function num(obj: Record<string, unknown>, key: string, where: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${where}: "${key}" must be a finite number`);
  return v;
}

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${where}: "${key}" must be a non-empty string`);
  return v;
}

/** Validates the config shape. Throws with a precise message on any defect. */
export function parseRepairConfig(raw: unknown): RepairConfig {
  if (!raw || typeof raw !== "object") throw new Error("config: not an object");
  const obj = raw as Record<string, unknown>;
  const accountName = str(obj, "accountName", "config");
  if (!Array.isArray(obj.splits) || obj.splits.length === 0) {
    throw new Error("config: splits must be a non-empty array");
  }
  const seen = new Set<number>();
  const splits = obj.splits.map((s, i): SplitConfig => {
    const where = `config.splits[${i}]`;
    if (!s || typeof s !== "object") throw new Error(`${where}: not an object`);
    const o = s as Record<string, unknown>;
    const transactionId = num(o, "transactionId", where);
    if (!Number.isInteger(transactionId)) throw new Error(`${where}: transactionId must be an integer`);
    if (seen.has(transactionId)) throw new Error(`${where}: duplicate transactionId ${transactionId}`);
    seen.add(transactionId);
    const cfg: SplitConfig = {
      transactionId,
      sourceKey: str(o, "sourceKey", where),
      symbol: str(o, "symbol", where),
      tradeDate: str(o, "tradeDate", where),
      type: str(o, "type", where),
      quantity: num(o, "quantity", where),
      amount: num(o, "amount", where),
      fees: num(o, "fees", where),
      closeQuantity: num(o, "closeQuantity", where),
      openQuantity: num(o, "openQuantity", where),
      evidence: str(o, "evidence", where),
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.tradeDate)) throw new Error(`${where}: tradeDate must be YYYY-MM-DD`);
    if (!["BUY", "SELL"].includes(cfg.type)) throw new Error(`${where}: type must be BUY or SELL`);
    if (!cfg.sourceKey.startsWith("ibkr:trade:")) throw new Error(`${where}: sourceKey must be an ibkr:trade: key`);
    if (cfg.closeQuantity <= 0 || cfg.openQuantity <= 0) {
      throw new Error(`${where}: closeQuantity and openQuantity must both be positive`);
    }
    if (Math.abs(cfg.closeQuantity + cfg.openQuantity - cfg.quantity) > QTY_TOLERANCE) {
      throw new Error(`${where}: closeQuantity + openQuantity must equal quantity`);
    }
    return cfg;
  });
  return { accountName, splits };
}

// ─── Plan (read only) ─────────────────────────────────────────────

interface TxnRow {
  id: number;
  account_id: number;
  security_id: number | null;
  import_batch_id: number | null;
  trade_date: string;
  settlement_date: string | null;
  type: string;
  quantity: number | null;
  amount: number | null;
  price_per_share: number | null;
  fees: number | null;
  is_external_flow: number | null;
  source_key: string | null;
  notes: string | null;
  symbol: string | null;
}

const SELECT_BY_ID = `SELECT t.*, s.symbol FROM transactions t
  LEFT JOIN securities s ON s.id = t.security_id WHERE t.id = ?`;
const SELECT_BY_KEY = `SELECT t.*, s.symbol FROM transactions t
  LEFT JOIN securities s ON s.id = t.security_id WHERE t.source_key = ?`;

function isDirection(d: IbkrTradeDirection | null, open: boolean, close: boolean): d is IbkrTradeDirection {
  return d != null && d.open === open && d.close === close;
}

/**
 * Pure read. For every configured split, decides whether the row is in its
 * exact before-state (one mixed row, no split row), already split, or
 * neither (a refusal).
 */
export function planMixedTradeSplits(db: Database.Database, config: RepairConfig): RepairPlan {
  const refusals: string[] = [];
  const account = db.prepare("SELECT id FROM accounts WHERE name = ?").get(config.accountName) as
    | { id: number }
    | undefined;
  if (!account) {
    return { accountId: -1, splits: [], refusals: [`no account named exactly "${config.accountName}"`] };
  }
  const byId = db.prepare(SELECT_BY_ID);
  const byKey = db.prepare(SELECT_BY_KEY);
  const splits: PlannedSplit[] = [];

  for (const cfg of config.splits) {
    const label = `transaction ${cfg.transactionId} (${cfg.symbol} ${cfg.tradeDate})`;
    const row = byId.get(cfg.transactionId) as TxnRow | undefined;
    if (!row) {
      refusals.push(`${label}: no such transaction`);
      continue;
    }
    if (row.account_id !== account.id || row.source_key !== cfg.sourceKey || row.symbol !== cfg.symbol ||
        row.trade_date !== cfg.tradeDate || row.type !== cfg.type) {
      refusals.push(`${label}: account, source_key, symbol, date or type differ from the config`);
      continue;
    }
    const direction = readIbkrTradeDirection(row.notes);
    if (!direction || !direction.time.startsWith(cfg.tradeDate)) {
      refusals.push(`${label}: no IBKR direction evidence with a broker time on the trade date`);
      continue;
    }
    const twin = byKey.get(splitOpenSourceKey(cfg.sourceKey)) as TxnRow | undefined;

    const isBefore =
      !twin &&
      isDirection(direction, true, true) &&
      same(row.quantity, cfg.quantity, QTY_TOLERANCE) &&
      same(row.amount, cfg.amount, MONEY_TOLERANCE) &&
      same(row.fees, cfg.fees, MONEY_TOLERANCE);

    const twinDirection = twin ? readIbkrTradeDirection(twin.notes) : null;
    const isAfter =
      twin != null &&
      isDirection(direction, false, true) &&
      isDirection(twinDirection, true, false) &&
      twinDirection.time === direction.time &&
      twin.account_id === row.account_id &&
      twin.security_id === row.security_id &&
      twin.trade_date === row.trade_date &&
      twin.type === row.type &&
      twin.id > row.id &&
      same(row.quantity, cfg.closeQuantity, QTY_TOLERANCE) &&
      same(twin.quantity, cfg.openQuantity, QTY_TOLERANCE) &&
      row.amount != null && twin.amount != null &&
      same(row.amount + twin.amount, cfg.amount, MONEY_TOLERANCE) &&
      row.fees != null && twin.fees != null &&
      same(row.fees + twin.fees, cfg.fees, MONEY_TOLERANCE);

    if (!isBefore && !isAfter) {
      refusals.push(
        `${label}: matches neither the expected mixed before-state nor the split after-state` +
          (twin ? " (a split-open row exists but does not match)" : ""),
      );
      continue;
    }
    splits.push({ config: cfg, state: isBefore ? "needs-repair" : "already-repaired", time: direction.time });
  }
  return { accountId: account.id, splits, refusals };
}

// ─── Apply (one transaction) ──────────────────────────────────────

function directionLine(open: boolean, close: boolean, time: string): string {
  return DIRECTION_PREFIX + JSON.stringify({ open, close, time });
}

/** Replaces the direction line, keeps every other line, appends the audit line. */
function rewriteNotes(notes: string | null, newDirection: string, audit: string): string {
  const lines = (notes ?? "").split("\n").filter((l) => l !== "" && !l.startsWith(DIRECTION_PREFIX));
  return [newDirection, ...lines, audit].join("\n");
}

/**
 * Plans and, with `apply: true`, splits every "needs-repair" row in ONE
 * transaction. Refuses (throws, writes nothing) when the plan has any
 * refusal. Re-reads both rows inside the transaction; a mismatch throws and
 * rolls the whole batch back.
 */
export function runMixedTradeSplits(
  db: Database.Database,
  config: RepairConfig,
  opts: { apply: boolean; today: string },
): RepairResult {
  const plan = planMixedTradeSplits(db, config);
  if (plan.refusals.length > 0) {
    if (opts.apply) throw new Error(`refusing to write; nothing changed:\n  - ${plan.refusals.join("\n  - ")}`);
    return { plan, applied: false, split: 0 };
  }
  const todo = plan.splits.filter((s) => s.state === "needs-repair");
  if (!opts.apply || todo.length === 0) return { plan, applied: opts.apply, split: 0 };

  const byId = db.prepare(SELECT_BY_ID);
  const update = db.prepare("UPDATE transactions SET quantity = ?, amount = ?, fees = ?, notes = ? WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, import_batch_id, trade_date, settlement_date, type, quantity,
        amount, price_per_share, fees, is_external_flow, source_key, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const split = db.transaction(() => {
    let n = 0;
    for (const { config: cfg, time } of todo) {
      const row = byId.get(cfg.transactionId) as TxnRow;
      const fraction = cfg.closeQuantity / cfg.quantity;
      const closeAmount = row.amount! * fraction;
      const closeFees = row.fees! * fraction;
      const openAmount = row.amount! - closeAmount;
      const openFees = row.fees! - closeFees;
      const openKey = splitOpenSourceKey(cfg.sourceKey);
      const audit =
        `Repair ${opts.today}: broker mixed trade (codes C;O) of ${cfg.quantity} split into a closing leg of ` +
        `${cfg.closeQuantity} (row ${cfg.transactionId}, ${cfg.sourceKey}) and an opening leg of ` +
        `${cfg.openQuantity} (${openKey}); original amount ${row.amount}, fees ${row.fees}. ${cfg.evidence}`;

      const upd = update.run(
        cfg.closeQuantity,
        closeAmount,
        closeFees,
        rewriteNotes(row.notes, directionLine(false, true, time), audit),
        row.id,
      );
      if (upd.changes !== 1) throw new Error(`${cfg.transactionId}: expected 1 row updated, got ${upd.changes}`);
      const ins = insert.run(
        row.account_id, row.security_id, row.import_batch_id, row.trade_date, row.settlement_date, row.type,
        cfg.openQuantity, openAmount, row.price_per_share, openFees, row.is_external_flow, openKey,
        [directionLine(true, false, time), audit].join("\n"),
      );
      if (ins.changes !== 1) throw new Error(`${cfg.transactionId}: split-open row not inserted`);
      n++;
    }
    bumpTaxGenerationIfPresent(db);
    const recheck = planMixedTradeSplits(db, config);
    const notDone = recheck.refusals.length > 0 || recheck.splits.some((s) => s.state !== "already-repaired");
    if (notDone) throw new Error(`re-read does not match the split rows; rolled back: ${recheck.refusals.join("; ")}`);
    return n;
  })();

  return { plan, applied: true, split };
}

// ─── CLI ──────────────────────────────────────────────────────────

function printPlan(result: RepairResult): void {
  for (const s of result.plan.splits) {
    const c = s.config;
    console.log(
      `  ${c.transactionId} ${c.symbol} ${c.tradeDate} ${c.type} ${c.quantity}: ${s.state}` +
        (s.state === "needs-repair" ? ` -> close ${c.closeQuantity} + open ${c.openQuantity}` : ""),
    );
  }
  for (const reason of result.plan.refusals) console.log(`  REFUSED: ${reason}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  /repair-ibkr-mixed-trade-splits\.(ts|js)$/.test(process.argv[1]);

if (isMain) {
  (async () => {
    const args = process.argv.slice(2);
    const argValue = (flag: string): string | undefined => {
      const eq = args.find((a) => a.startsWith(`${flag}=`));
      if (eq) return eq.slice(flag.length + 1);
      const i = args.indexOf(flag);
      return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
    };
    const apply = args.includes("--apply");
    const dbPath = argValue("--db") ?? process.env.REPAIR_DB_PATH;
    const configPath =
      argValue("--config") ??
      process.env.REPAIR_CONFIG_PATH ??
      path.join(process.cwd(), "data", "repair-configs", "ibkr-mixed-trade-splits.json");

    if (!dbPath) {
      console.error("No database named. Pass --db <path> or set REPAIR_DB_PATH (there is no default).");
      process.exit(1);
    }
    console.log(`[repair-ibkr-mixed-trade-splits] ${apply ? "APPLY" : "DRY RUN"}, db: ${dbPath}`);
    console.log(`[repair-ibkr-mixed-trade-splits] config: ${configPath}`);
    if (!fs.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }

    const config = parseRepairConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { todayET } = await import("@/lib/calendar/date-utils");
    const today = todayET();
    const db = new BetterSqlite3(dbPath, { readonly: !apply, fileMustExist: true, timeout: 60_000 });
    try {
      if (apply) db.pragma("foreign_keys = ON");
      const preview = runMixedTradeSplits(db, config, { apply: false, today });
      printPlan(preview);
      if (preview.plan.refusals.length > 0) {
        console.error("Refused: nothing written.");
        process.exitCode = 1;
        return;
      }
      const todo = preview.plan.splits.filter((s) => s.state === "needs-repair").length;
      if (todo === 0) {
        console.log("Every row is already split. Nothing to do.");
        return;
      }
      if (!apply) {
        console.log(`Dry run: ${todo} row(s) would be split. Re-run with --apply to write.`);
        return;
      }
      const backup = await takeBackup(db, { purpose: "pre-ibkr-mixed-trade-splits" });
      console.log(`Backup created: ${backup.path}`);
      const result = runMixedTradeSplits(db, config, { apply: true, today });
      console.log(`Split ${result.split} row(s) in one transaction. Recompute tax lots next (rehearsed).`);
    } finally {
      db.close();
    }
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

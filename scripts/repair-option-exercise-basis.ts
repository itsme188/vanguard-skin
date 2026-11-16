/**
 * repair-option-exercise-basis.ts: makes option exercise rows complete enough
 * for the tax-lot engine to move the option premium onto the stock leg.
 *
 * The defect (owner decision 16, 2026-11-16): `computeExerciseLinks`
 * (lib/compute/tax-lots.ts) links an EXERCISED / ASSIGNED option close to its
 * stock leg only when the row carries a non-zero `price_per_share`, and it
 * reads only those two types. Two import shapes miss that:
 *   - a Vanguard EXERCISED row with no price, and a Vanguard exercise booked
 *     as CORPORATE_ACTION ("Security Exchanged"), which closes nothing;
 *   - an IBKR exercise (activity code "C;Ex") imported as SELL_TO_CLOSE at $0.
 * The engine then books the premium as a realized option loss (or leaves the
 * option lot open) while the stock leg sits at the strike: a long call's
 * shares show an understated cost, a long put's sale overstated proceeds.
 * The broker's own records (cost-basis download, gifted-lot summary, Form
 * 8949 worksheet) carry strike plus or minus the premium.
 *
 * The repair edits ONLY the option close row: its `type` (EXERCISED for a
 * long option, ASSIGNED for a short one) and its `price_per_share`, and it
 * appends one line to `notes`. The price written is the STRIKE, read from the
 * option security: the price per share at which the exercise delivered the
 * stock, which is how the Transactions table, the security page and the chat
 * show it. It must equal the linked stock leg's price within one cent. The
 * engine never reads this price as dollars: `computeExerciseLinks` needs it
 * only to be non-zero (evidence of an exercise), `processSell` closes an
 * EXERCISED / ASSIGNED row at $0 whatever its price, and the premium that
 * rolls is the option lot's STORED cost. So a strike and a premium-per-share
 * price give the same tax result. Nothing is written to tax_lots: the next
 * tax-lot recompute moves the premium. `source_key`, `amount`, `quantity` and
 * the trade date never change, so a re-import of the same statement stays a
 * no-op.
 *
 * The rows come from a GITIGNORED config (the repo is public), default
 * `data/repair-configs/option-exercise-basis.json`:
 *
 *   {
 *     "note": "optional text appended to notes",
 *     "rows": [{
 *       "transactionId": 123,
 *       "accountName": "<exact accounts.name>",
 *       "optionSymbol": "<exact securities.symbol of the option>",
 *       "tradeDate": "YYYY-MM-DD",
 *       "quantity": 1,
 *       "before": { "type": "SELL_TO_CLOSE", "pricePerShare": 0 },
 *       "after":  { "type": "EXERCISED" },
 *       "premiumPerShare": 1.23,
 *       "stockLegTransactionId": 456
 *     }]
 *   }
 *
 * `after` carries no price: the strike is read from the option. The optional
 * `premiumPerShare` only recognises a row that an earlier version of this
 * script priced at the premium (rehearsal copies only); such a row is
 * rewritten to the strike.
 *
 * The script does not trust the config: the stock leg must be in the same
 * account, on the option's underlying, within one day, for exactly
 * quantity x multiplier shares at the strike, on the side the exercise
 * implies (long call / short put: BUY; long put / short call: SELL). IBKR
 * broker evidence on the row, when present, must say close-only. After the
 * writes, inside the same transaction, the engine's own `computeExerciseLinks`
 * must link every repaired row to exactly its configured stock leg, or the
 * whole run rolls back. A put whose stock leg is coded part close, part open
 * (a SELL that closed part of a long and opened a short with the rest) IS
 * included: the engine's mixed-trade split books both parts and the premium
 * lands on the sale. (A put exercised into a SHORT_SELL row is not linked by
 * the engine's lookup, which reads only BUY / SELL: leave such a row out.)
 *
 * Safety:
 *   - The database path is REQUIRED (`--db <path>` or REPAIR_DB_PATH) and is
 *     printed before the database is opened. There is no default.
 *   - Dry-run by default: the file is opened read-only, and the whole write
 *     (including the link check) is rehearsed on an in-memory copy.
 *     `--compare` also recomputes tax lots on two in-memory copies (without
 *     and with the repair) and prints the realized change per tax year.
 *   - Every row must be in its exact "before" state, already at its "after"
 *     type and the strike (skipped), or at its "after" type and the configured
 *     premiumPerShare (rewritten to the strike). Anything else refuses the
 *     WHOLE run.
 *   - All writes happen in ONE transaction; the tax-input generation is
 *     bumped in it, so the tax-lot convention reads stale until a recompute.
 *   - Idempotent: a second run finds every row repaired and writes nothing.
 *   - On --apply a VACUUM INTO backup is written next to the database
 *     (`<db dir>/backups/pre-option-exercise-basis-repair-<ET date>_<HH-MM-SS>.db`),
 *     a fresh one on every --apply; if that file already exists the run is
 *     refused and nothing is written.
 *
 * After --apply, recompute tax lots (rehearse first):
 *   REPAIR_DB_PATH=<db> npx tsx scripts/recompute-tax-lots-v2.ts --apply
 *
 * Usage (run from the repo root):
 *   npx tsx scripts/repair-option-exercise-basis.ts --db /path/copy.db [--compare]
 *   npx tsx scripts/repair-option-exercise-basis.ts --db /path/copy.db --apply
 *   REPAIR_DB_PATH=/path/copy.db REPAIR_CONFIG_PATH=/path/cfg.json \
 *     npx tsx scripts/repair-option-exercise-basis.ts --apply
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { computeExerciseLinks } from "../lib/compute/tax-lots";
import { bumpTaxGenerationIfPresent } from "../lib/compute/tax-convention";
import { readIbkrTradeDirection } from "../lib/import/ibkr-trade-direction";
import { takeBackup } from "../lib/backup/take-backup";

// ─── Types ────────────────────────────────────────────────────────

export const EXERCISE_TYPES = ["EXERCISED", "ASSIGNED"] as const;
export type ExerciseType = (typeof EXERCISE_TYPES)[number];

export interface RowState {
  type: string;
  pricePerShare: number | null;
}

export interface RepairRowConfig {
  transactionId: number;
  accountName: string;
  optionSymbol: string;
  tradeDate: string;
  quantity: number;
  before: RowState;
  /** The price is not configured: it is the option's strike. */
  after: { type: ExerciseType };
  /**
   * Optional: the premium per share an earlier version of this script wrote.
   * A row found at the "after" type and this price is rewritten to the strike.
   */
  premiumPerShare?: number;
  stockLegTransactionId: number;
}

export interface RepairConfig {
  note?: string;
  rows: RepairRowConfig[];
}

export type PlannedState = "needs-repair" | "premium-to-strike" | "already-repaired";

export interface PlannedRow {
  config: RepairRowConfig;
  state: PlannedState;
  notes: string | null;
  /** The option's strike: the price written to the row. */
  strike: number;
  /** The row's price as found. */
  currentPrice: number | null;
}

export interface RepairPlan {
  rows: PlannedRow[];
  /** Reasons the run is refused. Non-empty = nothing may be written. */
  refusals: string[];
}

export interface RepairResult {
  plan: RepairPlan;
  applied: boolean;
  updated: number;
}

const PRICE_TOLERANCE = 1e-6;
const QTY_TOLERANCE = 1e-6;
/** The strike must equal the stock leg's price within one cent. */
const STRIKE_LEG_TOLERANCE = 0.01 + 1e-9;

function samePrice(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= PRICE_TOLERANCE;
}

// ─── Config parsing ───────────────────────────────────────────────

function positiveInt(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error(`${where} must be a positive integer`);
  }
  return v;
}

function nonEmpty(v: unknown, where: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${where} must be a non-empty string`);
  return v;
}

/** Validates the config shape. Throws with a precise message on any defect. */
export function parseRepairConfig(raw: unknown): RepairConfig {
  if (!raw || typeof raw !== "object") throw new Error("config: not an object");
  const obj = raw as Record<string, unknown>;
  if (obj.note !== undefined && typeof obj.note !== "string") {
    throw new Error("config: note must be a string when present");
  }
  if (!Array.isArray(obj.rows) || obj.rows.length === 0) {
    throw new Error("config: rows must be a non-empty array");
  }
  const seenTxn = new Set<number>();
  const rows = obj.rows.map((r, i): RepairRowConfig => {
    const where = `config.rows[${i}]`;
    if (!r || typeof r !== "object") throw new Error(`${where}: not an object`);
    const row = r as Record<string, unknown>;
    const transactionId = positiveInt(row.transactionId, `${where}.transactionId`);
    if (seenTxn.has(transactionId)) throw new Error(`${where}: duplicate transactionId ${transactionId}`);
    seenTxn.add(transactionId);
    const tradeDate = nonEmpty(row.tradeDate, `${where}.tradeDate`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error(`${where}.tradeDate must be YYYY-MM-DD`);
    const quantity = row.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`${where}.quantity must be a positive number`);
    }
    const before = row.before as Record<string, unknown> | undefined;
    const after = row.after as Record<string, unknown> | undefined;
    if (!before || typeof before !== "object") throw new Error(`${where}.before must be an object`);
    if (!after || typeof after !== "object") throw new Error(`${where}.after must be an object`);
    const beforeType = nonEmpty(before.type, `${where}.before.type`);
    if (!("pricePerShare" in before)) throw new Error(`${where}.before.pricePerShare missing (use null for an empty price)`);
    const bp = before.pricePerShare;
    if (bp !== null && (typeof bp !== "number" || !Number.isFinite(bp))) {
      throw new Error(`${where}.before.pricePerShare must be a number or null`);
    }
    const afterType = after.type;
    if (!EXERCISE_TYPES.includes(afterType as ExerciseType)) {
      throw new Error(`${where}.after.type must be EXERCISED or ASSIGNED`);
    }
    if ("pricePerShare" in after) {
      throw new Error(
        `${where}.after.pricePerShare is no longer read: the repaired price is the option's strike. ` +
          "Move an earlier premium value to premiumPerShare",
      );
    }
    const pp = row.premiumPerShare;
    if (pp !== undefined && (typeof pp !== "number" || !Number.isFinite(pp) || pp <= 0)) {
      throw new Error(`${where}.premiumPerShare must be a positive number when present`);
    }
    return {
      transactionId,
      accountName: nonEmpty(row.accountName, `${where}.accountName`),
      optionSymbol: nonEmpty(row.optionSymbol, `${where}.optionSymbol`),
      tradeDate,
      quantity,
      before: { type: beforeType, pricePerShare: bp as number | null },
      after: { type: afterType as ExerciseType },
      ...(pp !== undefined ? { premiumPerShare: pp as number } : {}),
      stockLegTransactionId: positiveInt(row.stockLegTransactionId, `${where}.stockLegTransactionId`),
    };
  });
  return { note: obj.note as string | undefined, rows };
}

// ─── Plan (read only) ─────────────────────────────────────────────

interface OptionRow {
  id: number;
  account_id: number;
  account_name: string | null;
  trade_date: string;
  type: string;
  quantity: number;
  price_per_share: number | null;
  notes: string | null;
  symbol: string;
  security_type: string | null;
  underlying_symbol: string | null;
  option_type: string | null;
  strike_price: number | null;
  multiplier: number;
}

interface LegRow {
  id: number;
  account_id: number;
  trade_date: string;
  type: string;
  quantity: number;
  price_per_share: number | null;
  symbol: string;
  security_type: string | null;
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * Pure read. For every configured row: is it in its "before" state, already
 * repaired, or neither (a refusal); and does its stock leg really look like
 * the delivery of this exercise.
 */
export function planOptionExerciseRepair(db: Database.Database, config: RepairConfig): RepairPlan {
  const refusals: string[] = [];
  const rows: PlannedRow[] = [];
  const optStmt = db.prepare(
    `SELECT t.id, t.account_id, a.name AS account_name, t.trade_date, t.type, t.quantity,
            t.price_per_share, t.notes, s.symbol, s.security_type, s.underlying_symbol,
            s.option_type, s.strike_price, COALESCE(s.multiplier, 100) AS multiplier
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.id = ?`,
  );
  const legStmt = db.prepare(
    `SELECT t.id, t.account_id, t.trade_date, t.type, t.quantity, t.price_per_share,
            s.symbol, s.security_type
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
      WHERE t.id = ?`,
  );
  const legsTaken = new Set<number>();

  for (const cfg of config.rows) {
    const label = `transaction ${cfg.transactionId}`;
    const opt = optStmt.get(cfg.transactionId) as OptionRow | undefined;
    if (!opt) {
      refusals.push(`${label}: not found`);
      continue;
    }
    const problems: string[] = [];
    if (opt.account_name !== cfg.accountName) problems.push("account differs from the config");
    if (opt.symbol !== cfg.optionSymbol) problems.push("option symbol differs from the config");
    if ((opt.security_type ?? "").toLowerCase() !== "option") problems.push("security is not an option");
    if (opt.underlying_symbol == null || opt.option_type == null || opt.strike_price == null) {
      problems.push("option has no underlying, call/put or strike recorded (the engine cannot link it)");
    }
    if (opt.trade_date !== cfg.tradeDate) problems.push("trade date differs from the config");
    if (Math.abs(opt.quantity - cfg.quantity) > QTY_TOLERANCE) problems.push("quantity differs from the config");

    const strike = opt.strike_price;
    const isBefore =
      opt.type === cfg.before.type && samePrice(opt.price_per_share, cfg.before.pricePerShare);
    const isAtStrike =
      strike != null && opt.type === cfg.after.type && samePrice(opt.price_per_share, strike);
    const isAtPremium =
      !isAtStrike &&
      cfg.premiumPerShare !== undefined &&
      opt.type === cfg.after.type &&
      samePrice(opt.price_per_share, cfg.premiumPerShare);
    if (!isBefore && !isAtStrike && !isAtPremium) {
      problems.push(
        `row is in neither the expected before-state nor the repaired state (type ${opt.type}, price ${opt.price_per_share ?? "NULL"})`,
      );
    }

    const evidence = readIbkrTradeDirection(opt.notes);
    if (evidence && (evidence.open || !evidence.close)) {
      problems.push("broker trade direction on the row is not close-only");
    }

    // The stock leg must be the delivery of exactly this exercise.
    const isLong = cfg.after.type === "EXERCISED";
    const isCall = (opt.option_type ?? "").toUpperCase() === "CALL";
    const expectedLegType = isCall === isLong ? "buy" : "sell";
    const leg = legStmt.get(cfg.stockLegTransactionId) as LegRow | undefined;
    if (!leg) {
      problems.push(`stock leg ${cfg.stockLegTransactionId} not found`);
    } else {
      if (legsTaken.has(leg.id)) problems.push(`stock leg ${leg.id} is named by two config rows`);
      legsTaken.add(leg.id);
      if (leg.account_id !== opt.account_id) problems.push("stock leg is in another account");
      if (leg.symbol !== opt.underlying_symbol || (leg.security_type ?? "").toLowerCase() === "option") {
        problems.push("stock leg is not on the option's underlying");
      }
      if (daysApart(leg.trade_date, opt.trade_date) > 1) problems.push("stock leg is more than one day away");
      if (leg.type.toLowerCase() !== expectedLegType) {
        problems.push(`stock leg type ${leg.type} is not ${expectedLegType.toUpperCase()} (a ${isLong ? "long" : "short"} ${isCall ? "call" : "put"})`);
      }
      if (Math.abs(Math.abs(leg.quantity) - cfg.quantity * opt.multiplier) > QTY_TOLERANCE) {
        problems.push("stock leg quantity is not contracts x multiplier");
      }
      if (leg.price_per_share == null || strike == null ||
          Math.abs(leg.price_per_share - strike) > STRIKE_LEG_TOLERANCE) {
        problems.push("stock leg price is not the strike (within one cent)");
      }
    }

    if (problems.length > 0) {
      refusals.push(`${label}: ${problems.join("; ")}`);
      continue;
    }
    rows.push({
      config: cfg,
      state: isAtStrike ? "already-repaired" : isBefore ? "needs-repair" : "premium-to-strike",
      notes: opt.notes,
      strike: strike as number,
      currentPrice: opt.price_per_share,
    });
  }
  return { rows, refusals };
}

// ─── Apply (one transaction) ──────────────────────────────────────

export function defaultRepairNote(today: string): string {
  return (
    `repaired ${today}: option exercise typed and priced at the strike, the price per share the stock was delivered at; ` +
    "the premium moves onto the stock leg from the option lot's stored cost (repair-option-exercise-basis)"
  );
}

/** The line appended when a row priced at the premium is rewritten to the strike. */
export function premiumToStrikeNote(today: string): string {
  return (
    `repaired ${today}: exercise price changed from the premium per share to the strike, the price per share the stock was delivered at; ` +
    "the tax result is unchanged (repair-option-exercise-basis)"
  );
}

/**
 * Plans and, with `apply: true`, writes every "needs-repair" row in ONE
 * transaction, then requires the engine's own link lookup to link each
 * repaired row to exactly its configured stock leg. Refuses (throws, writes
 * nothing) when the plan has any refusal or a link check fails.
 */
export function runOptionExerciseRepair(
  db: Database.Database,
  config: RepairConfig,
  opts: { apply: boolean; today: string },
): RepairResult {
  const plan = planOptionExerciseRepair(db, config);
  if (plan.refusals.length > 0) {
    if (opts.apply) {
      throw new Error(`refusing to write; nothing changed:\n  - ${plan.refusals.join("\n  - ")}`);
    }
    return { plan, applied: false, updated: 0 };
  }
  const todo = plan.rows.filter((r) => r.state !== "already-repaired");
  if (!opts.apply || todo.length === 0) return { plan, applied: opts.apply, updated: 0 };

  // The guard re-checks the exact state the plan found (type and price).
  const update = db.prepare(
    `UPDATE transactions SET type = ?, price_per_share = ?, notes = ?
      WHERE id = ? AND type = ?
        AND ((? IS NULL AND price_per_share IS NULL) OR ABS(price_per_share - ?) <= ${PRICE_TOLERANCE})`,
  );
  const reread = db.prepare("SELECT type, price_per_share FROM transactions WHERE id = ?");

  const updated = db.transaction(() => {
    let n = 0;
    for (const r of todo) {
      const c = r.config;
      const fromPremium = r.state === "premium-to-strike";
      const noteLine = config.note ?? (fromPremium ? premiumToStrikeNote(opts.today) : defaultRepairNote(opts.today));
      const notes = r.notes ? `${r.notes}\n${noteLine}` : noteLine;
      const fromType = fromPremium ? c.after.type : c.before.type;
      const fromPrice = fromPremium ? (c.premiumPerShare as number) : c.before.pricePerShare;
      const res = update.run(c.after.type, r.strike, notes, c.transactionId, fromType, fromPrice, fromPrice);
      if (res.changes !== 1) {
        throw new Error(`transaction ${c.transactionId}: expected 1 row updated, got ${res.changes}; rolled back`);
      }
      const after = reread.get(c.transactionId) as { type: string; price_per_share: number | null };
      if (after.type !== c.after.type || !samePrice(after.price_per_share, r.strike)) {
        throw new Error(`transaction ${c.transactionId}: re-read does not match the repaired row; rolled back`);
      }
      n++;
    }
    // The engine's own lookup must now link every configured row (repaired
    // now or earlier) to exactly its stock leg.
    const { links } = computeExerciseLinks(db);
    for (const r of plan.rows) {
      const link = links.get(r.config.transactionId);
      if (!link || link.stockTxnId !== r.config.stockLegTransactionId) {
        throw new Error(
          `transaction ${r.config.transactionId}: the engine links it to ${link ? `transaction ${link.stockTxnId}` : "no stock leg"}, not ${r.config.stockLegTransactionId}; rolled back`,
        );
      }
    }
    bumpTaxGenerationIfPresent(db);
    return n;
  })();

  return { plan, applied: true, updated };
}

/**
 * The database image for an in-memory rehearsal copy. A WAL-mode file (the
 * live database is one) serializes with the WAL flag in its header, and an
 * in-memory database opened from that image refuses every write. Header
 * bytes 18 and 19 are the file-format write/read versions (2 = WAL, 1 =
 * rollback journal); setting both to 1 makes the copy writable. The source
 * database is never touched.
 */
export function rehearsalImage(db: Database.Database): Buffer {
  const image = db.serialize();
  image[18] = 1;
  image[19] = 1;
  return image;
}

// ─── CLI ──────────────────────────────────────────────────────────

function printPlan(plan: RepairPlan): void {
  for (const r of plan.rows) {
    const c = r.config;
    const change =
      r.state === "already-repaired"
        ? ` (${c.after.type} @ strike ${r.strike})`
        : `: ${r.state === "needs-repair" ? c.before.type : c.after.type} @ ${r.currentPrice ?? "NULL"} -> ${c.after.type} @ strike ${r.strike}`;
    console.log(`  transaction ${c.transactionId} (${c.tradeDate}, stock leg ${c.stockLegTransactionId}): ${r.state}${change}`);
  }
  for (const reason of plan.refusals) console.log(`  REFUSED: ${reason}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  /repair-option-exercise-basis\.(ts|js)$/.test(process.argv[1]);

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
    const compare = args.includes("--compare");
    const dbPath = argValue("--db") ?? process.env.REPAIR_DB_PATH;
    const configPath =
      argValue("--config") ??
      process.env.REPAIR_CONFIG_PATH ??
      path.join(process.cwd(), "data", "repair-configs", "option-exercise-basis.json");

    if (!dbPath) {
      console.error("No database named. Pass --db <path> or set REPAIR_DB_PATH (there is no default).");
      process.exit(1);
    }
    console.log(`[repair-option-exercise-basis] ${apply ? "APPLY" : "DRY RUN"}, db: ${dbPath}`);
    console.log(`[repair-option-exercise-basis] config: ${configPath}`);
    if (!fs.existsSync(dbPath)) {
      console.error(`Database not found at ${dbPath}`);
      process.exit(1);
    }

    const config = parseRepairConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
    const { default: BetterSqlite3 } = await import("better-sqlite3");
    const { todayET } = await import("../lib/calendar/date-utils");
    const today = todayET();
    const db = new BetterSqlite3(dbPath, { readonly: !apply, fileMustExist: true, timeout: 60_000 });
    try {
      const preview = runOptionExerciseRepair(db, config, { apply: false, today });
      printPlan(preview.plan);
      if (preview.plan.refusals.length > 0) {
        console.error("Refused: nothing written.");
        process.exitCode = 1;
        return;
      }
      const todo = preview.plan.rows.filter((r) => r.state !== "already-repaired").length;
      if (todo === 0) {
        console.log("Every row is already repaired. Nothing to do.");
        return;
      }
      if (!apply) {
        // Rehearse the whole write, link check included, on an in-memory copy.
        const copy = new BetterSqlite3(rehearsalImage(db));
        try {
          const rehearsal = runOptionExerciseRepair(copy, config, { apply: true, today });
          console.log(`Rehearsed on an in-memory copy: ${rehearsal.updated} row(s) written, every link checked.`);
          if (compare) {
            const { computeTaxLots } = await import("../lib/compute/tax-lots");
            const baseline = new BetterSqlite3(rehearsalImage(db));
            try {
              const realizedByYear = (d: Database.Database) => {
                computeTaxLots(d);
                return new Map(
                  (d.prepare(
                    `SELECT substr(sale_date, 1, 4) AS y, SUM(realized_gain_loss) AS g
                       FROM tax_lot_sales GROUP BY y`,
                  ).all() as Array<{ y: string; g: number }>).map((r) => [r.y, r.g]),
                );
              };
              const before = realizedByYear(baseline);
              const after = realizedByYear(copy);
              const years = [...new Set([...before.keys(), ...after.keys()])].sort();
              for (const y of years) {
                const delta = (after.get(y) ?? 0) - (before.get(y) ?? 0);
                if (Math.abs(delta) > 0.005) console.log(`  ${y}: realized gain/loss changes by ${delta.toFixed(2)}`);
              }
            } finally {
              baseline.close();
            }
          }
        } finally {
          copy.close();
        }
        console.log(`Dry run: ${todo} row(s) would be repaired. Re-run with --apply to write.`);
        return;
      }
      const backup = await takeBackup(db, { purpose: "pre-option-exercise-basis-repair" });
      console.log(`Backup created: ${backup.path}`);
      const result = runOptionExerciseRepair(db, config, { apply: true, today });
      console.log(`Repaired ${result.updated} row(s) in one transaction. Next: recompute tax lots (rehearse first).`);
    } finally {
      db.close();
    }
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

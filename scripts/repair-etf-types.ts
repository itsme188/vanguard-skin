/**
 * repair-etf-types.ts — Retype IBKR-imported ETFs mistakenly stored as
 * security_type='Stock'.
 *
 * Root cause: IBKR reports ETFs as plain stocks everywhere the DB learns a
 * security's type from IBKR — lib/tws/positions.ts maps SecType.STK ->
 * "Stock" unconditionally, and lib/import/parsers/ibkr-activity.ts maps
 * assetCategory "Stocks" -> "Stock" unconditionally. Nothing upstream
 * distinguishes ARKK/HACK/IGV/KRE/SOXX/SPY/TLT/UCO/NCLD (all real ETFs)
 * from a single-name equity. lib/tws/contracts.ts's enrichSecurities() now
 * self-heals this going forward via IBKR contract-details `stockType`
 * (see shouldRetypeAsEtf in lib/tws/security-type-map.ts); this script
 * repairs securities that were imported/enriched BEFORE that fix landed
 * (or that TWS enrichment hasn't reached yet).
 *
 * Two modes:
 *
 *   Mode 1 (default, offline) — explicit symbol list on the CLI. No TWS
 *   connection used. Shows each row's current type/name/fund_category as
 *   evidence, retypes NULL/'Stock' -> 'ETF' on --apply. The operator is
 *   asserting these are ETFs; the script only refuses rows that are
 *   already typed something other than 'Stock'/NULL, or that are on the
 *   closed-end-fund refusal list.
 *
 *   Mode 2 (--from-tws) — TWS must be connected. Sweeps every held /
 *   active-watchlist / held-option-underlying security currently typed
 *   'Stock', verifies each via IBKR contract-details `stockType` (reuses
 *   shouldRetypeAsEtf — the exact same helper Part 1's enrich path uses,
 *   so CLI-repaired and enrich-repaired rows are judged identically), and
 *   only retypes rows TWS confirms are ETF-family.
 *
 * Both modes refuse to retype a row whose current type isn't NULL/'Stock'
 * (never downgrades an already-typed row, never overwrites a
 * statement-sourced non-Stock type), and refuse PSUS (Pershing Square USA
 * — a closed-end fund, not an ETF, even though it trades on an exchange
 * like one).
 *
 * Dry-run by default. A timestamped `VACUUM INTO` backup is written to
 * data/backups/ before any --apply write.
 *
 * Usage:
 *   npx tsx scripts/repair-etf-types.ts ARKK HACK IGV KRE SOXX SPY TLT UCO NCLD
 *   npx tsx scripts/repair-etf-types.ts ARKK HACK IGV KRE SOXX SPY TLT UCO NCLD --apply
 *   npx tsx scripts/repair-etf-types.ts --from-tws
 *   npx tsx scripts/repair-etf-types.ts --from-tws --apply
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { SecType } from "@stoqey/ib";
import { getIbApi } from "../lib/tws/client";
import { RateLimiter } from "../lib/tws/rate-limiter";
import { shouldRetypeAsEtf } from "../lib/tws/security-type-map";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

/** Small pacing delay between sequential TWS contract-details calls in
 *  --from-tws mode, on top of RateLimiter's 55-req/10-min window (see
 *  lib/tws/CLAUDE.md "Rate Limiting"). */
const TWS_PACING_DELAY_MS = 300;

/** Symbols that must never be retyped as ETF even though they trade on an
 *  exchange and could superficially look like one. Keyed by symbol ->
 *  human-readable reason for the refusal message. */
const CLOSED_END_FUNDS = new Map<string, string>([
  ["PSUS", "Pershing Square USA — a closed-end fund, not an ETF"],
]);

// ─── Core retype function (shared by both modes; unit-tested) ─────────

export interface RetypeCandidate {
  id: number;
  symbol: string;
  name: string | null;
  securityType: string | null;
  fundCategory: string | null;
}

export type RetypeAction =
  | "retyped"
  | "would_retype"
  | "skipped_not_stock"
  | "skipped_closed_end_fund";

export interface RetypeOutcome {
  symbol: string;
  action: RetypeAction;
  previousType: string | null;
}

/**
 * Retype `candidates` from 'Stock'/NULL to 'ETF'. Pure eligibility logic
 * plus the actual write — the single source shared by both CLI modes.
 *
 * - Refuses (skipped_closed_end_fund) any symbol in CLOSED_END_FUNDS,
 *   regardless of its current stored type.
 * - Refuses (skipped_not_stock) any other row whose current security_type
 *   is neither NULL nor 'Stock' (case-insensitive, project convention) —
 *   never downgrades an already-typed row (ETF/Mutual Fund/Bond/Option)
 *   and never overwrites a statement-sourced non-Stock type.
 * - `opts.apply === false` (dry-run, default): returns outcomes, writes
 *   nothing.
 * - `opts.apply === true`: writes all eligible rows inside one transaction.
 */
export function retypeSecuritiesAsEtf(
  db: Database.Database,
  candidates: RetypeCandidate[],
  opts: { apply: boolean },
): RetypeOutcome[] {
  const outcomes: RetypeOutcome[] = [];
  const eligible: RetypeCandidate[] = [];

  for (const c of candidates) {
    if (CLOSED_END_FUNDS.has(c.symbol.toUpperCase())) {
      outcomes.push({
        symbol: c.symbol,
        action: "skipped_closed_end_fund",
        previousType: c.securityType,
      });
      continue;
    }

    const normalized = c.securityType?.trim().toLowerCase();
    const isStockOrNull = !normalized || normalized === "stock";
    if (!isStockOrNull) {
      outcomes.push({
        symbol: c.symbol,
        action: "skipped_not_stock",
        previousType: c.securityType,
      });
      continue;
    }

    outcomes.push({
      symbol: c.symbol,
      action: opts.apply ? "retyped" : "would_retype",
      previousType: c.securityType,
    });
    eligible.push(c);
  }

  if (opts.apply && eligible.length > 0) {
    const update = db.prepare(
      `UPDATE securities SET security_type = 'ETF' WHERE id = ?`,
    );
    const tx = db.transaction((rows: RetypeCandidate[]) => {
      for (const row of rows) update.run(row.id);
    });
    tx(eligible);
  }

  return outcomes;
}

// ─── Backup ─────────────────────────────────────────────────────────

/** Timestamped `VACUUM INTO` backup to data/backups/ (mirrors the pattern
 *  in scripts/rebuild-ibkr-ledger.ts's ensureBackup). Throws — and this
 *  script aborts before writing — if the backup comes out empty. */
function backupDatabase(db: Database.Database): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-etf-type-repair-${timestamp}.db`);
  db.prepare("VACUUM INTO ?").run(backupPath);
  const sizeBytes = fs.statSync(backupPath).size;
  if (sizeBytes === 0) {
    throw new Error(
      `backup at ${backupPath} is 0 bytes — aborting, refusing to write without a verified backup`,
    );
  }
  return backupPath;
}

// ─── Mode 1: offline, explicit symbol list ─────────────────────────

interface SecurityRow {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  fund_category: string | null;
}

function resolveCandidatesFromSymbols(
  db: Database.Database,
  symbols: string[],
): { found: RetypeCandidate[]; notFound: string[] } {
  const found: RetypeCandidate[] = [];
  const notFound: string[] = [];
  const stmt = db.prepare(
    `SELECT id, symbol, name, security_type, fund_category FROM securities WHERE UPPER(symbol) = ?`,
  );
  for (const symbol of symbols) {
    const row = stmt.get(symbol.toUpperCase()) as SecurityRow | undefined;
    if (!row) {
      notFound.push(symbol);
      continue;
    }
    found.push({
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      securityType: row.security_type,
      fundCategory: row.fund_category,
    });
  }
  return { found, notFound };
}

// ─── Mode 2: --from-tws sweep ───────────────────────────────────────

interface SweepRow extends SecurityRow {
  currency: string | null;
}

/** Held (quantity != 0, latest row per account+security) OR active
 *  watchlist OR the underlying of a held option — the same "who cares
 *  about this name" surface the earnings coverage guard uses — restricted
 *  to rows currently typed 'Stock' (the mistyped-ETF candidate pool). */
function getStockTypedSweepCandidates(db: Database.Database): SweepRow[] {
  return db
    .prepare(
      `SELECT DISTINCT s.id, s.symbol, s.name, s.security_type, s.fund_category, s.currency
         FROM securities s
        WHERE LOWER(COALESCE(s.security_type, '')) = 'stock'
          AND (
            EXISTS (
              SELECT 1 FROM holdings h
               WHERE h.security_id = s.id AND h.quantity != 0
                 AND h.as_of_date = (
                   SELECT MAX(h2.as_of_date) FROM holdings h2
                    WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
                 )
            )
            OR EXISTS (
              SELECT 1 FROM watchlist w WHERE w.security_id = s.id AND w.is_active = 1
            )
            OR EXISTS (
              SELECT 1 FROM holdings ho
              JOIN securities opt ON opt.id = ho.security_id
               WHERE LOWER(COALESCE(opt.security_type, '')) = 'option'
                 AND UPPER(COALESCE(opt.underlying_symbol, '')) = UPPER(s.symbol)
                 AND ho.quantity != 0
                 AND (opt.expiration_date IS NULL OR opt.expiration_date >= date('now'))
            )
          )
        ORDER BY s.symbol`,
    )
    .all() as SweepRow[];
}

/** Sequential contract-details verification, one security at a time
 *  (RateLimiter's window + a small fixed pacing delay between calls — see
 *  lib/tws/CLAUDE.md "Rate Limiting"). Reuses shouldRetypeAsEtf, the exact
 *  helper Part 1's enrich path uses, so a CLI sweep and a live enrich pass
 *  judge the same contract details the same way. */
async function verifyViaTws(
  candidates: SweepRow[],
): Promise<{ confirmed: RetypeCandidate[]; checked: number }> {
  const api = getIbApi();
  if (!api) {
    throw new Error("TWS not connected — cannot run --from-tws mode.");
  }

  const rateLimiter = new RateLimiter();
  const confirmed: RetypeCandidate[] = [];
  let checked = 0;

  for (const c of candidates) {
    await rateLimiter.waitForSlot();
    checked++;
    try {
      const details = await api.getContractDetails({
        symbol: c.symbol,
        secType: SecType.STK,
        exchange: "SMART",
        currency: c.currency || "USD",
      });
      const stockType = details[0]?.stockType ?? null;
      console.log(`  ${c.symbol}: stockType=${stockType ?? "(none)"}`);
      if (shouldRetypeAsEtf(c.security_type, stockType)) {
        confirmed.push({
          id: c.id,
          symbol: c.symbol,
          name: c.name,
          securityType: c.security_type,
          fundCategory: c.fund_category,
        });
      }
    } catch (err) {
      console.warn(
        `  ${c.symbol}: contract details lookup failed — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, TWS_PACING_DELAY_MS));
  }

  return { confirmed, checked };
}

// ─── CLI driver ─────────────────────────────────────────────────────

function partitionClosedEndFunds(symbols: string[]): {
  rest: string[];
  refused: string[];
} {
  const rest: string[] = [];
  const refused: string[] = [];
  for (const s of symbols) {
    if (CLOSED_END_FUNDS.has(s.toUpperCase())) refused.push(s);
    else rest.push(s);
  }
  return { rest, refused };
}

function printOutcomes(outcomes: RetypeOutcome[]): void {
  for (const o of outcomes) {
    switch (o.action) {
      case "retyped":
        console.log(`  ${o.symbol}: ${o.previousType ?? "(null)"} -> ETF (written)`);
        break;
      case "would_retype":
        console.log(
          `  ${o.symbol}: ${o.previousType ?? "(null)"} -> ETF (dry-run, would write)`,
        );
        break;
      case "skipped_closed_end_fund": {
        const reason = CLOSED_END_FUNDS.get(o.symbol.toUpperCase()) ?? "closed-end fund";
        console.warn(`  ${o.symbol}: SKIPPED — ${reason}; refusing to retype.`);
        break;
      }
      case "skipped_not_stock":
        console.log(
          `  ${o.symbol}: SKIPPED — current type is '${o.previousType}', not 'Stock'/NULL; refusing to retype.`,
        );
        break;
    }
  }
}

async function runOfflineMode(db: Database.Database, symbols: string[], apply: boolean) {
  const { rest, refused } = partitionClosedEndFunds(symbols);
  for (const sym of refused) {
    const reason = CLOSED_END_FUNDS.get(sym.toUpperCase())!;
    console.warn(`  ${sym.toUpperCase()}: SKIPPED — ${reason}; refusing to retype.`);
  }

  const { found, notFound } = resolveCandidatesFromSymbols(db, rest);
  for (const sym of notFound) {
    console.warn(`  ${sym}: not found in securities table — skipping.`);
  }
  if (found.length === 0) {
    console.log("\nNothing to retype.");
    return;
  }

  console.log("\nEvidence (current type / name / fund_category):");
  for (const c of found) {
    console.log(
      `  ${c.symbol}: type=${c.securityType ?? "(null)"} name="${c.name ?? ""}" fund_category=${c.fundCategory ?? "(null)"}`,
    );
  }

  if (apply) {
    const backupPath = backupDatabase(db);
    console.log(`\nBackup written: ${backupPath}`);
  }

  console.log("\nResult:");
  const outcomes = retypeSecuritiesAsEtf(db, found, { apply });
  printOutcomes(outcomes);
  if (!apply) console.log("\nDry-run (default). Re-run with --apply to write.");
}

async function runFromTwsMode(db: Database.Database, apply: boolean) {
  const candidates = getStockTypedSweepCandidates(db);
  console.log(
    `Found ${candidates.length} 'Stock'-typed held/watchlist/option-underlying securities to verify via TWS contract details.`,
  );
  if (candidates.length === 0) return;

  const { confirmed, checked } = await verifyViaTws(candidates);
  console.log(`\nChecked ${checked}, confirmed ${confirmed.length} ETF(s) by stockType.`);
  if (confirmed.length === 0) return;

  if (apply) {
    const backupPath = backupDatabase(db);
    console.log(`Backup written: ${backupPath}`);
  }

  console.log("\nResult:");
  const outcomes = retypeSecuritiesAsEtf(db, confirmed, { apply });
  printOutcomes(outcomes);
  if (!apply) console.log("\nDry-run (default). Re-run with --apply to write.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const fromTws = args.includes("--from-tws");
  const symbols = args.filter((a) => !a.startsWith("--"));

  if (!fromTws && symbols.length === 0) {
    console.error(
      "Usage:\n" +
        "  npx tsx scripts/repair-etf-types.ts <SYMBOL...> [--apply]\n" +
        "  npx tsx scripts/repair-etf-types.ts --from-tws [--apply]",
    );
    process.exit(1);
  }
  if (fromTws && symbols.length > 0) {
    console.warn(
      `--from-tws sweeps all eligible securities — ignoring explicit symbol list: ${symbols.join(", ")}`,
    );
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    if (fromTws) {
      await runFromTwsMode(db, apply);
    } else {
      await runOfflineMode(db, symbols, apply);
    }
  } finally {
    db.close();
  }
}

// Detect if this file is being run directly (not imported by tests) —
// mirrors scripts/repair-acats-opening-lots.ts.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-etf-types.ts") ||
    process.argv[1].endsWith("repair-etf-types.js"));

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

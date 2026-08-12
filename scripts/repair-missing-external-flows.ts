/**
 * repair-missing-external-flows.ts — Back-fill synthetic DEPOSIT/WITHDRAWAL
 * transaction rows for external cash flows that landed in
 * daily_valuations.cash_balance with NO matching transaction.
 *
 * Root cause (QA: analysis-risk-decomposition--vol-drawdown-sharpe-count-
 * cash-flows-as-returns, 2026-08-12): risk metrics (vol/drawdown/Sharpe) are
 * flow-adjusted via lib/compute/flow-adjusted.ts's buildFlowAdjustedIndex,
 * which strips is_external_flow=1 transactions out of the daily return
 * series so a deposit/withdrawal doesn't read as a fake market move. That
 * only works when every real external flow HAS a transaction row. A
 * read-only audit found daily_valuations.cash_balance jumping by six
 * figures on dates with zero transactions — e.g. 2026-07-11 Vanguard
 * Taxable: cash_balance +$[REDACTED], nearest transaction dates 07-02 and
 * 07-17. With nothing to net against, that jump reads as a real one-day
 * return and inflates volatility ([redacted]% vs ~[redacted]% ex-flows), poisoning
 * drawdown/Sharpe and any AI prose built on them.
 *
 * Shares its residual computation (lib/compute/cash-flow-audit.ts) with
 * lib/queries/data-confidence.ts's cashAccuracy dimension — see that
 * module's header for why daily_valuations.cash_balance is a RESIDUAL PLUG
 * (not a ledger roll-forward) and exactly which transaction types count as
 * "explained" cash movement and why (the BUY sign-convention flip across
 * import eras, REINVESTMENT's amount being a purchase not an inflow, etc.).
 *
 * Scope: Vanguard Taxable + Vanguard Roth IRA (statement/Plaid-sourced).
 * IBKR is EXCLUDED — it trades daily under a materially different
 * settlement model (margin, multi-leg options, frequent same-day sweeps),
 * and the same per-type cash model produces ~10x the candidate volume there
 * (including at least one obvious data-entry outlier, a single day's
 * "explained" off by ~$16M) — not this script's problem to solve.
 *
 * Dry-run by default: prints every candidate with account/date window,
 * cash before/after, delta, explained, residual, and the exact proposed
 * transaction row, detailed enough to approve line by line. Writes nothing
 * unless --apply is passed.
 *
 * --apply: backs up data/vanguard.db to data/backups/ (VACUUM INTO — same
 * convention as scripts/repair-etf-types.ts), then inside one transaction
 * INSERT OR IGNOREs one DEPOSIT (residual > 0) or WITHDRAWAL (residual < 0)
 * row per candidate, is_external_flow=1, with a deterministic
 * `repair-missing-flow:{account_id}:{date}:{rounded-dollar-residual}`
 * source_key so a re-run is a no-op. Prints what to do next — nothing
 * downstream needs recomputing (risk metrics, TWR, and XIRR all read
 * `transactions` live at query time), except any CACHED AI narrative built
 * on the old numbers.
 *
 * Idempotent: after --apply, a second run over the SAME dates finds zero
 * candidates (the inserted flow now fully explains the delta, so
 * `explained` moves off zero and `isUnexplainedCashFlow`'s negligible-
 * explained gate rejects it).
 *
 * Usage:
 *   npx tsx scripts/repair-missing-external-flows.ts             # dry-run (default)
 *   npx tsx scripts/repair-missing-external-flows.ts --apply      # write
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  computeCashFlowResiduals,
  isUnexplainedCashFlow,
  isLikelyIbkrAccountName,
  type CashFlowResidualPoint,
  type UnexplainedCashFlowFloors,
} from "../lib/compute/cash-flow-audit";

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");

// ─── Candidate selection (pure, unit-tested) ───────────────────────────

export interface ProposedFlowTransaction {
  accountId: number;
  tradeDate: string;
  type: "DEPOSIT" | "WITHDRAWAL";
  amount: number;
  sourceKey: string;
  notes: string;
}

/** Builds the exact row `--apply` would insert for a flagged candidate. */
export function buildProposedTransaction(point: CashFlowResidualPoint): ProposedFlowTransaction {
  const type: "DEPOSIT" | "WITHDRAWAL" = point.residual > 0 ? "DEPOSIT" : "WITHDRAWAL";
  const roundedResidual = Math.round(point.residual);
  return {
    accountId: point.accountId,
    tradeDate: point.toDate,
    type,
    amount: point.residual,
    sourceKey: `repair-missing-flow:${point.accountId}:${point.toDate}:${roundedResidual}`,
    notes:
      `Synthesized external flow — cash_balance moved ${point.delta.toFixed(2)} between ` +
      `${point.fromDate} (exclusive) and ${point.toDate} with ${point.explained.toFixed(2)} ` +
      `explained by recorded transactions (residual ${point.residual.toFixed(2)}). Inserted by ` +
      `scripts/repair-missing-external-flows.ts — QA: analysis-risk-decomposition--vol-drawdown-` +
      `sharpe-count-cash-flows-as-returns.`,
  };
}

/** Non-IBKR accounts only — see module header for why IBKR is excluded. */
export function nonIbkrAccountIds(db: Database.Database): number[] {
  const rows = db.prepare(`SELECT id, name FROM accounts ORDER BY id`).all() as {
    id: number;
    name: string;
  }[];
  return rows.filter((r) => !isLikelyIbkrAccountName(r.name)).map((r) => r.id);
}

/**
 * Full candidate list for --apply / dry-run: computes residuals for the
 * given accounts (default: every non-IBKR account) and keeps only the
 * points isUnexplainedCashFlow flags, oldest first.
 */
export function findCandidates(
  db: Database.Database,
  opts?: { accountIds?: number[]; floors?: UnexplainedCashFlowFloors }
): CashFlowResidualPoint[] {
  const accountIds = opts?.accountIds ?? nonIbkrAccountIds(db);
  const points = computeCashFlowResiduals(db, { accountIds });
  return points
    .filter((p) => isUnexplainedCashFlow(p, opts?.floors))
    .sort((a, b) => (a.toDate < b.toDate ? -1 : a.toDate > b.toDate ? 1 : a.accountId - b.accountId));
}

// ─── Backup (mirrors scripts/repair-etf-types.ts::backupDatabase) ─────

function backupDatabase(db: Database.Database): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(process.cwd(), "data", "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `pre-missing-flow-repair-${timestamp}.db`);
  db.prepare("VACUUM INTO ?").run(backupPath);
  const sizeBytes = fs.statSync(backupPath).size;
  if (sizeBytes === 0) {
    throw new Error(
      `backup at ${backupPath} is 0 bytes — aborting, refusing to write without a verified backup`
    );
  }
  return backupPath;
}

// ─── Apply ──────────────────────────────────────────────────────────

/** Inserts one row per candidate inside a single transaction. Returns the
 *  count actually inserted (INSERT OR IGNORE means a re-run over already-
 *  applied dates inserts 0, not an error). */
export function applyProposedTransactions(
  db: Database.Database,
  proposals: ProposedFlowTransaction[]
): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO transactions
       (account_id, security_id, import_batch_id, trade_date, settlement_date,
        type, quantity, amount, price_per_share, fees, is_external_flow, source_key, notes)
     VALUES (?, NULL, NULL, ?, NULL, ?, NULL, ?, NULL, 0, 1, ?, ?)`
  );
  let inserted = 0;
  const tx = db.transaction((rows: ProposedFlowTransaction[]) => {
    for (const p of rows) {
      const res = insert.run(p.accountId, p.tradeDate, p.type, p.amount, p.sourceKey, p.notes);
      if (res.changes > 0) inserted++;
    }
  });
  tx(proposals);
  return inserted;
}

// ─── CLI driver ─────────────────────────────────────────────────────

function printCandidate(point: CashFlowResidualPoint, proposal: ProposedFlowTransaction): void {
  const relPct = point.totalValueAtTo !== 0
    ? (Math.abs(point.residual) / Math.abs(point.totalValueAtTo)) * 100
    : 0;
  console.log(`\n${point.accountName} (account ${point.accountId}): ${point.fromDate} -> ${point.toDate}`);
  console.log(`  cash before:  ${point.cashBefore.toFixed(2)}`);
  console.log(`  cash after:   ${point.cashAfter.toFixed(2)}`);
  console.log(`  delta:        ${point.delta.toFixed(2)}`);
  console.log(`  explained:    ${point.explained.toFixed(2)}  (recorded transactions in the window)`);
  console.log(`  residual:     ${point.residual.toFixed(2)}  (${relPct.toFixed(2)}% of account value)`);
  console.log(`  proposed row: ${proposal.type} amount=${proposal.amount.toFixed(2)} trade_date=${proposal.tradeDate}`);
  console.log(`                source_key=${proposal.sourceKey}`);
  console.log(`                notes="${proposal.notes}"`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  const db = new Database(DB_PATH, apply ? {} : { readonly: true });
  db.pragma("foreign_keys = ON");

  try {
    const accountIds = nonIbkrAccountIds(db);
    const allAccounts = db.prepare(`SELECT id, name FROM accounts ORDER BY id`).all() as {
      id: number;
      name: string;
    }[];
    const excluded = allAccounts.filter((a) => !accountIds.includes(a.id));
    if (excluded.length > 0) {
      console.log(
        `Excluding ${excluded.map((a) => `${a.name} (account ${a.id})`).join(", ")} — ` +
          `IBKR trades daily under a different settlement model; see module header.`
      );
    }

    const candidates = findCandidates(db, { accountIds });

    if (candidates.length === 0) {
      console.log("\nNo unexplained cash-flow candidates found. Nothing to do.");
      return;
    }

    console.log(`\nFound ${candidates.length} unexplained cash-flow candidate(s):`);
    const proposals = candidates.map((c) => buildProposedTransaction(c));
    for (let i = 0; i < candidates.length; i++) {
      printCandidate(candidates[i], proposals[i]);
    }

    if (!apply) {
      console.log(`\nDry-run (default). Re-run with --apply to write ${proposals.length} row(s).`);
      return;
    }

    const backupPath = backupDatabase(db);
    console.log(`\nBackup written: ${backupPath}`);

    const inserted = applyProposedTransactions(db, proposals);
    console.log(`\nInserted ${inserted} of ${proposals.length} row(s) (skipped = already applied, same source_key).`);

    console.log(
      "\nNothing else needs recomputing — risk metrics (lib/compute/risk.ts), TWR " +
        "(lib/compute/twr.ts), and XIRR (lib/compute/xirr.ts) all read `transactions` " +
        "live at query time, and this script never touches daily_valuations.cash_balance " +
        "itself. If a risk narrative was cached before this fix, force-regenerate it:\n" +
        '  curl -X POST http://localhost:3099/api/analysis/narrative -H "Content-Type: application/json" ' +
        `-d '{"scope":"all","surface":"risk-metrics"}'`
    );
  } finally {
    db.close();
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-missing-external-flows.ts") ||
    process.argv[1].endsWith("repair-missing-external-flows.js"));

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

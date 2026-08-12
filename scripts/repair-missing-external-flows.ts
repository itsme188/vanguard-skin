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
 * ── external-flow-candidate vs. internal-shift (2026-08-12 refinement) ──
 * NOT every unexplained cash residual is a fake return day. Risk metrics
 * run on total_value, not cash_balance — a residual whose total_value move
 * is smooth (the cash/holdings SPLIT jumped, not the total) is an internal
 * valuation-source misattribution, not a missing external flow, and
 * inserting a flow for it would CREATE a fake flow-adjusted return day
 * where none existed (and corrupt TWR/XIRR, which also read
 * is_external_flow rows). See lib/compute/cash-flow-audit.ts's
 * classifyCashFlowResidual for the exact rule. This script proposes INSERT
 * rows ONLY for `external-flow-candidate` points; `internal-shift` points
 * are printed in a separate informational section and never written.
 *
 * Dry-run by default: prints every candidate with account/date window,
 * cash before/after, delta, explained, residual, total_value move, and (for
 * external-flow-candidates) the exact proposed transaction row — detailed
 * enough to approve line by line. Writes nothing unless --apply is passed.
 *
 * --apply: backs up data/vanguard.db to data/backups/ (VACUUM INTO — same
 * convention as scripts/repair-etf-types.ts), then inside one transaction
 * INSERT OR IGNOREs one DEPOSIT (residual > 0) or WITHDRAWAL (residual < 0)
 * row per external-flow-candidate, is_external_flow=1, with a deterministic
 * `repair-missing-flow:{account_id}:{date}:{rounded-dollar-amount}`
 * source_key so a re-run is a no-op. Prints what to do next — nothing
 * downstream needs recomputing (risk metrics, TWR, and XIRR all read
 * `transactions` live at query time), except any CACHED AI narrative built
 * on the old numbers.
 *
 * --only <date> (repeatable): restrict the run to specific toDate(s), e.g.
 * `--only 2026-07-11 --only 2026-08-03`. Applies to both the proposal list
 * and the informational internal-shift list.
 *
 * --amount <value>: override the amount for the (single) selected
 * candidate instead of using its computed residual — for when the residual
 * is directionally right but the exact figure is uncertain pending the
 * user's own knowledge of the real deposit/withdrawal (e.g. 2026-07-11's
 * residual mixes a [REDACTED] cash swing with a simultaneous [REDACTED] holdings
 * drop; the true external amount is closer to the $[REDACTED] total_value
 * move, but only the user can confirm it). Requires exactly one date
 * selected via --only — errors otherwise. Recomputes source_key from the
 * overridden amount so it stays deterministic. Example:
 *   npx tsx scripts/repair-missing-external-flows.ts --apply --only 2026-07-11 --amount [REDACTED]
 *
 * Idempotent: after --apply, a second run over the SAME dates finds zero
 * external-flow-candidates (the inserted flow now fully explains the
 * delta, so `explained` moves off zero and `isUnexplainedCashFlow`'s
 * negligible-explained gate rejects it). internal-shift entries are never
 * "resolved" by this script — they persist as an informational signal
 * until the underlying valuation-source misattribution is fixed elsewhere.
 *
 * Usage:
 *   npx tsx scripts/repair-missing-external-flows.ts                          # dry-run (default)
 *   npx tsx scripts/repair-missing-external-flows.ts --apply                   # write all external-flow-candidates
 *   npx tsx scripts/repair-missing-external-flows.ts --only 2026-07-11         # dry-run, one date
 *   npx tsx scripts/repair-missing-external-flows.ts --apply --only 2026-07-11 --amount [REDACTED]
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  computeCashFlowResiduals,
  isUnexplainedCashFlow,
  isLikelyIbkrAccountName,
  partitionCandidates,
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

/**
 * Builds the exact row `--apply` would insert for a flagged
 * external-flow-candidate. `amountOverride`, when given, replaces
 * point.residual as the amount (and therefore the type and source_key too)
 * — for the case where the residual is directionally right but the exact
 * figure needs the user's own knowledge to pin down (see the --amount flag
 * in the module header).
 */
export function buildProposedTransaction(
  point: CashFlowResidualPoint,
  amountOverride?: number
): ProposedFlowTransaction {
  const amount = amountOverride ?? point.residual;
  const type: "DEPOSIT" | "WITHDRAWAL" = amount > 0 ? "DEPOSIT" : "WITHDRAWAL";
  const roundedAmount = Math.round(amount);
  const overrideNote =
    amountOverride != null
      ? ` Amount overridden by the user via --amount to ${amount.toFixed(2)} (computed residual was ${point.residual.toFixed(2)}).`
      : "";
  return {
    accountId: point.accountId,
    tradeDate: point.toDate,
    type,
    amount,
    sourceKey: `repair-missing-flow:${point.accountId}:${point.toDate}:${roundedAmount}`,
    notes:
      `Synthesized external flow — cash_balance moved ${point.delta.toFixed(2)} between ` +
      `${point.fromDate} (exclusive) and ${point.toDate} with ${point.explained.toFixed(2)} ` +
      `explained by recorded transactions (residual ${point.residual.toFixed(2)}, total_value moved ` +
      `${point.totalDelta.toFixed(2)}).${overrideNote} Inserted by ` +
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

// ─── Selection: --only / --amount handling (pure, unit-tested) ────────

export interface SelectRunResult {
  /** Rows to insert on --apply — always exactly the external-flow-candidates
   *  that survived --only filtering, one proposal each. */
  proposals: ProposedFlowTransaction[];
  externalFlowCandidates: CashFlowResidualPoint[];
  /** Printed informationally, never inserted. */
  internalShifts: CashFlowResidualPoint[];
  /** --only dates that matched no candidate at all (typo guard). */
  unmatchedOnlyDates: string[];
  /** Non-null when the request is invalid — callers must not apply. */
  error: string | null;
}

/**
 * Applies --only date filtering and --amount override validation to a
 * candidate list, and builds the resulting proposals. Pure — no I/O — so
 * both the CLI driver and tests can exercise the exact same selection
 * logic.
 */
export function selectRun(
  candidates: CashFlowResidualPoint[],
  opts: { onlyDates?: string[]; amountOverride?: number } = {}
): SelectRunResult {
  const onlyDates = opts.onlyDates ?? [];
  let selected = candidates;
  let unmatchedOnlyDates: string[] = [];
  if (onlyDates.length > 0) {
    unmatchedOnlyDates = onlyDates.filter((d) => !candidates.some((c) => c.toDate === d));
    selected = candidates.filter((c) => onlyDates.includes(c.toDate));
  }

  const { externalFlowCandidates, internalShifts } = partitionCandidates(selected);

  // Require --only explicitly, not just "happens to be exactly one
  // candidate right now" — the candidate set changes as the ledger changes,
  // and an override silently landing on the wrong future date because the
  // count briefly matched by coincidence would be a nasty surprise.
  if (opts.amountOverride != null) {
    if (onlyDates.length !== 1) {
      return {
        proposals: [],
        externalFlowCandidates,
        internalShifts,
        unmatchedOnlyDates,
        error:
          `--amount requires exactly one date selected via --only (got ${onlyDates.length}). ` +
          `Pass --only <date> for the single date you're overriding.`,
      };
    }
    if (externalFlowCandidates.length !== 1) {
      return {
        proposals: [],
        externalFlowCandidates,
        internalShifts,
        unmatchedOnlyDates,
        error:
          `--amount's --only ${onlyDates[0]} must match exactly one external-flow-candidate ` +
          `(found ${externalFlowCandidates.length} — internal-shift dates never get a proposal).`,
      };
    }
  }

  const proposals = externalFlowCandidates.map((c) =>
    buildProposedTransaction(c, externalFlowCandidates.length === 1 ? opts.amountOverride : undefined)
  );

  return { proposals, externalFlowCandidates, internalShifts, unmatchedOnlyDates, error: null };
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

function relPctOf(amount: number, basis: number): number {
  return basis !== 0 ? (Math.abs(amount) / Math.abs(basis)) * 100 : 0;
}

/** Detail lines shared by both the proposal and internal-shift printouts. */
function printPointDetail(point: CashFlowResidualPoint): void {
  console.log(`\n${point.accountName} (account ${point.accountId}): ${point.fromDate} -> ${point.toDate}`);
  console.log(`  cash before:   ${point.cashBefore.toFixed(2)}`);
  console.log(`  cash after:    ${point.cashAfter.toFixed(2)}`);
  console.log(`  cash delta:    ${point.delta.toFixed(2)}`);
  console.log(`  explained:     ${point.explained.toFixed(2)}  (recorded transactions in the window)`);
  console.log(`  cash residual: ${point.residual.toFixed(2)}  (${relPctOf(point.residual, point.totalValueAtTo).toFixed(2)}% of account value)`);
  console.log(`  total_value:   ${point.totalValueAtFrom.toFixed(2)} -> ${point.totalValueAtTo.toFixed(2)}`);
  console.log(`  total_delta:   ${point.totalDelta.toFixed(2)}  (${(point.totalDeltaPct * 100).toFixed(2)}% of account value)`);
}

function printProposal(point: CashFlowResidualPoint, proposal: ProposedFlowTransaction): void {
  printPointDetail(point);
  console.log(`  classification: external-flow-candidate (total_value move corroborates the cash residual)`);
  console.log(`  proposed row:  ${proposal.type} amount=${proposal.amount.toFixed(2)} trade_date=${proposal.tradeDate}`);
  console.log(`                 source_key=${proposal.sourceKey}`);
  console.log(`                 notes="${proposal.notes}"`);
}

function printInternalShift(point: CashFlowResidualPoint): void {
  printPointDetail(point);
  console.log(`  classification: internal-shift (total_value moved smoothly — NOT proposed)`);
}

/** Collects every value passed to a repeatable `--flag value` CLI arg. */
export function collectFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) values.push(args[i + 1]);
  }
  return values;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyDates = collectFlagValues(args, "--only");
  const amountArgs = collectFlagValues(args, "--amount");

  if (amountArgs.length > 1) {
    console.error(`ERROR: --amount may only be passed once (got ${amountArgs.length}).`);
    process.exit(1);
    return;
  }
  let amountOverride: number | undefined;
  if (amountArgs.length === 1) {
    const parsed = Number(amountArgs[0]);
    if (!Number.isFinite(parsed)) {
      console.error(`ERROR: --amount value "${amountArgs[0]}" is not a number.`);
      process.exit(1);
      return;
    }
    amountOverride = parsed;
  }

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
    const result = selectRun(candidates, { onlyDates, amountOverride });

    for (const d of result.unmatchedOnlyDates) {
      console.warn(`--only ${d}: no unexplained cash-flow candidate on that date — ignoring.`);
    }

    if (result.error) {
      console.error(`ERROR: ${result.error}`);
      process.exit(1);
      return;
    }

    const { proposals, externalFlowCandidates, internalShifts } = result;

    if (externalFlowCandidates.length === 0 && internalShifts.length === 0) {
      console.log("\nNo unexplained cash-flow candidates found (after filters). Nothing to do.");
      return;
    }

    console.log(
      `\nFound ${externalFlowCandidates.length} external-flow-candidate(s) (proposed) and ` +
        `${internalShifts.length} internal-shift(s) (informational only).`
    );

    if (proposals.length > 0) {
      console.log(`\n── Proposed inserts (total_value move corroborates the cash residual) ──`);
      for (let i = 0; i < externalFlowCandidates.length; i++) {
        printProposal(externalFlowCandidates[i], proposals[i]);
      }
    }

    if (internalShifts.length > 0) {
      console.log(
        `\n── Internal cash↔holdings shifts — NOT proposed; likely valuation-source ` +
          `misattribution, no external money moved ──`
      );
      for (const point of internalShifts) {
        printInternalShift(point);
      }
    }

    if (!apply) {
      console.log(
        proposals.length > 0
          ? `\nDry-run (default). Re-run with --apply to write ${proposals.length} row(s).`
          : `\nDry-run (default). Nothing to write — no external-flow-candidates in this selection.`
      );
      return;
    }

    if (proposals.length === 0) {
      console.log("\nNothing to apply — no external-flow-candidates in this selection.");
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

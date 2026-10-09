"use client";

import { useState } from "react";
import type { Account, MonthlySnapshot } from "@/lib/types";
import type { AccountHoldingRow } from "@/lib/queries/holdings";
import type {
  TransactionSort,
  TransactionWithSecurity,
} from "@/lib/queries/transactions";
import type { DailyValuation } from "@/lib/queries/daily-valuations";
import type { AccountCashLine } from "@/lib/queries/account-cash-line";
import { HoldingsTable } from "./HoldingsTable";
import { TransactionHistory } from "./TransactionHistory";
import { EquityCurveChart } from "./EquityCurveChart";
import type { EquityFlow } from "@/lib/chart/equity-curve-anchor";
import { ReconciliationTable } from "./ReconciliationTable";
import { SnapshotAge, summarizeSnapshot } from "./SnapshotAge";
import type { ReconciliationCheckpoint } from "@/lib/queries/reconciliation";

interface AccountDetailProps {
  selectedAccount: Account;
  holdings: AccountHoldingRow[];
  transactions: TransactionWithSecurity[];
  /** Every transaction the account has, so the list can state its cap. */
  transactionTotal?: number;
  /** The sort the server fetched `transactions` in, applied before the cap. */
  transactionSort?: TransactionSort;
  snapshots: MonthlySnapshot[];
  dailyValuations?: DailyValuation[];
  /** External flows for the equity-curve spread check (not rendered). */
  equityFlows?: EquityFlow[];
  /** Positions / cash / total from the latest daily valuation, for the
   *  Holdings footer. */
  cashLine?: AccountCashLine | null;
  reconciliationCheckpoints?: ReconciliationCheckpoint[];
}

export function AccountDetail({
  selectedAccount,
  holdings,
  transactions,
  transactionTotal,
  transactionSort,
  snapshots,
  dailyValuations,
  equityFlows,
  cashLine,
  reconciliationCheckpoints,
}: AccountDetailProps) {
  // Every account gets the chip: the page has no other freshness control,
  // and the account with no chip (IBKR) was the one with the stalest rows.
  //
  // The holdings read keys "latest" per (account, security) — NOT a single
  // account-wide date — so the rows can carry several as-of dates at once:
  // a statement-only bond or cash fund stays on the month-end date while the
  // rest of the account synced days later. summarizeSnapshot reads the
  // newest and oldest date, each sleeve's own dates and the newest rows'
  // source off the rows already on screen (this is a client component — no
  // `db` access). Age and tone follow the NEWEST date, so one old bond does
  // not paint the whole account stale; the chip shows the range so it does
  // not claim that date for the older rows either (ruling 2026-09-14).
  const snapshot = summarizeSnapshot(holdings);

  return (
    <div className="space-y-6">
      {snapshot && (
        <div className="flex items-center justify-end">
          <SnapshotAge
            asOfDate={snapshot.newest}
            oldestAsOfDate={snapshot.oldest}
            source={snapshot.source}
            sleeves={snapshot.sleeves}
            alwaysShow
          />
        </div>
      )}
      {(snapshots.length > 0 || (dailyValuations && dailyValuations.length > 0)) && (
        <EquityCurveChart
          snapshots={snapshots}
          dailyValuations={dailyValuations}
          flows={equityFlows}
          accountName={selectedAccount.name}
        />
      )}

      <HoldingsTable holdings={holdings} cashLine={cashLine ?? null} />

      <TransactionHistory
        transactions={transactions}
        total={transactionTotal}
        serverSort={transactionSort}
      />

      {reconciliationCheckpoints && (
        <ReconciliationSection
          checkpoints={reconciliationCheckpoints}
          account={selectedAccount}
        />
      )}
    </div>
  );
}

function ReconciliationSection({
  checkpoints,
  account,
}: {
  checkpoints: ReconciliationCheckpoint[];
  account: Account;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-edge bg-panel overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-raised/50 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">Reconciliation</h3>
          {checkpoints.length > 0 && (
            <span className="text-xs text-ink-faint bg-muted px-2 py-0.5 rounded-full">
              {checkpoints.length}
            </span>
          )}
        </div>
        <span className="text-xs text-ink-faint font-medium">
          {expanded ? "Hide" : "Show"}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-edge px-5 py-4">
          <p className="text-xs text-ink-faint mb-3">
            Compare statement values against computed portfolio values
          </p>
          <ReconciliationTable
            checkpoints={checkpoints}
            accounts={[account]}
          />
        </div>
      )}
    </div>
  );
}

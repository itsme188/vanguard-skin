"use client";

import { useState } from "react";
import type { Account, MonthlySnapshot } from "@/lib/types";
import type { HoldingWithSecurity } from "@/lib/queries/holdings";
import type { TransactionWithSecurity } from "@/lib/queries/transactions";
import type { DailyValuation } from "@/lib/queries/daily-valuations";
import { HoldingsTable } from "./HoldingsTable";
import { TransactionHistory } from "./TransactionHistory";
import { EquityCurveChart } from "./EquityCurveChart";
import { ReconciliationTable } from "./ReconciliationTable";
import type { ReconciliationCheckpoint } from "@/lib/queries/reconciliation";

interface AccountDetailProps {
  selectedAccount: Account;
  holdings: HoldingWithSecurity[];
  transactions: TransactionWithSecurity[];
  snapshots: MonthlySnapshot[];
  dailyValuations?: DailyValuation[];
  reconciliationCheckpoints?: ReconciliationCheckpoint[];
}

export function AccountDetail({
  selectedAccount,
  holdings,
  transactions,
  snapshots,
  dailyValuations,
  reconciliationCheckpoints,
}: AccountDetailProps) {
  return (
    <div className="space-y-6">
      {(snapshots.length > 0 || (dailyValuations && dailyValuations.length > 0)) && (
        <EquityCurveChart
          snapshots={snapshots}
          dailyValuations={dailyValuations}
          accountName={selectedAccount.name}
        />
      )}

      <HoldingsTable holdings={holdings} />

      <TransactionHistory transactions={transactions} />

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

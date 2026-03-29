"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Account, MonthlySnapshot } from "@/lib/types";
import type { HoldingWithSecurity } from "@/lib/queries/holdings";
import type { TransactionWithSecurity } from "@/lib/queries/transactions";
import type { DailyValuation } from "@/lib/queries/daily-valuations";
import { HoldingsTable } from "./HoldingsTable";
import { TransactionHistory } from "./TransactionHistory";
import { EquityCurveChart } from "./EquityCurveChart";
import { ReconciliationTable } from "./ReconciliationTable";
import type { ReconciliationCheckpoint } from "@/lib/queries/reconciliation";

const ACCOUNT_DOTS: Record<string, string> = {
  "Vanguard Taxable": "bg-gold",
  "Vanguard Roth IRA": "bg-blue",
  IBKR: "bg-up",
};

interface AccountDetailProps {
  accounts: Account[];
  selectedAccount: Account;
  holdings: HoldingWithSecurity[];
  transactions: TransactionWithSecurity[];
  snapshots: MonthlySnapshot[];
  dailyValuations?: DailyValuation[];
  reconciliationCheckpoints?: ReconciliationCheckpoint[];
}

export function AccountDetail({
  accounts,
  selectedAccount,
  holdings,
  transactions,
  snapshots,
  dailyValuations,
  reconciliationCheckpoints,
}: AccountDetailProps) {
  const router = useRouter();

  return (
    <div className="space-y-6">
      {/* Account selector */}
      <div className="flex gap-2" role="tablist" aria-label="Account selector">
        {accounts.map((account) => (
          <button
            key={account.id}
            role="tab"
            aria-selected={account.id === selectedAccount.id}
            onClick={() =>
              router.push(`/dashboard/accounts?id=${account.id}`)
            }
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors focus-ring ${
              account.id === selectedAccount.id
                ? "bg-raised border border-edge-strong text-ink"
                : "text-ink-faint hover:bg-raised hover:text-ink-dim"
            }`}
          >
            <div
              className={`w-2 h-2 rounded-full ${
                ACCOUNT_DOTS[account.name] ?? "bg-ink-faint"
              }`}
            />
            {account.name}
          </button>
        ))}
      </div>

      {/* Equity curve */}
      {(snapshots.length > 0 || (dailyValuations && dailyValuations.length > 0)) && (
        <EquityCurveChart
          snapshots={snapshots}
          dailyValuations={dailyValuations}
          accountName={selectedAccount.name}
        />
      )}

      {/* Holdings */}
      <HoldingsTable holdings={holdings} />

      {/* Transactions */}
      <TransactionHistory transactions={transactions} />

      {/* Reconciliation (collapsible) */}
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
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">Reconciliation</h3>
          {checkpoints.length > 0 && (
            <span className="text-xs text-ink-faint bg-muted px-2 py-0.5 rounded-full">
              {checkpoints.length}
            </span>
          )}
        </div>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          className={`text-ink-faint transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
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

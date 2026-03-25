"use client";

import { useRouter } from "next/navigation";
import type { Account, MonthlySnapshot } from "@/lib/types";
import type { HoldingWithSecurity } from "@/lib/queries/holdings";
import type { TransactionWithSecurity } from "@/lib/queries/transactions";
import type { DailyValuation } from "@/lib/queries/daily-valuations";
import { HoldingsTable } from "./HoldingsTable";
import { TransactionHistory } from "./TransactionHistory";
import { EquityCurveChart } from "./EquityCurveChart";

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
}

export function AccountDetail({
  accounts,
  selectedAccount,
  holdings,
  transactions,
  snapshots,
  dailyValuations,
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
    </div>
  );
}

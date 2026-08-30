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
import { SnapshotAge } from "./SnapshotAge";
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
  // Vanguard accounts update only on statement import — the holdings table
  // reflects the period-end of the last imported statement, not live data.
  // Surfacing the snapshot age here makes that boundary explicit (vs IBKR
  // which has a sibling refresh button that already shows live sync state).
  const isVanguard = selectedAccount.name.toLowerCase().includes("vanguard");
  // getHoldingsByAccount's default (no explicit asOfDate) branch keys
  // "latest" per (account, security) — NOT a single account-wide date — and
  // orders by symbol, not date. So holdings[0] can be a statement-only bond
  // still carrying an older as_of_date (e.g. 2026-07-31) while the rest of
  // the account synced days later (2026-08-28); reading holdings[0] alone
  // painted a false "stale" snapshot-age chip. Dates are YYYY-MM-DD, so a
  // plain string max across the rows gives the true latest date without a
  // second DB round trip (this is a client component — no `db` access).
  const snapshotDate = holdings.reduce<string | null>(
    (latest, h) => (latest === null || h.as_of_date > latest ? h.as_of_date : latest),
    null
  );

  return (
    <div className="space-y-6">
      {isVanguard && snapshotDate && (
        <div className="flex items-center justify-end -mb-3">
          <SnapshotAge asOfDate={snapshotDate} alwaysShow />
        </div>
      )}
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

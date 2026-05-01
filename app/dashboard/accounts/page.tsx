export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { getAllAccounts } from "@/lib/queries/accounts";
import {
  getAllHoldings,
  getHoldingsByAccount,
} from "@/lib/queries/holdings";
import { getTransactionsByAccount } from "@/lib/queries/transactions";
import { getSnapshotsByAccount } from "@/lib/queries/monthly-snapshots";
import { getDailyValuationsByAccount } from "@/lib/queries/daily-valuations";
import { getReconciliationCheckpoints } from "@/lib/queries/reconciliation";
import { AccountDetail } from "../components/AccountDetail";
import { AccountSelector } from "../components/AccountSelector";
import { AllHoldingsTable } from "../components/AllHoldingsTable";
import { EmptyState } from "../components/EmptyState";

export default async function AccountsPage(props: {
  searchParams: Promise<{ id?: string }>;
}) {
  const searchParams = await props.searchParams;

  let accounts;
  try {
    accounts = getAllAccounts(db);
  } catch {
    throw new Error("Failed to load accounts. The database may be unavailable.");
  }

  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" /></svg>}
        title="No accounts yet"
        description="Import your Vanguard statements or IBKR activity files to create accounts."
        action={{ label: "Import Files", href: "/dashboard/import" }}
      />
    );
  }

  const isAll = searchParams.id === "all";

  if (isAll) {
    let holdings;
    try {
      holdings = getAllHoldings(db);
    } catch {
      throw new Error("Failed to load holdings. The database may be unavailable.");
    }

    return (
      <div className="space-y-6">
        <AccountSelector accounts={accounts} selected="all" />
        <section id="holdings" className="space-y-4 scroll-mt-24">
          <div>
            <h2 className="text-lg font-medium text-ink">Holdings</h2>
            <p className="text-sm text-ink-faint mt-0.5">
              {holdings.length} positions across all accounts
            </p>
          </div>
          {holdings.length === 0 ? (
            <EmptyState
              icon={
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <path d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
                </svg>
              }
              title="No holdings yet"
              description="Import your Vanguard statements or sync positions from TWS to see your holdings."
              action={{ label: "Import Files", href: "/dashboard/import" }}
            />
          ) : (
            <AllHoldingsTable holdings={holdings} />
          )}
        </section>
      </div>
    );
  }

  const selectedId = searchParams.id
    ? parseInt(searchParams.id, 10)
    : accounts[0].id;
  const selectedAccount =
    accounts.find((a) => a.id === selectedId) ?? accounts[0];

  let holdings, transactions, snapshots, dailyValuations, reconciliationCheckpoints;
  try {
    holdings = getHoldingsByAccount(db, selectedAccount.id);
    transactions = getTransactionsByAccount(db, selectedAccount.id, {
      limit: 50,
    });
    snapshots = getSnapshotsByAccount(db, selectedAccount.id);
    dailyValuations = getDailyValuationsByAccount(db, selectedAccount.id);
    reconciliationCheckpoints = getReconciliationCheckpoints(db, selectedAccount.id);
  } catch {
    throw new Error(`Failed to load data for ${selectedAccount.name}. The database may be unavailable.`);
  }

  return (
    <div className="space-y-6">
      <AccountSelector accounts={accounts} selected={selectedAccount.id} />
      <AccountDetail
        selectedAccount={selectedAccount}
        holdings={holdings}
        transactions={transactions}
        snapshots={snapshots}
        dailyValuations={dailyValuations}
        reconciliationCheckpoints={reconciliationCheckpoints}
      />
    </div>
  );
}

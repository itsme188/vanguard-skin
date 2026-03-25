import { db } from "@/lib/db";
import { getAllAccounts } from "@/lib/queries/accounts";
import { getHoldingsByAccount } from "@/lib/queries/holdings";
import { getTransactionsByAccount } from "@/lib/queries/transactions";
import { getSnapshotsByAccount } from "@/lib/queries/monthly-snapshots";
import { getDailyValuationsByAccount } from "@/lib/queries/daily-valuations";
import { AccountDetail } from "../components/AccountDetail";

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
      <div className="text-center py-12 text-ink-faint">
        No accounts configured.
      </div>
    );
  }

  const selectedId = searchParams.id
    ? parseInt(searchParams.id, 10)
    : accounts[0].id;
  const selectedAccount =
    accounts.find((a) => a.id === selectedId) ?? accounts[0];

  let holdings, transactions, snapshots, dailyValuations;
  try {
    holdings = getHoldingsByAccount(db, selectedAccount.id);
    transactions = getTransactionsByAccount(db, selectedAccount.id, {
      limit: 50,
    });
    snapshots = getSnapshotsByAccount(db, selectedAccount.id);
    dailyValuations = getDailyValuationsByAccount(db, selectedAccount.id);
  } catch {
    throw new Error(`Failed to load data for ${selectedAccount.name}. The database may be unavailable.`);
  }

  return (
    <AccountDetail
      accounts={accounts}
      selectedAccount={selectedAccount}
      holdings={holdings}
      transactions={transactions}
      snapshots={snapshots}
      dailyValuations={dailyValuations}
    />
  );
}

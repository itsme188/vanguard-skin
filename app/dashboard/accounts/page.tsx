import { db } from "@/lib/db";
import { getAllAccounts } from "@/lib/queries/accounts";
import { getHoldingsByAccount } from "@/lib/queries/holdings";
import { getTransactionsByAccount } from "@/lib/queries/transactions";
import { getSnapshotsByAccount } from "@/lib/queries/monthly-snapshots";
import { AccountDetail } from "../components/AccountDetail";

export default async function AccountsPage(props: {
  searchParams: Promise<{ id?: string }>;
}) {
  const searchParams = await props.searchParams;
  const accounts = getAllAccounts(db);

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

  const holdings = getHoldingsByAccount(db, selectedAccount.id);
  const transactions = getTransactionsByAccount(db, selectedAccount.id, {
    limit: 50,
  });
  const snapshots = getSnapshotsByAccount(db, selectedAccount.id);

  return (
    <AccountDetail
      accounts={accounts}
      selectedAccount={selectedAccount}
      holdings={holdings}
      transactions={transactions}
      snapshots={snapshots}
    />
  );
}

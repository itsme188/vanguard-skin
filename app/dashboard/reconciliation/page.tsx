import { db } from "@/lib/db";
import { getReconciliationCheckpoints } from "@/lib/queries/reconciliation";
import { getAllAccounts } from "@/lib/queries/accounts";
import { ReconciliationTable } from "../components/ReconciliationTable";

export default function ReconciliationPage() {
  let checkpoints, accounts;
  try {
    checkpoints = getReconciliationCheckpoints(db);
    accounts = getAllAccounts(db);
  } catch {
    throw new Error("Failed to load reconciliation data. The database may be unavailable.");
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Reconciliation</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          Compare statement values against computed portfolio values to find discrepancies
        </p>
      </div>

      <ReconciliationTable checkpoints={checkpoints} accounts={accounts} />
    </div>
  );
}

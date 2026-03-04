import { db } from "@/lib/db";
import { getReconciliationCheckpoints } from "@/lib/queries/reconciliation";
import { getAllAccounts } from "@/lib/queries/accounts";
import { ReconciliationTable } from "../components/ReconciliationTable";

export default function ReconciliationPage() {
  const checkpoints = getReconciliationCheckpoints(db);
  const accounts = getAllAccounts(db);

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

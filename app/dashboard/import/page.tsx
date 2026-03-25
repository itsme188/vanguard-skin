import { db } from "@/lib/db";
import { getAllImportBatches } from "@/lib/queries/import-batches";
import { ImportFlow } from "../components/ImportFlow";
import { ImportHistory } from "../components/ImportHistory";

export default function ImportPage() {
  let batches;
  try {
    batches = getAllImportBatches(db);
  } catch {
    throw new Error("Failed to load import history. The database may be unavailable.");
  }

  return (
    <div className="space-y-8">
      <ImportFlow />
      <ImportHistory batches={batches} />
    </div>
  );
}

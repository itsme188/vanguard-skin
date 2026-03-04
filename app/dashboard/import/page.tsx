import { db } from "@/lib/db";
import { getAllImportBatches } from "@/lib/queries/import-batches";
import { ImportFlow } from "../components/ImportFlow";
import { ImportHistory } from "../components/ImportHistory";

export default function ImportPage() {
  const batches = getAllImportBatches(db);

  return (
    <div className="space-y-8">
      <ImportFlow />
      <ImportHistory batches={batches} />
    </div>
  );
}

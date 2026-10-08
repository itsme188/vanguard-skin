export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { getAllImportBatches } from "@/lib/queries/import-batches";
import { ImportFlow } from "../components/ImportFlow";
import { ImportHistory } from "../components/ImportHistory";
import { CanonicalCsvGuide } from "../components/CanonicalCsvGuide";

// Browser-tab title (qa:page-head--same-tab-title-every-route-...).
export const metadata = { title: "Import" };

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
      <CanonicalCsvGuide />
      <ImportHistory batches={batches} />
    </div>
  );
}

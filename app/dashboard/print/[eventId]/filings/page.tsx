export const dynamic = "force-dynamic";

import Link from "next/link";
import { db } from "@/lib/db";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import { getFullView } from "@/lib/filing-summary/view";
import { EmptySection } from "@/app/dashboard/components/EmptySection";
import { FilingSummaryView } from "./FilingSummaryView";

/**
 * The full filing summary for one armed print (spec §9 "Full summary page").
 * Server page: loads the read-only view model directly; the client view
 * handles the run switcher, the re-run picker and Retry.
 */
export async function generateMetadata(props: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await props.params;
  return { title: `Filing summary · print ${eventId}` };
}

function BackLink() {
  return (
    <Link href="/dashboard/today" className="text-sm text-ink-dim underline underline-offset-2 hover:text-ink">
      Back to Today
    </Link>
  );
}

export default async function FilingSummaryPage(props: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await props.params;
  const id = Number(eventId);
  const view = Number.isInteger(id) && id > 0 ? getFullView(db, id, getCachedModelCatalog()) : null;

  if (!view) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <BackLink />
        <EmptySection
          title="Filing summary"
          reason={`There is no print with id ${eventId}. It may have been deleted or replaced; open the summary again from Today.`}
        />
      </div>
    );
  }

  if (view.event.pollState === null && view.runs.length === 0 && view.filings.length === 0) {
    const who = view.event.symbol ?? "This print";
    return (
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
        <BackLink />
        <EmptySection
          title={`${who} · filing summary`}
          reason={`${who} on ${view.event.eventDate} has no filing summary. A summary starts when the print is armed on Today.`}
        />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
      <BackLink />
      <FilingSummaryView view={view} />
    </div>
  );
}

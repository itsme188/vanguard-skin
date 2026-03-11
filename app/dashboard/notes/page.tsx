import { db } from "@/lib/db";
import { getNotesFiltered, getEarningsTimeline } from "@/lib/queries/notes";
import { getTranscriptsSummary } from "@/lib/queries/transcripts";
import type { NoteType } from "@/lib/types";
import { NotesView } from "../components/NotesView";

interface PageProps {
  searchParams: Promise<{
    type?: string;
    search?: string;
    security_id?: string;
  }>;
}

export default async function NotesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const noteType = (params.type as NoteType) || undefined;

  const notes = getNotesFiltered(db, {
    note_type: noteType,
    search: params.search || undefined,
    security_id: params.security_id ? parseInt(params.security_id, 10) : undefined,
    limit: 100,
  });

  const earningsTimeline = getEarningsTimeline(db);
  const transcriptSummaries = noteType === "earnings" || !noteType
    ? getTranscriptsSummary(db, { limit: 50 })
    : [];

  // Get list of securities for the picker
  const securities = db
    .prepare(
      `SELECT DISTINCT s.id, s.symbol, s.name
       FROM securities s
       WHERE s.symbol IS NOT NULL AND s.symbol != ''
         AND s.security_type IN ('stock', 'etf', 'mutual_fund')
       ORDER BY s.symbol`
    )
    .all() as { id: number; symbol: string; name: string | null }[];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-ink">Notes</h2>
        <p className="text-sm text-ink-faint mt-0.5">
          Investment journal, earnings notes, and trade theses
        </p>
      </div>

      <NotesView
        initialNotes={notes}
        earningsTimeline={earningsTimeline}
        transcriptSummaries={transcriptSummaries}
        securities={securities}
        currentType={noteType ?? null}
        currentSearch={params.search ?? null}
      />
    </div>
  );
}

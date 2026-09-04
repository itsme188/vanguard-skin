export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getNotesFiltered, groupEarningsTimeline } from "@/lib/queries/notes";
import type { NoteWithContext, EarningsTimelineEntry } from "@/lib/queries/notes";
import {
  getTranscriptsSummary,
  getTickersWithTranscripts,
} from "@/lib/queries/transcripts";
import type { TranscriptSummaryEntry } from "@/lib/queries/transcripts";
import {
  getRecentArticles,
  getResearchSources,
  getSymbolSecurityMap,
  getFilteredArticles,
  getFilteredArticleCount,
  getFilteredArticleCategoryCounts,
} from "@/lib/queries/research";
import type { NoteType } from "@/lib/types";
import { NotesView } from "../components/NotesView";
import { ResearchFeedsView } from "../components/ResearchFeedsView";
import { ResearchViewToggle } from "../components/ResearchViewToggle";
import { ResearchDocumentsView } from "../components/ResearchDocumentsView";

const NOTE_TYPES: readonly NoteType[] = ["journal", "earnings", "trade_thesis"];

interface PageProps {
  searchParams: Promise<{
    type?: string;
    search?: string;
    security_id?: string;
    security?: string;
    view?: string;
  }>;
}

export default async function ResearchPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // Phase 5: Trade Reviews relocated to Analysis. Preserve saved bookmarks.
  if (params.view === "reviews" || params.view === "trade-reviews") {
    redirect("/dashboard/analysis?view=trade-reviews");
  }

  const view = params.view ?? "notes";
  // ?type= is user-editable and shareable, so an unknown value (notably the
  // guessable "all") must fall back to "no filter" rather than being cast
  // straight through — a bogus note_type matches no row and renders the
  // "No notes yet" empty state over a full notebook.
  const noteType = NOTE_TYPES.includes(params.type as NoteType)
    ? (params.type as NoteType)
    : undefined;
  const securityId = params.security_id ?? params.security;

  // NotesView is the only consumer of the queries below, and EarningsView
  // (timeline + transcript wall) only renders on the Earnings tab — key on
  // exactly those conditions. Every Research render used to pay for the
  // unbounded earnings timeline plus 50 transcript rows, including the
  // feeds/documents views and the non-earnings note tabs that discard them.
  const showNotesView = view !== "feeds" && view !== "documents";
  const showEarningsView = showNotesView && noteType === "earnings";

  let notes: NoteWithContext[] = [];
  let earningsTimeline: EarningsTimelineEntry[] = [];
  let transcriptSummaries: TranscriptSummaryEntry[] = [];
  let transcriptTickers: string[] = [];
  let securities: { id: number; symbol: string; name: string | null }[] = [];

  if (showNotesView) {
    try {
      const search = params.search || undefined;
      // parseInt drops a non-numeric ?security= — getNotesFiltered ignores a
      // falsy security_id, so such a param filters nothing (mirrored by
      // notesListIsFiltered on the client).
      const filterSecurityId = securityId ? parseInt(securityId, 10) : undefined;

      if (showEarningsView) {
        // ONE query pass feeds both surfaces. The timeline must be complete
        // (limit: -1), and the notes list is grouped from the very same
        // rows — running the identical filtered query twice per render was
        // pure waste, and left room for the two to drift on filters.
        notes = getNotesFiltered(db, {
          note_type: "earnings",
          search,
          security_id: filterSecurityId,
          limit: -1,
        });
        earningsTimeline = groupEarningsTimeline(notes);
        transcriptSummaries = getTranscriptsSummary(db, {
          limit: 50,
          securityId: filterSecurityId,
          search,
        });
        // Unfiltered on purpose — the "Fetch <TICKER> Transcript" buttons
        // are this set's complement and must not grow when a filter is on.
        transcriptTickers = getTickersWithTranscripts(db);
      } else {
        notes = getNotesFiltered(db, {
          note_type: noteType,
          search,
          security_id: filterSecurityId,
          limit: 100,
        });
      }

      securities = db
        .prepare(
          `SELECT DISTINCT s.id, s.symbol, s.name
           FROM securities s
           WHERE s.symbol IS NOT NULL AND s.symbol != ''
             AND LOWER(s.security_type) IN ('stock', 'etf', 'mutual fund')
           ORDER BY s.symbol`
        )
        .all() as { id: number; symbol: string; name: string | null }[];
    } catch {
      throw new Error("Failed to load research data. The database may be unavailable.");
    }
  }

  // Load feeds data when viewing feeds
  let feedArticles: Awaited<ReturnType<typeof getRecentArticles>> = [];
  let feedSources: Awaited<ReturnType<typeof getResearchSources>> = [];
  let feedSymbolMap: Record<string, number> = {};
  let filteredArticles: Awaited<ReturnType<typeof getFilteredArticles>> = [];
  let filteredCount = 0;
  let filteredCategoryCounts: Awaited<ReturnType<typeof getFilteredArticleCategoryCounts>> = [];

  if (view === "feeds") {
    try {
      feedArticles = getRecentArticles(db, { processedOnly: true, limit: 50 });
      feedSources = getResearchSources(db);
      feedSymbolMap = getSymbolSecurityMap(db, feedArticles.map((a) => a.id));
      filteredArticles = getFilteredArticles(db, { limit: 100 });
      filteredCount = getFilteredArticleCount(db);
      // Full-set aggregate for the section headers — never derive header
      // counts from `filteredArticles`, which is capped at 100 rows.
      filteredCategoryCounts = getFilteredArticleCategoryCounts(db);
    } catch {
      // Non-blocking — feeds table may not exist yet (pre-migration)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-ink">Research</h2>
          <p className="text-sm text-ink-faint mt-0.5">
            {view === "feeds"
              ? "Newsletter digests and market research from Gmail"
              : view === "documents"
                ? "Uploaded research PDFs — searchable from chat"
                : "Investment journal, earnings notes, and trade theses"}
          </p>
        </div>
        <ResearchViewToggle currentView={view} />
      </div>

      {view === "documents" ? (
        <ResearchDocumentsView />
      ) : view === "feeds" ? (
        <ResearchFeedsView
          initialArticles={feedArticles}
          sources={feedSources}
          initialSymbolMap={feedSymbolMap}
          initialFilteredArticles={filteredArticles}
          initialFilteredCount={filteredCount}
          initialFilteredCategoryCounts={filteredCategoryCounts}
        />
      ) : (
        <NotesView
          initialNotes={notes}
          earningsTimeline={earningsTimeline}
          transcriptSummaries={transcriptSummaries}
          transcriptTickers={transcriptTickers}
          securities={securities}
          currentType={noteType ?? null}
          currentSearch={params.search ?? null}
        />
      )}
    </div>
  );
}

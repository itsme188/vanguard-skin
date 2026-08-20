export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getNotesFiltered, getEarningsTimeline } from "@/lib/queries/notes";
import { getTranscriptsSummary } from "@/lib/queries/transcripts";
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
  const noteType = (params.type as NoteType) || undefined;
  const securityId = params.security_id ?? params.security;

  // Always load notes (for the Notes view)
  let notes, earningsTimeline, transcriptSummaries, securities;
  try {
    notes = getNotesFiltered(db, {
      note_type: noteType,
      search: params.search || undefined,
      security_id: securityId ? parseInt(securityId, 10) : undefined,
      limit: 100,
    });

    earningsTimeline = getEarningsTimeline(db, {
      security_id: securityId ? parseInt(securityId, 10) : undefined,
      search: params.search || undefined,
    });
    transcriptSummaries = noteType === "earnings" || !noteType
      ? getTranscriptsSummary(db, {
          limit: 50,
          securityId: securityId ? parseInt(securityId, 10) : undefined,
          search: params.search || undefined,
        })
      : [];

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
          securities={securities}
          currentType={noteType ?? null}
          currentSearch={params.search ?? null}
        />
      )}
    </div>
  );
}

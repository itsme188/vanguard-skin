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
  countRecentArticles,
  getArticleById,
  getResearchSources,
  getSymbolSecurityMap,
  getFilteredArticles,
  getFilteredArticleCount,
  getFilteredArticleCategoryCounts,
} from "@/lib/queries/research";
import type { ResearchArticle } from "@/lib/queries/research";
import { getSecurityBySymbolCI } from "@/lib/queries/securities";
import { getNotePickerSecurities } from "@/lib/queries/note-security-picker";
import type { TieredPickerSecurity } from "@/lib/notes/security-picker";
import { coerceNoteType } from "@/lib/notes/coerce";
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
    /** Feeds and Documents: narrow the list to one ticker (links from a security's page). */
    symbol?: string;
    /** Feeds: open this one article (`?view=feeds&article=<id>`). */
    article?: string;
  }>;
}

// Browser-tab title (qa:page-head--same-tab-title-every-route-...).
export async function generateMetadata({ searchParams }: PageProps) {
  const { view } = await searchParams;
  if (view === "feeds") return { title: "Research · Feeds" };
  if (view === "documents") return { title: "Research · Documents" };
  return { title: "Research" };
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
  const noteType = coerceNoteType(params.type);
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
  let securities: TieredPickerSecurity[] = [];

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

      securities = getNotePickerSecurities(db);
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
  let feedTotal: number | null = null;
  // ?symbol= is user-editable: trim and upper-case it, and treat blank as absent.
  const symbolParam = (params.symbol ?? "").trim().toUpperCase();
  let feedSymbolFilter: { symbol: string; securityId: number | null } | null = null;
  const articleParam = (params.article ?? "").trim() || null;
  let linkedArticle: ResearchArticle | null = null;

  if (view === "feeds") {
    try {
      // The symbol filter is the feed's existing security filter: articles
      // linked to that security. A symbol no security carries matches nothing.
      if (symbolParam) {
        feedSymbolFilter = {
          symbol: symbolParam,
          securityId: getSecurityBySymbolCI(db, symbolParam)?.id ?? null,
        };
      }
      if (feedSymbolFilter && feedSymbolFilter.securityId === null) {
        feedTotal = 0;
      } else {
        // List and count read ONE filter object, so "N of M" cannot drift.
        const feedFilter = {
          processedOnly: true,
          securityId: feedSymbolFilter?.securityId ?? undefined,
        };
        feedArticles = getRecentArticles(db, { ...feedFilter, limit: 50 });
        feedTotal = countRecentArticles(db, feedFilter);
      }
      // ?article=<id>: the one row, whether or not it is among the newest 50.
      // Only the card's fields cross to the client, never the stored body.
      if (articleParam && /^\d+$/.test(articleParam)) {
        const row = getArticleById(db, Number(articleParam));
        if (row) {
          linkedArticle = {
            id: row.id,
            source_id: row.source_id,
            source_name: row.source_name,
            gmail_message_id: row.gmail_message_id,
            received_at: row.received_at,
            subject: row.subject,
            sender: row.sender,
            summary: row.summary,
            key_themes: row.key_themes,
            sentiment: row.sentiment,
            sentiment_score: row.sentiment_score,
            mentioned_symbols: row.mentioned_symbols,
            portfolio_relevance: row.portfolio_relevance,
            processed_at: row.processed_at,
            created_at: row.created_at,
            source_url: row.source_url,
            website_url: row.website_url ?? null,
            is_relevant: row.is_relevant,
            excluded_category: row.excluded_category,
          };
        }
      }
      feedSources = getResearchSources(db);
      feedSymbolMap = getSymbolSecurityMap(
        db,
        linkedArticle
          ? [...feedArticles.map((a) => a.id), linkedArticle.id]
          : feedArticles.map((a) => a.id),
      );
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
        <ResearchDocumentsView key={symbolParam} initialSymbol={symbolParam} />
      ) : view === "feeds" ? (
        <ResearchFeedsView
          // Re-keyed on the symbol: clearing the chip changes the URL, and the
          // view must restart from the list this render read.
          key={symbolParam}
          initialArticles={feedArticles}
          initialTotal={feedTotal}
          symbolFilter={feedSymbolFilter}
          linkedArticleParam={articleParam}
          linkedArticle={linkedArticle}
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

import { db } from "@/lib/db";
import { getNotesFiltered, getEarningsTimeline } from "@/lib/queries/notes";
import { getTranscriptsSummary } from "@/lib/queries/transcripts";
import { getTradeReviews } from "@/lib/queries/trade-reviews";
import { getAvailableReviewPeriods } from "@/lib/compute/trade-roundtrips";
import type { NoteType } from "@/lib/types";
import { NotesView } from "../components/NotesView";
import { TradeReviewView } from "../components/TradeReviewView";
import { ResearchViewToggle } from "../components/ResearchViewToggle";

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

    earningsTimeline = getEarningsTimeline(db);
    transcriptSummaries = noteType === "earnings" || !noteType
      ? getTranscriptsSummary(db, { limit: 50 })
      : [];

    securities = db
      .prepare(
        `SELECT DISTINCT s.id, s.symbol, s.name
         FROM securities s
         WHERE s.symbol IS NOT NULL AND s.symbol != ''
           AND s.security_type IN ('stock', 'etf', 'mutual_fund')
         ORDER BY s.symbol`
      )
      .all() as { id: number; symbol: string; name: string | null }[];
  } catch {
    throw new Error("Failed to load research data. The database may be unavailable.");
  }

  // Load trade review data when viewing reviews
  let reviews: Awaited<ReturnType<typeof getTradeReviews>> = [];
  let reviewPeriods: Awaited<ReturnType<typeof getAvailableReviewPeriods>> = [];
  let accounts: { id: number; name: string }[] = [];
  let defaultAccountId: number | null = null;

  if (view === "reviews") {
    try {
      accounts = db
        .prepare("SELECT id, name FROM accounts ORDER BY name")
        .all() as { id: number; name: string }[];

      // Default to IBKR if it exists (short-term trading account)
      const ibkr = accounts.find(
        (a) => a.name.toLowerCase().includes("ibkr")
      );
      defaultAccountId = ibkr?.id ?? accounts[0]?.id ?? null;

      if (defaultAccountId) {
        reviews = getTradeReviews(db, defaultAccountId);
        reviewPeriods = getAvailableReviewPeriods(db, defaultAccountId);
      }
    } catch {
      // Non-blocking — trade reviews are optional
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-ink">Research</h2>
          <p className="text-sm text-ink-faint mt-0.5">
            {view === "reviews"
              ? "Monthly AI trade analysis and behavioral patterns"
              : "Investment journal, earnings notes, and trade theses"}
          </p>
        </div>
        <ResearchViewToggle currentView={view} />
      </div>

      {view === "reviews" ? (
        <TradeReviewView
          initialReviews={reviews}
          accounts={accounts}
          initialPeriods={reviewPeriods}
          defaultAccountId={defaultAccountId}
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

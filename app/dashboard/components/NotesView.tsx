"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { NoteWithContext, EarningsTimelineEntry } from "@/lib/queries/notes";
import type { TranscriptSummaryEntry } from "@/lib/queries/transcripts";
import type { NoteType, NoteSentiment } from "@/lib/types";
import { TranscriptCard, FetchTranscriptButton } from "./TranscriptCard";
import { useToast } from "./Toast";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState } from "./EmptyState";

// ─── Props ───────────────────────────────────────────────────────

interface NotesViewProps {
  initialNotes: NoteWithContext[];
  earningsTimeline: EarningsTimelineEntry[];
  transcriptSummaries: TranscriptSummaryEntry[];
  securities: { id: number; symbol: string; name: string | null }[];
  currentType: NoteType | null;
  currentSearch: string | null;
}

// ─── Constants ───────────────────────────────────────────────────

// "Stock Notes" is the broadened presentation of the trade_thesis note type
// (2026-06-09 rework): position notes, thesis updates, "why I'm watching
// this" — anything stock-specific that isn't earnings. Journal is reserved
// for market & trading psychology. The DB value stays trade_thesis (schema
// CHECK constraint; existing rows keep working).
const TYPE_OPTIONS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Journal", value: "journal" },
  { label: "Earnings", value: "earnings" },
  { label: "Stock Notes", value: "trade_thesis" },
];

const SENTIMENT_OPTIONS: { label: string; value: NoteSentiment }[] = [
  { label: "Bullish", value: "bullish" },
  { label: "Bearish", value: "bearish" },
  { label: "Neutral", value: "neutral" },
  { label: "Cautious", value: "cautious" },
  { label: "Confident", value: "confident" },
];

const SENTIMENT_STYLES: Record<string, string> = {
  bullish: "bg-up/20 text-up",
  bearish: "bg-down/20 text-down",
  neutral: "bg-muted text-ink-dim",
  cautious: "bg-gold/20 text-gold-ink",
  confident: "bg-blue/20 text-blue",
};

const TYPE_BORDER: Record<string, string> = {
  journal: "border-l-gold",
  earnings: "border-l-blue",
  trade_thesis: "border-l-up",
};

// ─── Main Component ──────────────────────────────────────────────

export function NotesView({
  initialNotes,
  earningsTimeline,
  transcriptSummaries,
  securities,
  currentType,
  currentSearch,
}: NotesViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();

  // Form state — sync with active filter tab
  const [formType, setFormType] = useState<NoteType>(currentType ?? "journal");
  useEffect(() => {
    if (currentType) setFormType(currentType);
  }, [currentType]);
  const [formContent, setFormContent] = useState("");
  // ?symbol= prefill — the Security Detail "+ Add note" link lands here with
  // type+symbol preselected so a stock thought is one textarea away.
  const [formSymbol, setFormSymbol] = useState(
    () => searchParams.get("symbol")?.toUpperCase() ?? ""
  );
  const [formDate, setFormDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [formSentiment, setFormSentiment] = useState<NoteSentiment | "">("");
  const [formTags, setFormTags] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ─── Live search (deep-QA finding: Enter-only read as broken) ──
  // Controlled draft + 350ms debounce → URL replace. Enter still applies
  // immediately. Skip the initial mount (and echoes of the current URL
  // value) so navigation isn't triggered by arriving with ?search= set.
  const [searchDraft, setSearchDraft] = useState(currentSearch ?? "");
  useEffect(() => {
    if (searchDraft === (currentSearch ?? "")) return;
    const t = setTimeout(() => {
      setFilter("search", searchDraft.trim(), { replace: true });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft, currentSearch]);

  // ─── Filter navigation ─────────────────────────────────────────

  function setFilter(key: string, value: string, opts?: { replace?: boolean }) {
    startTransition(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      // replace: live-search keystrokes shouldn't stack history entries.
      if (opts?.replace) router.replace(`?${params.toString()}`);
      else router.push(`?${params.toString()}`);
    });
  }

  // ─── Create note ───────────────────────────────────────────────

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!formContent.trim()) return;

    setIsSaving(true);
    setSaveError(null);

    try {
      const body: Record<string, unknown> = {
        note_type: formType,
        content: formContent.trim(),
        event_date: formDate,
      };
      // Only attach `symbol` when the dropdown is actually rendered for this
      // note type — `formSymbol` state persists in React even when the
      // dropdown unmounts (e.g. user picks Earnings + CRCL, switches back
      // to Journal). Without this gate the residual symbol leaks into the
      // POST body and the server tags the journal entry with CRCL.
      if (
        formSymbol &&
        (formType === "earnings" || formType === "trade_thesis")
      ) {
        body.symbol = formSymbol;
      }
      if (formSentiment) body.sentiment = formSentiment;
      if (formTags.trim()) {
        body.tags = formTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }

      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      // Reset form — all stateful fields, not just the visible ones.
      // `formSymbol` was previously missed here: a residual symbol from a
      // prior Earnings/Trade-Thesis save would carry forward into the next
      // note (visible if the user reopened the dropdown; ineffective if
      // they didn't — but the value was still in state). Belt + suspenders
      // with the gate above in case a future refactor accidentally drops
      // the build-time guard.
      setFormContent("");
      setFormTags("");
      setFormSentiment("");
      setFormSymbol("");

      // Refresh page data
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setIsSaving(false);
    }
  }

  // ─── Update note ───────────────────────────────────────────────

  async function handleUpdate(id: number) {
    if (!editContent.trim()) return;

    try {
      const res = await fetch("/api/notes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, content: editContent.trim() }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      setEditingId(null);
      toast("Note updated", "success");
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update note", "error");
    }
  }

  // ─── Delete note ───────────────────────────────────────────────

  async function handleDelete(id: number) {
    try {
      const res = await fetch(`/api/notes?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      toast("Note deleted", "success");
      startTransition(() => {
        router.refresh();
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete note", "error");
    }
  }

  // ─── Render ────────────────────────────────────────────────────

  const showEarningsView = currentType === "earnings";

  return (
    <div className="space-y-6">
      {/* ─── Type filter pills ───────────────────────────────────── */}
      <div className="flex items-center gap-1.5" role="group" aria-label="Note type filter">
        {TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter("type", opt.value)}
            aria-pressed={(opt.value || null) === currentType}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap focus-ring ${
              (opt.value || null) === currentType
                ? "bg-gold/20 text-gold-ink"
                : "text-ink-faint hover:text-ink hover:bg-panel"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* ─── Quick-add form ──────────────────────────────────────── */}
      <form onSubmit={handleCreate} className="bg-panel border border-edge rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={formType}
            onChange={(e) => {
              const next = e.target.value as NoteType;
              setFormType(next);
              // Third reset point (belt-and-suspenders-and-belt): clearing
              // formSymbol on type-switch prevents a residual ticker from
              // an Earnings/Trade-Thesis draft from leaking into a
              // subsequent Journal entry's hidden state. The build-time
              // gate in handleCreate already prevents the leak from
              // reaching the API; this just removes the latent state.
              if (next === "journal") setFormSymbol("");
            }}
            className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-gold"
          >
            <option value="journal">Journal</option>
            <option value="earnings">Earnings</option>
            <option value="trade_thesis">Stock Note</option>
          </select>

          {(formType === "earnings" || formType === "trade_thesis") && (
            <select
              value={formSymbol}
              onChange={(e) => setFormSymbol(e.target.value)}
              // min-w-0 + max-w-full: a <select> sizes to its longest <option>,
              // and securities.symbol holds 80+-char prediction-market names —
              // unconstrained it blew the Notes page to 613px at a 390px
              // viewport (deep-QA 2026-07-28).
              className="min-w-0 max-w-full truncate bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-gold"
            >
              <option value="">Select security...</option>
              {securities.map((s) => (
                <option key={s.id} value={s.symbol}>
                  {s.symbol}
                </option>
              ))}
            </select>
          )}

          <input
            type="date"
            value={formDate}
            onChange={(e) => setFormDate(e.target.value)}
            className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-gold"
          />

          <div className="flex gap-1">
            {SENTIMENT_OPTIONS.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={formSentiment === s.value}
                onClick={() =>
                  setFormSentiment(formSentiment === s.value ? "" : s.value)
                }
                className={`px-2 py-1 rounded text-xs font-medium transition-colors focus-ring ${
                  formSentiment === s.value
                    ? SENTIMENT_STYLES[s.value]
                    : "text-ink-faint hover:text-ink-dim"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <textarea
          ref={textareaRef}
          value={formContent}
          onChange={(e) => setFormContent(e.target.value)}
          placeholder={
            formType === "journal"
              ? "Market & trading psychology — how you feel about the market, how you're trading..."
              : formType === "earnings"
                ? "Earnings call notes, guidance thoughts..."
                : "Position notes, thesis updates, why you're watching this name..."
          }
          rows={3}
          className="w-full bg-raised border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint resize-none focus:outline-none focus:border-gold"
        />

        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <input
              type="text"
              value={formTags}
              onChange={(e) => setFormTags(e.target.value)}
              placeholder="Tags (comma-separated)"
              aria-describedby="tags-hint"
              className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint w-60"
            />
            <span id="tags-hint" className="text-[10px] text-ink-faint mt-0.5">e.g. tech, earnings, Q4</span>
          </div>

          <div className="flex items-center gap-3">
            {saveError && (
              <span className="text-xs text-down">{saveError}</span>
            )}
            <button
              type="submit"
              disabled={!formContent.trim() || isSaving}
              className="px-4 py-1.5 bg-gold text-canvas rounded-lg text-sm font-medium hover:bg-gold/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {isSaving ? "Saving..." : "Save Note"}
            </button>
          </div>
        </div>
      </form>

      {/* ─── Search ──────────────────────────────────────────────── */}
      <div>
        <input
          type="text"
          value={searchDraft}
          placeholder="Search notes..."
          aria-label="Search notes"
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setFilter("search", (e.target as HTMLInputElement).value);
            }
          }}
          className="w-full bg-panel border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
        />
      </div>

      {/* ─── Notes list / Earnings timeline ──────────────────────── */}
      {isPending && (
        <div className="text-center text-ink-faint text-sm py-4">Loading...</div>
      )}

      {showEarningsView ? (
        <EarningsView
          timeline={earningsTimeline}
          transcriptSummaries={transcriptSummaries}
          securities={securities}
          editingId={editingId}
          editContent={editContent}
          onStartEdit={(id, content) => {
            setEditingId(id);
            setEditContent(content);
          }}
          onCancelEdit={() => setEditingId(null)}
          onSaveEdit={handleUpdate}
          onDelete={handleDelete}
          onRefresh={() => startTransition(() => router.refresh())}
        />
      ) : (
        <NotesList
          notes={initialNotes}
          filtered={notesListIsFiltered({
            search: searchParams.get("search"),
            symbol: searchParams.get("symbol"),
            type: searchParams.get("type"),
          })}
          editingId={editingId}
          editContent={editContent}
          onStartEdit={(id, content) => {
            setEditingId(id);
            setEditContent(content);
          }}
          onCancelEdit={() => setEditingId(null)}
          onSaveEdit={handleUpdate}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}

// ─── Notes List ──────────────────────────────────────────────────

// A tab selection (?type=) is navigation, not a user filter — only search and
// symbol may flip a zero-result into "No matching notes". A bare Stock Notes
// tab on an empty journal must read "No notes yet", not blame a search the
// user never typed.
export function notesListIsFiltered(params: {
  search?: string | null;
  symbol?: string | null;
  type?: string | null;
}): boolean {
  return Boolean(params.search || params.symbol);
}

function NotesList({
  notes,
  filtered = false,
  editingId,
  editContent,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  notes: NoteWithContext[];
  filtered?: boolean;
  editingId: number | null;
  editContent: string;
  onStartEdit: (id: number, content: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  if (notes.length === 0) {
    // A filtered zero-result is not "no notes yet" — say what actually happened
    // (deep-QA finding: search with no matches read as an empty journal).
    return (
      <EmptyState
        icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}><path d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" /></svg>}
        title={filtered ? "No matching notes" : "No notes yet"}
        description={
          filtered
            ? "Nothing matches the current search or filter — clear it to see all notes."
            : "Start writing to build your investment journal."
        }
      />
    );
  }

  // Group by date
  const grouped = new Map<string, NoteWithContext[]>();
  for (const note of notes) {
    const dateKey = note.event_date;
    if (!grouped.has(dateKey)) grouped.set(dateKey, []);
    grouped.get(dateKey)!.push(note);
  }

  return (
    <div className="space-y-6">
      {Array.from(grouped.entries()).map(([date, dateNotes]) => (
        <div key={date} className="space-y-2">
          <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">
            {formatDate(date)}
          </h3>
          <div className="space-y-2">
            {dateNotes.map((note) => (
              <NoteCard
                key={note.id}
                note={note}
                isEditing={editingId === note.id}
                editContent={editContent}
                onStartEdit={onStartEdit}
                onCancelEdit={onCancelEdit}
                onSaveEdit={onSaveEdit}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Earnings Timeline ───────────────────────────────────────────

function EarningsView({
  timeline,
  transcriptSummaries,
  securities,
  editingId,
  editContent,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onRefresh,
}: {
  timeline: EarningsTimelineEntry[];
  transcriptSummaries: TranscriptSummaryEntry[];
  securities: { id: number; symbol: string; name: string | null }[];
  editingId: number | null;
  editContent: string;
  onStartEdit: (id: number, content: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: number) => void;
  onDelete: (id: number) => void;
  onRefresh: () => void;
}) {
  // Group transcripts by ticker for interleaving with notes
  const transcriptsByTicker = new Map<string, TranscriptSummaryEntry[]>();
  for (const t of transcriptSummaries) {
    if (!transcriptsByTicker.has(t.ticker)) transcriptsByTicker.set(t.ticker, []);
    transcriptsByTicker.get(t.ticker)!.push(t);
  }

  // Collect all tickers that have transcripts but no notes timeline entry
  const timelineTickers = new Set(timeline.map((e) => e.symbol));
  const extraTranscriptTickers = [...transcriptsByTicker.keys()].filter(
    (ticker) => !timelineTickers.has(ticker)
  );

  // Tickers that already have cached transcripts
  const tickersWithTranscripts = new Set(transcriptSummaries.map((t) => t.ticker));

  // Portfolio tickers that don't have transcripts yet (exclude common non-stock symbols)
  const fetchableTickers = securities
    .map((s) => s.symbol)
    .filter((sym) => !tickersWithTranscripts.has(sym))
    .filter((sym) => !sym.includes(" ") && sym.length <= 5); // basic filter for stock-like symbols

  if (timeline.length === 0 && transcriptSummaries.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-panel border border-edge rounded-xl p-8 text-center">
          <p className="text-ink-faint text-sm">
            No earnings notes yet. Add notes during earnings calls to track your
            thoughts quarter over quarter.
          </p>
        </div>
        {fetchableTickers.length > 0 && (
          <FetchTickersSection tickers={fetchableTickers} onRefresh={onRefresh} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Securities with user notes (+ their transcripts interleaved) */}
      {timeline.map((entry) => {
        const tickerTranscripts = transcriptsByTicker.get(entry.symbol) ?? [];
        return (
          <div key={entry.security_id}>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="font-mono font-semibold text-ink text-sm">
                {entry.symbol}
              </span>
              {entry.security_name && (
                <span className="text-ink-faint text-xs truncate">
                  {entry.security_name}
                </span>
              )}
              <span className="text-ink-faint text-xs">
                ({entry.notes.length} note{entry.notes.length !== 1 ? "s" : ""}
                {tickerTranscripts.length > 0 &&
                  `, ${tickerTranscripts.length} transcript${tickerTranscripts.length !== 1 ? "s" : ""}`}
                )
              </span>
            </div>
            <div className="space-y-2 pl-3 border-l-2 border-blue/30">
              {/* Transcript cards first (most recent quarter at top) */}
              {tickerTranscripts.map((t) => (
                <TranscriptCard
                  key={`transcript-${t.ticker}-${t.year}-${t.quarter}`}
                  transcript={t}
                />
              ))}
              {/* Then user notes */}
              {entry.notes.map((note) => (
                <NoteCard
                  key={note.id}
                  note={note}
                  isEditing={editingId === note.id}
                  editContent={editContent}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSaveEdit={onSaveEdit}
                  onDelete={onDelete}
                  compact
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Securities with transcripts only (no user notes) */}
      {extraTranscriptTickers.map((ticker) => {
        const transcripts = transcriptsByTicker.get(ticker)!;
        return (
          <div key={`transcript-only-${ticker}`}>
            <div className="flex items-baseline gap-2 mb-3">
              <span className="font-mono font-semibold text-ink text-sm">
                {ticker}
              </span>
              <span className="text-ink-faint text-xs">
                ({transcripts.length} transcript{transcripts.length !== 1 ? "s" : ""})
              </span>
            </div>
            <div className="space-y-2 pl-3 border-l-2 border-[#818CF8]/30">
              {transcripts.map((t) => (
                <TranscriptCard
                  key={`transcript-${t.ticker}-${t.year}-${t.quarter}`}
                  transcript={t}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Fetch transcripts for portfolio tickers without cached data */}
      {fetchableTickers.length > 0 && (
        <FetchTickersSection tickers={fetchableTickers} onRefresh={onRefresh} />
      )}
    </div>
  );
}

// ─── Fetch Tickers Section ────────────────────────────────────────

function FetchTickersSection({
  tickers,
  onRefresh,
}: {
  tickers: string[];
  onRefresh: () => void;
}) {
  return (
    <div className="bg-panel border border-edge rounded-xl p-4">
      <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-3">
        Fetch Earnings Transcripts
      </h4>
      <div className="flex flex-wrap gap-2">
        {tickers.map((ticker) => (
          <FetchTranscriptButton
            key={ticker}
            ticker={ticker}
            onFetched={onRefresh}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Note Card ───────────────────────────────────────────────────

function NoteCard({
  note,
  isEditing,
  editContent,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  compact = false,
}: {
  note: NoteWithContext;
  isEditing: boolean;
  editContent: string;
  onStartEdit: (id: number, content: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: number) => void;
  onDelete: (id: number) => void;
  compact?: boolean;
}) {
  const [showActions, setShowActions] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const borderClass = TYPE_BORDER[note.note_type] ?? "border-l-edge";
  const tags: string[] = note.tags ? JSON.parse(note.tags) : [];

  return (
    <div
      className={`bg-panel border rounded-xl border-l-2 ${compact ? "p-3" : "p-4"} group ${
        isEditing
          ? "border-gold/40 border-l-gold bg-gold/[0.02]"
          : `border-edge ${borderClass}`
      }`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete note"
        message="Are you sure you want to delete this note? This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          onDelete(note.id);
        }}
        onCancel={() => setShowDeleteConfirm(false)}
      />
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Header: type badge + symbol + date */}
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            {!compact && (
              <span className="text-[10px] font-medium uppercase tracking-wider text-ink-faint bg-muted px-1.5 py-0.5 rounded">
                {note.note_type.replace("_", " ")}
              </span>
            )}
            {note.symbol && (
              <span className="font-mono text-xs font-semibold text-blue">
                {note.symbol}
              </span>
            )}
            {compact && (
              <span className="text-xs text-ink-faint">
                {formatDate(note.event_date)}
              </span>
            )}
            {note.sentiment && (
              <span
                className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${SENTIMENT_STYLES[note.sentiment] ?? ""}`}
              >
                {note.sentiment}
              </span>
            )}
          </div>

          {/* Content */}
          {isEditing ? (
            <div className="space-y-2">
              <textarea
                value={editContent}
                onChange={(e) => onStartEdit(note.id, e.target.value)}
                rows={3}
                className="w-full bg-raised border border-edge rounded-lg px-3 py-2 text-sm text-ink resize-none focus:outline-none focus:border-gold"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => onSaveEdit(note.id)}
                  className="px-3 py-1 bg-gold text-canvas rounded text-xs font-medium hover:bg-gold/90"
                >
                  Save
                </button>
                <button
                  onClick={onCancelEdit}
                  className="px-3 py-1 text-ink-faint hover:text-ink text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink whitespace-pre-wrap">
              {note.content}
            </p>
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <div className="flex gap-1 mt-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] text-ink-faint bg-muted px-1.5 py-0.5 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Transaction link */}
          {note.transaction_type && note.transaction_date && (
            <div className="text-xs text-ink-faint mt-1.5">
              Linked to {note.transaction_type} on {formatDate(note.transaction_date)}
            </div>
          )}
        </div>

        {/* Action buttons */}
        {showActions && !isEditing && (
          <div className="flex gap-1 shrink-0">
            <button
              onClick={() => onStartEdit(note.id, note.content)}
              className="p-1 text-ink-faint hover:text-ink rounded transition-colors focus-ring"
              aria-label="Edit note"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="p-1 text-ink-faint hover:text-down rounded transition-colors focus-ring"
              aria-label="Delete note"
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}, ${year}`;
}

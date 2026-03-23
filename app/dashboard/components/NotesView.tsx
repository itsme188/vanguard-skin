"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { NoteWithContext, EarningsTimelineEntry } from "@/lib/queries/notes";
import type { TranscriptSummaryEntry } from "@/lib/queries/transcripts";
import type { NoteType, NoteSentiment } from "@/lib/types";
import { TranscriptCard, FetchTranscriptButton } from "./TranscriptCard";

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

const TYPE_OPTIONS: { label: string; value: string }[] = [
  { label: "All", value: "" },
  { label: "Journal", value: "journal" },
  { label: "Earnings", value: "earnings" },
  { label: "Trade Theses", value: "trade_thesis" },
];

const SENTIMENT_OPTIONS: { label: string; value: NoteSentiment }[] = [
  { label: "Bullish", value: "bullish" },
  { label: "Bearish", value: "bearish" },
  { label: "Neutral", value: "neutral" },
  { label: "Cautious", value: "cautious" },
  { label: "Confident", value: "confident" },
];

const SENTIMENT_STYLES: Record<string, string> = {
  bullish: "bg-up/15 text-up",
  bearish: "bg-down/15 text-down",
  neutral: "bg-muted text-ink-dim",
  cautious: "bg-gold/15 text-gold",
  confident: "bg-blue/15 text-blue",
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

  // Form state — sync with active filter tab
  const [formType, setFormType] = useState<NoteType>(currentType ?? "journal");
  useEffect(() => {
    if (currentType) setFormType(currentType);
  }, [currentType]);
  const [formContent, setFormContent] = useState("");
  const [formSymbol, setFormSymbol] = useState("");
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

  // ─── Filter navigation ─────────────────────────────────────────

  function setFilter(key: string, value: string) {
    startTransition(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      router.push(`?${params.toString()}`);
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
      if (formSymbol) body.symbol = formSymbol;
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

      // Reset form
      setFormContent("");
      setFormTags("");
      setFormSentiment("");

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
      startTransition(() => {
        router.refresh();
      });
    } catch {
      // Keep editing state on error
    }
  }

  // ─── Delete note ───────────────────────────────────────────────

  async function handleDelete(id: number) {
    try {
      const res = await fetch(`/api/notes?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      startTransition(() => {
        router.refresh();
      });
    } catch {
      // Silently fail on delete error
    }
  }

  // ─── Render ────────────────────────────────────────────────────

  const showEarningsView = currentType === "earnings";

  return (
    <div className="space-y-6">
      {/* ─── Type filter pills ───────────────────────────────────── */}
      <div className="flex items-center gap-1.5">
        {TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter("type", opt.value)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              (opt.value || null) === currentType
                ? "bg-gold-glow text-gold"
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
            onChange={(e) => setFormType(e.target.value as NoteType)}
            className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-gold"
          >
            <option value="journal">Journal</option>
            <option value="earnings">Earnings</option>
            <option value="trade_thesis">Trade Thesis</option>
          </select>

          {(formType === "earnings" || formType === "trade_thesis") && (
            <select
              value={formSymbol}
              onChange={(e) => setFormSymbol(e.target.value)}
              className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-gold"
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
                onClick={() =>
                  setFormSentiment(formSentiment === s.value ? "" : s.value)
                }
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
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
              ? "Market thoughts, observations, self-critique..."
              : formType === "earnings"
                ? "Earnings call notes, guidance thoughts..."
                : "Trade thesis, rationale for this position..."
          }
          rows={3}
          className="w-full bg-raised border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint resize-none focus:outline-none focus:border-gold"
        />

        <div className="flex items-center justify-between">
          <input
            type="text"
            value={formTags}
            onChange={(e) => setFormTags(e.target.value)}
            placeholder="Tags (comma-separated)"
            className="bg-raised border border-edge rounded-lg px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint w-60 focus:outline-none focus:border-gold"
          />

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
          defaultValue={currentSearch ?? ""}
          placeholder="Search notes..."
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setFilter("search", (e.target as HTMLInputElement).value);
            }
          }}
          className="w-full bg-panel border border-edge rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold"
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

function NotesList({
  notes,
  editingId,
  editContent,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  notes: NoteWithContext[];
  editingId: number | null;
  editContent: string;
  onStartEdit: (id: number, content: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: number) => void;
  onDelete: (id: number) => void;
}) {
  if (notes.length === 0) {
    return (
      <div className="bg-panel border border-edge rounded-xl p-8 text-center">
        <p className="text-ink-faint text-sm">
          No notes yet. Start writing to build your investment journal.
        </p>
      </div>
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
  const borderClass = TYPE_BORDER[note.note_type] ?? "border-l-edge";
  const tags: string[] = note.tags ? JSON.parse(note.tags) : [];

  return (
    <div
      className={`bg-panel border border-edge rounded-xl ${borderClass} border-l-2 ${compact ? "p-3" : "p-4"} group`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
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
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${SENTIMENT_STYLES[note.sentiment] ?? ""}`}
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
              className="p-1 text-ink-faint hover:text-ink rounded transition-colors"
              title="Edit"
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
              onClick={() => {
                if (confirm("Delete this note?")) onDelete(note.id);
              }}
              className="p-1 text-ink-faint hover:text-down rounded transition-colors"
              title="Delete"
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

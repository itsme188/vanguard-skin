"use client";

import { readMutationResult, networkFailureMessage } from "@/lib/ui/mutation-result";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  ResearchDocumentSummary,
  ResearchDocumentType,
  ResearchDocumentSentiment,
  ResearchDocumentProcessingState,
} from "@/lib/queries/research-documents";
import { documentMatchesSearch } from "./research-documents-search";
import { Chip } from "./Chip";
import { SymbolLink } from "./SymbolLink";
import { ConfirmDialog } from "./ConfirmDialog";
import { useToast } from "./Toast";
import apiFetch from "@/lib/http/apiFetch";

interface DocumentListResponse {
  documents: ResearchDocumentSummary[];
  total: number;
  /** symbol -> security id, for the mentioned symbols that are known securities. */
  symbolMap?: Record<string, number>;
}

/** How often the list is re-read while a document's full text is still extracting. */
const PENDING_LIST_POLL_MS = 10_000;

/** Symbols shown on a collapsed card before the "+N" label takes over. */
const COLLAPSED_SYMBOL_LIMIT = 6;

/** A collapsed card shows the first few symbols; an expanded one shows them all. */
export function visibleDocumentSymbols(
  symbols: string[],
  showAll: boolean,
): { shown: string[]; hidden: number } {
  const shown = showAll ? symbols : symbols.slice(0, COLLAPSED_SYMBOL_LIMIT);
  return { shown, hidden: symbols.length - shown.length };
}

/**
 * The card header reads the LIST row; the open panel reads the DETAIL fetch.
 * The two refresh on different timers, so while the list still says
 * "extracting" a fresher detail read wins. A list row that has left
 * "extracting" is final.
 */
export function effectiveProcessingState(
  listState: ResearchDocumentProcessingState,
  detailState: ResearchDocumentProcessingState | undefined,
): ResearchDocumentProcessingState {
  if (listState === "pending_body" && detailState) return detailState;
  return listState;
}

// Mirrors RESEARCH_TAG_MAX_LENGTH / RESEARCH_TAG_MAX_COUNT in
// lib/research-documents/extract.ts (that module pulls in the server-side AI
// client, so a client component cannot import from it). A test pins the pair.
export const DOCUMENT_TAG_MAX_LENGTH = 40;
export const DOCUMENT_TAG_MAX_COUNT = 15;

export interface TagAddPlan {
  /** The full tag list to save. */
  next: string[];
  /** Entries that are new to the document. */
  added: string[];
  /** Entries longer than the limit: not sent. */
  tooLong: string[];
  /** Entries that would push the document past the tag cap: not sent. */
  overCap: string[];
}

/**
 * Turn what was typed into the tags to save. A comma separates tags (as in
 * the Notes composer). An entry the server would drop is held back and named,
 * so the input never clears on a tag that was not stored.
 */
export function planTagAdd(existing: string[], input: string): TagAddPlan {
  const plan: TagAddPlan = { next: [...existing], added: [], tooLong: [], overCap: [] };
  const seen = new Set(existing);
  for (const piece of input.split(",")) {
    const tag = piece.toLowerCase().replace(/\s+/g, " ").trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    if (tag.length > DOCUMENT_TAG_MAX_LENGTH) {
      plan.tooLong.push(tag);
    } else if (plan.next.length >= DOCUMENT_TAG_MAX_COUNT) {
      plan.overCap.push(tag);
    } else {
      plan.next.push(tag);
      plan.added.push(tag);
    }
  }
  return plan;
}

/** The sentence explaining held-back entries, or null when all were accepted. */
export function tagAddProblem(plan: TagAddPlan): string | null {
  const parts: string[] = [];
  if (plan.tooLong.length > 0) {
    parts.push(
      `A tag can be at most ${DOCUMENT_TAG_MAX_LENGTH} characters. Not added: ${plan.tooLong
        .map((t) => `"${t.slice(0, DOCUMENT_TAG_MAX_LENGTH)}…"`)
        .join(", ")}.`,
    );
  }
  if (plan.overCap.length > 0) {
    parts.push(
      `A document can carry at most ${DOCUMENT_TAG_MAX_COUNT} tags. Not added: ${plan.overCap
        .map((t) => `"${t}"`)
        .join(", ")}. Remove a tag first.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

const DOC_TYPE_LABELS: Record<ResearchDocumentType, string> = {
  analyst_report: "Analyst Report",
  research_note: "Research Note",
  market_analysis: "Market Analysis",
  industry_primer: "Industry Primer",
  investor_letter: "Investor Letter",
  earnings_presentation: "Earnings / IR Deck",
  article: "Article / Journalism",
  book_summary_or_essay: "Book Summary / Essay",
  macro_note: "Macro Note",
  other: "Other",
};

const SENTIMENT_TONE: Record<ResearchDocumentSentiment, "up" | "down" | "neutral" | "gold"> = {
  bullish: "up",
  bearish: "down",
  neutral: "neutral",
  mixed: "gold",
};

function parseSymbols(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

// ─── Upload drop zone ────────────────────────────────────────────

interface UploadZoneProps {
  onUploadComplete: () => void;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function phaseFor(elapsed: number, filename: string): string {
  if (elapsed < 2) return `Uploading ${filename}`;
  if (elapsed < 8) return "Sending to Claude";
  if (elapsed < 30) return "Claude is reading the PDF";
  if (elapsed < 90) return "Claude is extracting metadata and body text";
  return "Claude is still working — dense reports with graphics can take 3-5 min";
}

function UploadZone({ onUploadComplete }: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [currentFilename, setCurrentFilename] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Live elapsed timer while uploading.
  useEffect(() => {
    if (!uploading) {
      setElapsed(0);
      return;
    }
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, [uploading]);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      if (!file.name.toLowerCase().endsWith(".pdf") && !file.type.includes("pdf")) {
        setError("Only PDF files are supported.");
        return;
      }

      setUploading(true);
      setCurrentFilename(file.name);
      setElapsed(0);

      const form = new FormData();
      form.append("file", file);

      try {
        const res = await apiFetch("/api/research/documents", {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const baseMsg = body.error ?? `Upload failed (HTTP ${res.status})`;
          // Only a snippet with content: an empty one rendered a labelled
          // empty "Model output snippet:" block.
          const snippet =
            typeof body.snippet === "string" && body.snippet.trim() ? body.snippet : null;
          setError(
            snippet
              ? `${baseMsg}\n\nModel output snippet:\n${snippet}`
              : baseMsg,
          );
          return;
        }
        onUploadComplete();
      } catch {
        setError(networkFailureMessage("upload the document"));
      } finally {
        setUploading(false);
        setCurrentFilename(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [onUploadComplete],
  );

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`rounded-xl border-2 border-dashed transition-colors p-6 ${
        dragOver
          ? "border-gold bg-gold/5"
          : uploading
            ? "border-gold/40 bg-gold/5"
            : "border-edge-strong bg-panel hover:border-gold/60"
      }`}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-ink mb-1">
            Upload research PDF
          </div>
          <div className="text-xs text-ink-faint">
            Drop an analyst report, bank research note, or market analysis here —
            Claude extracts title, author, tickers, summary, and full text. Then it&apos;s
            searchable from chat via <code className="font-mono">query_research_documents</code>.
          </div>
          {uploading && currentFilename && (
            <div className="text-xs text-gold-ink mt-2 flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
              <span className="flex-1 truncate">
                {phaseFor(elapsed, currentFilename)}
              </span>
              <span className="font-mono text-ink-faint tabular-nums">
                {formatElapsed(elapsed)}
              </span>
            </div>
          )}
          {error && (
            <pre className="text-xs text-down mt-2 whitespace-pre-wrap font-mono max-h-40 overflow-auto">
              {error}
            </pre>
          )}
        </div>
        <div className="shrink-0">
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
            disabled={uploading}
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-[filter,scale] active:scale-[0.96] disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          >
            {uploading ? "Processing…" : "Choose PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Filters bar ──────────────────────────────────────────────────

interface FiltersProps {
  search: string;
  onSearchChange: (s: string) => void;
  documentType: ResearchDocumentType | "";
  onDocumentTypeChange: (t: ResearchDocumentType | "") => void;
  symbol: string;
  onSymbolChange: (s: string) => void;
}

function Filters({
  search,
  onSearchChange,
  documentType,
  onDocumentTypeChange,
  symbol,
  onSymbolChange,
}: FiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        placeholder="Search documents…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="flex-1 min-w-[200px] px-3 py-2 rounded-lg bg-raised border border-edge text-sm text-ink placeholder:text-ink-faint"
      />
      <input
        type="text"
        placeholder="Symbol"
        value={symbol}
        onChange={(e) => onSymbolChange(e.target.value.toUpperCase())}
        className="w-24 px-3 py-2 rounded-lg bg-raised border border-edge text-sm font-mono text-ink placeholder:text-ink-faint"
      />
      <select
        value={documentType}
        onChange={(e) => onDocumentTypeChange(e.target.value as ResearchDocumentType | "")}
        className="px-3 py-2 rounded-lg bg-raised border border-edge text-sm text-ink"
      >
        <option value="">All types</option>
        {Object.entries(DOC_TYPE_LABELS).map(([key, label]) => (
          <option key={key} value={key}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Document row + expandable detail ────────────────────────────

interface ResearchDocumentDetail {
  id: number;
  title: string;
  author: string | null;
  source: string | null;
  filename: string;
  publication_date: string | null;
  document_type: ResearchDocumentType | null;
  summary: string | null;
  key_points: string[];
  mentioned_symbols: string[];
  tags: string[];
  sentiment: ResearchDocumentSentiment | null;
  target_prices: Array<{ symbol: string; price: number; horizon?: string }>;
  raw_text: string;
  char_count: number | null;
  uploaded_at: string;
  ai_model: string | null;
  processing_state: ResearchDocumentProcessingState;
}

// ─── Tag editor ─────────────────────────────────────────────────

function coerceTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string");
  }
  if (typeof raw === "string") {
    // Defensive: server should already have parsed this, but tolerate drift.
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((t): t is string => typeof t === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

function TagEditor({
  docId,
  initialTags,
  onTagsChanged,
}: {
  docId: number;
  initialTags: unknown;
  onTagsChanged: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState<string[]>(() => coerceTags(initialTags));
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const commit = useCallback(
    async (next: string[], heldBack: string | null = null) => {
      setSaving(true);
      setSaveError(heldBack);
      try {
        const res = await apiFetch(`/api/research/documents/${docId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tags: next }),
        });
        if (res.ok) {
          const data = await res.json();
          const normalized: string[] = Array.isArray(data.tags) ? data.tags : [];
          setTags(normalized);
          onTagsChanged(normalized);
          // The server has the last word on what a tag may contain. If it kept
          // fewer tags than were sent, say so instead of looking like success.
          if (normalized.length < next.length && !heldBack) {
            setSaveError(
              "Not every tag was saved. A tag keeps only letters, numbers, spaces and & + - . /",
            );
          }
        } else {
          setSaveError(`Couldn't save tags (server returned ${res.status}).`);
        }
      } catch {
        setSaveError("Couldn't save tags: could not reach the server.");
      } finally {
        setSaving(false);
      }
    },
    [docId, onTagsChanged],
  );

  function addTag() {
    if (!input.trim()) return;
    const plan = planTagAdd(tags, input);
    const problem = tagAddProblem(plan);
    // Held-back entries stay in the box so they can be shortened, not retyped.
    setInput([...plan.tooLong, ...plan.overCap].join(", "));
    if (plan.added.length === 0) {
      setSaveError(problem ?? "That tag is already on this document.");
      return;
    }
    commit(plan.next, problem);
  }

  function removeTag(t: string) {
    commit(tags.filter((x) => x !== t));
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1.5">
        Tags
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span
            key={t}
            className="group inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-raised border border-edge text-[11px] text-ink-dim"
          >
            {t}
            <button
              onClick={() => removeTag(t)}
              disabled={saving}
              // Touch target: the glyph is ~7px wide. ±4px vertical keeps the
              // extension inside the 26px pitch of wrapped tag rows.
              className="relative text-ink-faint hover:text-down transition-colors pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-1 pointer-coarse:after:-inset-x-2.5"
              aria-label={`Remove tag ${t}`}
            >
              ×
            </button>
          </span>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addTag();
          }}
          className="inline-flex items-center"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="add tag…"
            disabled={saving}
            className="px-2 py-0.5 rounded-full border border-dashed border-edge text-[11px] bg-transparent text-ink placeholder:text-ink-faint w-28 focus:outline-none focus:border-gold"
          />
        </form>
      </div>
      {saveError && <p className="text-[11px] text-down mt-1">{saveError}</p>}
    </div>
  );
}

function DocumentRow({
  doc,
  symbolMap,
  onDeleted,
  onTagsChanged,
}: {
  doc: ResearchDocumentSummary;
  /** symbol -> security id; a symbol missing here renders as plain text. */
  symbolMap: Record<string, number>;
  onDeleted: () => void;
  /** Lifts a saved tag edit back to the list so the collapsed header chips
   * and the "+N tags" count stop contradicting the open editor. */
  onTagsChanged: (docId: number, tags: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ResearchDocumentDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { toast } = useToast();

  const symbols = parseSymbols(doc.mentioned_symbols);
  const rowTags = parseSymbols(doc.tags);
  const hasChips = symbols.length > 0 || rowTags.length > 0;
  // Expanding the card resolves the "+N" label into the full symbol list.
  const { shown: shownSymbols, hidden: hiddenSymbols } = visibleDocumentSymbols(
    symbols,
    expanded,
  );
  const processingState = effectiveProcessingState(
    doc.processing_state,
    detail?.processing_state,
  );

  async function fetchDetail() {
    const res = await fetch(`/api/research/documents/${doc.id}`);
    if (res.ok) {
      const data = await res.json();
      setDetail(data);
      return data as ResearchDocumentDetail;
    }
    return null;
  }

  async function toggleExpanded() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!detail) {
      setLoadingDetail(true);
      try {
        await fetchDetail();
      } finally {
        setLoadingDetail(false);
      }
    }
  }

  // Poll for ready state while the body is still extracting, only when the
  // row is expanded (to avoid poll storms across many rows).
  useEffect(() => {
    if (!expanded) return;
    if (!detail || detail.processing_state !== "pending_body") return;
    const interval = setInterval(() => {
      fetchDetail();
    }, 15000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, detail?.processing_state, detail?.id]);

  // The list poll saw extraction finish while this row's loaded detail still
  // says "extracting" (the loop above only runs while expanded): re-read it,
  // so reopening the card does not show a stale "still extracting" panel.
  useEffect(() => {
    if (doc.processing_state === "pending_body") return;
    if (detail?.processing_state !== "pending_body") return;
    fetchDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.processing_state, detail?.processing_state]);

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    setConfirmingDelete(true);
  }

  async function confirmDelete() {
    setConfirmingDelete(false);
    try {
      const res = await apiFetch(`/api/research/documents/${doc.id}`, {
        method: "DELETE",
      });
      if (res.ok) {
        onDeleted();
      } else {
        toast(`Couldn't delete "${doc.title}" (server returned ${res.status}).`, "error");
      }
    } catch {
      toast(`Couldn't delete "${doc.title}": could not reach the server.`, "error");
    }
  }

  function handleTagsChanged(newTags: string[]) {
    if (detail) setDetail({ ...detail, tags: newTags });
    // The collapsed header renders from the PARENT's row object, so the
    // list has to be patched too — otherwise the header keeps the old
    // chips and the old "+N tags" count until a full reload.
    onTagsChanged(doc.id, newTags);
  }

  return (
    <div className="rounded-xl bg-panel border border-edge overflow-hidden">
      {/* The header tint covers the toggle button AND the chip row below it.
          The chips sit OUTSIDE the button because a symbol chip is a link, and
          a link may not be nested inside a button. */}
      <div className="hover:bg-raised transition-colors">
        <button
          onClick={toggleExpanded}
          aria-expanded={expanded}
          className={`w-full text-left px-4 pt-3 ${hasChips ? "pb-2" : "pb-3"}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-sm font-medium text-ink truncate">
                  {doc.title}
                </span>
                {doc.sentiment && (
                  <Chip tone={SENTIMENT_TONE[doc.sentiment]} size="xs">
                    {doc.sentiment}
                  </Chip>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap text-[11px] text-ink-faint">
                {/* Separators only BETWEEN present fields — a missing source/author
                    used to leak a leading "·" ("· Other"). */}
                {[
                  doc.source,
                  doc.author,
                  doc.document_type
                    ? (DOC_TYPE_LABELS[doc.document_type] ?? doc.document_type)
                    : null,
                  doc.publication_date,
                ]
                  .filter((part): part is string => !!part)
                  .map((part, i) => (
                    <span key={`${i}-${part}`}>
                      {i > 0 && "· "}
                      {part}
                    </span>
                  ))}
              </div>
              {processingState === "pending_body" && (
                <div className="flex items-center gap-1.5 mt-1.5 text-[11px] font-medium text-gold-ink">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
                  Extracting full text…
                </div>
              )}
              {processingState === "failed" && (
                <div className="mt-1.5 text-[11px] font-medium text-down">
                  Full-text extraction failed
                </div>
              )}
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <span className="text-[10px] text-ink-faint">
                {expanded ? "▾" : "▸"}
              </span>
            </div>
          </div>
        </button>
        {hasChips && (
          // A click on the row's empty space still toggles the card, as it did
          // when the chips were inside the button; a click on a link does not.
          <div
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) return;
              toggleExpanded();
            }}
            className="flex flex-wrap gap-1 px-4 pb-3"
          >
            {shownSymbols.map((s) => {
              const securityId = symbolMap[s.toUpperCase()];
              const chipClass =
                "px-1.5 py-0.5 rounded bg-raised text-ink-dim text-[11px] font-mono font-medium";
              return securityId ? (
                <SymbolLink
                  key={`sym-${s}`}
                  securityId={securityId}
                  symbol={s}
                  className={chipClass}
                />
              ) : (
                <span key={`sym-${s}`} className={chipClass}>
                  {s}
                </span>
              );
            })}
            {hiddenSymbols > 0 && (
              <span
                className="text-[11px] text-ink-faint"
                title="Open the document to see every symbol"
              >
                +{hiddenSymbols}
              </span>
            )}
            {rowTags.slice(0, 5).map((t) => (
              <span
                key={`tag-${t}`}
                className="px-1.5 py-0.5 rounded-full bg-gold/15 text-gold-ink text-[11px] font-medium"
              >
                {t}
              </span>
            ))}
            {rowTags.length > 5 && (
              <span className="text-[10px] text-ink-faint">
                +{rowTags.length - 5} tags
              </span>
            )}
          </div>
        )}
      </div>
      {expanded && (
        <div className="border-t border-edge px-4 py-3 bg-canvas/50">
          {loadingDetail ? (
            <div className="text-xs text-ink-faint">Loading…</div>
          ) : detail ? (
            <div className="space-y-3">
              <TagEditor
                docId={detail.id}
                initialTags={detail.tags}
                onTagsChanged={handleTagsChanged}
              />
              {detail.summary && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1">
                    Summary
                  </div>
                  <div className="text-sm text-ink-dim space-y-2 leading-relaxed">
                    {detail.summary
                      .split(/\n{2,}/)
                      .filter((p) => p.trim())
                      .map((para, i) => (
                        <p key={i}>{para.trim()}</p>
                      ))}
                  </div>
                </div>
              )}
              {detail.key_points.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1">
                    Key points
                  </div>
                  <ul className="text-sm text-ink-dim space-y-1 list-disc list-inside">
                    {detail.key_points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {detail.target_prices.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1">
                    Target prices
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail.target_prices.map((tp, i) => (
                      <span
                        key={i}
                        className="px-2 py-1 rounded bg-raised text-xs text-ink-dim"
                      >
                        <span className="font-mono font-medium text-ink">
                          {tp.symbol}
                        </span>{" "}
                        ${tp.price.toLocaleString()}
                        {tp.horizon && (
                          <span className="text-ink-faint"> · {tp.horizon}</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {detail.processing_state === "pending_body" ? (
                <div className="pt-2 border-t border-edge">
                  <div className="flex items-center gap-2 text-[11px] text-gold-ink">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
                    <span>
                      Full text still extracting in the background. This
                      panel will refresh automatically (every 15s).
                    </span>
                  </div>
                </div>
              ) : detail.processing_state === "failed" ? (
                <div className="pt-2 border-t border-edge">
                  <div className="text-[11px] text-down">
                    Full-text extraction failed. Metadata is preserved. To
                    retry, delete this entry and upload the PDF again (the
                    same file is not accepted twice).
                  </div>
                </div>
              ) : detail.raw_text ? (
                <div className="pt-2 border-t border-edge">
                  <button
                    onClick={() => setShowFullText((v) => !v)}
                    className="text-[10px] uppercase tracking-wider text-ink-faint hover:text-ink-dim transition-colors flex items-center gap-1.5"
                  >
                    <span>{showFullText ? "▾" : "▸"}</span>
                    {showFullText ? "Hide" : "Show"} full text
                    <span className="text-ink-faint/70 normal-case tracking-normal">
                      · {detail.raw_text.length.toLocaleString()} chars
                    </span>
                  </button>
                  {showFullText && (
                    <div
                      className="mt-3 max-h-[60vh] overflow-y-auto rounded-lg border border-edge bg-panel/50 p-4 text-sm text-ink-dim leading-relaxed space-y-3"
                    >
                      {detail.raw_text
                        .split(/\n{2,}/)
                        .filter((p) => p.trim())
                        .map((para, i) => (
                          <p key={i} className="whitespace-pre-wrap">
                            {para.trim()}
                          </p>
                        ))}
                    </div>
                  )}
                </div>
              ) : null}
              <div className="flex items-center justify-between pt-2 border-t border-edge">
                <span className="text-[10px] text-ink-faint">
                  {detail.filename}
                  {detail.ai_model && ` · ${detail.ai_model}`}
                </span>
                <button
                  onClick={handleDelete}
                  aria-label={`Delete document ${doc.title}`}
                  className="relative text-[10px] text-ink-faint hover:text-down transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']"
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <div className="text-xs text-down">Could not load detail.</div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmingDelete}
        title="Delete document"
        message={`Delete "${doc.title}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────

// ─── Forward-to-research inbox card (U6) ─────────────────────────

function InboxForwardCard({ onIngested }: { onIngested: () => void }) {
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  // QA finding research-documents-check-inbox--silent-400-no-feedback: the
  // toast() calls below fire, but ToastProvider is mounted ABOVE <main> in
  // app/dashboard/layout.tsx (its toast container div is a sibling of the
  // <main> subtree, never a descendant of it) — so a check scoped to <main>
  // (or a viewport where the corner toast goes unnoticed) never sees a
  // failure that already happened. Same silent-400 class as the two fixed
  // siblings (Sync Feeds → syncFeedback in ResearchFeedsView.tsx /
  // lib/research/sync-feedback.ts; Discover from Gmail → discoverError in
  // ManageSourcesModal.tsx), same remedy: a local status line rendered
  // directly under the control, inside this component's own tree.
  const [checkError, setCheckError] = useState<string | null>(null);
  const address = "read@myportfoliodesk.com";

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const res = await apiFetch("/api/research/ingest-inbox", { method: "POST" });
      const result = await readMutationResult<{ ingested?: number; failed?: number }>(res);
      if (result.ok) {
        const data = result.data;
        // A successful check clears any standing error from a prior attempt.
        setCheckError(null);
        const n: number = data.ingested ?? 0;
        if (n > 0) {
          toast(`Filed ${n} forwarded item${n === 1 ? "" : "s"} into Documents.`, "info");
          onIngested();
        } else {
          toast("Inbox checked — nothing new to file.", "info");
        }
        if ((data.failed ?? 0) > 0) {
          toast(`${data.failed} forwarded message(s) couldn't be processed.`, "error");
        }
      } else {
        const message = `Couldn't check the inbox: ${result.message}`;
        setCheckError(message);
        toast(message, "error");
      }
    } catch {
      const message = "Couldn't reach the inbox checker.";
      setCheckError(message);
      toast(message, "error");
    } finally {
      setChecking(false);
    }
  }, [toast, onIngested]);

  return (
    <div className="rounded-xl border border-edge bg-panel p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">Forward articles to file them here</div>
          <div className="text-xs text-ink-faint mt-0.5">
            Send any email — a link, a PDF, or a screenshot — to{" "}
            <span className="font-mono text-ink-dim">{address}</span> and it lands in
            Documents automatically (also checked on each research sync).
          </div>
        </div>
        <button
          onClick={check}
          disabled={checking}
          className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink disabled:opacity-50"
          title="Pull anything forwarded to the research address right now"
        >
          {checking ? "Checking…" : "Check inbox"}
        </button>
      </div>
      {checkError && (
        <div
          role="alert"
          className="px-3 py-2 rounded-lg bg-down/10 border border-down/30 text-xs text-down"
        >
          {checkError}
        </div>
      )}
    </div>
  );
}

/** The `?symbol=` link value as the Symbol box holds it: trimmed, upper-case. */
export function initialDocumentSymbol(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

export function ResearchDocumentsView({
  initialSymbol,
}: {
  /** `?symbol=` from the URL (a security page's "View all" link). It seeds
   *  the Symbol box, which is the one symbol filter this list has. */
  initialSymbol?: string | null;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [documents, setDocuments] = useState<ResearchDocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [documentType, setDocumentType] = useState<ResearchDocumentType | "">("");
  const [symbol, setSymbol] = useState(() => initialDocumentSymbol(initialSymbol));
  const [symbolMap, setSymbolMap] = useState<Record<string, number>>({});

  // Clearing the chip empties the Symbol box and takes `symbol` out of the
  // URL, so a reload does not bring the filter back.
  const clearSymbol = useCallback(() => {
    setSymbol("");
    if (searchParams.get("symbol") === null) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("symbol");
    const qs = params.toString();
    router.replace(qs ? `?${qs}` : "?");
  }, [router, searchParams]);

  // `quiet` = a background re-read (the pending-extraction poll): it must not
  // flip the list back to its loading state.
  const fetchDocuments = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    try {
      // When there's a search query, hit the chat-tool search endpoint via a
      // lightweight client call pattern — but we don't have a dedicated GET
      // search endpoint yet, so filter client-side when search is non-empty.
      const params = new URLSearchParams();
      if (documentType) params.set("document_type", documentType);
      if (symbol) params.set("symbol", symbol);
      params.set("limit", "100");

      const res = await fetch(`/api/research/documents?${params}`);
      if (res.ok) {
        const data: DocumentListResponse = await res.json();
        let filtered = data.documents;
        if (search.trim()) {
          // Matches tags too (QA: a visibly rendered tag returned no documents).
          filtered = filtered.filter((d) => documentMatchesSearch(d, search));
        }
        setDocuments(filtered);
        setTotal(data.total);
        setSymbolMap(data.symbolMap ?? {});
      }
    } catch (err) {
      // A failed background re-read keeps the list on screen; the next tick
      // tries again. A foreground read fails as it did before.
      if (!opts?.quiet) throw err;
    } finally {
      if (!opts?.quiet) setLoading(false);
    }
  }, [documentType, symbol, search]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // A collapsed card's "Extracting full text…" badge reads the LIST row, and
  // nothing re-read the list: the badge pulsed forever after the server had
  // finished. Re-read the list while any row is still extracting, whether or
  // not a card is open, and stop once none is.
  const anyPendingBody = documents.some((d) => d.processing_state === "pending_body");
  useEffect(() => {
    if (!anyPendingBody) return;
    const interval = setInterval(() => {
      fetchDocuments({ quiet: true });
    }, PENDING_LIST_POLL_MS);
    return () => clearInterval(interval);
  }, [anyPendingBody, fetchDocuments]);

  // A row saved new tags: patch just that row in place (immutably) instead of
  // refetching the whole list, so the collapsed header agrees with the open
  // editor immediately. `tags` is carried as a JSON string on the summary
  // row, which is what parseSymbols() reads.
  const handleTagsChanged = useCallback((docId: number, tags: string[]) => {
    setDocuments((prev) =>
      prev.map((d) => (d.id === docId ? { ...d, tags: JSON.stringify(tags) } : d)),
    );
  }, []);

  return (
    <div className="space-y-4">
      <UploadZone onUploadComplete={fetchDocuments} />

      <InboxForwardCard onIngested={fetchDocuments} />

      <div className="flex items-center justify-between gap-2">
        <Filters
          search={search}
          onSearchChange={setSearch}
          documentType={documentType}
          onDocumentTypeChange={setDocumentType}
          symbol={symbol}
          onSymbolChange={setSymbol}
        />
      </div>

      {symbol && (
        <div role="status" className="flex items-center gap-2 flex-wrap text-xs text-ink-dim">
          <Chip tone="info" size="sm">
            Symbol: {symbol}
            <button
              type="button"
              onClick={clearSymbol}
              aria-label={`Clear the ${symbol} symbol filter`}
              className="relative ml-1.5 hover:brightness-125 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2.5"
            >
              ×
            </button>
          </Chip>
          <span>Only documents that mention this symbol are listed.</span>
        </div>
      )}

      {loading && documents.length === 0 ? (
        <div className="text-sm text-ink-faint text-center py-8">Loading…</div>
      ) : documents.length === 0 ? (
        <div className="text-sm text-ink-faint text-center py-8">
          {total === 0
            ? "No research documents uploaded yet. Drop a PDF above to get started."
            : "No documents match the current filters."}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs text-ink-faint">
            {documents.length} of {total} documents
          </div>
          {documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              symbolMap={symbolMap}
              onDeleted={fetchDocuments}
              onTagsChanged={handleTagsChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

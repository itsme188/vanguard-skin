"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ResearchDocumentSummary,
  ResearchDocumentType,
  ResearchDocumentSentiment,
  ResearchDocumentProcessingState,
} from "@/lib/queries/research-documents";

interface DocumentListResponse {
  documents: ResearchDocumentSummary[];
  total: number;
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

const SENTIMENT_CLASSES: Record<ResearchDocumentSentiment, string> = {
  bullish: "bg-up-tint text-up",
  bearish: "bg-down-tint text-down",
  neutral: "bg-raised text-ink-dim",
  mixed: "bg-gold/10 text-gold",
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
        const res = await fetch("/api/research/documents", {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const baseMsg = body.error ?? `Upload failed (HTTP ${res.status})`;
          const snippet = typeof body.snippet === "string" ? body.snippet : null;
          setError(
            snippet
              ? `${baseMsg}\n\nModel output snippet:\n${snippet}`
              : baseMsg,
          );
          return;
        }
        onUploadComplete();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
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
            <div className="text-xs text-gold mt-2 flex items-center gap-2">
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
            className="px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
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

  const commit = useCallback(
    async (next: string[]) => {
      setSaving(true);
      try {
        const res = await fetch(`/api/research/documents/${docId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tags: next }),
        });
        if (res.ok) {
          const data = await res.json();
          const normalized: string[] = Array.isArray(data.tags) ? data.tags : [];
          setTags(normalized);
          onTagsChanged(normalized);
        }
      } finally {
        setSaving(false);
      }
    },
    [docId, onTagsChanged],
  );

  function addTag() {
    const raw = input.trim();
    if (!raw) return;
    const next = [...new Set([...tags, raw.toLowerCase()])];
    setInput("");
    commit(next);
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
              className="text-ink-faint hover:text-down transition-colors"
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
    </div>
  );
}

function DocumentRow({
  doc,
  onDeleted,
}: {
  doc: ResearchDocumentSummary;
  onDeleted: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ResearchDocumentDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showFullText, setShowFullText] = useState(false);

  const symbols = parseSymbols(doc.mentioned_symbols);
  const rowTags = parseSymbols(doc.tags);

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

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/research/documents/${doc.id}`, {
      method: "DELETE",
    });
    if (res.ok) onDeleted();
  }

  function handleTagsChanged(newTags: string[]) {
    if (!detail) return;
    setDetail({ ...detail, tags: newTags });
  }

  return (
    <div className="rounded-xl bg-panel border border-edge overflow-hidden">
      <button
        onClick={toggleExpanded}
        className="w-full text-left px-4 py-3 hover:bg-raised transition-colors"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-sm font-medium text-ink truncate">
                {doc.title}
              </span>
              {doc.sentiment && (
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${SENTIMENT_CLASSES[doc.sentiment]}`}
                >
                  {doc.sentiment}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap text-[11px] text-ink-faint">
              {doc.source && <span>{doc.source}</span>}
              {doc.author && <span>· {doc.author}</span>}
              {doc.document_type && (
                <span>· {DOC_TYPE_LABELS[doc.document_type]}</span>
              )}
              {doc.publication_date && <span>· {doc.publication_date}</span>}
            </div>
            {doc.processing_state === "pending_body" && (
              <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-gold">
                <span className="inline-block w-1 h-1 rounded-full bg-gold animate-pulse" />
                Extracting full text…
              </div>
            )}
            {doc.processing_state === "failed" && (
              <div className="mt-1.5 text-[10px] text-down">
                Full-text extraction failed
              </div>
            )}
            {(symbols.length > 0 || rowTags.length > 0) && (
              <div className="flex flex-wrap gap-1 mt-2">
                {symbols.slice(0, 6).map((s) => (
                  <span
                    key={`sym-${s}`}
                    className="px-1.5 py-0.5 rounded bg-raised text-ink-faint text-[10px] font-mono"
                  >
                    {s}
                  </span>
                ))}
                {symbols.length > 6 && (
                  <span className="text-[10px] text-ink-faint">
                    +{symbols.length - 6}
                  </span>
                )}
                {rowTags.slice(0, 5).map((t) => (
                  <span
                    key={`tag-${t}`}
                    className="px-1.5 py-0.5 rounded-full bg-gold/5 border border-gold/20 text-gold/80 text-[10px]"
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
          <div className="shrink-0 flex items-center gap-2">
            <span className="text-[10px] text-ink-faint">
              {expanded ? "▾" : "▸"}
            </span>
          </div>
        </div>
      </button>
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
                  <div className="flex items-center gap-2 text-[11px] text-gold">
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
                    Full-text extraction failed. Metadata is preserved — you
                    can re-upload the PDF to retry, or delete this entry.
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
                  className="text-[10px] text-ink-faint hover:text-down transition-colors"
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
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────

export function ResearchDocumentsView() {
  const [documents, setDocuments] = useState<ResearchDocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [documentType, setDocumentType] = useState<ResearchDocumentType | "">("");
  const [symbol, setSymbol] = useState("");

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
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
          const needle = search.trim().toLowerCase();
          filtered = filtered.filter(
            (d) =>
              d.title.toLowerCase().includes(needle) ||
              d.source?.toLowerCase().includes(needle) ||
              d.author?.toLowerCase().includes(needle) ||
              d.summary?.toLowerCase().includes(needle),
          );
        }
        setDocuments(filtered);
        setTotal(data.total);
      }
    } finally {
      setLoading(false);
    }
  }, [documentType, symbol, search]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  return (
    <div className="space-y-4">
      <UploadZone onUploadComplete={fetchDocuments} />

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
            <DocumentRow key={doc.id} doc={doc} onDeleted={fetchDocuments} />
          ))}
        </div>
      )}
    </div>
  );
}

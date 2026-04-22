"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ResearchDocumentSummary,
  ResearchDocumentType,
  ResearchDocumentSentiment,
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

function UploadZone({ onUploadComplete }: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      if (!file.name.toLowerCase().endsWith(".pdf") && !file.type.includes("pdf")) {
        setError("Only PDF files are supported.");
        return;
      }

      setUploading(true);
      setProgressMessage(`Extracting ${file.name}...`);

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
        setProgressMessage(null);
        onUploadComplete();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        setProgressMessage(null);
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
          {progressMessage && (
            <div className="text-xs text-gold mt-2 flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
              {progressMessage}
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
  sentiment: ResearchDocumentSentiment | null;
  target_prices: Array<{ symbol: string; price: number; horizon?: string }>;
  raw_text: string;
  char_count: number | null;
  uploaded_at: string;
  ai_model: string | null;
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

  const symbols = parseSymbols(doc.mentioned_symbols);

  async function toggleExpanded() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!detail) {
      setLoadingDetail(true);
      try {
        const res = await fetch(`/api/research/documents/${doc.id}`);
        if (res.ok) {
          const data = await res.json();
          setDetail(data);
        }
      } finally {
        setLoadingDetail(false);
      }
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/research/documents/${doc.id}`, {
      method: "DELETE",
    });
    if (res.ok) onDeleted();
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
            {symbols.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {symbols.slice(0, 6).map((s) => (
                  <span
                    key={s}
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
              {detail.summary && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-1">
                    Summary
                  </div>
                  <p className="text-sm text-ink-dim whitespace-pre-wrap">
                    {detail.summary}
                  </p>
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
              <div className="flex items-center justify-between pt-2 border-t border-edge">
                <span className="text-[10px] text-ink-faint">
                  {detail.filename} · {detail.char_count?.toLocaleString() ?? "?"} chars
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

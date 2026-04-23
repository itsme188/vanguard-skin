import Link from "next/link";
import type {
  ResearchDocumentSummary,
  ResearchDocumentType,
} from "@/lib/queries/research-documents";
import { TerminalSection } from "./TerminalSection";

const DOC_TYPE_LABELS: Record<ResearchDocumentType, string> = {
  analyst_report: "Analyst Report",
  research_note: "Research Note",
  market_analysis: "Market Analysis",
  industry_primer: "Industry Primer",
  investor_letter: "Investor Letter",
  earnings_presentation: "Earnings / IR Deck",
  article: "Article",
  book_summary_or_essay: "Book Summary / Essay",
  macro_note: "Macro Note",
  other: "Other",
};

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr)
      ? arr.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

export function ResearchDocumentsPanel({
  symbol,
  documents,
}: {
  symbol: string | null;
  documents: ResearchDocumentSummary[];
}) {
  if (!symbol || documents.length === 0) return null;

  return (
    <TerminalSection
      title={`Research Documents · ${documents.length}`}
      action={
        <Link
          href={`/dashboard/research?view=documents`}
          style={{
            fontFamily: "var(--font-mono), monospace",
            fontSize: "11px",
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#ffb84d",
          }}
          className="hover:underline"
        >
          View all →
        </Link>
      }
    >
      <div>
        {documents.map((doc, idx) => {
          const tags = parseStringArray(doc.tags);
          return (
            <div
              key={doc.id}
              style={{
                padding: "14px 20px",
                borderTop: idx === 0 ? undefined : "1px solid #161616",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px", flexWrap: "wrap" }}>
                {doc.source && (
                  <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "11px", fontWeight: 600, color: "#ffb84d", letterSpacing: "0.18em", textTransform: "uppercase" }}>
                    {doc.source}
                  </span>
                )}
                {doc.publication_date && (
                  <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "12px", color: "#666", letterSpacing: "0.08em" }}>
                    {doc.publication_date}
                  </span>
                )}
                {doc.document_type && (
                  <span style={{ fontFamily: "var(--font-mono), monospace", fontSize: "11px", letterSpacing: "0.14em", textTransform: "uppercase", color: "#888", border: "1px solid #333", padding: "2px 6px", borderRadius: "2px" }}>
                    {DOC_TYPE_LABELS[doc.document_type]}
                  </span>
                )}
              </div>
              <p style={{ fontFamily: "Geist, system-ui, sans-serif", fontSize: "16px", fontWeight: 500, color: "#eee", marginBottom: doc.summary ? "4px" : 0 }}>
                {doc.title}
              </p>
              {doc.summary && (
                <p className="line-clamp-2" style={{ fontFamily: "Geist, system-ui, sans-serif", fontSize: "14px", color: "#aaa", lineHeight: 1.55 }}>
                  {doc.summary}
                </p>
              )}
              {tags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "8px" }}>
                  {tags.slice(0, 6).map((t) => (
                    <span
                      key={t}
                      style={{
                        fontFamily: "var(--font-mono), monospace",
                        fontSize: "11px",
                        color: "#ffb84d",
                        border: "1px solid rgba(255, 184, 77, 0.25)",
                        background: "rgba(255, 184, 77, 0.05)",
                        padding: "2px 6px",
                        borderRadius: "2px",
                        letterSpacing: "0.06em",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                  {tags.length > 6 && (
                    <span style={{ fontSize: "11px", color: "#666" }}>+{tags.length - 6}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </TerminalSection>
  );
}

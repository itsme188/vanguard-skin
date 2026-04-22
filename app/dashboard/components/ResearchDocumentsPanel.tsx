import Link from "next/link";
import type {
  ResearchDocumentSummary,
  ResearchDocumentType,
} from "@/lib/queries/research-documents";

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
    <section className="rounded-xl border border-edge bg-panel overflow-hidden">
      <div className="px-5 py-3 border-b border-edge flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">
          Research Documents ({documents.length})
        </h2>
        <Link
          href={`/dashboard/research?view=documents`}
          className="text-xs text-gold hover:underline"
        >
          View All
        </Link>
      </div>
      <div className="divide-y divide-edge/50">
        {documents.map((doc) => {
          const tags = parseStringArray(doc.tags);
          return (
            <div key={doc.id} className="px-5 py-3">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                {doc.source && (
                  <span className="text-[10px] font-medium text-gold uppercase tracking-wide">
                    {doc.source}
                  </span>
                )}
                {doc.publication_date && (
                  <span className="text-xs text-ink-faint font-mono">
                    {doc.publication_date}
                  </span>
                )}
                {doc.document_type && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-raised text-ink-dim">
                    {DOC_TYPE_LABELS[doc.document_type]}
                  </span>
                )}
              </div>
              <p className="text-sm text-ink font-medium">{doc.title}</p>
              {doc.summary && (
                <p className="text-xs text-ink-dim line-clamp-2 mt-0.5">
                  {doc.summary}
                </p>
              )}
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {tags.slice(0, 6).map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 rounded-full bg-gold/5 border border-gold/20 text-gold/80 text-[10px]"
                    >
                      {t}
                    </span>
                  ))}
                  {tags.length > 6 && (
                    <span className="text-[10px] text-ink-faint">
                      +{tags.length - 6}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

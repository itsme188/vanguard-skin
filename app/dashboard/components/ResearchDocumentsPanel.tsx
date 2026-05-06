import Link from "next/link";
import type {
  ResearchDocumentSummary,
  ResearchDocumentType,
} from "@/lib/queries/research-documents";
import { Section } from "./Section";
import { Chip } from "./Chip";

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
    <Section
      title={`Research Documents · ${documents.length}`}
      action={
        <Link
          href={`/dashboard/research?view=documents`}
          className="text-xs font-medium text-blue hover:brightness-110 transition-colors"
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
              className={`px-5 py-3.5 ${idx === 0 ? "" : "border-t border-edge"}`}
            >
              <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
                {doc.source && (
                  <span
                    className="font-mono uppercase font-semibold text-gold"
                    style={{ fontSize: "11px", letterSpacing: "0.18em" }}
                  >
                    {doc.source}
                  </span>
                )}
                {doc.publication_date && (
                  <span
                    className="font-mono text-ink-faint"
                    style={{ fontSize: "12px", letterSpacing: "0.08em" }}
                  >
                    {doc.publication_date}
                  </span>
                )}
                {doc.document_type && (
                  <Chip tone="neutral" size="xs" uppercase>
                    {DOC_TYPE_LABELS[doc.document_type]}
                  </Chip>
                )}
              </div>
              <p className={`text-base font-medium text-ink ${doc.summary ? "mb-1" : ""}`}>
                {doc.title}
              </p>
              {doc.summary && (
                <p className="line-clamp-2 text-sm leading-snug text-ink-dim">
                  {doc.summary}
                </p>
              )}
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {tags.slice(0, 6).map((t) => (
                    <Chip key={t} tone="gold" size="xs">
                      {t}
                    </Chip>
                  ))}
                  {tags.length > 6 && (
                    <span className="text-xs text-ink-faint self-center">+{tags.length - 6}</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/**
 * SEC 10-K / 10-Q section extractor + summarizer.
 *
 * Pipeline:
 *   1. Look up latest 10-K or 10-Q for the ticker via EDGAR.
 *   2. Check DB cache for an existing (symbol, accession, section) row.
 *   3. On miss: fetch the primary HTML doc, strip tags, regex-locate the
 *      named section, hand to Claude Sonnet for a structured summary, and
 *      persist to `filing_sections`.
 *   4. Return the summary + key bullets + citation to the caller.
 *
 * The Claude call is model-agnostic via `getModelForFeature("filingSectionExtraction")`.
 */

import type Database from "better-sqlite3";
import {
  getLatestAnnualOrQuarterlyFiling,
  fetchFilingPrimaryDoc,
  stripFilingHtml,
  extractItemSection,
} from "@/lib/apis/edgar";
import { resolveFeatureModel } from "@/lib/ai/models";
import { generateTextForFeature } from "@/lib/ai/generate";
import {
  getCachedFilingSection,
  type FilingSection,
} from "@/lib/queries/filings";
import { upsertFilingSection } from "@/lib/mutations/filings";

export type FilingSectionName = "risk_factors" | "mda";
export type FilingType = "10-K" | "10-Q";

export interface FilingSectionResult {
  symbol: string;
  filing_type: FilingType;
  accession_number: string;
  filing_date: string;
  section_name: FilingSectionName;
  summary: string;
  key_points: string[] | null;
  source_url: string | null;
  cached: boolean;
}

// Hard cap on chars sent to Claude. Risk factors sections routinely run
// 50-80K chars; 180K is ~1.5× the worst cases and leaves headroom below
// Sonnet's 200K context window.
const MAX_SECTION_CHARS = 180_000;

const SECTION_LABELS: Record<FilingSectionName, string> = {
  risk_factors: "Risk Factors (Item 1A)",
  mda: "Management's Discussion and Analysis (MD&A)",
};

function buildPrompt(
  symbol: string,
  filingType: FilingType,
  sectionName: FilingSectionName,
  filingDate: string,
  sectionText: string,
): string {
  const label = SECTION_LABELS[sectionName];
  return `You are a sell-side research analyst reading an SEC ${filingType} filing for ${symbol}, dated ${filingDate}. Produce a concise structured brief of the "${label}" section below.

Output format (plain text, exactly):
SUMMARY
<2-4 short paragraphs — the most important themes, changes vs prior years if mentioned, and what an investor should actually worry about or act on. Plain prose, no bullets here.>

KEY POINTS
- <specific, non-boilerplate risk/insight>
- <another>
- <6-10 total>

NEW OR ELEVATED
- <risks introduced or escalated in this filing vs standard boilerplate, if any>
- <if none, write "None identified.">

Rules:
- Ignore generic boilerplate ("we operate in a competitive industry", "macroeconomic conditions may affect us"). Only surface concrete, company-specific content.
- Cite dollar figures, counterparty names, jurisdictions, percentages, product lines, and regulatory actions when present.
- Do not invent facts. If the section is sparse, say so.

SECTION TEXT (${label}):
---
${sectionText}
---`;
}

function parseModelOutput(raw: string): {
  summary: string;
  keyPoints: string[] | null;
} {
  const summaryMatch = raw.match(/SUMMARY\s*\n([\s\S]*?)(?:\n\s*KEY POINTS|\n\s*NEW OR ELEVATED|$)/i);
  const keyPointsMatch = raw.match(
    /KEY POINTS\s*\n([\s\S]*?)(?:\n\s*NEW OR ELEVATED|$)/i,
  );
  const summary = (summaryMatch ? summaryMatch[1] : raw).trim();
  const keyPoints = keyPointsMatch
    ? keyPointsMatch[1]
        .split(/\n/)
        .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
        .filter(Boolean)
    : null;
  // Preserve the NEW OR ELEVATED block in the summary so no information is
  // dropped on the floor.
  const newOrElevatedMatch = raw.match(/NEW OR ELEVATED\s*\n([\s\S]*?)$/i);
  const newOrElevated = newOrElevatedMatch ? newOrElevatedMatch[1].trim() : "";
  const fullSummary = newOrElevated
    ? `${summary}\n\nNew or Elevated:\n${newOrElevated}`
    : summary;
  return { summary: fullSummary, keyPoints };
}

function toResult(row: FilingSection, cached: boolean): FilingSectionResult {
  return {
    symbol: row.symbol,
    filing_type: row.filing_type,
    accession_number: row.accession_number,
    filing_date: row.filing_date,
    section_name: row.section_name,
    summary: row.summary,
    key_points: row.key_points ? (JSON.parse(row.key_points) as string[]) : null,
    source_url: row.source_url,
    cached,
  };
}

/**
 * Retrieve-and-cache a summarized 10-K / 10-Q section for a ticker.
 * Returns `{ error }` on any failure (unknown ticker, no filings, section
 * not locatable, LLM error).
 */
export async function getFilingSection(
  db: Database.Database,
  params: {
    symbol: string;
    filing_type: FilingType;
    section: FilingSectionName;
  },
): Promise<FilingSectionResult | { error: string }> {
  const symbol = params.symbol.toUpperCase();
  const { filing_type: filingType, section } = params;

  let ref;
  try {
    ref = await getLatestAnnualOrQuarterlyFiling(symbol, filingType);
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `EDGAR lookup failed for ${symbol}: ${err.message}`
          : `EDGAR lookup failed for ${symbol}`,
    };
  }

  if (!ref) {
    return { error: `No ${filingType} filings found for ${symbol} in SEC EDGAR.` };
  }

  const cached = getCachedFilingSection(db, symbol, ref.accessionNumber, section);
  if (cached) {
    return toResult(cached, true);
  }

  let html: string;
  try {
    html = await fetchFilingPrimaryDoc(ref);
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `Failed to fetch filing document: ${err.message}`
          : `Failed to fetch filing document`,
    };
  }

  const stripped = stripFilingHtml(html);
  const sectionText = extractItemSection(stripped, filingType, section);
  if (!sectionText) {
    return {
      error: `Could not locate "${SECTION_LABELS[section]}" in ${symbol} ${filingType} (${ref.filingDate}). Filing format may be non-standard; try EDGAR directly: ${ref.filingUrl}`,
    };
  }

  const bounded =
    sectionText.length > MAX_SECTION_CHARS
      ? sectionText.slice(0, MAX_SECTION_CHARS) +
        "\n\n[...section truncated for length; summary based on leading portion...]"
      : sectionText;

  const prompt = buildPrompt(symbol, filingType, section, ref.filingDate, bounded);

  let modelOutput: string;
  try {
    // AIRefusalError flows into this catch block and surfaces as { error }
    const { text } = await generateTextForFeature("filingSectionExtraction", {
      prompt,
      maxOutputTokens: 2000,
    });
    modelOutput = text;
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `LLM extraction failed: ${err.message}`
          : `LLM extraction failed`,
    };
  }

  const { summary, keyPoints } = parseModelOutput(modelOutput);
  const { modelId } = resolveFeatureModel("filingSectionExtraction");

  upsertFilingSection(db, {
    symbol,
    cik: ref.cik,
    filing_type: filingType,
    accession_number: ref.accessionNumber,
    filing_date: ref.filingDate,
    section_name: section,
    summary,
    key_points: keyPoints ? JSON.stringify(keyPoints) : null,
    source_url: ref.filingUrl,
    char_count: sectionText.length,
    model_id: modelId,
  });

  return {
    symbol,
    filing_type: filingType,
    accession_number: ref.accessionNumber,
    filing_date: ref.filingDate,
    section_name: section,
    summary,
    key_points: keyPoints,
    source_url: ref.filingUrl,
    cached: false,
  };
}

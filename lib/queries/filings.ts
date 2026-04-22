import type Database from "better-sqlite3";

export interface FilingSection {
  id: number;
  symbol: string;
  cik: string;
  filing_type: "10-K" | "10-Q";
  accession_number: string;
  filing_date: string;
  section_name: "risk_factors" | "mda";
  summary: string;
  key_points: string | null;
  source_url: string | null;
  char_count: number | null;
  model_id: string | null;
  created_at: string;
}

export function getCachedFilingSection(
  db: Database.Database,
  symbol: string,
  accessionNumber: string,
  sectionName: "risk_factors" | "mda",
): FilingSection | null {
  const row = db
    .prepare(
      `SELECT * FROM filing_sections
       WHERE symbol = ? AND accession_number = ? AND section_name = ?`,
    )
    .get(symbol.toUpperCase(), accessionNumber, sectionName) as
    | FilingSection
    | undefined;
  return row ?? null;
}

export function getLatestCachedSection(
  db: Database.Database,
  symbol: string,
  filingType: "10-K" | "10-Q",
  sectionName: "risk_factors" | "mda",
): FilingSection | null {
  const row = db
    .prepare(
      `SELECT * FROM filing_sections
       WHERE symbol = ? AND filing_type = ? AND section_name = ?
       ORDER BY filing_date DESC
       LIMIT 1`,
    )
    .get(symbol.toUpperCase(), filingType, sectionName) as
    | FilingSection
    | undefined;
  return row ?? null;
}

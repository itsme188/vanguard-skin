import type Database from "better-sqlite3";

export interface UpsertFilingSectionInput {
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
}

export function upsertFilingSection(
  db: Database.Database,
  input: UpsertFilingSectionInput,
): number {
  const result = db
    .prepare(
      `INSERT INTO filing_sections (
        symbol, cik, filing_type, accession_number, filing_date,
        section_name, summary, key_points, source_url, char_count, model_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, accession_number, section_name) DO UPDATE SET
        summary = excluded.summary,
        key_points = excluded.key_points,
        source_url = excluded.source_url,
        char_count = excluded.char_count,
        model_id = excluded.model_id,
        filing_date = excluded.filing_date,
        cik = excluded.cik,
        filing_type = excluded.filing_type`,
    )
    .run(
      input.symbol.toUpperCase(),
      input.cik,
      input.filing_type,
      input.accession_number,
      input.filing_date,
      input.section_name,
      input.summary,
      input.key_points,
      input.source_url,
      input.char_count,
      input.model_id,
    );
  return result.lastInsertRowid as number;
}

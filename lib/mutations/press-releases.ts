import type Database from "better-sqlite3";

export interface PressReleaseInput {
  finnhub_id: number;
  symbol: string;
  headline: string;
  summary: string | null;
  source: string | null;
  category: string | null;
  url: string | null;
  image_url: string | null;
  published_at: string; // ISO 8601
  raw_json: string | null;
}

/**
 * Upsert keyed on finnhub_id. Re-syncing the same window is idempotent;
 * Finnhub's id is globally unique so two different symbols never collide.
 */
export function upsertPressRelease(
  db: Database.Database,
  input: PressReleaseInput,
): number {
  const result = db
    .prepare(
      `INSERT INTO press_releases (
         finnhub_id, symbol, headline, summary, source, category,
         url, image_url, published_at, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(finnhub_id) DO UPDATE SET
         headline = excluded.headline,
         summary = excluded.summary,
         source = excluded.source,
         category = excluded.category,
         url = excluded.url,
         image_url = excluded.image_url,
         published_at = excluded.published_at,
         raw_json = excluded.raw_json,
         cached_at = datetime('now')`,
    )
    .run(
      input.finnhub_id,
      input.symbol.toUpperCase(),
      input.headline,
      input.summary,
      input.source,
      input.category,
      input.url,
      input.image_url,
      input.published_at,
      input.raw_json,
    );
  return result.lastInsertRowid as number;
}

export function deletePressRelease(
  db: Database.Database,
  id: number,
): boolean {
  const result = db
    .prepare(`DELETE FROM press_releases WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

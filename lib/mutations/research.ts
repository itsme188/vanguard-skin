import type Database from "better-sqlite3";

/**
 * Columns updateSource may touch. The PATCH route spreads the request body
 * straight into `updates`, and the dynamic SET loop interpolates keys as
 * column names — anything outside this allowlist is dropped, never
 * interpolated into SQL.
 */
const UPDATABLE_SOURCE_COLUMNS = new Set([
  "name",
  "sender_email",
  "sender_pattern",
  "subject_pattern",
  "is_active",
  "fetch_frequency",
  "max_age_days",
  "processing_prompt",
  "website_url",
  "allow_off_topic",
]);

export function updateSource(
  db: Database.Database,
  id: number,
  updates: {
    name?: string;
    sender_email?: string | null;
    sender_pattern?: string | null;
    subject_pattern?: string | null;
    is_active?: number;
    fetch_frequency?: string;
    max_age_days?: number;
    processing_prompt?: string | null;
    website_url?: string | null;
    /** 1 = bypass the D3 off-topic relevance filter for this source (migration 055). */
    allow_off_topic?: number;
  }
): void {
  const fields: string[] = [];
  const params: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && UPDATABLE_SOURCE_COLUMNS.has(key)) {
      fields.push(`${key} = ?`);
      params.push(value);
    }
  }

  if (fields.length === 0) return;
  params.push(id);

  db.prepare(`UPDATE research_sources SET ${fields.join(", ")} WHERE id = ?`).run(
    ...params
  );
}

export function createSource(
  db: Database.Database,
  source: {
    name: string;
    sender_email?: string;
    sender_pattern?: string;
    subject_pattern?: string;
    fetch_frequency?: string;
    max_age_days?: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO research_sources (name, sender_email, sender_pattern, subject_pattern, fetch_frequency, max_age_days)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      source.name,
      source.sender_email || null,
      source.sender_pattern || null,
      source.subject_pattern || null,
      source.fetch_frequency || "daily",
      source.max_age_days || 7
    );

  return Number(result.lastInsertRowid);
}

export function deleteSource(db: Database.Database, id: number): void {
  db.prepare(`DELETE FROM research_sources WHERE id = ?`).run(id);
}

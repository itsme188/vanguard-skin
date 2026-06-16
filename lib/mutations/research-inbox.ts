import type Database from "better-sqlite3";

export interface InboxMessageRecord {
  gmail_message_id: string;
  status: "done" | "failed";
  document_id?: number | null;
  document_count?: number;
  subject?: string | null;
  from_addr?: string | null;
  error?: string | null;
}

/**
 * Record (or update) the outcome of processing a forwarded Gmail message. Upsert
 * so a previously-failed message that succeeds on a later poll flips to 'done'.
 */
export function recordInboxMessage(
  db: Database.Database,
  r: InboxMessageRecord,
): void {
  db.prepare(
    `INSERT INTO research_inbox_messages
       (gmail_message_id, status, document_id, document_count, subject, from_addr, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(gmail_message_id) DO UPDATE SET
       status = excluded.status,
       document_id = excluded.document_id,
       document_count = excluded.document_count,
       subject = excluded.subject,
       from_addr = excluded.from_addr,
       error = excluded.error,
       processed_at = datetime('now')`,
  ).run(
    r.gmail_message_id,
    r.status,
    r.document_id ?? null,
    r.document_count ?? 0,
    r.subject ?? null,
    r.from_addr ?? null,
    r.error ?? null,
  );
}

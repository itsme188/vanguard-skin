import type Database from "better-sqlite3";

/** Gmail message ids the inbox poller has already handled (done OR failed). */
export function getProcessedInboxMessageIds(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT gmail_message_id FROM research_inbox_messages")
    .all() as { gmail_message_id: string }[];
  return new Set(rows.map((r) => r.gmail_message_id));
}

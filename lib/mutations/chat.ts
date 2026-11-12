import type Database from "better-sqlite3";
import type { ChatModelFamily } from "@/lib/chat/model-choice";

/**
 * A new conversation. `modelFamily` is the model CLASS it runs on (haiku,
 * sonnet or opus; the caller validates it with isChatModelFamily), or null
 * for the chat's default. It is written here, once: no function changes it
 * later (owner ruling 2026-11-13: one thread never mixes models).
 */
export function createConversation(
  db: Database.Database,
  scope: string,
  modelFamily: ChatModelFamily | null = null,
): number {
  const result = db
    .prepare(`INSERT INTO chat_conversations (scope, model_family) VALUES (?, ?)`)
    .run(scope, modelFamily);
  return result.lastInsertRowid as number;
}

export function saveMessage(
  db: Database.Database,
  conversationId: number,
  role: string,
  content: string | null,
  parts: string | null,
): number {
  const result = db
    .prepare(
      `INSERT INTO chat_messages (conversation_id, role, content, parts)
       VALUES (?, ?, ?, ?)`,
    )
    .run(conversationId, role, content, parts);
  db.prepare(
    `UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?`,
  ).run(conversationId);
  return result.lastInsertRowid as number;
}

export function updateConversationTitle(
  db: Database.Database,
  conversationId: number,
  title: string,
): void {
  db.prepare(
    `UPDATE chat_conversations SET title = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(title, conversationId);
}

export function deleteConversation(
  db: Database.Database,
  conversationId: number,
): boolean {
  const result = db
    .prepare(`DELETE FROM chat_conversations WHERE id = ?`)
    .run(conversationId);
  return result.changes > 0;
}

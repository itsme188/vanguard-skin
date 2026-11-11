import type Database from "better-sqlite3";

export interface ChatConversation {
  id: number;
  title: string | null;
  scope: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessage {
  id: number;
  conversation_id: number;
  role: string;
  content: string | null;
  parts: string | null;
  created_at: string;
}

export function getRecentConversations(
  db: Database.Database,
  limit: number = 20,
): ChatConversation[] {
  return db
    .prepare(
      `SELECT c.*, COUNT(m.id) as message_count
       FROM chat_conversations c
       LEFT JOIN chat_messages m ON m.conversation_id = c.id
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as ChatConversation[];
}

export function getConversationMessages(
  db: Database.Database,
  conversationId: number,
): ChatMessage[] {
  return db
    .prepare(
      `SELECT * FROM chat_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId) as ChatMessage[];
}

export interface ChatConversationRow {
  id: number;
  title: string | null;
  scope: string;
  created_at: string;
  updated_at: string;
}

/** One conversation by id, or null when it does not exist (or was deleted). */
export function getConversationById(
  db: Database.Database,
  conversationId: number,
): ChatConversationRow | null {
  const row = db
    .prepare(`SELECT id, title, scope, created_at, updated_at FROM chat_conversations WHERE id = ?`)
    .get(conversationId) as ChatConversationRow | undefined;
  return row ?? null;
}

/**
 * The newest stored message of a conversation (by insertion order, so two
 * rows written in the same second still come back in the order they were
 * saved), or null for an empty conversation.
 */
export function getLastConversationMessage(
  db: Database.Database,
  conversationId: number,
): ChatMessage | null {
  const row = db
    .prepare(`SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`)
    .get(conversationId) as ChatMessage | undefined;
  return row ?? null;
}

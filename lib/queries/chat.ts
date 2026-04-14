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
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as ChatMessage[];
}

-- Chat conversation history
CREATE TABLE chat_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  scope TEXT NOT NULL DEFAULT 'all',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT,
  parts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chat_messages_conv ON chat_messages(conversation_id, created_at);
CREATE INDEX idx_chat_conversations_updated ON chat_conversations(updated_at DESC);

-- Research feed sources (newsletter registry)
CREATE TABLE IF NOT EXISTS research_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sender_email TEXT,
  sender_pattern TEXT,
  subject_pattern TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  fetch_frequency TEXT NOT NULL DEFAULT 'daily',
  max_age_days INTEGER NOT NULL DEFAULT 7,
  processing_prompt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ingested newsletter articles with AI enrichment
CREATE TABLE IF NOT EXISTS research_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  gmail_message_id TEXT UNIQUE,
  gmail_thread_id TEXT,
  received_at TEXT NOT NULL,
  subject TEXT NOT NULL,
  sender TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  summary TEXT,
  key_themes TEXT,
  sentiment TEXT,
  sentiment_score REAL,
  mentioned_symbols TEXT,
  portfolio_relevance TEXT,
  ai_model TEXT,
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(source_id) REFERENCES research_sources(id)
);

CREATE INDEX IF NOT EXISTS idx_research_articles_source ON research_articles(source_id);
CREATE INDEX IF NOT EXISTS idx_research_articles_received ON research_articles(received_at);
CREATE INDEX IF NOT EXISTS idx_research_articles_processed ON research_articles(processed_at);

-- Many-to-many: articles <-> portfolio securities
CREATE TABLE IF NOT EXISTS research_article_securities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  mention_context TEXT,
  sentiment TEXT,
  FOREIGN KEY(article_id) REFERENCES research_articles(id) ON DELETE CASCADE,
  FOREIGN KEY(security_id) REFERENCES securities(id),
  UNIQUE(article_id, security_id)
);

CREATE INDEX IF NOT EXISTS idx_ras_security ON research_article_securities(security_id);
CREATE INDEX IF NOT EXISTS idx_ras_article ON research_article_securities(article_id);

-- Seed known newsletter sources (names only — user populates sender_email via Discover or manual entry)
INSERT INTO research_sources (name, sender_email) VALUES ('Vital Knowledge', 'updates@vitalknowledge.net');
INSERT INTO research_sources (name) VALUES ('TMT Breakouts');
INSERT INTO research_sources (name) VALUES ('Morning Recap');
INSERT INTO research_sources (name) VALUES ('Afternoon Recap');
INSERT INTO research_sources (name) VALUES ('Stratechery');
INSERT INTO research_sources (name) VALUES ('The Diff');
INSERT INTO research_sources (name) VALUES ('Alliant Capital');

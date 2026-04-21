-- Migration 029: security_levels + level_alerts + watchlist grouping
--
-- Canonical store for price levels on securities (per-security entries/exits/stops,
-- index levels from newsletters, etc.) and the alerts generated when prices cross them.
--
-- Multiple producers (user, newsletter, technical, claude) and multiple consumers
-- (chart overlay, alerts inbox, chat, weekly briefing).

-- ─── security_levels ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS security_levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  security_id INTEGER NOT NULL,
  level_type TEXT NOT NULL,                 -- 'support' | 'resistance' | 'entry' | 'exit' | 'stop' | 'scale_in'
  price REAL NOT NULL,
  direction TEXT,                           -- 'bullish' | 'bearish' (how to interpret a hit)
  action_hint TEXT,                         -- 'new_position' | 'scale_in' | 'trim' | 'close' | 'watch'
  source TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'newsletter' | 'technical' | 'claude'
  source_article_id INTEGER,                -- FK to research_articles when source='newsletter'
  source_author TEXT,                       -- display: "Eliant Capital", "Purple Drink"
  thesis TEXT,                              -- paraphrased reasoning
  timeframe TEXT,                           -- 'day' | 'week' | 'month' (informational)
  expires_at TEXT,                          -- optional auto-expire
  group_id TEXT,                            -- cluster levels that form one setup
  set_date TEXT NOT NULL DEFAULT (date('now')),
  is_active INTEGER NOT NULL DEFAULT 1,
  triggered_at TEXT,                        -- timestamp when price crossed this level
  triggered_price REAL,                     -- actual price at trigger time
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (security_id) REFERENCES securities(id),
  FOREIGN KEY (source_article_id) REFERENCES research_articles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_security_levels_security ON security_levels(security_id, is_active);
CREATE INDEX IF NOT EXISTS idx_security_levels_active ON security_levels(is_active, set_date DESC);
CREATE INDEX IF NOT EXISTS idx_security_levels_source_article ON security_levels(source_article_id);

-- ─── level_alerts ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS level_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level_id INTEGER NOT NULL,
  security_id INTEGER NOT NULL,
  triggered_at TEXT NOT NULL,
  triggered_price REAL NOT NULL,
  suggested_action TEXT,                    -- Claude-generated recommendation
  position_context TEXT,                    -- JSON snapshot: holdings across accounts
  user_response TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'acted' | 'ignored' | 'dismissed'
  user_response_at TEXT,
  user_response_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (level_id) REFERENCES security_levels(id) ON DELETE CASCADE,
  FOREIGN KEY (security_id) REFERENCES securities(id)
);

CREATE INDEX IF NOT EXISTS idx_level_alerts_pending ON level_alerts(user_response, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_level_alerts_security ON level_alerts(security_id, created_at DESC);

-- ─── watchlist: add group_name ──────────────────────────────────────
-- Existing watchlist is a flat list. Add grouping to support user's two real lists
-- ("Buy in Vanguard" — slow-motion screening; "IBKR Buy Next" — waiting for market pullback).
-- Defaults to 'default' so existing rows keep working without UI changes.

ALTER TABLE watchlist ADD COLUMN group_name TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_watchlist_group ON watchlist(group_name, is_active);

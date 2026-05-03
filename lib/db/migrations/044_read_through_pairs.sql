-- Stock-to-stock read-through pairs — when reporter A prints earnings,
-- the pair (A → B) tells the preview composer to inject A's beat-vs-
-- consensus delta + reaction snapshot into B's upcoming preview email.
--
-- Plan: docs/plans/2026-05-02-stock-to-stock-read-throughs.md
-- TODO entry: docs/plans/TODO.md § "Stock-to-stock read-throughs"
--
-- Directed pairs only. A cluster (e.g. {GOOGL, META, APP, RDDT} ad
-- platforms) is materialized by the seed script as N×(N−1) directed
-- rows, one per ordered pair. Avoids a separate `clusters` table while
-- N stays small; revisit if any cluster grows past ~6 members.
--
-- The composer integration (lib/digest/send-earnings-email.ts) is
-- blocked by the reaction_snapshot enrichment gap surfaced 2026-05-02
-- (see Bugs/Quality TODO entry); this migration ships the foundation
-- so the seed list and design are in place for the next session.

CREATE TABLE IF NOT EXISTS read_through_pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_symbol TEXT NOT NULL,
  target_symbol TEXT NOT NULL,

  -- Free-text rationale rendered into the AI prompt so Sonnet can
  -- frame the implication ("PRTO and XMTR both make on-demand parts;
  -- their margins move on the same input-cost cycle").
  hypothesis TEXT,

  -- Cluster tag for fan-out provenance + future grouping in UI.
  -- Single-pair entries leave this NULL. Cluster seeds set e.g.
  -- 'ad-platform-2026'.
  group_label TEXT,

  -- 0.0–1.0. Composer can sort multiple reporters in window by weight
  -- and inject the top N. Default 1.0 = treat all curated pairs as
  -- equally relevant until performance attribution tells us otherwise.
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(reporter_symbol, target_symbol),
  CHECK (reporter_symbol != target_symbol)
);

CREATE INDEX IF NOT EXISTS idx_read_through_pairs_target
  ON read_through_pairs(target_symbol);
CREATE INDEX IF NOT EXISTS idx_read_through_pairs_reporter
  ON read_through_pairs(reporter_symbol);
CREATE INDEX IF NOT EXISTS idx_read_through_pairs_group
  ON read_through_pairs(group_label) WHERE group_label IS NOT NULL;

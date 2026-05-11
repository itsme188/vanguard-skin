-- Migration 054: Email filtering — admin-mail short-circuit + relevance flag.
--
-- Tier 5 D1+D2 slice. Adds three columns to research_articles so the Gmail
-- fetcher can pre-filter Substack admin mail (payment receipts, welcome
-- emails, gift-subscription notifications) before it reaches the AI
-- processing step. Saves Claude tokens AND keeps the morning digest free
-- of operational noise.
--
-- is_relevant:        1 (default) = include in digest; 0 = exclude
-- excluded_category:  short tag explaining why (welcome, receipt, gift, admin)
-- excluded_reason:    free-text for audit (the matching subject line snippet)
--
-- Existing articles are grandfathered: DEFAULT 1 means everything already
-- in the table stays in digest. D2 regex applies prospectively only — to
-- new fetches after the column is added. The D5 audit UI (deferred to a
-- later slice) will let the user retroactively flip is_relevant on existing
-- rows if they want.
--
-- Sibling index on (is_relevant, received_at) accelerates the digest filter
-- pass that will land in D4.

ALTER TABLE research_articles ADD COLUMN is_relevant INTEGER NOT NULL DEFAULT 1;
ALTER TABLE research_articles ADD COLUMN excluded_category TEXT;
ALTER TABLE research_articles ADD COLUMN excluded_reason TEXT;

CREATE INDEX idx_research_articles_is_relevant
  ON research_articles(is_relevant, received_at DESC);

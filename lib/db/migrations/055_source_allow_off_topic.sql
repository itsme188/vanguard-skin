-- Migration 055: Per-source opt-out of the D3 portfolio-relevance filter.
--
-- D3 has Claude vote `is_portfolio_relevant` on every article. When the vote
-- is false, processUnprocessedArticles flips `is_relevant=0` so the article
-- skips the digest. Some sources are intentionally general-purpose (Helene
-- Meisler's chart commentary, Vital Knowledge macro) and the user wants ALL
-- of their content in the digest regardless of Claude's portfolio-relevance
-- verdict. `allow_off_topic=1` on the source opts out of the gate.
--
-- Defaults to 0 (gate applies) so new sources auto-inherit the filter.
-- Existing sources keep gate-on; the user can flip individual sources via
-- the Sources admin UI (no app surface yet — direct UPDATE in the DB until
-- D5 ships the surface).

ALTER TABLE research_sources ADD COLUMN allow_off_topic INTEGER NOT NULL DEFAULT 0;

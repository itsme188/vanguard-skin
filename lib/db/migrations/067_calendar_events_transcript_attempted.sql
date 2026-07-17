-- Migration 067: pacing marker for the same-day transcript orchestrator
-- (#12 B1). Stamped on EVERY fetch attempt (success or failure) BEFORE the
-- fetchTranscript call so a hung fetch can't hot-loop the sweep; the
-- orchestrator skips an event whose transcript_attempted_at is <30 min old.
-- Sibling to migration 062's enrichment_attempted_at pacing marker.
ALTER TABLE calendar_events ADD COLUMN transcript_attempted_at TEXT;

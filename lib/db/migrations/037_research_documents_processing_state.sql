-- Add processing_state to support deferred raw-text extraction. Uploads fire
-- two Claude calls in parallel: metadata (fast) + raw_text (slow). The row is
-- inserted as soon as metadata is ready with a placeholder raw_text and
-- processing_state='pending_body'. A background promise awaits raw_text and
-- updates the row to processing_state='ready'. On failure, 'failed'.
--
-- FTS5 doesn't need updating - processing_state isn't a search column.

ALTER TABLE research_documents ADD COLUMN processing_state TEXT
  DEFAULT 'ready'
  CHECK (processing_state IN ('ready', 'pending_body', 'failed'));

CREATE INDEX idx_research_documents_processing_state
  ON research_documents(processing_state)
  WHERE processing_state != 'ready';

-- Add raw_html column to preserve original newsletter HTML (images, charts, tables).
-- raw_text remains for AI processing; raw_html is for display in the expanded article view.
ALTER TABLE research_articles ADD COLUMN raw_html TEXT;

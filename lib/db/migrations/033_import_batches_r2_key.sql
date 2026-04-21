-- Migration 033: R2 key for archived source files.
-- Phase 3 of Cloudflare integration (see memory/project_ai_gateway.md).
-- Purely additive column — enables disaster-recovery archival of original
-- PDFs/CSVs to Cloudflare R2 after successful import. The DB has always had
-- the parsed data; this just lets us retrieve the source file later.

ALTER TABLE import_batches ADD COLUMN raw_file_r2_key TEXT;

-- Key format (enforced in app logic): {account-slug}/{YYYY-MM}/{filename}
--   e.g. "vanguard-taxable/2026-02/2026-02-Vanguard-Brokerage-statement.pdf"
-- NULL means either (a) R2 wasn't configured when this batch was imported, or
-- (b) backfill hasn't run yet. Either way, nothing breaks — R2 is additive.

-- Migration 032: review_status column on security_levels.
-- Gates newsletter-extracted levels behind a user-review step before the scan
-- arms them. User-created levels bypass (default 'auto_approved') so the user
-- flow is unchanged. Newsletter extraction inserts 'pending_review'; the
-- /dashboard/levels/review page lets the user approve or reject in bulk.

ALTER TABLE security_levels ADD COLUMN review_status TEXT NOT NULL DEFAULT 'auto_approved';

-- review_status values (enforced in app logic):
--   'auto_approved'    — armed; scan considers it (user-created OR approved newsletter level)
--   'pending_review'   — extracted from newsletter; waiting on user approval; scan ignores
--   'rejected'         — user rejected an extracted level; scan ignores; kept for audit

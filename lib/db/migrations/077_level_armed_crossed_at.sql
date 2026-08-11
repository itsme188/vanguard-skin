-- Migration 077: armed_crossed_at column on security_levels.
--
-- Approving (arming) a level whose trigger condition is ALREADY satisfied
-- (QA finding alerts-review--approve-fires-instant-false-hit-alert-threshold-scan)
-- would otherwise present as a fresh cross on the very next scan. When the
-- guard is force-overridden, this column is stamped with the arm time so
-- alert composition can disclose honestly ("was already past this level
-- when it was armed") instead of pretending the price just crossed.
--
-- NULL for every normal arm (condition not yet satisfied at approval time).
-- Cleared back to NULL on any clean re-approval/reject/pending transition so
-- a stale stamp from a prior force-arm cycle can't survive.

ALTER TABLE security_levels ADD COLUMN armed_crossed_at TEXT;

-- 072_earnings_date_verification.sql
-- Date/slot verification stamps for earnings calendar rows.
-- date_verified_at: set when a Claude+web_search pass confirmed (or a
-- correction re-established) this row's event_date + BMO/AMC slot.
-- date_verification_note: human-readable outcome ("confirmed via ir.example.com",
-- "unconfirmed — no company announcement found").
ALTER TABLE calendar_events ADD COLUMN date_verified_at TEXT;
ALTER TABLE calendar_events ADD COLUMN date_verification_note TEXT;

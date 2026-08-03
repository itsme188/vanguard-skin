-- Bogey-sheet expected move (feedback #5, 2026-08-03).
-- Analyst sheets (TMT Breakout weeklies) state an expected earnings move per
-- name; it outranks the market-derived implied move (sheet > straddle >
-- iv_approx) at every render surface via lib/earnings/expected-move.ts.
-- Stored on the bogey row because it is per-source analyst data with
-- provenance (source_label), like whisper numbers. Absolute percent: ±6% → 6.
ALTER TABLE earnings_bogeys ADD COLUMN expected_move_pct REAL;

-- Add data_quality column to daily_valuations to track reliability of each row.
-- Values: 'live' (all prices from today), 'recent' (prices <3d old),
--         'estimated' (prices >3d old or cash anchor >30d), 'computed' (default/unknown).
ALTER TABLE daily_valuations ADD COLUMN data_quality TEXT DEFAULT 'computed';

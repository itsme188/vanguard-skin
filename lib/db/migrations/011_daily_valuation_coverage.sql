-- Add coverage tracking columns to daily_valuations
-- These are diagnostic: how many holdings existed vs how many had a price
ALTER TABLE daily_valuations ADD COLUMN holdings_count INTEGER;
ALTER TABLE daily_valuations ADD COLUMN priced_count INTEGER;

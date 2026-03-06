-- Add IBKR TWS enrichment columns to securities
ALTER TABLE securities ADD COLUMN sector TEXT;
ALTER TABLE securities ADD COLUMN industry TEXT;
ALTER TABLE securities ADD COLUMN exchange TEXT;
ALTER TABLE securities ADD COLUMN ib_con_id INTEGER;

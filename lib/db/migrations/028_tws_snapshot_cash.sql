-- Store TWS-reported cash alongside netLiquidation in monthly_snapshots.
-- Only populated for source='tws' rows. NULL for statement-sourced snapshots.
ALTER TABLE monthly_snapshots ADD COLUMN cash_value REAL;

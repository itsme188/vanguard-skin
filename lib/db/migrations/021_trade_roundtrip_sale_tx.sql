-- Add sale_transaction_id to trade_roundtrips for grouped trade tracking.
-- Nullable for backward compatibility with existing reviews.
ALTER TABLE trade_roundtrips ADD COLUMN sale_transaction_id INTEGER;

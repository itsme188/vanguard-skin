-- Transactions are filtered by (account_id, trade_date) in dashboard and chat queries
CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, trade_date);

-- Transactions are filtered by (type, security_id) in tax lot computation BUY/SELL queries
CREATE INDEX IF NOT EXISTS idx_transactions_type_security ON transactions(type, security_id);

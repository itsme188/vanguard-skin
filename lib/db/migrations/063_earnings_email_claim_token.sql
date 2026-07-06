-- 063: claim ownership token. A send claim held >30 min can be taken over by
-- a second process; without a token, the slow first process's failure-cleanup
-- DELETE could remove the successor's live claim (theoretical duplicate-send
-- opener — 2026-07-04 audit review minor). Claims now carry a per-claim UUID
-- and release is token-conditional. Reap is unchanged (it only targets claims
-- stale >30 min, which a live successor's refreshed sent_at can never be).
ALTER TABLE earnings_emails ADD COLUMN claim_token TEXT;

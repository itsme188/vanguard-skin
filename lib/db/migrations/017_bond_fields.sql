-- Bond-specific fields: duration for rate sensitivity, credit rating for quality analysis,
-- coupon rate for yield estimates. All nullable — only populated for bond securities.

ALTER TABLE securities ADD COLUMN duration_years REAL;
ALTER TABLE securities ADD COLUMN credit_rating TEXT;
ALTER TABLE securities ADD COLUMN coupon_rate REAL;

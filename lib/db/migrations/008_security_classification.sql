-- Add classification columns for factor analysis and allocation views
ALTER TABLE securities ADD COLUMN fund_category TEXT;
ALTER TABLE securities ADD COLUMN geography TEXT;
ALTER TABLE securities ADD COLUMN market_cap_category TEXT;
ALTER TABLE securities ADD COLUMN style TEXT;
ALTER TABLE securities ADD COLUMN classification_source TEXT;

CREATE INDEX idx_securities_fund_category ON securities(fund_category);
CREATE INDEX idx_securities_geography ON securities(geography);

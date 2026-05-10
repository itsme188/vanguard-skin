-- Construction caps — per-scope sanity thresholds consumed by the What-if
-- Calculator + Cash-Deploy solver. Defaults chosen per Analysis Deep Dive
-- spec §5.1. User-editable via Settings UI (deferred to post-P4).
--
-- top1_max:   max weight any single position should reach
-- top3_max:   max combined weight of top 3 positions
-- sector_max: max weight any single sector should reach
-- beta_range: [low, high] acceptable portfolio beta band
--
-- The Roth profile is most concentrated-tolerant (long-tail growth allowed);
-- IBKR is most permissive (active trading account); Vanguard is the
-- conservative long-term core.

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('construction_caps_roth',     '{"top1_max":0.10,"top3_max":0.25,"sector_max":0.35,"beta_range":[0.7,1.2]}'),
  ('construction_caps_vanguard', '{"top1_max":0.08,"top3_max":0.22,"sector_max":0.30,"beta_range":[0.7,1.1]}'),
  ('construction_caps_ibkr',     '{"top1_max":0.15,"top3_max":0.40,"sector_max":0.45,"beta_range":[0.5,1.5]}'),
  ('construction_caps_all',      '{"top1_max":0.10,"top3_max":0.25,"sector_max":0.35,"beta_range":[0.7,1.2]}');

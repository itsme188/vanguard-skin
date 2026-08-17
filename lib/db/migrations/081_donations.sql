-- lib/db/migrations/081_donations.sql
-- R4 donation tracking (spec: docs/superpowers/specs/2026-08-17-donation-tracking-design.md §4).
-- donations rows come ONLY from the daf-contributions import; links/assignments
-- ONLY from explicit user confirmation or a reviewed repair --apply.

CREATE TABLE donations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT UNIQUE NOT NULL,
  import_batch_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('stock','cash')),
  security_id INTEGER,
  symbol_raw TEXT,
  quantity REAL CHECK (quantity IS NULL OR quantity > 0),
  fmv_usd REAL NOT NULL CHECK (fmv_usd > 0),
  unit_valuation REAL CHECK (unit_valuation IS NULL OR unit_valuation > 0),
  created_date TEXT,
  received_date TEXT NOT NULL,
  completed_date TEXT,
  reversed_date TEXT,
  notes TEXT,
  FOREIGN KEY(import_batch_id) REFERENCES import_batches(id),
  FOREIGN KEY(security_id) REFERENCES securities(id)
);
CREATE INDEX idx_donations_received ON donations(received_date);
CREATE INDEX idx_donations_security ON donations(security_id);

CREATE TABLE donation_leg_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL,
  transaction_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('out','routing_artifact')),
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(donation_id) REFERENCES donations(id) ON DELETE CASCADE,
  FOREIGN KEY(transaction_id) REFERENCES transactions(id)
);
-- v1 pair model: exactly one flow-carrying leg and at most one artifact leg per donation.
CREATE UNIQUE INDEX idx_donation_out_link ON donation_leg_links(donation_id) WHERE role = 'out';
CREATE UNIQUE INDEX idx_donation_artifact_link ON donation_leg_links(donation_id) WHERE role = 'routing_artifact';

CREATE TABLE donation_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  donation_id INTEGER NOT NULL,
  acquisition_transaction_id INTEGER NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(donation_id, acquisition_transaction_id),
  FOREIGN KEY(donation_id) REFERENCES donations(id) ON DELETE CASCADE,
  FOREIGN KEY(acquisition_transaction_id) REFERENCES transactions(id)
);

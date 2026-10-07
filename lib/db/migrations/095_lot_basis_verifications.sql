-- 095: lot_basis_verifications — "the owner checked this lot's basis".
--
-- The Giving page flags a donated lot whose per-share basis is under 1% of
-- the gift's per-share fair market value and leaves that gift out of the
-- year's "Gain avoided" total (owner ruling 2026-10-06). The flag is right to
-- fire, but sometimes the tiny basis is true. This table records that the
-- owner verified one such lot against a source document, and which document
-- (owner request 2026-10-07).
--
-- A lot IS its acquisition transaction, so the marker hangs off that row: one
-- marker per transaction, and it covers every gift that draws on the lot.
-- Deleting the transaction (an import-batch undo) removes the marker with it.
--
-- verified_amount / verified_quantity are the LOT's cost basis and quantity
-- acquired (tax_lots.cost_basis and tax_lots.quantity_acquired for this
-- acquisition transaction) at the moment of verification. Those are the
-- figures the Giving page shows and its 1% rule reads. If either later
-- differs from the lot's current value, or the lot is gone from the ledger,
-- the marker is stale and no longer applies: what was verified is not what
-- the lot says now.
--
-- The marker is a note about a check. It is not a tax input: nothing here
-- feeds the tax-lot engine, and writing a row never triggers a recompute.
--
-- Additive and data-free: a new, empty table.

CREATE TABLE lot_basis_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  acquisition_transaction_id INTEGER NOT NULL UNIQUE,
  source_note TEXT NOT NULL CHECK (length(trim(source_note)) > 0),
  verified_amount REAL,
  verified_quantity REAL,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (acquisition_transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
);

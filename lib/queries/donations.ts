import type Database from "better-sqlite3";

export interface DonationRow {
  id: number;
  source_key: string;
  import_batch_id: number | null;
  kind: "stock" | "cash";
  security_id: number | null;
  symbol_raw: string | null;
  quantity: number | null;
  fmv_usd: number;
  unit_valuation: number | null;
  created_date: string | null;
  received_date: string;
  completed_date: string | null;
  reversed_date: string | null;
  notes: string | null;
}

export function getDonations(db: Database.Database): DonationRow[] {
  return db
    .prepare("SELECT * FROM donations ORDER BY received_date DESC")
    .all() as DonationRow[];
}

export function getDonationBySourceKey(db: Database.Database, sourceKey: string): DonationRow | null {
  const row = db.prepare("SELECT * FROM donations WHERE source_key = ?").get(sourceKey) as
    | DonationRow
    | undefined;
  return row ?? null;
}

export function getDonationsForYear(db: Database.Database, year: string): DonationRow[] {
  return db
    .prepare("SELECT * FROM donations WHERE received_date LIKE ? ORDER BY received_date DESC")
    .all(`${year}-%`) as DonationRow[];
}

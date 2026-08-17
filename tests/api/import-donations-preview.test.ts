/**
 * Task 5 review fix (Important #1): previewDonations (app/api/import/route.ts)
 * runs commitDonations' real INSERT/UPDATE logic inside a transaction that's
 * unconditionally rolled back — but that "preview never persists" invariant
 * had zero test coverage. This pins it: a preview call over a donations file
 * must leave `donations` and `import_batches` row counts unchanged while
 * still reporting accurate counts in its return payload.
 *
 * The route module imports the `@/lib/db` singleton at load time (which
 * would open the real on-disk DB) — previewDonations takes an explicit db
 * param, so the singleton is never touched here; stub it to keep the test
 * hermetic (same pattern as tests/api/import-undo-recovery.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/db", () => ({ db: {} }));

import { runMigrations } from "@/lib/db/migrate";
import { previewDonations } from "@/app/api/import/route";
import { upsertSecurity } from "@/lib/mutations/securities";
import type { ParsedDonation } from "@/lib/import/types";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

const STOCK_DONATION: ParsedDonation = {
  sourceKey: "daf:contribution:2026-03-02:FAKE:10:2026-03-01 20:00:00 +0000",
  kind: "stock",
  symbolRaw: "FAKE",
  quantity: 10,
  fmvUsd: 1234.5,
  unitValuation: 123.45,
  createdDate: "2026-03-01",
  receivedDate: "2026-03-02",
  completedDate: "2026-03-03",
  createdAtRaw: "2026-03-01 20:00:00 +0000",
};

const CASH_DONATION: ParsedDonation = {
  sourceKey: "daf:contribution:2026-05-02:USD:2500:2026-05-01 12:00:00 +0000",
  kind: "cash",
  symbolRaw: null,
  quantity: null,
  fmvUsd: 2500,
  unitValuation: 1,
  createdDate: "2026-05-01",
  receivedDate: "2026-05-02",
  completedDate: "2026-05-02",
  createdAtRaw: "2026-05-01 12:00:00 +0000",
};

describe("previewDonations: never persists", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = fresh();
    upsertSecurity(db, "FAKE", "Fake Co");
  });

  it("leaves donations + import_batches row counts unchanged after a preview call, while still reporting the correct newCount", () => {
    const before = {
      donations: (db.prepare("SELECT COUNT(*) AS c FROM donations").get() as { c: number }).c,
      batches: (db.prepare("SELECT COUNT(*) AS c FROM import_batches").get() as { c: number }).c,
    };

    const preview = previewDonations(db, [STOCK_DONATION, CASH_DONATION]);

    expect(preview).toBeDefined();
    expect(preview!.count).toBe(2);
    expect(preview!.newCount).toBe(2);
    expect(preview!.updatedCount).toBe(0);
    expect(preview!.identityConflicts).toHaveLength(0);
    expect(preview!.unresolvedSymbols).toHaveLength(0);

    const after = {
      donations: (db.prepare("SELECT COUNT(*) AS c FROM donations").get() as { c: number }).c,
      batches: (db.prepare("SELECT COUNT(*) AS c FROM import_batches").get() as { c: number }).c,
    };
    expect(after.donations).toBe(before.donations);
    expect(after.batches).toBe(before.batches);
  });

  it("still reports an accurate updatedCount for a donation that already exists, without persisting the update", () => {
    // Seed a prior commit-equivalent state directly (bypassing engine.ts —
    // this test targets previewDonations in isolation).
    db.prepare(
      `INSERT INTO donations (source_key, kind, security_id, symbol_raw, quantity, fmv_usd,
         unit_valuation, created_date, received_date, completed_date, notes)
       VALUES (?, 'stock', (SELECT id FROM securities WHERE symbol='FAKE'), 'FAKE', 10, 1234.5,
         123.45, '2026-03-01', '2026-03-02', NULL, NULL)`,
    ).run(STOCK_DONATION.sourceKey);

    const before = (db.prepare("SELECT COUNT(*) AS c FROM donations").get() as { c: number }).c;

    // Same identity, but completed_date now populated — would be an update.
    const withCompletedDate: ParsedDonation = { ...STOCK_DONATION, completedDate: "2026-03-05" };
    const preview = previewDonations(db, [withCompletedDate]);

    expect(preview!.newCount).toBe(0);
    expect(preview!.updatedCount).toBe(1);

    const after = (db.prepare("SELECT COUNT(*) AS c FROM donations").get() as { c: number }).c;
    expect(after).toBe(before);

    const row = db
      .prepare("SELECT completed_date FROM donations WHERE source_key = ?")
      .get(STOCK_DONATION.sourceKey) as { completed_date: string | null };
    expect(row.completed_date).toBeNull(); // NOT persisted — preview must never write
  });

  it("returns undefined for an empty donations array and performs no writes", () => {
    const before = (db.prepare("SELECT COUNT(*) AS c FROM import_batches").get() as { c: number }).c;
    const preview = previewDonations(db, []);
    expect(preview).toBeUndefined();
    const after = (db.prepare("SELECT COUNT(*) AS c FROM import_batches").get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

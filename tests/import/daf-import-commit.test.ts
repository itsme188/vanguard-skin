import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport } from "@/lib/import/engine";
import { commitDonations, findAbsentPriorDonations } from "@/lib/import/donations-commit";
import { upsertSecurity } from "@/lib/mutations/securities";
import type { ParsedDonation } from "@/lib/import/types";

// Header + row shapes derived from tests/fixtures/daf-contributions-sample.csv
// (Task 4's parser fixture) — built inline here as template-string variants
// per the task-5 brief's Step 1.
const HEADER =
  "type,frequency,amount,currency,USD amount,currency valuation,created at,received at,completed at";
const ROW1_FAKE =
  "  Stock,One time,10.0,FAKE,1234.5,123.45,2026-03-01 20:00:00 +0000,2026-03-02 13:00:00 +0000,2026-03-03 17:00:00 +0000";
const ROW2_ZZZZ =
  "  Stock,One time,5.0,ZZZZ,500.0,,2026-04-10 01:30:00 +0000,2026-04-10 13:00:00 +0000,";
const ROW2_ZZZZ_COMPLETED =
  "  Stock,One time,5.0,ZZZZ,500.0,,2026-04-10 01:30:00 +0000,2026-04-10 13:00:00 +0000,2026-04-11 12:00:00 +0000";
const ROW3_CASH =
  "  Bank transfer,One time,2500.0,USD,2500.0,1,2026-05-01 12:00:00 +0000,2026-05-02 05:00:00 +0000,2026-05-02 05:00:00 +0000";

const FIXTURE_3 = [HEADER, ROW1_FAKE, ROW2_ZZZZ, ROW3_CASH].join("\n");
const FIXTURE_ROW2_COMPLETED = [HEADER, ROW1_FAKE, ROW2_ZZZZ_COMPLETED, ROW3_CASH].join("\n");
// Truncated: row2 (ZZZZ) dropped, but row1 + row3 still fall in 2026 — same
// year window findAbsentPriorDonations checks.
const FIXTURE_TRUNCATED = [HEADER, ROW1_FAKE, ROW3_CASH].join("\n");

describe("commitImport: daf-contributions donations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // FAKE resolves to a real security; ZZZZ deliberately does not — lets the
    // unresolved-symbol assertions target ZZZZ specifically.
    upsertSecurity(db, "FAKE", "Fake Co");
  });

  it("commits all 3 donations; batch summary names the count; unresolved symbol lands with security_id NULL + is warned about", async () => {
    const parsed = await parseImport(FIXTURE_3, "contrib.csv");
    const result = commitImport(db, parsed);

    expect(result.newDonations).toBe(3);
    expect(result.updatedDonations).toBe(0);

    const batchRow = db
      .prepare("SELECT summary FROM import_batches WHERE id = ?")
      .get(result.batchId) as { summary: string };
    expect(batchRow.summary).toContain("3 donations");

    const rows = db
      .prepare("SELECT source_key, symbol_raw, security_id, fmv_usd, kind FROM donations")
      .all() as { source_key: string; symbol_raw: string | null; security_id: number | null; fmv_usd: number; kind: string }[];
    expect(rows).toHaveLength(3);

    const fakeRow = rows.find((r) => r.symbol_raw === "FAKE")!;
    expect(fakeRow.security_id).not.toBeNull();
    expect(fakeRow.kind).toBe("stock");

    const zzzzRow = rows.find((r) => r.symbol_raw === "ZZZZ")!;
    expect(zzzzRow.security_id).toBeNull();

    const cashRow = rows.find((r) => r.kind === "cash")!;
    expect(cashRow.symbol_raw).toBeNull();
    expect(cashRow.fmv_usd).toBe(2500);

    expect(result.warnings.join("\n")).toContain("ZZZZ");
    expect(result.warnings.join("\n").toLowerCase()).toContain("unresolved");
  });

  it("re-commit of the identical file is a no-op (0 new, 0 updated) but the summary still names the donation count", async () => {
    const parsed1 = await parseImport(FIXTURE_3, "contrib.csv");
    commitImport(db, parsed1);

    const parsed2 = await parseImport(FIXTURE_3, "contrib.csv");
    const result2 = commitImport(db, parsed2);

    expect(result2.newDonations).toBe(0);
    expect(result2.updatedDonations).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM donations").get() as { c: number }).c).toBe(3);

    const batchRow = db
      .prepare("SELECT summary FROM import_batches WHERE id = ?")
      .get(result2.batchId) as { summary: string };
    expect(batchRow.summary).toContain("0 donations");
  });

  it("a variant where row2 gains a completed-at timestamp updates metadata WITHOUT moving batch ownership", async () => {
    const parsed1 = await parseImport(FIXTURE_3, "contrib.csv");
    const result1 = commitImport(db, parsed1);

    const parsed2 = await parseImport(FIXTURE_ROW2_COMPLETED, "contrib-v2.csv");
    const result2 = commitImport(db, parsed2);

    expect(result2.newDonations).toBe(0);
    expect(result2.updatedDonations).toBe(1);

    const row = db
      .prepare("SELECT completed_date, import_batch_id FROM donations WHERE symbol_raw = 'ZZZZ'")
      .get() as { completed_date: string; import_batch_id: number };
    expect(row.completed_date).toBe("2026-04-11");
    // Batch ownership is IMMUTABLE — the metadata upsert must not repoint
    // import_batch_id at batch 2.
    expect(row.import_batch_id).toBe(result1.batchId);
  });

  it("commitDonations refuses a silent authoritative-field change under an unchanged source_key: identityConflicts length 1, DB unchanged", () => {
    const batch = db
      .prepare("INSERT INTO import_batches (source_type, filename) VALUES ('daf-contributions','seed.csv')")
      .run();
    const batchId = batch.lastInsertRowid as number;

    const original: ParsedDonation = {
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
    const outcome1 = commitDonations(db, [original], batchId);
    expect(outcome1.newDonations).toBe(1);

    // Same source_key reappears (e.g. a hand-edited re-export), but the
    // quantity now disagrees with the on-file record.
    const changedQty: ParsedDonation = { ...original, quantity: 20 };
    const outcome2 = commitDonations(db, [changedQty], batchId);

    expect(outcome2.identityConflicts).toHaveLength(1);
    expect(outcome2.identityConflicts[0].sourceKey).toBe(original.sourceKey);
    expect(outcome2.identityConflicts[0].field).toBe("quantity");
    expect(outcome2.newDonations).toBe(0);
    expect(outcome2.updatedDonations).toBe(0);

    const dbRow = db
      .prepare("SELECT quantity FROM donations WHERE source_key = ?")
      .get(original.sourceKey) as { quantity: number };
    expect(dbRow.quantity).toBe(10); // unchanged — no silent overwrite
  });

  it("blocks (does not insert) donations whose sourceKey carries the null-created collision marker, and commitImport warns about it", async () => {
    const collidingCsv = [
      HEADER,
      "  Stock,One time,10.0,FAKE,1234.5,123.45,,2026-03-02 13:00:00 +0000,2026-03-03 17:00:00 +0000",
      "  Stock,One time,10.0,FAKE,1234.5,123.45,,2026-03-02 13:00:00 +0000,2026-03-03 17:00:00 +0000",
    ].join("\n");

    const parsed = await parseImport(collidingCsv, "colliding.csv");
    expect(parsed.donations).toHaveLength(2);

    const result = commitImport(db, parsed);

    expect(result.newDonations).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM donations").get() as { c: number }).c).toBe(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes("identity"))).toBe(true);
  });

  it("findAbsentPriorDonations flags a 2026 DB donation missing from a truncated re-file; the truncated commit's warnings name it", async () => {
    const parsed1 = await parseImport(FIXTURE_3, "contrib.csv");
    commitImport(db, parsed1);

    const parsedTruncated = await parseImport(FIXTURE_TRUNCATED, "contrib-truncated.csv");
    const absent = findAbsentPriorDonations(db, parsedTruncated.donations!);
    expect(absent).toHaveLength(1);
    expect(absent[0].symbol_raw).toBe("ZZZZ");

    const result = commitImport(db, parsedTruncated);
    expect(result.warnings.some((w) => w.includes(absent[0].source_key))).toBe(true);
  });
});

/**
 * Snapshot v14: when `getEarningsHeldSymbols` throws, the snapshot is still
 * built and the field is LEFT OUT, so the Worker falls back to `heldSymbols`
 * (the behaviour before v14). It must never be written as an empty list by
 * mistake: an empty list means "no held names" to the Worker and would stop
 * every cloud preview and recap for a held name.
 *
 * Invented tickers and round numbers only: the repo is public.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/queries/briefing-symbols", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/queries/briefing-symbols")>();
  return {
    ...real,
    getEarningsHeldSymbols: () => {
      throw new Error("synthetic helper failure");
    },
  };
});

import { buildSnapshot } from "@/scripts/snapshot-state-to-r2";
import { earningsHeldSet } from "../../workers/cron/src/earnings-held";
import type { Snapshot as WorkerSnapshot } from "../../workers/cron/src/state";

let db: Database.Database;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const account = Number(db.prepare(`INSERT INTO accounts (name) VALUES ('Desk')`).run().lastInsertRowid);
  const security = Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES ('ZZL', 'Long Co', 'Stock')`)
      .run().lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 10, '2026-06-10', 'test:zzl')`,
  ).run(account, security);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  db.close();
});

describe("snapshot earningsHeldSymbols when the helper fails", () => {
  it("still builds the snapshot, leaves the field out and says so", () => {
    const snapshot = buildSnapshot(db) as unknown as WorkerSnapshot;
    expect(snapshot.heldSymbols).toEqual(["ZZL"]);
    expect("earningsHeldSymbols" in JSON.parse(JSON.stringify(snapshot))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("earningsHeldSymbols could not be built"),
      expect.any(Error),
    );
  });

  it("the Worker then reads heldSymbols, as it did before v14", () => {
    const snapshot = JSON.parse(JSON.stringify(buildSnapshot(db))) as WorkerSnapshot;
    expect([...earningsHeldSet(snapshot)]).toEqual(["ZZL"]);
  });
});

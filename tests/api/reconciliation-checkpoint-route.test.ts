/**
 * QA finding accounts-reconciliation--duplicate-date-checkpoint-silently-replaces:
 * POST /api/reconciliation answered 200 and silently replaced the checkpoint
 * already saved for that account + date. The route now answers 409
 * `checkpoint_exists` with the existing row, and replaces only when the body
 * names that row's id (`replaceCheckpointId`).
 *
 * Fixtures are synthetic round numbers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let accountId: number;

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  accountId = Number(
    hoisted.db.prepare("INSERT INTO accounts (name) VALUES ('Test AAA')").run().lastInsertRowid,
  );
});

async function post(body: unknown) {
  const { POST } = await import("@/app/api/reconciliation/route");
  const res = await POST(
    new NextRequest("http://localhost/api/reconciliation", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

const stored = () =>
  hoisted.db
    .prepare("SELECT id, statement_value, notes FROM reconciliation_checkpoints ORDER BY id")
    .all() as Array<{ id: number; statement_value: number; notes: string | null }>;

describe("POST /api/reconciliation", () => {
  it("saves a first checkpoint", async () => {
    const r = await post({
      accountId,
      checkpointDate: "2020-01-31",
      statementValue: 1000,
      notes: "First entry",
    });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.data.notes).toBe("First entry");
    expect(r.json.replaced).toBe(false);
  });

  it("answers 409 checkpoint_exists for a second save on the same date and keeps the first", async () => {
    const first = await post({
      accountId,
      checkpointDate: "2020-01-31",
      statementValue: 1000,
      notes: "First entry",
    });
    const second = await post({
      accountId,
      checkpointDate: "2020-01-31",
      statementValue: 2000,
      notes: "Second entry",
    });

    expect(second.status).toBe(409);
    expect(second.json.success).toBe(false);
    expect(second.json.code).toBe("checkpoint_exists");
    expect(second.json.error).toContain("Test AAA");
    expect(second.json.error).toContain("2020-01-31");
    expect(second.json.existing).toMatchObject({
      id: first.json.data.id,
      statement_value: 1000,
      notes: "First entry",
    });
    expect(stored()).toEqual([
      { id: first.json.data.id, statement_value: 1000, notes: "First entry" },
    ]);
  });

  it("the refusal message never carries a dollar figure", async () => {
    await post({ accountId, checkpointDate: "2020-01-31", statementValue: 1000 });
    const second = await post({ accountId, checkpointDate: "2020-01-31", statementValue: 2000 });
    expect(second.json.error).not.toMatch(/1000|1,000|2000|2,000|\$/);
  });

  it("replaces when the body names the existing checkpoint", async () => {
    const first = await post({
      accountId,
      checkpointDate: "2020-01-31",
      statementValue: 1000,
      notes: "First entry",
    });
    const r = await post({
      accountId,
      checkpointDate: "2020-01-31",
      statementValue: 2000,
      notes: "Second entry",
      replaceCheckpointId: first.json.data.id,
    });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.replaced).toBe(true);
    expect(stored()).toEqual([
      { id: first.json.data.id, statement_value: 2000, notes: "Second entry" },
    ]);
  });

  it("a loose truthy flag is not a replace instruction", async () => {
    await post({ accountId, checkpointDate: "2020-01-31", statementValue: 1000, notes: "First entry" });
    for (const flag of [true, "1", "yes", 1.5, -1]) {
      const r = await post({
        accountId,
        checkpointDate: "2020-01-31",
        statementValue: 2000,
        replaceCheckpointId: flag,
        force: true,
        replace: true,
      });
      expect([400, 409]).toContain(r.status);
    }
    expect(stored().map((x) => [x.statement_value, x.notes])).toEqual([[1000, "First entry"]]);
  });

  it("keeps both checkpoints when the dates differ", async () => {
    await post({ accountId, checkpointDate: "2020-01-31", statementValue: 1000, notes: "January" });
    const r = await post({ accountId, checkpointDate: "2020-02-29", statementValue: 2000, notes: "February" });
    expect(r.status).toBe(200);
    expect(stored().map((x) => x.notes)).toEqual(["January", "February"]);
  });
});

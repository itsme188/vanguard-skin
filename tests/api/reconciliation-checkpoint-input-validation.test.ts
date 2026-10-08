/**
 * POST /api/reconciliation accepted a zero, negative or non-finite statement
 * value (and a malformed date or an unknown account) when posted directly:
 * only the form blocked them. The route answers 400 and the query function
 * refuses the same inputs, so nothing is stored.
 *
 * Fixtures are synthetic round numbers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import {
  addReconciliationCheckpoint,
  checkpointInputProblem,
  CheckpointInputError,
} from "@/lib/queries/reconciliation";

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

async function postRaw(rawBody: string) {
  const { POST } = await import("@/app/api/reconciliation/route");
  const res = await POST(
    new NextRequest("http://localhost/api/reconciliation", { method: "POST", body: rawBody }),
  );
  return { status: res.status, json: await res.json() };
}
const post = (body: unknown) => postRaw(JSON.stringify(body));

async function del(query: string) {
  const { DELETE } = await import("@/app/api/reconciliation/route");
  const res = await DELETE(
    new NextRequest(`http://localhost/api/reconciliation${query}`, { method: "DELETE" }),
  );
  return { status: res.status, json: await res.json() };
}

const storedCount = () =>
  (hoisted.db.prepare("SELECT COUNT(*) AS n FROM reconciliation_checkpoints").get() as { n: number })
    .n;

const good = () => ({ accountId, checkpointDate: "2020-01-31", statementValue: 1000 });

describe("POST /api/reconciliation input validation", () => {
  it.each([
    ["zero", 0],
    ["negative", -500],
    ["a numeric string", "1000"],
    ["null", null],
    ["a boolean", true],
  ])("answers 400 for a statement value that is %s", async (_label, statementValue) => {
    const r = await post({ ...good(), statementValue });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(typeof r.json.error).toBe("string");
    expect(r.json.error).toMatch(/statement value/i);
    expect(storedCount()).toBe(0);
  });

  it("answers 400 for a statement value too large to be a finite number", async () => {
    // JSON has no Infinity literal; 1e999 parses to Infinity.
    const r = await postRaw(
      `{"accountId":${accountId},"checkpointDate":"2020-01-31","statementValue":1e999}`,
    );
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(storedCount()).toBe(0);
  });

  it.each([
    ["not ISO", "01/31/2020"],
    ["with a time part", "2020-01-31T00:00:00Z"],
    ["not a calendar day", "2020-02-30"],
    ["month 13", "2020-13-01"],
    ["a number", 20200131],
  ])("answers 400 for a date that is %s", async (_label, checkpointDate) => {
    const r = await post({ ...good(), checkpointDate });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(r.json.error).toMatch(/date/i);
    expect(storedCount()).toBe(0);
  });

  it("accepts a leap day", async () => {
    const r = await post({ ...good(), checkpointDate: "2020-02-29" });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
  });

  it.each([
    ["unknown", 999999],
    ["a string", "1"],
    ["fractional", 1.5],
    ["negative", -1],
  ])("answers 400 for an account id that is %s", async (_label, badAccountId) => {
    const r = await post({ ...good(), accountId: badAccountId });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(r.json.error).toMatch(/account/i);
    expect(storedCount()).toBe(0);
  });

  it("answers 400 for notes that are not text", async () => {
    const r = await post({ ...good(), notes: { a: 1 } });
    expect(r.status).toBe(400);
    expect(r.json.success).toBe(false);
    expect(storedCount()).toBe(0);
  });

  it("still saves a valid checkpoint", async () => {
    const r = await post({ ...good(), notes: "First entry" });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(storedCount()).toBe(1);
  });
});

describe("DELETE /api/reconciliation input validation", () => {
  it.each(["?id=abc", "?id=0", "?id=-3", "?id=1.5", "?id=2x"])(
    "answers 400 for %s and deletes nothing",
    async (query) => {
      await post(good());
      const r = await del(query);
      expect(r.status).toBe(400);
      expect(r.json.success).toBe(false);
      expect(storedCount()).toBe(1);
    },
  );

  it("still deletes by a real id", async () => {
    const saved = await post(good());
    const r = await del(`?id=${saved.json.data.id}`);
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(storedCount()).toBe(0);
  });
});

describe("addReconciliationCheckpoint refuses bad input itself", () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "throws CheckpointInputError for statement value %s",
    (value) => {
      expect(() => addReconciliationCheckpoint(hoisted.db, accountId, "2020-01-31", value)).toThrow(
        CheckpointInputError,
      );
      expect(storedCount()).toBe(0);
    },
  );

  it("throws for an impossible date and for an unknown account", () => {
    expect(() => addReconciliationCheckpoint(hoisted.db, accountId, "2020-02-30", 1000)).toThrow(
      CheckpointInputError,
    );
    expect(() => addReconciliationCheckpoint(hoisted.db, 999999, "2020-01-31", 1000)).toThrow(
      CheckpointInputError,
    );
    expect(storedCount()).toBe(0);
  });

  it("checkpointInputProblem is null for good input", () => {
    expect(checkpointInputProblem(hoisted.db, accountId, "2020-01-31", 1000)).toBeNull();
    expect(checkpointInputProblem(hoisted.db, accountId, "2020-01-31", 0.01)).toBeNull();
  });
});

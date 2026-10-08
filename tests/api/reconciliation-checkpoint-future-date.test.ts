/**
 * accounts-reconciliation--checkpoint-computed-dash-no-reason-when-no-exact-date-valuation-row
 * (the safe half only): a checkpoint dated after today is refused, by the
 * route (400), by the query function, and by the form. "Today" is the
 * Eastern day. What "Computed" shows for a saved row is unchanged.
 *
 * Fixtures are synthetic round numbers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import {
  addReconciliationCheckpoint,
  checkpointFormBlocker,
  checkpointInputProblem,
  CheckpointInputError,
  CHECKPOINT_FUTURE_DATE_MESSAGE,
} from "@/lib/queries/reconciliation";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let accountId: number;
let today: string;

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  accountId = Number(
    hoisted.db.prepare("INSERT INTO accounts (name) VALUES ('Test AAA')").run().lastInsertRowid,
  );
  today = todayET();
});

async function post(body: unknown) {
  const { POST } = await import("@/app/api/reconciliation/route");
  const res = await POST(
    new NextRequest("http://localhost/api/reconciliation", { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: res.status, json: await res.json() };
}

const storedCount = () =>
  (hoisted.db.prepare("SELECT COUNT(*) AS n FROM reconciliation_checkpoints").get() as { n: number })
    .n;

describe("a checkpoint dated in the future", () => {
  it("says so in the agreed words", () => {
    expect(CHECKPOINT_FUTURE_DATE_MESSAGE).toBe("Statement date cannot be in the future.");
  });

  it.each([
    ["tomorrow", 1],
    ["next year", 365],
  ])("is refused by the route with 400 and writes nothing (%s)", async (_label, days) => {
    const r = await post({ accountId, checkpointDate: addDays(today, days), statementValue: 1000 });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ success: false, error: CHECKPOINT_FUTURE_DATE_MESSAGE });
    expect(storedCount()).toBe(0);
  });

  it("is refused by the query function, which also writes nothing", () => {
    const tomorrow = addDays(today, 1);
    expect(checkpointInputProblem(hoisted.db, accountId, tomorrow, 1000)).toBe(CHECKPOINT_FUTURE_DATE_MESSAGE);
    expect(() => addReconciliationCheckpoint(hoisted.db, accountId, tomorrow, 1000)).toThrow(CheckpointInputError);
    expect(() => addReconciliationCheckpoint(hoisted.db, accountId, tomorrow, 1000)).toThrow(
      CHECKPOINT_FUTURE_DATE_MESSAGE,
    );
    expect(storedCount()).toBe(0);
  });

  it("cannot replace a saved checkpoint either", async () => {
    // A row that predates the rule (written directly) is left exactly as it was.
    const tomorrow = addDays(today, 1);
    const id = Number(
      hoisted.db
        .prepare(
          "INSERT INTO reconciliation_checkpoints (account_id, checkpoint_date, statement_value) VALUES (?, ?, 500)",
        )
        .run(accountId, tomorrow).lastInsertRowid,
    );
    const r = await post({ accountId, checkpointDate: tomorrow, statementValue: 1000, replaceCheckpointId: id });
    expect(r.status).toBe(400);
    const row = hoisted.db
      .prepare("SELECT statement_value FROM reconciliation_checkpoints WHERE id = ?")
      .get(id) as { statement_value: number };
    expect(row.statement_value).toBe(500);
  });

  it("a malformed date keeps its own message", () => {
    expect(checkpointInputProblem(hoisted.db, accountId, "2999-13-01", 1000)).toBe(
      "Statement date must be a real date in YYYY-MM-DD form",
    );
  });
});

describe("today and a past date are accepted exactly as before", () => {
  it.each([
    ["today", 0],
    ["yesterday", -1],
    ["a year ago", -365],
  ])("the route saves a checkpoint dated %s", async (_label, days) => {
    const checkpointDate = addDays(today, days);
    expect(checkpointInputProblem(hoisted.db, accountId, checkpointDate, 1000)).toBeNull();
    const r = await post({ accountId, checkpointDate, statementValue: 1000 });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.data.checkpoint_date).toBe(checkpointDate);
    // No valuation row for the date: Computed stays empty, as it did.
    expect(r.json.data.computed_value).toBeNull();
    expect(r.json.data.difference).toBeNull();
    expect(storedCount()).toBe(1);
  });

  it("an exact-date valuation still fills Computed and Difference", async () => {
    hoisted.db
      .prepare("INSERT INTO monthly_snapshots (account_id, month_end_date, total_value) VALUES (?, ?, 900)")
      .run(accountId, today);
    const r = await post({ accountId, checkpointDate: today, statementValue: 1000 });
    expect(r.status).toBe(200);
    expect(r.json.data.computed_value).toBe(900);
    expect(r.json.data.difference).toBe(100);
  });
});

describe("the form blocks a future date with the same words", () => {
  const filled = { accountId: "1", checkpointDate: "2020-01-31", statementValue: "1000" };

  it("blocks the day after the given today and allows today itself", () => {
    expect(checkpointFormBlocker({ ...filled, checkpointDate: "2020-02-01" }, "2020-01-31")).toBe(
      CHECKPOINT_FUTURE_DATE_MESSAGE,
    );
    expect(checkpointFormBlocker(filled, "2020-01-31")).toBeNull();
    expect(checkpointFormBlocker(filled, "2020-06-30")).toBeNull();
  });

  it("defaults today to the Eastern day", () => {
    expect(checkpointFormBlocker({ ...filled, checkpointDate: addDays(todayET(), 1) })).toBe(
      CHECKPOINT_FUTURE_DATE_MESSAGE,
    );
    expect(checkpointFormBlocker({ ...filled, checkpointDate: todayET() })).toBeNull();
  });

  it("an empty date still asks for the date first", () => {
    expect(checkpointFormBlocker({ ...filled, checkpointDate: "" }, "2020-01-31")).toBe("Enter the statement date");
  });
});

describe("source pins", () => {
  const table = readFileSync(
    path.join(process.cwd(), "app/dashboard/components/ReconciliationTable.tsx"),
    "utf8",
  );
  const queries = readFileSync(path.join(process.cwd(), "lib/queries/reconciliation.ts"), "utf8");

  it("the date input carries max = the Eastern day the blocker was given", () => {
    anchorIndex(table, "const today = todayET();");
    anchorIndex(table, "checkpointFormBlocker(formData, today)");
    const input = sliceBetween(table, 'id="recon-date"', "/>");
    anchorIndex(input, "max={today}");
  });

  it("neither file derives today from the UTC clock", () => {
    for (const src of [table, queries]) {
      expect(src).not.toMatch(/toISOString\(\)\s*\.slice\(0,\s*10\)\s*[;)]?\s*$/m);
      expect(src).not.toContain("new Date().toISOString()");
    }
    anchorIndex(queries, "checkpointDate > todayET()");
  });

  it("the save handler still reads the response through readMutationResult", () => {
    const handler = sliceBetween(table, "async function saveCheckpoint(", "async function handleDelete(");
    anchorIndex(handler, "await readMutationResult(res)");
    anchorIndex(handler, "result.message");
  });
});

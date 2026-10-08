import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  addReconciliationCheckpoint,
  checkpointDifferenceBand,
  checkpointFormBlocker,
  getReconciliationCheckpoints,
  parseCheckpointConflict,
} from "@/lib/queries/reconciliation";

/**
 * QA finding accounts-reconciliation--duplicate-date-checkpoint-silently-replaces:
 * a second checkpoint on the same account + date went through
 * `INSERT OR REPLACE` and destroyed the first one (value, difference, note)
 * with no warning. A checkpoint is the owner's audit record: it is replaced
 * only when the caller names the exact row it saw and chose to replace.
 *
 * Fixtures are synthetic round numbers.
 */
describe("addReconciliationCheckpoint", () => {
  let db: Database.Database;
  let accountId: number;
  let otherAccountId: number;

  function rows() {
    return db
      .prepare(
        `SELECT id, account_id, checkpoint_date, statement_value, notes
           FROM reconciliation_checkpoints ORDER BY id`,
      )
      .all() as Array<{
      id: number;
      account_id: number;
      checkpoint_date: string;
      statement_value: number;
      notes: string | null;
    }>;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    accountId = Number(
      db.prepare("INSERT INTO accounts (name) VALUES ('Test AAA')").run()
        .lastInsertRowid,
    );
    otherAccountId = Number(
      db.prepare("INSERT INTO accounts (name) VALUES ('Test ZZZ')").run()
        .lastInsertRowid,
    );
  });

  it("saves a first checkpoint", () => {
    const r = addReconciliationCheckpoint(db, accountId, "2020-01-31", 1000, "First entry");
    expect(r.status).toBe("saved");
    if (r.status !== "saved") return;
    expect(r.checkpoint.notes).toBe("First entry");
    expect(r.checkpoint.account_name).toBe("Test AAA");
    expect(rows()).toHaveLength(1);
  });

  it("refuses a second checkpoint on the same account and date, leaving the first untouched", () => {
    const first = addReconciliationCheckpoint(db, accountId, "2020-01-31", 1000, "First entry");
    if (first.status !== "saved") throw new Error("seed failed");

    const second = addReconciliationCheckpoint(db, accountId, "2020-01-31", 2000, "Second entry");

    expect(second.status).toBe("exists");
    if (second.status !== "exists") return;
    expect(second.existing.id).toBe(first.checkpoint.id);
    expect(second.existing.notes).toBe("First entry");
    expect(rows()).toEqual([
      {
        id: first.checkpoint.id,
        account_id: accountId,
        checkpoint_date: "2020-01-31",
        statement_value: 1000,
        notes: "First entry",
      },
    ]);
  });

  it("keeps both checkpoints when the dates differ", () => {
    addReconciliationCheckpoint(db, accountId, "2020-01-31", 1000, "January");
    const r = addReconciliationCheckpoint(db, accountId, "2020-02-29", 2000, "February");
    expect(r.status).toBe("saved");
    expect(rows().map((x) => [x.checkpoint_date, x.notes])).toEqual([
      ["2020-01-31", "January"],
      ["2020-02-29", "February"],
    ]);
    expect(getReconciliationCheckpoints(db, accountId)).toHaveLength(2);
  });

  it("keeps both checkpoints when the same date is on two accounts", () => {
    addReconciliationCheckpoint(db, accountId, "2020-01-31", 1000, "A");
    const r = addReconciliationCheckpoint(db, otherAccountId, "2020-01-31", 2000, "Z");
    expect(r.status).toBe("saved");
    expect(rows()).toHaveLength(2);
  });

  it("replaces only when the caller names the existing checkpoint it saw", () => {
    const first = addReconciliationCheckpoint(db, accountId, "2020-01-31", 1000, "First entry");
    if (first.status !== "saved") throw new Error("seed failed");

    const r = addReconciliationCheckpoint(db, accountId, "2020-01-31", 2000, "Second entry", {
      replaceCheckpointId: first.checkpoint.id,
    });

    expect(r.status).toBe("replaced");
    if (r.status !== "replaced") return;
    expect(r.previous.notes).toBe("First entry");
    expect(r.previous.statement_value).toBe(1000);
    expect(r.checkpoint.id).toBe(first.checkpoint.id);
    expect(rows()).toEqual([
      {
        id: first.checkpoint.id,
        account_id: accountId,
        checkpoint_date: "2020-01-31",
        statement_value: 2000,
        notes: "Second entry",
      },
    ]);
  });

  it("refuses a replace that names a different checkpoint than the one on that date", () => {
    const jan = addReconciliationCheckpoint(db, accountId, "2020-01-31", 1000, "January");
    const feb = addReconciliationCheckpoint(db, accountId, "2020-02-29", 2000, "February");
    if (jan.status !== "saved" || feb.status !== "saved") throw new Error("seed failed");

    // The user confirmed replacing February's row, but the write lands on January's date.
    const r = addReconciliationCheckpoint(db, accountId, "2020-01-31", 3000, "Stale confirm", {
      replaceCheckpointId: feb.checkpoint.id,
    });

    expect(r.status).toBe("exists");
    expect(rows().map((x) => [x.statement_value, x.notes])).toEqual([
      [1000, "January"],
      [2000, "February"],
    ]);
  });

  it("a replace id with nothing on that date is a plain save", () => {
    const r = addReconciliationCheckpoint(db, accountId, "2020-01-31", 1000, "Only", {
      replaceCheckpointId: 999,
    });
    expect(r.status).toBe("saved");
    expect(rows()).toHaveLength(1);
  });

  it("recomputes the difference on a replace", () => {
    db.prepare(
      `INSERT INTO daily_valuations
         (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
       VALUES (?, '2020-01-31', 0, 900, 900, 1, 1)`,
    ).run(accountId);
    const first = addReconciliationCheckpoint(db, accountId, "2020-01-31", 1000);
    if (first.status !== "saved") throw new Error("seed failed");
    expect(first.checkpoint.difference).toBe(100);

    const r = addReconciliationCheckpoint(db, accountId, "2020-01-31", 950, undefined, {
      replaceCheckpointId: first.checkpoint.id,
    });
    if (r.status !== "replaced") throw new Error("expected replaced");
    expect(r.checkpoint.computed_value).toBe(900);
    expect(r.checkpoint.difference).toBe(50);
  });
});

describe("parseCheckpointConflict", () => {
  it("reads the existing checkpoint out of a 409 body", () => {
    expect(
      parseCheckpointConflict({
        success: false,
        code: "checkpoint_exists",
        error: "x",
        existing: {
          id: 7,
          account_name: "Test AAA",
          checkpoint_date: "2020-01-31",
          statement_value: 1000,
          notes: "First entry",
        },
      }),
    ).toEqual({
      id: 7,
      account_name: "Test AAA",
      checkpoint_date: "2020-01-31",
      statement_value: 1000,
      notes: "First entry",
    });
  });

  it("returns null for any other body, so the caller shows an error instead of a replace prompt", () => {
    expect(parseCheckpointConflict(null)).toBeNull();
    expect(parseCheckpointConflict({ success: false, error: "boom" })).toBeNull();
    expect(parseCheckpointConflict({ code: "checkpoint_exists" })).toBeNull();
    expect(
      parseCheckpointConflict({ code: "checkpoint_exists", existing: { id: "7" } }),
    ).toBeNull();
  });
});

describe("checkpointFormBlocker", () => {
  const filled = { accountId: "1", checkpointDate: "2020-01-31", statementValue: "1000" };

  it("is null for a valid form", () => {
    expect(checkpointFormBlocker(filled)).toBeNull();
  });

  it("names a zero or negative statement value instead of blaming empty fields", () => {
    expect(checkpointFormBlocker({ ...filled, statementValue: "0" })).toBe(
      "Statement value must be greater than 0",
    );
    expect(checkpointFormBlocker({ ...filled, statementValue: "-5000" })).toBe(
      "Statement value must be greater than 0",
    );
  });

  it("names the field that is actually empty", () => {
    expect(checkpointFormBlocker({ ...filled, checkpointDate: "" })).toBe("Enter the statement date");
    expect(checkpointFormBlocker({ ...filled, statementValue: "" })).toBe("Enter the statement value");
    expect(checkpointFormBlocker({ ...filled, accountId: "" })).toBe("Choose an account");
    expect(checkpointFormBlocker({ ...filled, statementValue: "abc" })).toBe(
      "Statement value must be a number",
    );
  });
});

describe("checkpointDifferenceBand", () => {
  it("has no band without a computed difference", () => {
    expect(checkpointDifferenceBand(null)).toBeNull();
  });

  it("bands by absolute difference and says what each glyph means", () => {
    expect(checkpointDifferenceBand(0)).toMatchObject({ band: "match", glyph: "✓" });
    expect(checkpointDifferenceBand(-0.004)).toMatchObject({ band: "match" });
    expect(checkpointDifferenceBand(0.01)).toMatchObject({ band: "close", glyph: "~" });
    expect(checkpointDifferenceBand(-99.99)).toMatchObject({ band: "close" });
    expect(checkpointDifferenceBand(100)).toMatchObject({ band: "off", glyph: "!" });
    expect(checkpointDifferenceBand(-5000)).toMatchObject({ band: "off" });
    for (const d of [0, 50, 500]) {
      expect(checkpointDifferenceBand(d)?.label.length).toBeGreaterThan(10);
    }
    expect(checkpointDifferenceBand(50)?.label).toContain("$100");
  });
});

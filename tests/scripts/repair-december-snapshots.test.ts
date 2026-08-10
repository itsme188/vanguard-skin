import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import {
  parseSnapshotCsv,
  findSnapshotMismatches,
  repairDecemberSnapshots,
  type CsvSnapshotRow,
} from "@/scripts/repair-december-snapshots";

// ─── DB fixtures ────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

// migrations/002_seed_accounts.sql already seeds 'Vanguard Taxable', 'Vanguard
// Roth IRA', and 'IBKR' — INSERT OR IGNORE + a lookup keeps this helper safe
// whether the name is migration-seeded or test-only.
function seedAccount(db: Database.Database, name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }
  ).id;
}

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  values: {
    totalValue: number;
    startingValue?: number | null;
    depositsWithdrawals?: number | null;
    twr?: number | null;
    investmentGain?: number | null;
    notes?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value,
        deposits_withdrawals, twr, investment_gain, notes, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'canonical')`,
  ).run(
    accountId,
    monthEndDate,
    values.totalValue,
    values.startingValue ?? null,
    values.depositsWithdrawals ?? null,
    values.twr ?? null,
    values.investmentGain ?? null,
    values.notes ?? null,
  );
}

function readSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
): {
  totalValue: number;
  startingValue: number | null;
  depositsWithdrawals: number | null;
  twr: number | null;
  investmentGain: number | null;
  notes: string | null;
} {
  return db
    .prepare(
      `SELECT total_value AS totalValue, starting_value AS startingValue,
              deposits_withdrawals AS depositsWithdrawals, twr AS twr,
              investment_gain AS investmentGain, notes AS notes
         FROM monthly_snapshots
        WHERE account_id = ? AND month_end_date = ?`,
    )
    .get(accountId, monthEndDate) as {
    totalValue: number;
    startingValue: number | null;
    depositsWithdrawals: number | null;
    twr: number | null;
    investmentGain: number | null;
    notes: string | null;
  };
}

// ─── CSV fixture (real temp file, per the brief) ───────────────────

const CSV_HEADER =
  "account,month_end_date,total_value,starting_value,deposits_withdrawals,dividends,interest,commissions,fees,investment_gain,twr";

function csvLine(fields: Array<string | number>): string {
  return fields.map((f) => String(f)).join(",");
}

/** The 4 canonical (statement-verified) December rows from the plan's table. */
const CANONICAL_DECEMBER_ROWS: Array<{
  monthEndDate: string;
  totalValue: number;
  startingValue: number;
  depositsWithdrawals: number;
  investmentGain: number;
  twr: number;
}> = [
  {
    monthEndDate: "2022-12-31",
    totalValue: 328285.46,
    startingValue: 351126.94,
    depositsWithdrawals: 0.0,
    investmentGain: -22841.48,
    twr: -0.065052,
  },
  {
    monthEndDate: "2023-12-31",
    totalValue: 526157.97,
    startingValue: 502253.87,
    depositsWithdrawals: 0.0,
    investmentGain: 23904.1,
    twr: 0.047594,
  },
  {
    monthEndDate: "2024-12-31",
    totalValue: 896634.19,
    startingValue: 939820.98,
    depositsWithdrawals: 0.0,
    investmentGain: -43186.79,
    twr: -0.045952,
  },
  {
    monthEndDate: "2025-12-31",
    totalValue: 1290023.49,
    startingValue: 1344716.44,
    depositsWithdrawals: -20000.0,
    investmentGain: -34692.95,
    twr: -0.025799,
  },
];

function buildCsvContent(rows: Array<{ account: string } & Record<string, unknown>>): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      csvLine([
        r.account as string,
        r.monthEndDate as string,
        r.totalValue as number,
        (r.startingValue as number | undefined) ?? "",
        (r.depositsWithdrawals as number | undefined) ?? "",
        "", // dividends — not compared/repaired by this script
        "", // interest
        "", // commissions
        "", // fees
        (r.investmentGain as number | undefined) ?? "",
        (r.twr as number | undefined) ?? "",
      ]),
    );
  }
  return lines.join("\n");
}

let tmpDir: string;

function writeTempCsv(content: string): string {
  const filePath = path.join(tmpDir, `snapshots-${Date.now()}-${Math.random()}.csv`);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function readCsvRows(csvPath: string): CsvSnapshotRow[] {
  const content = fs.readFileSync(csvPath, "utf-8");
  const parsed = parseSnapshotCsv(content);
  expect(parsed.malformedRowNumbers).toHaveLength(0);
  return parsed.rows;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twr-december-repair-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── parseSnapshotCsv ───────────────────────────────────────────────

describe("parseSnapshotCsv", () => {
  it("parses a well-formed row, including optional fields as null when blank", () => {
    const content = buildCsvContent([
      { account: "Vanguard Taxable", monthEndDate: "2022-12-31", totalValue: 328285.46 },
    ]);
    const parsed = parseSnapshotCsv(content);
    expect(parsed.malformedRowNumbers).toHaveLength(0);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      account: "Vanguard Taxable",
      monthEndDate: "2022-12-31",
      totalValue: 328285.46,
      startingValue: null,
      depositsWithdrawals: null,
      twr: null,
      investmentGain: null,
    });
  });

  it("parses all 5 compared fields when present", () => {
    const content = buildCsvContent([
      { account: "Vanguard Taxable", ...CANONICAL_DECEMBER_ROWS[0] },
    ]);
    const parsed = parseSnapshotCsv(content);
    expect(parsed.rows[0]).toMatchObject({
      totalValue: 328285.46,
      startingValue: 351126.94,
      depositsWithdrawals: 0.0,
      investmentGain: -22841.48,
      twr: -0.065052,
    });
  });

  it("skips (and reports) a row missing total_value", () => {
    const content = [CSV_HEADER, "Vanguard Taxable,2022-12-31,,,,,,,,,"].join("\n");
    const parsed = parseSnapshotCsv(content);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.malformedRowNumbers).toEqual([2]);
  });

  it("skips (and reports) a row with a comma-grouped numeric (would silently truncate)", () => {
    const content = [CSV_HEADER, 'Vanguard Taxable,2022-12-31,"328,285.46",,,,,,,,'].join("\n");
    const parsed = parseSnapshotCsv(content);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.malformedRowNumbers).toEqual([2]);
  });

  it("trims leading/trailing whitespace off a padded account column", () => {
    const content = [
      CSV_HEADER,
      csvLine([
        "  Vanguard Taxable  ",
        "2022-12-31",
        328285.46,
        351126.94,
        0.0,
        "",
        "",
        "",
        "",
        -22841.48,
        -0.065052,
      ]),
    ].join("\n");
    const parsed = parseSnapshotCsv(content);
    expect(parsed.malformedRowNumbers).toHaveLength(0);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].account).toBe("Vanguard Taxable");
  });
});

// ─── findSnapshotMismatches (audit phase, ALL rows) ────────────────

describe("findSnapshotMismatches", () => {
  let db: Database.Database;
  let taxableId: number;
  let rothId: number;

  beforeEach(() => {
    db = createTestDb();
    taxableId = seedAccount(db, "Vanguard Taxable");
    rothId = seedAccount(db, "Vanguard Roth");
  });

  it("reports the 4 poisoned December rows as mismatches (live-shaped fixture)", () => {
    // Poisoned rows: annual-summary drafts written by batch 26.
    seedSnapshot(db, taxableId, "2022-12-31", {
      totalValue: 362408.31,
      startingValue: 391746.97,
      depositsWithdrawals: 118593.14,
      twr: -0.312,
      investmentGain: null,
    });
    seedSnapshot(db, taxableId, "2023-12-31", {
      totalValue: 580250.4,
      startingValue: 362408.31,
      depositsWithdrawals: 124523.94,
      twr: null,
      investmentGain: null,
    });
    seedSnapshot(db, taxableId, "2024-12-31", {
      totalValue: 896634.19, // total already correct — mismatch must still trigger on other fields
      startingValue: 526157.97,
      depositsWithdrawals: 255000.0,
      twr: null,
      investmentGain: null,
    });
    seedSnapshot(db, taxableId, "2025-12-31", {
      totalValue: 1290023.49, // total already correct
      startingValue: 896634.19,
      depositsWithdrawals: 10000.0,
      twr: null,
      investmentGain: null,
    });

    const csvContent = buildCsvContent(
      CANONICAL_DECEMBER_ROWS.map((r) => ({ account: "Vanguard Taxable", ...r })),
    );
    const csvPath = writeTempCsv(csvContent);
    const rows = readCsvRows(csvPath);

    const audit = findSnapshotMismatches(db, rows);
    expect(audit.mismatches).toHaveLength(4);
    expect(audit.mismatches.every((m) => m.isDecember)).toBe(true);
    expect(audit.unresolved).toHaveLength(0);
  });

  it("does not flag a row that matches the CSV within tolerance", () => {
    seedSnapshot(db, taxableId, "2022-12-31", {
      totalValue: 328285.46,
      startingValue: 351126.94,
      depositsWithdrawals: 0.0,
      twr: -0.065052,
      investmentGain: -22841.48,
    });
    const csvPath = writeTempCsv(
      buildCsvContent([{ account: "Vanguard Taxable", ...CANONICAL_DECEMBER_ROWS[0] }]),
    );
    const audit = findSnapshotMismatches(db, readCsvRows(csvPath));
    expect(audit.mismatches).toHaveLength(0);
  });

  it("tolerates float diffs at or under 0.005 but flags anything larger", () => {
    seedSnapshot(db, taxableId, "2024-06-30", { totalValue: 500000.0 });

    const withinTolerance = findSnapshotMismatches(db, [
      {
        account: "Vanguard Taxable",
        monthEndDate: "2024-06-30",
        totalValue: 500000.004,
        startingValue: null,
        depositsWithdrawals: null,
        twr: null,
        investmentGain: null,
      },
    ]);
    expect(withinTolerance.mismatches).toHaveLength(0);

    const overTolerance = findSnapshotMismatches(db, [
      {
        account: "Vanguard Taxable",
        monthEndDate: "2024-06-30",
        totalValue: 500000.006,
        startingValue: null,
        depositsWithdrawals: null,
        twr: null,
        investmentGain: null,
      },
    ]);
    expect(overTolerance.mismatches).toHaveLength(1);
  });

  it("treats NULL (DB) vs a real value (CSV) as a mismatch on that field only", () => {
    seedSnapshot(db, taxableId, "2023-12-31", {
      totalValue: 526157.97,
      startingValue: 502253.87,
      depositsWithdrawals: 0.0,
      twr: null, // poisoned: NULL in DB
      investmentGain: 23904.1,
    });
    const csvPath = writeTempCsv(
      buildCsvContent([{ account: "Vanguard Taxable", ...CANONICAL_DECEMBER_ROWS[1] }]),
    );
    const audit = findSnapshotMismatches(db, readCsvRows(csvPath));
    expect(audit.mismatches).toHaveLength(1);
    expect(audit.mismatches[0].mismatchedFields).toEqual(["twr"]);
  });

  it("reports a CSV row for an unresolvable account name as unresolved, not a mismatch", () => {
    const audit = findSnapshotMismatches(db, [
      {
        account: "Some Unknown Account",
        monthEndDate: "2022-12-31",
        totalValue: 1000,
        startingValue: null,
        depositsWithdrawals: null,
        twr: null,
        investmentGain: null,
      },
    ]);
    expect(audit.mismatches).toHaveLength(0);
    expect(audit.unresolved).toEqual([
      { account: "Some Unknown Account", monthEndDate: "2022-12-31" },
    ]);
  });

  it("skips a CSV row silently when no DB row exists for that (account, month) at all", () => {
    // taxableId has no snapshot rows seeded at all.
    const audit = findSnapshotMismatches(db, [
      {
        account: "Vanguard Taxable",
        monthEndDate: "2022-12-31",
        totalValue: 1000,
        startingValue: null,
        depositsWithdrawals: null,
        twr: null,
        investmentGain: null,
      },
    ]);
    expect(audit.mismatches).toHaveLength(0);
    expect(audit.unresolved).toHaveLength(0);
  });

  it("never touches Roth rows that never appear in the CSV", () => {
    seedSnapshot(db, rothId, "2022-12-31", { totalValue: 100000 });
    const audit = findSnapshotMismatches(db, [
      {
        account: "Vanguard Taxable",
        monthEndDate: "2022-12-31",
        totalValue: 328285.46,
        startingValue: null,
        depositsWithdrawals: null,
        twr: null,
        investmentGain: null,
      },
    ]);
    // No mismatch for Roth is even possible — it was never in the CSV rows passed in.
    expect(audit.mismatches.some((m) => m.accountId === rothId)).toBe(false);
  });
});

// ─── repairDecemberSnapshots (December-only conditional write) ────

describe("repairDecemberSnapshots", () => {
  let db: Database.Database;
  let taxableId: number;
  let rothId: number;
  const TODAY = "2026-08-10";

  beforeEach(() => {
    db = createTestDb();
    taxableId = seedAccount(db, "Vanguard Taxable");
    rothId = seedAccount(db, "Vanguard Roth");

    // The 4 live-shaped poisoned rows.
    seedSnapshot(db, taxableId, "2022-12-31", {
      totalValue: 362408.31,
      startingValue: 391746.97,
      depositsWithdrawals: 118593.14,
      twr: -0.312,
      investmentGain: null,
      notes: "imported from batch 26",
    });
    seedSnapshot(db, taxableId, "2023-12-31", {
      totalValue: 580250.4,
      startingValue: 362408.31,
      depositsWithdrawals: 124523.94,
      twr: null,
      investmentGain: null,
    });
    seedSnapshot(db, taxableId, "2024-12-31", {
      totalValue: 896634.19,
      startingValue: 526157.97,
      depositsWithdrawals: 255000.0,
      twr: null,
      investmentGain: null,
    });
    seedSnapshot(db, taxableId, "2025-12-31", {
      totalValue: 1290023.49,
      startingValue: 896634.19,
      depositsWithdrawals: 10000.0,
      twr: null,
      investmentGain: null,
    });

    // Healthy neighbor: a non-December row that already matches the CSV
    // (will appear in the CSV fixture below, unchanged).
    seedSnapshot(db, taxableId, "2024-06-30", {
      totalValue: 500000.0,
      startingValue: 480000.0,
      depositsWithdrawals: 0.0,
      twr: 0.04,
      investmentGain: 20000.0,
    });

    // A genuinely mismatched non-December row — must be reported, never written.
    seedSnapshot(db, taxableId, "2024-09-30", {
      totalValue: 400000.0,
      startingValue: 390000.0,
      depositsWithdrawals: 0.0,
      twr: 0.01,
      investmentGain: 10000.0,
    });

    // Healthy Roth December rows — never referenced by the CSV fixture,
    // must never be touched.
    seedSnapshot(db, rothId, "2022-12-31", {
      totalValue: 55000,
      startingValue: 54000,
      depositsWithdrawals: 0,
      twr: 0.018,
      investmentGain: 1000,
    });
    seedSnapshot(db, rothId, "2023-12-31", {
      totalValue: 60000,
      startingValue: 55000,
      depositsWithdrawals: 0,
      twr: 0.09,
      investmentGain: 5000,
    });
  });

  function buildFixtureCsvRows(): CsvSnapshotRow[] {
    const rows = [
      ...CANONICAL_DECEMBER_ROWS.map((r) => ({ account: "Vanguard Taxable", ...r })),
      {
        account: "Vanguard Taxable",
        monthEndDate: "2024-06-30",
        totalValue: 500000.0,
        startingValue: 480000.0,
        depositsWithdrawals: 0.0,
        investmentGain: 20000.0,
        twr: 0.04,
      },
      {
        account: "Vanguard Taxable",
        monthEndDate: "2024-09-30",
        totalValue: 410000.0, // mismatches the seeded 400000.0
        startingValue: 390000.0,
        depositsWithdrawals: 0.0,
        investmentGain: 10000.0,
        twr: 0.01,
      },
    ];
    const csvPath = writeTempCsv(buildCsvContent(rows));
    return readCsvRows(csvPath);
  }

  it("dry-run reports exactly 4 December mismatches and writes nothing", () => {
    const rows = buildFixtureCsvRows();
    const before2022 = readSnapshot(db, taxableId, "2022-12-31");

    const result = repairDecemberSnapshots(db, rows, { apply: false, today: TODAY });

    expect(result.decemberMismatches).toHaveLength(4);
    expect(result.updated).toBe(0);

    const after2022 = readSnapshot(db, taxableId, "2022-12-31");
    expect(after2022).toEqual(before2022);
  });

  it("apply repairs all 4 December rows (values + note) and leaves Roth + non-December untouched", () => {
    const rows = buildFixtureCsvRows();

    const rothBefore = [
      readSnapshot(db, rothId, "2022-12-31"),
      readSnapshot(db, rothId, "2023-12-31"),
    ];
    const healthyNonDecBefore = readSnapshot(db, taxableId, "2024-06-30");
    const mismatchedNonDecBefore = readSnapshot(db, taxableId, "2024-09-30");

    const result = repairDecemberSnapshots(db, rows, { apply: true, today: TODAY });
    expect(result.updated).toBe(4);
    expect(result.nonDecemberMismatches).toHaveLength(1);
    expect(result.nonDecemberMismatches[0].monthEndDate).toBe("2024-09-30");

    // 2022-12-31: values repaired, existing note preserved + new note appended.
    const s2022 = readSnapshot(db, taxableId, "2022-12-31");
    expect(s2022.totalValue).toBeCloseTo(328285.46, 2);
    expect(s2022.startingValue).toBeCloseTo(351126.94, 2);
    expect(s2022.depositsWithdrawals).toBeCloseTo(0.0, 2);
    expect(s2022.twr).toBeCloseTo(-0.065052, 6);
    expect(s2022.investmentGain).toBeCloseTo(-22841.48, 2);
    expect(s2022.notes).toBe(
      "imported from batch 26\nrepaired 2026-08-10 from canonical CSV (annual-row defect, batch 26)",
    );

    // 2023/2024/2025: NULL twr repaired to the CSV's real value; no pre-existing note.
    const s2023 = readSnapshot(db, taxableId, "2023-12-31");
    expect(s2023.twr).toBeCloseTo(0.047594, 6);
    expect(s2023.startingValue).toBeCloseTo(502253.87, 2);
    expect(s2023.notes).toBe(
      "repaired 2026-08-10 from canonical CSV (annual-row defect, batch 26)",
    );

    const s2024 = readSnapshot(db, taxableId, "2024-12-31");
    expect(s2024.twr).toBeCloseTo(-0.045952, 6);
    expect(s2024.startingValue).toBeCloseTo(939820.98, 2);
    expect(s2024.investmentGain).toBeCloseTo(-43186.79, 2);

    const s2025 = readSnapshot(db, taxableId, "2025-12-31");
    expect(s2025.twr).toBeCloseTo(-0.025799, 6);
    expect(s2025.startingValue).toBeCloseTo(1344716.44, 2);
    expect(s2025.depositsWithdrawals).toBeCloseTo(-20000.0, 2);

    // Roth December rows: byte-identical, never touched.
    expect(readSnapshot(db, rothId, "2022-12-31")).toEqual(rothBefore[0]);
    expect(readSnapshot(db, rothId, "2023-12-31")).toEqual(rothBefore[1]);

    // Healthy non-December row: untouched (it already matched).
    expect(readSnapshot(db, taxableId, "2024-06-30")).toEqual(healthyNonDecBefore);

    // Mismatched non-December row: reported, but NEVER written.
    expect(readSnapshot(db, taxableId, "2024-09-30")).toEqual(mismatchedNonDecBefore);
  });

  it("is idempotent — a second apply run finds 0 December mismatches and writes nothing further", () => {
    const rows = buildFixtureCsvRows();
    repairDecemberSnapshots(db, rows, { apply: true, today: TODAY });

    const afterFirst = readSnapshot(db, taxableId, "2022-12-31");

    const second = repairDecemberSnapshots(db, rows, { apply: true, today: "2026-08-11" });
    expect(second.decemberMismatches).toHaveLength(0);
    expect(second.updated).toBe(0);

    // Notes must NOT gain a second appended line.
    const afterSecond = readSnapshot(db, taxableId, "2022-12-31");
    expect(afterSecond).toEqual(afterFirst);
  });

  it("refuses to write ANY December row when a December CSV row references an unknown account", () => {
    const rows: CsvSnapshotRow[] = [
      ...buildFixtureCsvRows(),
      {
        account: "Vanguard 529 Ghost",
        monthEndDate: "2022-12-31",
        totalValue: 1,
        startingValue: null,
        depositsWithdrawals: null,
        twr: null,
        investmentGain: null,
      },
    ];

    const before2022 = readSnapshot(db, taxableId, "2022-12-31");
    const result = repairDecemberSnapshots(db, rows, { apply: true, today: TODAY });

    expect(result.unknownDecemberAccounts).toEqual(["Vanguard 529 Ghost"]);
    expect(result.updated).toBe(0);
    // Even the 4 resolvable December mismatches must be left untouched.
    expect(readSnapshot(db, taxableId, "2022-12-31")).toEqual(before2022);
  });

  it("an unresolved account in a NON-December row does not block December repairs", () => {
    const rows: CsvSnapshotRow[] = [
      ...buildFixtureCsvRows(),
      {
        account: "Vanguard 529 Ghost",
        monthEndDate: "2024-03-31",
        totalValue: 1,
        startingValue: null,
        depositsWithdrawals: null,
        twr: null,
        investmentGain: null,
      },
    ];

    const result = repairDecemberSnapshots(db, rows, { apply: true, today: TODAY });
    expect(result.unknownDecemberAccounts).toHaveLength(0);
    expect(result.updated).toBe(4);
  });

  it("resolves and repairs a December row even when the CSV account column is padded with whitespace", () => {
    // Real-world CSV export/copy-paste whitespace, not just the exact-name
    // happy path — "Vanguard Taxable" here means "  Vanguard Taxable  ".
    const csvPath = writeTempCsv(
      [
        CSV_HEADER,
        csvLine([
          "  Vanguard Taxable  ",
          "2022-12-31",
          328285.46,
          351126.94,
          0.0,
          "",
          "",
          "",
          "",
          -22841.48,
          -0.065052,
        ]),
      ].join("\n"),
    );
    const rows = readCsvRows(csvPath);
    expect(rows[0].account).toBe("Vanguard Taxable"); // parsed + trimmed already

    const result = repairDecemberSnapshots(db, rows, { apply: true, today: TODAY });
    expect(result.unresolved).toHaveLength(0);
    expect(result.updated).toBe(1);

    const s2022 = readSnapshot(db, taxableId, "2022-12-31");
    expect(s2022.totalValue).toBeCloseTo(328285.46, 2);
    expect(s2022.startingValue).toBeCloseTo(351126.94, 2);
    expect(s2022.twr).toBeCloseTo(-0.065052, 6);
  });

  it("rolls back the ENTIRE December batch when the post-write verification catches a real mismatch", () => {
    // Force a genuine post-write mismatch (not a mock): a real SQLite
    // trigger corrupts `twr` on the row that's updated LAST in iteration
    // order (2025-12-31 — CANONICAL_DECEMBER_ROWS is in ascending-date
    // order, and findSnapshotMismatches/repairDecemberSnapshots preserve
    // CSV row order) immediately after its UPDATE lands. The in-transaction
    // verification re-read must then see a real mismatch, throw, and
    // better-sqlite3's transaction wrapper must roll back the WHOLE batch —
    // including 2022/2023/2024, whose own UPDATE + individual verify both
    // already ran cleanly earlier in the same transaction.
    db.exec(`
      CREATE TRIGGER corrupt_2025_twr_after_repair_write
      AFTER UPDATE OF total_value ON monthly_snapshots
      WHEN NEW.account_id = ${taxableId} AND NEW.month_end_date = '2025-12-31'
      BEGIN
        UPDATE monthly_snapshots SET twr = -999 WHERE id = NEW.id;
      END;
    `);

    const rows = buildFixtureCsvRows();
    const before = {
      "2022-12-31": readSnapshot(db, taxableId, "2022-12-31"),
      "2023-12-31": readSnapshot(db, taxableId, "2023-12-31"),
      "2024-12-31": readSnapshot(db, taxableId, "2024-12-31"),
      "2025-12-31": readSnapshot(db, taxableId, "2025-12-31"),
    };

    expect(() =>
      repairDecemberSnapshots(db, rows, { apply: true, today: TODAY }),
    ).toThrow(/verification failed/);

    // Full-batch rollback: EVERY December row — including the three whose
    // UPDATE and individual verify both succeeded before the transaction
    // hit the corrupted 2025 row — must still hold its ORIGINAL poisoned
    // value. A partial commit here would mean an operator re-running
    // --apply after a "verification failed" error inherits a half-repaired
    // December chain without knowing it.
    expect(readSnapshot(db, taxableId, "2022-12-31")).toEqual(before["2022-12-31"]);
    expect(readSnapshot(db, taxableId, "2023-12-31")).toEqual(before["2023-12-31"]);
    expect(readSnapshot(db, taxableId, "2024-12-31")).toEqual(before["2024-12-31"]);
    expect(readSnapshot(db, taxableId, "2025-12-31")).toEqual(before["2025-12-31"]);
  });
});

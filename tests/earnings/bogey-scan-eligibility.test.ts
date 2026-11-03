import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  BOGEY_SCAN_SOURCE_NAMES,
  BOGEY_SCAN_SOURCE_SQL,
  isBogeyScanSource,
} from "@/lib/earnings/bogey-scan-eligibility";

// Owner ruling 2026-11-02: only TMT Breakout articles are bogey-scanned.
describe("bogey scan eligibility gate", () => {
  const eligible = ["TMT Breakout", "TMT Breakouts", "  tmt breakout ", "TMT BREAKOUTS"];
  const ineligible = ["Vital Knowledge", "Stratechery", "The Diff", "Morning Recap", "TMT", "", "Desk Notes"];

  it("JS predicate accepts both seeded spellings and nothing else", () => {
    for (const n of eligible) expect(isBogeyScanSource(n), n).toBe(true);
    for (const n of ineligible) expect(isBogeyScanSource(n), n).toBe(false);
    expect(isBogeyScanSource(null)).toBe(false);
    expect(isBogeyScanSource(undefined)).toBe(false);
  });

  it("SQL twin agrees with the JS predicate on every name (parity)", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE research_sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    const names = [...eligible, ...ineligible.filter((n) => n !== "")];
    names.forEach((n, i) => db.prepare("INSERT INTO research_sources (id, name) VALUES (?, ?)").run(i + 1, n));
    const rows = db
      .prepare(`SELECT rs.name AS name, (${BOGEY_SCAN_SOURCE_SQL}) AS ok FROM research_sources rs`)
      .all() as { name: string; ok: number }[];
    expect(rows).toHaveLength(names.length);
    for (const r of rows) expect(r.ok === 1, r.name).toBe(isBogeyScanSource(r.name));
  });

  it("names the publication lowercase (the SQL and JS compare lowercased)", () => {
    for (const n of BOGEY_SCAN_SOURCE_NAMES) expect(n).toBe(n.toLowerCase());
  });
});

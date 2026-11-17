import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  BOGEY_SCAN_PREVIEW_ONLY_SOURCE_NAMES,
  BOGEY_SCAN_SOURCE_NAMES,
  BOGEY_SCAN_SOURCE_SQL,
  isBogeyScanArticle,
} from "@/lib/earnings/bogey-scan-eligibility";

// Owner rulings: 2026-11-02 (TMT Breakout only) and 2026-11-17 (FundaAI's
// "Preview" posts too, and none of its other post types).
describe("bogey scan eligibility gate", () => {
  const tmtNames = ["TMT Breakout", "TMT Breakouts", "  tmt breakout ", "TMT BREAKOUTS"];
  const otherNames = ["Vital Knowledge", "Stratechery", "The Diff", "Morning Recap", "TMT", "Desk Notes", "Funda", "FundaAI Weekly"];
  const fundaNames = ["FundaAI", " fundaai ", "FUNDAAI"];

  const previewSubjects = [
    "Preview|ACME FY27Q3: Demand Remains Solid",
    "Preview | ACME 3Q26: Data Drama",
    "PREVIEW|ACME",
    "preview |ACME & BETA 3Q26",
  ];
  const nonPreviewSubjects = [
    "Weekly|Thoughts on Short/Mid/Long Terms",
    "Deep|ACME: The Supply Chain",
    "Deep | What Is Holding Back Mass Production?",
    "Research|ACME checks",
    "Review|ACME 3Q26: A Clean Quarter",
    "Column|Security budgets",
    "Previewing next week|ACME",
    "Re: Preview|ACME FY27Q3",
    "ACME Preview|notes",
    "Preview",
    "Preview: ACME FY27Q3",
    "",
  ];

  it("a TMT Breakout article passes whatever its subject", () => {
    for (const n of tmtNames) {
      for (const s of [...previewSubjects, ...nonPreviewSubjects]) {
        expect(isBogeyScanArticle(n, s), `${n} / ${s}`).toBe(true);
      }
      expect(isBogeyScanArticle(n, null)).toBe(true);
      expect(isBogeyScanArticle(n, undefined)).toBe(true);
    }
  });

  it("a FundaAI article passes only when its subject starts with Preview and a bar", () => {
    for (const n of fundaNames) {
      for (const s of previewSubjects) expect(isBogeyScanArticle(n, s), `${n} / ${s}`).toBe(true);
      for (const s of nonPreviewSubjects) expect(isBogeyScanArticle(n, s), `${n} / ${s}`).toBe(false);
      expect(isBogeyScanArticle(n, null)).toBe(false);
      expect(isBogeyScanArticle(n, undefined)).toBe(false);
    }
  });

  it("every other source fails, a Preview subject included", () => {
    for (const n of otherNames) {
      for (const s of [...previewSubjects, ...nonPreviewSubjects]) {
        expect(isBogeyScanArticle(n, s), `${n} / ${s}`).toBe(false);
      }
    }
    expect(isBogeyScanArticle("", previewSubjects[0])).toBe(false);
    expect(isBogeyScanArticle(null, previewSubjects[0])).toBe(false);
    expect(isBogeyScanArticle(undefined, previewSubjects[0])).toBe(false);
  });

  it("SQL twin agrees with the JS predicate on every name and subject (parity)", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE research_sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE research_articles (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, subject TEXT);
    `);
    const names = [...tmtNames, ...fundaNames, ...otherNames];
    const subjects: (string | null)[] = [...previewSubjects, ...nonPreviewSubjects, null];
    const insertSource = db.prepare("INSERT INTO research_sources (id, name) VALUES (?, ?)");
    const insertArticle = db.prepare("INSERT INTO research_articles (source_id, subject) VALUES (?, ?)");
    names.forEach((n, i) => {
      insertSource.run(i + 1, n);
      for (const s of subjects) insertArticle.run(i + 1, s);
    });
    const rows = db
      .prepare(
        `SELECT rs.name AS name, a.subject AS subject, (${BOGEY_SCAN_SOURCE_SQL}) AS ok
           FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id`,
      )
      .all() as { name: string; subject: string | null; ok: number }[];
    expect(rows).toHaveLength(names.length * subjects.length);
    for (const r of rows) {
      expect(r.ok === 1, `${r.name} / ${r.subject}`).toBe(isBogeyScanArticle(r.name, r.subject));
    }
    // The parity loop alone would pass if both sides were wrong the same way.
    expect(rows.filter((r) => r.ok === 1)).toHaveLength(
      tmtNames.length * subjects.length + fundaNames.length * previewSubjects.length,
    );
  });

  it("names every publication lowercase (the SQL and JS compare lowercased)", () => {
    for (const n of [...BOGEY_SCAN_SOURCE_NAMES, ...BOGEY_SCAN_PREVIEW_ONLY_SOURCE_NAMES]) {
      expect(n).toBe(n.toLowerCase());
    }
  });
});

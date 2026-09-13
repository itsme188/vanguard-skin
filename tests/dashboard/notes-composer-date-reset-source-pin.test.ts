/**
 * QA finding research-notes-composer--date-field-persists-after-save-next-note-backdated (MEDIUM).
 *
 * The Notes composer's post-save reset cleared content, tags and sentiment
 * but never `formDate`. A user who back-dates one note (e.g. logging a
 * missed journal entry from last week) and then writes a second note gets
 * the second note silently filed under the old date too — there is no
 * visual cue that the date field is "stuck".
 *
 * Also, the initial `formDate` was seeded from `new Date().toISOString().slice(0, 10)`
 * — a UTC calendar date, not the ET-anchored "today" this project requires
 * (CLAUDE.md: "ET-anchor every user-facing 'today' ... Never
 * `new Date().toISOString().slice(0,10)`"). Near midnight ET (UTC ahead by
 * 4-5h), that seeds tomorrow's date for a note filed today.
 *
 * This is a source-pin test — this repo has no jsdom/RTL harness (see
 * tests/dashboard/notes-composer-save-failure-copy.test.ts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("app/dashboard/components/NotesView.tsx", "utf8");

describe("NotesView formDate is ET-anchored, never UTC-sliced", () => {
  it("never uses the UTC toISOString().slice(0, 10) anti-pattern anywhere in the file", () => {
    // Any spacing inside the slice() call.
    expect(src).not.toMatch(/toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)/);
  });

  it("imports todayET from the shared ET date-utils module", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\btodayET\b[^}]*\}\s*from\s*["']@\/lib\/calendar\/date-utils["']/,
    );
  });

  it("seeds the initial formDate from todayET()", () => {
    const formDateInit = src.slice(
      src.indexOf("const [formDate, setFormDate]"),
      src.indexOf("const [formDate, setFormDate]") + 200,
    );
    expect(formDateInit).toMatch(/useState\(\s*\(\)\s*=>\s*todayET\(\)\s*\)/);
  });
});

describe("NotesView create handler resets formDate back to today after a save", () => {
  function extractHandleCreate(): string {
    const start = src.indexOf("async function handleCreate");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("// ─── Update note ───", start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("calls setFormDate(todayET()) in the post-save reset block", () => {
    const create = extractHandleCreate();
    expect(create).toMatch(/setFormDate\(\s*todayET\(\)\s*\)/);
  });

  it("resets formDate alongside (after) the other reset calls, not before them", () => {
    const create = extractHandleCreate();
    const contentReset = create.indexOf('setFormContent("")');
    const dateReset = create.indexOf("setFormDate(todayET())");
    expect(contentReset).toBeGreaterThan(-1);
    expect(dateReset).toBeGreaterThan(contentReset);
  });

  it("the date reset happens only after a confirmed success (after both failure returns)", () => {
    const create = extractHandleCreate();
    const dateReset = create.indexOf("setFormDate(todayET())");
    // Both failure branches ("if (!res)" and "if (!res.ok || !data?.success)")
    // must appear, and return, before the reset block.
    const networkFailure = create.indexOf("if (!res)");
    const serverFailure = create.indexOf("if (!res.ok || !data?.success)");
    expect(networkFailure).toBeGreaterThan(-1);
    expect(serverFailure).toBeGreaterThan(networkFailure);
    expect(dateReset).toBeGreaterThan(serverFailure);
  });
});

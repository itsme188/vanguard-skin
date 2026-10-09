/**
 * lib/calendar/macro-refused-note.ts: a refused macro actual is visible
 * (follow-up to migration 097). A row whose fetched actual was refused by the
 * size check stores no actual and a reason; without a line on the card it
 * looked like any row with no actual. Pure helper tests plus source pins on
 * the two cards that print the period line. Synthetic figures only.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { macroActualProblem } from "@/lib/calendar/macro-figure";
import { recordMacroBasis } from "@/lib/calendar/macro-actual-gate";
import { REFUSED_ACTUAL_TEXT, refusedActualNote } from "@/lib/calendar/macro-refused-note";
import { anchorIndex } from "../helpers/source-anchor";

const REASON = macroActualProblem("30.0%", "0.3%", "0.2%") as string;

describe("refusedActualNote", () => {
  it("the fixture reason is the sentence the size check really writes", () => {
    expect(REASON).toMatch(/ten times/);
  });

  it("a refused row gets the plain line, with the stored reason as the hover title", () => {
    expect(
      refusedActualNote({ event_type: "cpi", actual_value: null, actual_refused_reason: REASON }),
    ).toEqual({ text: REFUSED_ACTUAL_TEXT, title: REASON });
  });

  it("says it in plain words, with no figure of its own", () => {
    expect(REFUSED_ACTUAL_TEXT).toBe(
      "Actual not shown: the fetched figure was on a different scale from the estimates.",
    );
    expect(REFUSED_ACTUAL_TEXT).not.toMatch(/\d/);
  });

  it("an empty-string actual counts as empty", () => {
    expect(
      refusedActualNote({ event_type: "cpi", actual_value: "  ", actual_refused_reason: REASON }),
    ).not.toBeNull();
  });

  it("no reason, no line", () => {
    for (const reason of [null, undefined, "", "   "]) {
      expect(
        refusedActualNote({ event_type: "cpi", actual_value: null, actual_refused_reason: reason }),
      ).toBeNull();
    }
  });

  it("a row that holds an actual never gets the line, even beside a leftover reason", () => {
    expect(
      refusedActualNote({ event_type: "cpi", actual_value: "0.3%", actual_refused_reason: REASON }),
    ).toBeNull();
  });

  it("never an earnings row", () => {
    expect(
      refusedActualNote({
        event_type: "earnings",
        actual_value: null,
        actual_refused_reason: REASON,
      }),
    ).toBeNull();
  });

  it("trims the stored reason for the title", () => {
    expect(
      refusedActualNote({
        event_type: "jobs",
        actual_value: null,
        actual_refused_reason: `  ${REASON}  `,
      })?.title,
    ).toBe(REASON);
  });

  it("reads a row the real writer produced", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const id = Number(
      db
        .prepare(
          `INSERT INTO calendar_events
             (source, event_type, event_date, title, source_key, week_of,
              consensus_estimate, previous_value)
           VALUES ('claude_macro', 'cpi', '2026-09-10', 'August CPI', 'fred:10:2026-09-10',
                   '2026-09-07', '0.3%', '0.2%')`,
        )
        .run().lastInsertRowid,
    );
    recordMacroBasis(db, id, { refusedReason: REASON, referencePeriod: "2026-08" });
    const row = db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as {
      event_type: string;
      actual_value: string | null;
      actual_refused_reason: string | null;
    };
    expect(refusedActualNote(row)).toEqual({ text: REFUSED_ACTUAL_TEXT, title: REASON });

    // A later valid actual clears the reason, and the line goes with it.
    db.prepare(`UPDATE calendar_events SET actual_value = '0.3%' WHERE id = ?`).run(id);
    recordMacroBasis(db, id, {});
    const after = db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(id) as typeof row;
    expect(refusedActualNote(after)).toBeNull();
  });
});

describe("the two cards print the refused line", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
  const HELPER = read("lib/calendar/macro-refused-note.ts");

  it("the helper is a plain module a server component may import", () => {
    expect(HELPER).not.toMatch(/^\s*["']use client["']/m);
    expect(HELPER).not.toMatch(/from "react"/);
  });

  it.each(["app/dashboard/components/EventCard.tsx", "app/dashboard/today/WeekAheadView.tsx"])(
    "%s shows the line with the reason as its title, in the dim ink its notes use",
    (file) => {
      const src = read(file);
      expect(src).toContain('from "@/lib/calendar/macro-refused-note"');
      expect(src).toMatch(/refusedActualNote\(/);
      const at = anchorIndex(src, "{refusedNote && (", 0, file);
      const block = src.slice(at, anchorIndex(src, ")}", at, "end of the line"));
      expect(block).toContain("title={refusedNote.title}");
      expect(block).toContain("{refusedNote.text}");
      expect(block).toContain("text-ink-dim");
      // No new colour: only the ink class the period note beside it uses.
      const colours = block.match(/\b(?:text|bg|border)-[a-z]+(?:-[a-z]+)*\b/g) ?? [];
      expect(colours.filter((c) => !/^text-(?:xs|ink-dim)$/.test(c))).toEqual([]);
    },
  );

  it("the week view does not also call a refused row 'no actual recorded'", () => {
    const src = read("app/dashboard/today/WeekAheadView.tsx");
    expect(src).toContain("!refusedNote && showsNoActualRecorded(event, todayIso)");
  });

  it("the compact card prints the line too", () => {
    const src = read("app/dashboard/components/EventCard.tsx");
    const first = anchorIndex(src, "{refusedNote && (");
    anchorIndex(src, "{refusedNote && (", first + 1, "second (full card) use");
  });
});

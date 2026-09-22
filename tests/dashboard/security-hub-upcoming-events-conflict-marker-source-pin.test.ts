/**
 * QA finding security-detail-upcoming-events--date-conflicted-earnings-row-rendered-as-settled-no-marker:
 * the security hub's Upcoming Events section rendered an earnings row whose
 * calendar_events.date_status === 'conflict' identically to a settled row —
 * no chip, no mention of the competing vendor date (which can be EARLIER
 * than the shown one, so a user could miss a print).
 *
 * The security detail page (app/dashboard/security/[id]/page.tsx) queries
 * the real db singleton at module scope, so it can't be rendered directly
 * in this test process without opening the real database — same constraint
 * as tests/dashboard/security-hub-dte-et-anchored-source-pin.test.ts, whose
 * pattern (read the source as text, regex-pin the fix, then prove the pin
 * is sensitive by re-running it against a deliberately mutated copy) this
 * test follows. The shared EarningsConflictMarker component itself is
 * exercised with a real renderToStaticMarkup pass in
 * tests/dashboard/earnings-conflict-marker.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_PATH = "app/dashboard/security/[id]/page.tsx";
const src = readFileSync(SRC_PATH, "utf8");

/** The Upcoming Events row's own markup — scope of this regression. */
function extractUpcomingEventsRow(content: string): string {
  const start = content.indexOf('{upcomingEvents.map((event, idx) => (');
  if (start === -1) throw new Error("could not find the upcomingEvents.map row in the source");
  const end = content.indexOf("))}", start);
  if (end === -1) throw new Error("could not find the end of the upcomingEvents.map block");
  return content.slice(start, end);
}

function assertRendersConflictMarker(row: string): void {
  if (!/EarningsConflictMarker/.test(row)) {
    throw new Error("Upcoming Events row never mentions EarningsConflictMarker");
  }
  if (!/dateStatus=\{event\.date_status\}/.test(row)) {
    throw new Error("EarningsConflictMarker is not wired to event.date_status");
  }
  if (!/dateConflictWith=\{event\.date_conflict_with\}/.test(row)) {
    throw new Error("EarningsConflictMarker is not wired to event.date_conflict_with");
  }
}

describe("Security hub Upcoming Events row renders the date-conflict marker", () => {
  it("imports EarningsConflictMarker from the shared calendar components", () => {
    expect(src).toMatch(
      /import\s*\{\s*EarningsConflictMarker\s*\}\s*from\s*["']\.\.\/\.\.\/components\/calendar\/EarningsConflictMarker["']/,
    );
  });

  it("wires EarningsConflictMarker into the Upcoming Events row with the event's own date_status/date_conflict_with", () => {
    expect(() => assertRendersConflictMarker(extractUpcomingEventsRow(src))).not.toThrow();
  });

  it("never edits EarningsDateChip or EarningsHub.tsx (out of ownership) to get there", () => {
    // Regression guard against a lazy fix that imports the Hub's editable
    // chip directly instead of the shared read-only marker — that chip
    // carries live confirm/correct-date mutation forms that don't belong on
    // a read-only list surface.
    expect(src).not.toMatch(/EarningsDateChip/);
  });
});

describe("pin sensitivity — the check must fail against a mutated copy that removes the marker", () => {
  it("throws when the EarningsConflictMarker call is stripped from the Upcoming Events row", () => {
    const row = extractUpcomingEventsRow(src);
    const mutatedRow = row.replace(
      /<EarningsConflictMarker[\s\S]*?\/>\s*/,
      "",
    );
    expect(mutatedRow).not.toBe(row);

    const dir = mkdtempSync(join(tmpdir(), "security-hub-conflict-marker-pin-"));
    writeFileSync(join(dir, "row.txt"), mutatedRow, "utf8");
    const reread = readFileSync(join(dir, "row.txt"), "utf8");

    expect(() => assertRendersConflictMarker(reread)).toThrow();
  });
});

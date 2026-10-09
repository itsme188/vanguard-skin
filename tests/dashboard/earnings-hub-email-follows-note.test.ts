/**
 * Owner ruling 2026-10-07
 * [qa:dashboard-today-earningshub-refresh-from-finnhub-refresh-silently-supersedes-a-user-added-earnings-row-the-hub]:
 * when one company has two live hand-entered earnings rows, email follows
 * the EARLIER date, and the Hub marks the LATER row as such — with the date
 * email follows and the plain remedy. The earlier row carries no mark.
 *
 * No DOM harness in this repo: the sentence is unit-tested through its pure
 * composer and the wiring is source-pinned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";
import { emailFollowsEarlierCopy } from "@/app/dashboard/today/email-follows-earlier-copy";

describe("emailFollowsEarlierCopy", () => {
  // F1 2026-10-08: the notice counts the real number of entries and never names
  // a date that has already passed (the ruling itself is unchanged).
  it("names the company, the upcoming date email follows, the count and the remedy", () => {
    expect(emailFollowsEarlierCopy("ZZA", "2026-06-10", 2, "2026-06-01")).toBe(
      "Email follows your earlier ZZA entry (2026-06-10). Delete one of the 2 entries to settle the date.",
    );
  });

  it("counts three or four hand-entered entries as they are", () => {
    expect(emailFollowsEarlierCopy("ZZA", "2026-06-10", 3, "2026-06-10")).toContain("one of the 3 entries");
    expect(emailFollowsEarlierCopy("ZZA", "2026-06-10", 4, "2026-06-01")).toContain("one of the 4 entries");
  });

  it("does not name a date that has already passed", () => {
    const text = emailFollowsEarlierCopy("ZZA", "2026-06-10", 3, "2026-06-11");
    expect(text).not.toContain("2026-06-10");
    expect(text).toContain("Email follows your earliest ZZA entry");
    expect(text).toContain("already passed");
    expect(text).toContain("one of the 3 entries");
  });
});

describe("EarningsHub source — the later hand-entered row is marked", () => {
  const src = readFileSync("app/dashboard/today/EarningsHub.tsx", "utf8");

  it("reads the ignored rows through the one shared query, not a rule of its own", () => {
    expect(src).toContain('from "@/lib/queries/manual-twin-email"');
    expect(src).toContain("getEmailIgnoredManualTwins(db)");
    expect(src).toContain("emailFollowsDate: ignoredManualTwins.get(e.id)?.emailRowDate ?? null");
    // The count is the earlier row plus every row that follows it.
    expect(src).toContain("emailFollowsCount");
    expect(src).toContain("emailFollowsEarlierCopy(symbol, emailFollowsDate, entryCount, todayET())");
  });

  it("renders the note on both the desktop row and the phone card", () => {
    const desktop = sliceBetween(src, "function DesktopRow(", "function MobileCard(");
    const mobile = src.slice(anchorIndex(src, "function MobileCard("));
    expect(desktop).toContain("<EmailFollowsEarlierNote");
    expect(mobile).toContain("<EmailFollowsEarlierNote");
  });

  it("is always-visible text at a readable tone — no hover-only title, no privacy wrapper needed", () => {
    const note = sliceBetween(src, "function EmailFollowsEarlierNote(", "function DesktopRow(");
    expect(note).toContain("emailFollowsEarlierCopy(");
    expect(note).toContain("text-ink-dim");
    expect(note).not.toMatch(/title=/);
    expect(note).not.toContain("cursor-help");
    // Renders nothing for an unmarked row (the earlier row needs no mark).
    expect(note).toContain("if (!emailFollowsDate || !symbol) return null;");
  });
});

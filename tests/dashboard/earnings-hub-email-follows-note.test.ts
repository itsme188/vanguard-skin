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
  it("names the company, the date email follows, and the remedy", () => {
    expect(emailFollowsEarlierCopy("ZZA", "2026-06-10")).toBe(
      "Email follows your earlier ZZA entry (2026-06-10). Delete one of the two entries to settle the date.",
    );
  });
});

describe("EarningsHub source — the later hand-entered row is marked", () => {
  const src = readFileSync("app/dashboard/today/EarningsHub.tsx", "utf8");

  it("reads the ignored rows through the one shared query, not a rule of its own", () => {
    expect(src).toContain('from "@/lib/queries/manual-twin-email"');
    expect(src).toContain("getEmailIgnoredManualTwins(db)");
    expect(src).toContain("emailFollowsDate: ignoredManualTwins.get(e.id)?.emailRowDate ?? null");
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

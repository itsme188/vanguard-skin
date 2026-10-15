/**
 * The Alerts "Emails" list prints "reports <event_date>" beside each sent
 * email. On a phone the row is a wrapping flex line, and a bare
 * "reports 2026-10-14" breaks at a hyphen inside the date, so a reader sees
 * "2026-10-" on one line and "14" on the next
 * (qa:alerts-emails-tab-390x844-app-dashboard-alerts-page-tsx-reports-event-date-emails-tab-splits-the-reports-date-).
 * The date is wrapped in a no-wrap span so it never splits. Source-pin test
 * (no DOM harness).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/alerts/page.tsx", "utf8");

describe("Emails tab 'reports' date", () => {
  it("renders the event date inside a whitespace-nowrap span", () => {
    const at = anchorIndex(src, "reports{\" \"}", 0, "reports label");
    const region = src.slice(at, at + 200);
    expect(region).toMatch(/<span className="whitespace-nowrap">\{e\.event_date\}<\/span>/);
  });

  it("the bare 'reports {e.event_date}' text node is gone", () => {
    expect(src).not.toContain("reports {e.event_date}");
  });
});

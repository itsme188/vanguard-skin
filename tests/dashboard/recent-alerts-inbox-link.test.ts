/**
 * qa: security-detail-recent-alerts--pending-crossings-no-controls-no-inbox-link
 * The hub's Recent Alerts section listed pending crossings with no control and
 * no link anywhere. It now links to the Alerts inbox, on the tab that holds
 * the rows shown.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alertsInboxLink } from "@/app/dashboard/components/RecentAlertsPanel";
import { parseAlertsViewParam } from "@/lib/alerts/view-param";
import { anchorIndex } from "../helpers/source-anchor";

const viewOf = (href: string) => new URL(href, "http://x").searchParams.get("view");

describe("alertsInboxLink", () => {
  it("sends a list with a pending crossing to the Pending tab", () => {
    const link = alertsInboxLink(
      [{ user_response: "ignored" }, { user_response: "pending" }],
      "ZZZ",
    );
    expect(viewOf(link.href)).toBe("pending");
    expect(link.href.startsWith("/dashboard/alerts?")).toBe(true);
    expect(new URL(link.href, "http://x").searchParams.get("symbol")).toBe("ZZZ");
    expect(link.label).toBe("Respond in Alerts →");
  });

  it("sends an all-answered list to the All tab", () => {
    const link = alertsInboxLink([{ user_response: "ignored" }, { user_response: "acted" }], null);
    expect(viewOf(link.href)).toBe("all");
    expect(link.href).not.toContain("symbol=");
    expect(link.label).toBe("All alerts →");
  });

  it("only uses view values the Alerts page round-trips", () => {
    for (const v of ["pending", "all"]) expect(parseAlertsViewParam(v)).toBe(v);
  });

  it("is rendered as the section action", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "app/dashboard/components/RecentAlertsPanel.tsx"),
      "utf8",
    );
    const at = anchorIndex(src, "action={");
    expect(src.slice(at, at + 200)).toContain("href={inbox.href}");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import { parseStoredTimestamp } from "@/lib/format";

// QA finding 2026-11-07: a Review card printed its creation time 5 hours late
// (4 under daylight time). `security_levels.created_at` is a bare SQLite
// `datetime('now')` stamp (UTC, space-separated, no zone marker), and
// `new Date(thatString)` parses it as LOCAL time. Fired alerts beside it carry
// an ISO `triggered_at` with a Z and were right. Both the card's time and the
// "today's activity" split must read the stamp through parseStoredTimestamp.
const src = readFileSync("app/dashboard/alerts/page.tsx", "utf8");

describe("alerts page reads a stored created_at as UTC", () => {
  it("the review card's time comes from parseStoredTimestamp, not a bare Date parse", () => {
    const row = src.slice(anchorIndex(src, "function ReviewRow(", 0, "ReviewRow"));
    expect(row).toContain("parseStoredTimestamp(level.created_at)");
    expect(row).not.toContain("new Date(level.created_at)");
  });

  it("the today/older split parses through the same helper", () => {
    const fn = sliceBetween(src, "function isToday(", "function formatPriceSourceLabel(");
    expect(fn).toContain("parseStoredTimestamp(");
    expect(fn).not.toMatch(/new Date\(iso\)/);
    expect(src).toMatch(/import \{[^}]*parseStoredTimestamp[^}]*\} from "@\/lib\/format"/);
  });

  it("parseStoredTimestamp turns a bare SQLite stamp into the UTC instant", () => {
    // 15:58 UTC is 10:58 Eastern under daylight time.
    const d = parseStoredTimestamp("2026-11-06 15:58:27");
    expect(d.toISOString()).toBe("2026-11-06T15:58:27.000Z");
    expect(d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })).toBe("10:58 AM");
  });
});

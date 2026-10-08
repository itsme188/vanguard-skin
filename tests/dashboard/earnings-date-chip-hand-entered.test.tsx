/**
 * The Earnings Hub date chip on a hand-entered row
 * (qa:today-earningshub-fix-date--chip-self-destructs-manual-rows-never-get-one).
 *
 * The calendar sync no longer stamps `user_confirmed` on hand-entered rows, so
 * such a row has an empty date status. It still needs a chip: the chip is the
 * only way into the date / slot / release-time editor. No DOM harness: the
 * pure decision is tested directly, the markup with renderToStaticMarkup, the
 * hub wiring against source. Symbols and dates are synthetic.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

import {
  EarningsDateChip,
  earningsDateChipKind,
  HAND_ENTERED_LABEL,
  HAND_ENTERED_LINE,
} from "@/app/dashboard/today/EarningsDateChip";

const HUB = readFileSync("app/dashboard/today/EarningsHub.tsx", "utf8");
const DATE_CHIP = readFileSync("app/dashboard/today/EarningsDateChip.tsx", "utf8");

describe("earningsDateChipKind — which chip a row gets", () => {
  it("a hand-entered row with no date status gets the hand-entered chip", () => {
    expect(earningsDateChipKind("manual", null)).toBe("hand_entered");
    expect(earningsDateChipKind("manual", undefined)).toBe("hand_entered");
    // A legacy successor row stored an empty string, not NULL.
    expect(earningsDateChipKind("manual", "" as never)).toBe("hand_entered");
  });

  it("a hand-entered row the user confirmed keeps the confirmed chip", () => {
    expect(earningsDateChipKind("manual", "user_confirmed")).toBe("user_confirmed");
  });

  it("a vendor row with no date status gets nothing", () => {
    for (const source of ["finnhub", "nasdaq", "wsh", "apple_calendar", "claude_macro"]) {
      expect(earningsDateChipKind(source, null)).toBeNull();
    }
    expect(earningsDateChipKind(null, null)).toBeNull();
    expect(earningsDateChipKind(undefined, undefined)).toBeNull();
  });

  it("every existing status is unchanged, whatever the source", () => {
    for (const source of ["manual", "finnhub", "nasdaq", undefined]) {
      for (const status of ["confirmed", "single", "user_confirmed", "conflict"] as const) {
        expect(earningsDateChipKind(source, status)).toBe(status);
      }
    }
  });
});

describe("EarningsDateChip markup", () => {
  const render = (props: { source?: string; dateStatus: "confirmed" | "single" | "user_confirmed" | "conflict" | null }) =>
    renderToStaticMarkup(
      createElement(EarningsDateChip, {
        symbol: "ZZZ",
        eventDate: "2026-11-04",
        releaseTime: "16:15",
        dateConflictWith: null,
        ...props,
      }),
    );

  it("a hand-entered row with no status renders a tappable chip that says who entered it", () => {
    const html = render({ source: "manual", dateStatus: null });
    expect(html).toContain("<button");
    expect(html).toContain(HAND_ENTERED_LABEL);
    expect(html).toContain(HAND_ENTERED_LINE);
    expect(html).not.toContain("🔒");
    expect(html.toLowerCase()).not.toContain("confirm");
    expect(html.toLowerCase()).not.toContain("locked");
  });

  it("the hand-entered wording never claims a confirmation", () => {
    for (const text of [HAND_ENTERED_LABEL, HAND_ENTERED_LINE]) {
      expect(text.toLowerCase()).not.toMatch(/confirm|lock|verif/);
    }
    expect(HAND_ENTERED_LABEL.toLowerCase()).toContain("entered by you");
  });

  it("a confirmed hand-entered row renders the lock chip as before", () => {
    const html = render({ source: "manual", dateStatus: "user_confirmed" });
    expect(html).toContain("🔒");
    expect(html).toContain("You confirmed this date (locked)");
    expect(html).not.toContain(HAND_ENTERED_LABEL);
  });

  it("the passive vendor chips are unchanged", () => {
    expect(render({ source: "nasdaq", dateStatus: "confirmed" })).toContain("✓ 2 src");
    expect(render({ source: "finnhub", dateStatus: "single" })).toContain("1 src");
    expect(render({ source: "nasdaq", dateStatus: "conflict" })).toContain("⚠ confirm");
  });

  it("a vendor row with no status renders nothing, wrapper included", () => {
    expect(render({ source: "finnhub", dateStatus: null })).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(EarningsDateChip, {
          symbol: "ZZZ",
          eventDate: "2026-11-04",
          releaseTime: null,
          dateStatus: null,
          dateConflictWith: null,
          source: "finnhub",
          wrapperClassName: "block mt-0.5",
        }),
      ),
    ).toBe("");
  });

  it("the wrapper class wraps a chip that does render", () => {
    const html = renderToStaticMarkup(
      createElement(EarningsDateChip, {
        symbol: "ZZZ",
        eventDate: "2026-11-04",
        releaseTime: null,
        dateStatus: null,
        dateConflictWith: null,
        source: "manual",
        wrapperClassName: "block mt-0.5",
      }),
    );
    expect(html.startsWith('<span class="block mt-0.5">')).toBe(true);
    expect(html).toContain(HAND_ENTERED_LABEL);
  });
});

describe("wiring", () => {
  it("both hub layouts pass the row's source and no longer gate on date_status", () => {
    expect(HUB).not.toContain("{event.date_status && (");
    const desktop = sliceBetween(HUB, "function DesktopRow(", "function MobileCard(");
    anchorIndex(desktop, "<EarningsDateChip");
    anchorIndex(desktop, "source={event.source}");
    const mobile = HUB.slice(anchorIndex(HUB, "function MobileCard("));
    const chipAt = anchorIndex(mobile, "<EarningsDateChip");
    expect(mobile.slice(chipAt, chipAt + 400)).toContain("source={event.source}");
  });

  it("the hand-entered chip opens the same fix-date editor and never writes a confirmation", () => {
    // One passive popover serves every non-conflict kind.
    const inner = DATE_CHIP.slice(anchorIndex(DATE_CHIP, "function EarningsDateChipInner("));
    const passive = sliceBetween(inner, 'if (kind !== "conflict") {', "// conflict");
    anchorIndex(passive, "hand_entered: {");
    anchorIndex(passive, "Date is wrong?");
    anchorIndex(passive, "<ReleaseTimeEditor");
    expect(passive).not.toContain("/api/earnings/confirm-date");
    // The only confirm-date call stays inside the conflict branch.
    expect(DATE_CHIP.split('apiFetch("/api/earnings/confirm-date"').length).toBe(2);
  });
});

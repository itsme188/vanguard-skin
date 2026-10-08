import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AllHoldingsTable, type AllHoldingsRow } from "@/app/dashboard/components/AllHoldingsTable";
import { PrivacyProvider } from "@/lib/privacy/context";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * QA finding accounts-holdings-all--value-gain-alloc-columns-offscreen-1280-
 * rail-open-scrollbar-at-bottom: at 1280px with the chat rail open the table
 * is wider than its container, so Value / Gain / Gain % / Alloc % sit past the
 * right edge. The only cues were a 32px edge fade and a scrollbar below every
 * row. The filter bar now carries a "More columns" button that shows only
 * while ScrollFade reports hidden columns and scrolls them into view.
 *
 * No DOM harness in this repo: static markup plus source pins.
 * Fixtures are synthetic: ZZ* tickers, round numbers.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/accounts",
}));

const ROW: AllHoldingsRow = {
  account_id: 1,
  account_name: "ZZ Account",
  security_id: 1,
  symbol: "ZZA",
  security_name: "ZZA Corp",
  security_type: "Stock",
  multiplier: 1,
  quantity: 10,
  cost_basis: 100,
  as_of_date: "2026-03-03",
  current_price: 20,
  current_value: 200,
  unrealized_gain: 100,
} as AllHoldingsRow;

const SRC = readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");

describe("AllHoldingsTable more-columns cue", () => {
  const html = renderToStaticMarkup(
    <PrivacyProvider>
      <AllHoldingsTable holdings={[ROW]} />
    </PrivacyProvider>,
  );

  it("renders a real button, outside the sideways scroller, that names the hidden columns", () => {
    const btn = anchorIndex(html, "More columns");
    const scroller = anchorIndex(html, "overflow-x-auto");
    expect(btn).toBeLessThan(scroller);
    const tag = html.slice(html.lastIndexOf("<button", btn), btn);
    expect(tag).toContain('type="button"');
    expect(tag).toContain("Value, Gain and Alloc");
  });

  it("shows the button only while ScrollFade reports columns past the right edge", () => {
    const btn = anchorIndex(html, "More columns");
    const tag = html.slice(html.lastIndexOf("<button", btn), btn);
    // Hidden by default; revealed by the wrapper class ScrollFade toggles.
    expect(tag).toMatch(/class="[^"]*\bhidden\b/);
    expect(tag).toContain("group-has-[.scroll-fade.is-scrollable]/holdings:inline-flex");
    expect(html).toContain("group/holdings");
    // The class the cue keys on is the one ScrollFade really toggles.
    const fade = readFileSync("app/dashboard/components/ScrollFade.tsx", "utf8");
    anchorIndex(fade, 'classList.toggle("is-scrollable"');
    anchorIndex(fade, "className={`scroll-fade ");
  });

  it("the button scrolls the table's own scroller, and the table stays inside ScrollFade", () => {
    const handler = sliceBetween(SRC, "const showMoreColumns", "};");
    expect(handler).toContain(".scroll-fade > .overflow-x-auto");
    expect(handler).toContain("scrollTo");
    const table = anchorIndex(SRC, '<table className="w-full text-sm">');
    expect(anchorIndex(SRC, "<ScrollFade>")).toBeLessThan(table);
    expect(anchorIndex(SRC, "</ScrollFade>")).toBeGreaterThan(table);
  });
});

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AllHoldingsTable,
  summarizeHoldingsFooter,
  type AllHoldingsRow,
} from "@/app/dashboard/components/AllHoldingsTable";
import { PrivacyProvider } from "@/lib/privacy/context";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

/**
 * The cross-account Holdings footer sums three columns over three different
 * sets of rows by necessity: Value covers every priced position, Cost Basis
 * only the positions whose basis is known, Gain only the positions with
 * both. So Value − Cost Basis does not equal Gain, and the footer has to SAY
 * which positions are left out of which column, in the row itself — not in
 * a hover title on a "~" that reads as rounding.
 *
 * Fixtures are synthetic: ZZ* tickers, round numbers.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/accounts",
}));

let nextId = 1;
function row(
  symbol: string,
  f: { cost: number | null; value: number | null },
): AllHoldingsRow {
  const known = f.cost !== null && f.cost !== 0;
  return {
    account_id: 1,
    account_name: "ZZ Account",
    security_id: nextId++,
    symbol,
    security_name: `${symbol} Corp`,
    security_type: "Stock",
    multiplier: 1,
    quantity: 10,
    cost_basis: f.cost,
    as_of_date: "2026-03-03",
    current_price: f.value === null ? null : f.value / 10,
    current_value: f.value,
    // Same rule as lib/queries/holdings.ts: a gain needs a price AND a
    // known, nonzero basis.
    unrealized_gain: f.value !== null && known ? f.value - f.cost! : null,
  };
}

const FULL = [row("ZZAAA", { cost: 1000, value: 1500 }), row("ZZBBB", { cost: 2000, value: 1800 })];
const NO_BASIS_NULL = row("ZZNUL", { cost: null, value: 400 });
const NO_BASIS_ZERO = row("ZZZER", { cost: 0, value: 300 });
const NO_BASIS_SHORT = row("ZZSHT", { cost: null, value: -100 });
const NO_BASIS_NO_PRICE = row("ZZDRK", { cost: null, value: null });
const NO_PRICE = row("ZZNPX", { cost: 500, value: null });

function render(holdings: AllHoldingsRow[]): string {
  return renderToStaticMarkup(
    <PrivacyProvider>
      <AllHoldingsTable holdings={holdings} />
    </PrivacyProvider>,
  );
}

function footerOf(html: string): string {
  return sliceBetween(html, "<tfoot", "</tfoot>");
}

describe("summarizeHoldingsFooter", () => {
  it("ties exactly when every position has a basis and a price, and discloses nothing", () => {
    const s = summarizeHoldingsFooter(FULL);
    expect(s.totalValue).toBe(3300);
    expect(s.totalCostBasis).toBe(3000);
    expect(s.totalGain).toBe(300);
    expect(s.noBasisCount).toBe(0);
    expect(s.noPriceCount).toBe(0);
    expect(s.totalValue - s.totalCostBasis!).toBe(s.totalGain);
  });

  it("counts a null AND a stored-zero basis as no cost basis, and sums their value (shorts net)", () => {
    const s = summarizeHoldingsFooter([...FULL, NO_BASIS_NULL, NO_BASIS_ZERO, NO_BASIS_SHORT]);
    expect(s.noBasisCount).toBe(3);
    expect(s.noBasisValue).toBe(600);
    expect(s.noBasisUnpricedCount).toBe(0);
    // Value keeps covering every position; Cost Basis and Gain do not.
    expect(s.totalValue).toBe(3900);
    expect(s.totalCostBasis).toBe(3000);
    expect(s.totalGain).toBe(300);
  });

  it("the disclosed figures explain the whole gap between Value − Cost Basis and Gain", () => {
    const s = summarizeHoldingsFooter([
      ...FULL,
      NO_BASIS_NULL,
      NO_BASIS_ZERO,
      NO_BASIS_SHORT,
      NO_BASIS_NO_PRICE,
      NO_PRICE,
    ]);
    expect(s.noBasisCount).toBe(4);
    expect(s.noBasisUnpricedCount).toBe(1);
    expect(s.noBasisValue).toBe(600);
    expect(s.noPriceCount).toBe(1);
    expect(s.noPriceCostBasis).toBe(500);
    // The identity the two disclosure sentences assert.
    const gap = s.totalValue - s.totalCostBasis! - s.totalGain!;
    expect(gap).toBe(s.noBasisValue - s.noPriceCostBasis);
  });

  it("reports an unknown total, never zero, when no row can supply it", () => {
    const s = summarizeHoldingsFooter([NO_BASIS_NULL, NO_BASIS_ZERO]);
    expect(s.totalCostBasis).toBeNull();
    expect(s.totalGain).toBeNull();
    expect(s.totalValue).toBe(700);
  });
});

describe("AllHoldingsTable footer (rendered)", () => {
  it("states inline how many positions carry no cost basis, and their value", () => {
    const footer = footerOf(render([...FULL, NO_BASIS_NULL, NO_BASIS_ZERO]));
    expect(footer).toContain("Positions with no cost basis");
    expect(footer).toContain("left out of Cost Basis and Gain");
    expect(footer).toContain("data-footer-disclosure=\"no-basis\"");
    const sentence = sliceBetween(footer, 'data-footer-disclosure="no-basis"', "</p>");
    expect(sentence).toMatch(/>2</);
    expect(sentence).toContain("$700.00");
    // Value still covers every position.
    expect(footer).toContain("$4,000.00");
  });

  it("drops the hover-only marker: no tilde and no title attribute in the footer", () => {
    const footer = footerOf(render([...FULL, NO_BASIS_NULL, NO_PRICE]));
    expect(footer).not.toContain("~");
    expect(footer).not.toContain("title=");
    expect(footer).not.toContain("cursor-help");
  });

  it("also discloses positions that have a basis but no current price", () => {
    const footer = footerOf(render([...FULL, NO_PRICE]));
    const sentence = sliceBetween(footer, 'data-footer-disclosure="no-price"', "</p>");
    expect(sentence).toContain("Positions with a cost basis but no current price");
    expect(sentence).toContain("left out of Value and Gain");
    expect(sentence).toMatch(/>1</);
    expect(sentence).toContain("$500.00");
    expect(footer).not.toContain('data-footer-disclosure="no-basis"');
  });

  it("says when some no-basis positions have no price either", () => {
    const footer = footerOf(render([...FULL, NO_BASIS_NULL, NO_BASIS_NO_PRICE]));
    const sentence = sliceBetween(footer, 'data-footer-disclosure="no-basis"', "</p>");
    expect(sentence).toContain("no current price either");
  });

  it("adds no disclosure row when every position has a basis and a price", () => {
    const footer = footerOf(render(FULL));
    expect(footer).not.toContain("data-footer-disclosure");
    expect(footer).toContain("$3,300.00");
    expect(footer).toContain("$3,000.00");
  });

  it("the wording never changes with the count, so Hide amounts cannot leak 'exactly one'", () => {
    const one = footerOf(render([...FULL, NO_BASIS_NULL]));
    const two = footerOf(render([...FULL, NO_BASIS_NULL, NO_BASIS_ZERO]));
    const strip = (s: string) =>
      sliceBetween(s, 'data-footer-disclosure="no-basis"', "</p>").replace(/<span[^>]*>[^<]*<\/span>/g, "#");
    expect(strip(one)).toBe(strip(two));
  });
});

describe("AllHoldingsTable footer (source)", () => {
  const src = () => readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");
  const footerSrc = () => sliceBetween(src(), "<tfoot>", "</tfoot>");

  it("renders the disclosed count and value through the privacy components", () => {
    const footer = footerSrc();
    expect(footer).toContain("<Count value={footer.noBasisCount} />");
    expect(footer).toContain("<Money value={footer.noBasisValue} precise />");
    expect(footer).toContain("<Count value={footer.noPriceCount} />");
    expect(footer).toContain("<Money value={footer.noPriceCostBasis} precise />");
    // No interpolated count in a plain template string.
    expect(footer).not.toMatch(/\$\{footer\.no(Basis|Price)/);
  });

  it("has no tilde marker, title or hover cursor left in the footer", () => {
    const footer = footerSrc();
    expect(footer).not.toContain("~");
    expect(footer).not.toContain("title=");
    expect(footer).not.toContain("cursor-help");
    expect(src()).not.toContain("missingGainTooltip");
  });

  it("decides 'no cost basis' with the file's one predicate", () => {
    const text = src();
    expect((text.match(/const hasKnownBasis\s*=/g) ?? []).length).toBe(1);
    const summary = text.slice(
      anchorIndex(text, "export function summarizeHoldingsFooter"),
      anchorIndex(text, "export function AllHoldingsTable"),
    );
    expect(summary).toContain("rows.filter(hasKnownBasis)");
    expect(summary).toContain("!hasKnownBasis(h)");
    expect(summary).not.toMatch(/cost_basis\s*[!=]==?\s*(null|0)/);
  });

  it("the disclosure text is readable (not the faint tone) at its small size", () => {
    const footer = footerSrc();
    const cell = sliceBetween(footer, "<td colSpan={9}", "data-footer-disclosure");
    expect(cell).toContain("text-ink-dim");
    expect(cell).not.toContain("text-ink-faint");
  });
});

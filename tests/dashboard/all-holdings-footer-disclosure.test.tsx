import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AllHoldingsTable,
  summarizeHoldingsFooter,
  type AllHoldingsRow,
} from "@/app/dashboard/components/AllHoldingsTable";
import { computePositionTotals, type SecurityPosition } from "@/lib/queries/security-detail";
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

/** The disclosure block, which sits AFTER the table (outside the scroller). */
function disclosuresOf(html: string): string {
  return html.slice(anchorIndex(html, "data-footer-disclosures"));
}

function text(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
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

  it("Gain % is measured over the cost basis of the positions that are in Gain", () => {
    // Reviewer's case: one +50% position and one position with a basis but
    // no price. Gain is +500 on a 1,000 basis: +50%, not +5% of 10,000.
    const s = summarizeHoldingsFooter([
      row("ZZUPP", { cost: 1000, value: 1500 }),
      row("ZZBIG", { cost: 9000, value: null }),
    ]);
    expect(s.totalGain).toBe(500);
    expect(s.totalCostBasis).toBe(10000);
    expect(s.noPriceCostBasis).toBe(9000);
    expect(s.gainCostBasis).toBe(1000);
    expect(s.gainCostBasis).toBe(s.totalCostBasis! - s.noPriceCostBasis);
    // Value, Cost Basis and Gain keep their definitions.
    expect(s.totalValue).toBe(1500);
  });

  it("counts priced and unpriced no-basis positions separately: unknown is not zero", () => {
    const s = summarizeHoldingsFooter([...FULL, NO_BASIS_NULL, NO_BASIS_NO_PRICE]);
    expect(s.noBasisCount).toBe(2);
    expect(s.noBasisPricedCount).toBe(1);
    expect(s.noBasisUnpricedCount).toBe(1);
    expect(s.noBasisValue).toBe(400);
    expect(summarizeHoldingsFooter(FULL).gainCostBasis).toBe(3000);
    expect(summarizeHoldingsFooter([NO_BASIS_NULL]).gainCostBasis).toBeNull();
  });

  it("reports an unknown total, never zero, when no row can supply it", () => {
    const s = summarizeHoldingsFooter([NO_BASIS_NULL, NO_BASIS_ZERO]);
    expect(s.totalCostBasis).toBeNull();
    expect(s.totalGain).toBeNull();
    expect(s.totalValue).toBe(700);
  });

  it("uses gross known basis for long and short gain percent, matching the security hub", () => {
    const long = row("ZZLNG", { cost: 1000, value: 1250 }); // +250 / 1000 = +25.00%
    const short = row("ZZSHR", { cost: -600, value: -400 }); // +200 / 600 = +33.33%
    const footer = summarizeHoldingsFooter([long, short]);
    const hub = computePositionTotals(
      [long, short].map(
        (r): SecurityPosition => ({
          account_id: r.account_id,
          account_name: r.account_name,
          quantity: r.quantity,
          cost_basis: r.cost_basis,
          current_price: r.current_price,
          current_value: r.current_value,
          unrealized_gain: r.unrealized_gain,
          as_of_date: r.as_of_date,
        }),
      ),
    );

    expect(footer.gainCostBasis).toBe(1600);
    expect(footer.totalGain).toBe(450);
    expect(footer.totalGain! / footer.gainCostBasis!).toBeCloseTo(450 / 1600, 10);
    expect(hub.totalGainRatio).toBeCloseTo(450 / 1600, 10);
    expect(footer.totalGain! / footer.gainCostBasis!).toBeCloseTo(hub.totalGainRatio!, 10);
  });
});

describe("AllHoldingsTable footer (rendered)", () => {
  it("states in words how many positions carry no cost basis, and their value", () => {
    const html = render([...FULL, NO_BASIS_NULL, NO_BASIS_ZERO]);
    const sentence = text(sliceBetween(disclosuresOf(html), 'data-footer-disclosure="no-basis"', "</p>"));
    expect(sentence).toContain(
      "Positions with no cost basis: 2, worth $700.00. They are counted in Value and left out of Cost Basis, Gain and Gain %.",
    );
    // Value still covers every position.
    expect(footerOf(html)).toContain("$4,000.00");
  });

  it("puts the sentences after the table, outside the horizontal scroller", () => {
    const html = render([...FULL, NO_BASIS_NULL, NO_PRICE]);
    expect(footerOf(html)).not.toContain("data-footer-disclosure");
    expect(anchorIndex(html, "data-footer-disclosures")).toBeGreaterThan(anchorIndex(html, "</table>"));
    expect(sliceBetween(html, "<table", "</table>")).not.toContain("Positions with no cost basis");
  });

  it("drops the hover-only marker: no tilde, title or help cursor in the footer or the sentences", () => {
    const html = render([...FULL, NO_BASIS_NULL, NO_PRICE]);
    for (const part of [footerOf(html), disclosuresOf(html)]) {
      expect(part).not.toContain("~");
      expect(part).not.toContain("title=");
      expect(part).not.toContain("cursor-help");
    }
  });

  it("also discloses positions that have a basis but no current price", () => {
    const html = render([...FULL, NO_PRICE]);
    const sentence = text(sliceBetween(disclosuresOf(html), 'data-footer-disclosure="no-price"', "</p>"));
    expect(sentence).toContain(
      "Positions with a cost basis but no current price: 1, cost basis $500.00. They are counted in Cost Basis and left out of Value, Gain and Gain %.",
    );
    expect(sentence).not.toContain("Gain % base");
    expect(html).not.toContain('data-footer-disclosure="no-basis"');
  });

  it("prints Gain % over the positions in Gain (reviewer's two-row case)", () => {
    const footer = footerOf(
      render([row("ZZUPP", { cost: 1000, value: 1500 }), row("ZZBIG", { cost: 9000, value: null })]),
    );
    expect(footer).toContain("+$500.00");
    expect(footer).toContain("+50.00%");
    expect(footer).not.toContain("+5.00%");
    // Cost Basis keeps covering both positions.
    expect(footer).toContain("$10,000.00");
  });

  it("when some no-basis positions have no price: values only the priced ones, calls the rest unknown", () => {
    const html = render([...FULL, NO_BASIS_NULL, NO_BASIS_ZERO, NO_BASIS_NO_PRICE]);
    const sentence = text(sliceBetween(disclosuresOf(html), 'data-footer-disclosure="no-basis"', "</p>"));
    expect(sentence).toContain(
      "Positions with no cost basis: 3. With a current price: 2, worth $700.00; they are counted in Value and left out of Cost Basis, Gain and Gain %. Without a current price: 1; their value is unknown and they are in none of the totals.",
    );
  });

  it("when every no-basis position is unpriced: says the value is unknown and prints no figure", () => {
    const html = render([...FULL, NO_BASIS_NO_PRICE]);
    const raw = sliceBetween(disclosuresOf(html), 'data-footer-disclosure="no-basis"', "</p>");
    const sentence = text(raw);
    expect(sentence).toContain(
      "Positions with no cost basis: 1. None has a current price, so their value is unknown and they are in none of the totals.",
    );
    expect(sentence).not.toContain("$");
    expect(sentence).not.toContain("worth");
  });

  it("adds no disclosure block when every position has a basis and a price", () => {
    const html = render(FULL);
    expect(html).not.toContain("data-footer-disclosure");
    expect(footerOf(html)).toContain("$3,300.00");
    expect(footerOf(html)).toContain("$3,000.00");
  });

  it("the wording never changes with the count, so Hide amounts cannot leak 'exactly one'", () => {
    const strip = (rows: AllHoldingsRow[]) =>
      sliceBetween(disclosuresOf(render(rows)), 'data-footer-disclosure="no-basis"', "</p>").replace(
        /<span[^>]*>[^<]*<\/span>/g,
        "#",
      );
    expect(strip([...FULL, NO_BASIS_NULL])).toBe(strip([...FULL, NO_BASIS_NULL, NO_BASIS_ZERO]));
    expect(strip([...FULL, NO_BASIS_NULL, NO_BASIS_NO_PRICE])).toBe(
      strip([...FULL, NO_BASIS_NULL, NO_BASIS_ZERO, NO_BASIS_NO_PRICE, row("ZZDK2", { cost: 0, value: null })]),
    );
  });
});

describe("AllHoldingsTable footer (source)", () => {
  const src = () => readFileSync("app/dashboard/components/AllHoldingsTable.tsx", "utf8");
  const footerSrc = () => sliceBetween(src(), "<tfoot>", "</tfoot>");
  const disclosureSrc = () => {
    const text = src();
    return text.slice(anchorIndex(text, "data-footer-disclosures"));
  };

  it("renders the disclosed counts and values through the privacy components", () => {
    const block = disclosureSrc();
    expect(block).toContain("<Count value={footer.noBasisCount} />");
    expect(block).toContain("<Count value={footer.noBasisPricedCount} />");
    expect(block).toContain("<Count value={footer.noBasisUnpricedCount} />");
    expect(block).toContain("<Money value={footer.noBasisValue} precise />");
    expect(block).toContain("<Count value={footer.noPriceCount} />");
    expect(block).toContain("<Money value={footer.noPriceCostBasis} precise />");
    // No interpolated count in a plain template string.
    expect(block).not.toMatch(/\$\{footer\.no(Basis|Price)/);
  });

  it("the sentences are a block after the scroll wrapper, not a table row", () => {
    const text = src();
    expect(footerSrc()).not.toContain("data-footer-disclosure");
    expect(footerSrc()).not.toContain("colSpan={9}");
    expect(anchorIndex(text, "data-footer-disclosures")).toBeGreaterThan(
      anchorIndex(text, "</ScrollFade>"),
    );
  });

  it("has no tilde marker, title or hover cursor left in the footer or the sentences", () => {
    for (const part of [footerSrc(), disclosureSrc()]) {
      expect(part).not.toContain("~");
      expect(part).not.toContain("title=");
      expect(part).not.toContain("cursor-help");
    }
    expect(src()).not.toContain("missingGainTooltip");
  });

  it("decides 'no cost basis' with the file's one predicate", () => {
    const text = src();
    // 2026-10-07: the one predicate is now the shared helper in
    // lib/compute/known-basis.ts (also used by HoldingsTable.tsx); this file
    // imports it and defines no copy.
    expect(text).toMatch(/import\s*\{\s*hasKnownBasis\s*\}\s*from\s*"@\/lib\/compute\/known-basis"/);
    expect(text).not.toMatch(/(const|function)\s+hasKnownBasis\b/);
    const summary = text.slice(
      anchorIndex(text, "export function summarizeHoldingsFooter"),
      anchorIndex(text, "export function AllHoldingsTable"),
    );
    expect(summary).toContain("rows.filter(hasKnownBasis)");
    expect(summary).toContain("!hasKnownBasis(h)");
    expect(summary).not.toMatch(/cost_basis\s*[!=]==?\s*(null|0)/);
  });

  it("the footer Gain % divides by the cost basis of the rows in Gain", () => {
    expect(footerSrc()).toMatch(/unrealizedGainRatio\(footer\.totalGain,\s*footer\.gainCostBasis\)/);
    expect(footerSrc()).not.toMatch(/unrealizedGainRatio\(footer\.totalGain,\s*footer\.totalCostBasis\)/);
  });

  it("the disclosure text is readable (not the faint tone) at its small size", () => {
    const block = disclosureSrc();
    const opening = block.slice(0, anchorIndex(block, ">"));
    expect(opening).toContain("text-ink-dim");
    expect(opening).not.toContain("text-ink-faint");
  });
});

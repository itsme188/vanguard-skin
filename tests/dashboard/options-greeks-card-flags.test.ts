import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { PortfolioGreeks, PositionGreeks } from "@/lib/compute/options-greeks";
import {
  greeksFootnoteGroups,
  isDeepInTheMoney,
  isIvSolveUnstable,
  ivCellDisplay,
  sortGreeksPositions,
  IV_DEFAULT_MARK,
  IV_SNAPSHOT_MARK,
  IV_UNSTABLE_TITLE,
} from "@/app/dashboard/components/OptionsGreeksCard";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// QA findings on the Options Greeks card (A11 + B14). No DOM harness in this
// repo: the card's decisions are exported pure functions (tested directly) and
// the render sites are source-pinned. All figures are synthetic.

function pos(over: Partial<PositionGreeks> & { symbol: string }): PositionGreeks {
  return {
    securityId: 1,
    underlying: "AAA",
    optionType: "CALL",
    strike: 100,
    expiration: "2027-03-19",
    quantity: 1,
    multiplier: 100,
    underlyingPrice: 100,
    optionPrice: 5,
    daysToExpiry: 180,
    expired: false,
    greeks: { delta: 0.5, gamma: 0.01, theta: -0.02, vega: 0.2, iv: 0.25, ivSource: "computed", volUsed: 0.25 },
    ...over,
  };
}

describe("IV solve flagged by condition, never by value (A11 ruling)", () => {
  it("flags a deep in-the-money call whatever the solved number is", () => {
    const sane = pos({ symbol: "a", strike: 45, underlyingPrice: 100 });
    const garbage = pos({
      symbol: "b",
      strike: 45,
      underlyingPrice: 100,
      greeks: { delta: 0.9, gamma: 0.001, theta: -0.1, vega: 0.1, iv: 2.1, ivSource: "computed", volUsed: 2.1 },
    });
    expect(isIvSolveUnstable(sane)).toBe(true);
    expect(isIvSolveUnstable(garbage)).toBe(true);
    expect(ivCellDisplay(garbage)).toEqual({ text: "210%", mark: null, flagged: true, title: IV_UNSTABLE_TITLE });
  });

  it("does not flag a high IV on a contract that is neither short-dated nor deep in the money (no ceiling)", () => {
    const high = pos({
      symbol: "a",
      greeks: { delta: 0.6, gamma: 0.01, theta: -0.1, vega: 0.2, iv: 3.4, ivSource: "computed", volUsed: 3.4 },
    });
    expect(isIvSolveUnstable(high)).toBe(false);
    expect(ivCellDisplay(high)).toEqual({ text: "340%", mark: null, flagged: false, title: undefined });
  });

  it("flags at 3 days to expiry and not at 4", () => {
    expect(isIvSolveUnstable(pos({ symbol: "a", daysToExpiry: 3 }))).toBe(true);
    expect(isIvSolveUnstable(pos({ symbol: "a", daysToExpiry: 0 }))).toBe(true);
    expect(isIvSolveUnstable(pos({ symbol: "a", daysToExpiry: 4 }))).toBe(false);
  });

  it("reads moneyness in the right direction for calls and puts", () => {
    expect(isDeepInTheMoney({ optionType: "CALL", strike: 100, underlyingPrice: 120 })).toBe(true);
    expect(isDeepInTheMoney({ optionType: "CALL", strike: 100, underlyingPrice: 119 })).toBe(false);
    expect(isDeepInTheMoney({ optionType: "CALL", strike: 120, underlyingPrice: 100 })).toBe(false); // deep OTM
    expect(isDeepInTheMoney({ optionType: "PUT", strike: 120, underlyingPrice: 100 })).toBe(true);
    expect(isDeepInTheMoney({ optionType: "PUT", strike: 100, underlyingPrice: 120 })).toBe(false);
    expect(isDeepInTheMoney({ optionType: "CALL", strike: 100, underlyingPrice: 0 })).toBe(false); // no price
  });

  it("never applies the solve flag to an expired row, a row with no Greeks, or a vol that was not solved", () => {
    expect(isIvSolveUnstable(pos({ symbol: "a", strike: 45, expired: true, daysToExpiry: -1, greeks: null }))).toBe(false);
    expect(isIvSolveUnstable(pos({ symbol: "a", strike: 45, greeks: null }))).toBe(false);
    const snapshot = pos({
      symbol: "a",
      strike: 45,
      greeks: { delta: 0.98, gamma: 0, theta: 0, vega: 0, iv: 0.64, ivSource: "ibkr", volUsed: 0.64 },
    });
    expect(isIvSolveUnstable(snapshot)).toBe(false);
  });
});

describe("a Greek computed at a fallback volatility is visibly marked (B14)", () => {
  it("marks the underlying-snapshot vol with its own mark and a title", () => {
    const d = ivCellDisplay(
      pos({ symbol: "a", greeks: { delta: 0.98, gamma: 0, theta: 0, vega: 0, iv: 0.64, ivSource: "ibkr", volUsed: 0.64 } }),
    );
    expect(d.text).toBe(`64%${IV_SNAPSHOT_MARK}`);
    expect(d.mark).toBe(IV_SNAPSHOT_MARK);
    expect(d.flagged).toBe(true);
    expect(d.title).toMatch(/broker snapshot, not solved from this contract/);
  });

  it("shows the assumed vol, marked, instead of a bare dash", () => {
    const d = ivCellDisplay(
      pos({ symbol: "a", greeks: { delta: 0.5, gamma: 0, theta: 0, vega: 0, iv: null, ivSource: "default", volUsed: 0.3 } }),
    );
    expect(d.text).toBe(`30%${IV_DEFAULT_MARK}`);
    expect(d.mark).toBe(IV_DEFAULT_MARK);
    expect(d.flagged).toBe(true);
    expect(d.title).toMatch(/Assumed volatility/);
  });

  it("prints a dash and no mark for a row with no Greeks", () => {
    expect(ivCellDisplay(pos({ symbol: "a", greeks: null }))).toEqual({
      text: "—",
      mark: null,
      flagged: false,
      title: undefined,
    });
  });
});

describe("coverage footnote groups are disjoint and match the counts", () => {
  const positions: PositionGreeks[] = [
    pos({ symbol: "own" }),
    pos({ symbol: "snap", greeks: { delta: 0.5, gamma: 0, theta: 0, vega: 0, iv: 0.4, ivSource: "ibkr", volUsed: 0.4 } }),
    pos({ symbol: "dflt", greeks: { delta: 0.5, gamma: 0, theta: 0, vega: 0, iv: null, ivSource: "default", volUsed: 0.3 } }),
    pos({ symbol: "unsolved", greeks: { delta: 0.5, gamma: 0, theta: 0, vega: 0, iv: null, ivSource: "default", volUsed: 0.3 } }),
    pos({ symbol: "nopx", underlyingPrice: 0, greeks: null }),
    pos({ symbol: "gone", expired: true, daysToExpiry: -1, greeks: null }),
    pos({ symbol: "sib", underlying: "GOOGL", underlyingPriceSource: "GOOG" }),
  ];
  const data: Pick<PortfolioGreeks, "positions" | "diagnostics"> = {
    positions,
    diagnostics: [
      { symbol: "dflt", underlying: "AAA", reason: "missing_option_price", daysToExpiry: 180 },
      { symbol: "unsolved", underlying: "AAA", reason: "missing_iv", daysToExpiry: 180 },
      { symbol: "nopx", underlying: "AAA", reason: "no_underlying_price", daysToExpiry: 180 },
      { symbol: "gone", underlying: "AAA", reason: "expired", daysToExpiry: -1 },
    ],
  };

  it("files a fallback-vol row as covered, never as could-not-compute", () => {
    const g = greeksFootnoteGroups(data);
    expect(g.notPriced.map((r) => r.symbol)).toEqual(["nopx"]);
    expect(g.fallbackVol.map((r) => r.symbol)).toEqual(["snap", "dflt", "unsolved"]);
    expect(g.expired.map((r) => r.symbol)).toEqual(["gone"]);
    expect(g.siblingPriced).toEqual([{ symbol: "sib", label: "priced off GOOG (GOOGL has no stored close)" }]);

    const live = positions.filter((p) => !p.expired).length;
    const pricedOwnVol = positions.filter((p) => !p.expired && p.greeks && p.greeks.ivSource === "computed").length;
    expect(pricedOwnVol + g.fallbackVol.length + g.notPriced.length).toBe(live);
  });

  it("says which fallback each row used", () => {
    const g = greeksFootnoteGroups(data);
    const label = (s: string) => g.fallbackVol.find((r) => r.symbol === s)!.label;
    expect(label("snap")).toBe("volatility from the underlying's broker snapshot");
    expect(label("dflt")).toBe("no option price (assumed 30% volatility)");
    expect(label("unsolved")).toBe("couldn't solve for IV (assumed 30% volatility)");
  });
});

describe("sortGreeksPositions", () => {
  const rows = [
    pos({ symbol: "c", underlying: "CCC", daysToExpiry: 30, greeks: null }),
    pos({ symbol: "a", underlying: "AAA", daysToExpiry: 400 }),
    pos({ symbol: "b", underlying: "BBB", daysToExpiry: 5, greeks: { delta: -0.4, gamma: 0, theta: 0, vega: 0, iv: 0.9, ivSource: "computed" } }),
  ];

  it("keeps the compute's order when no sort is chosen", () => {
    expect(sortGreeksPositions(rows, { field: null, dir: "desc" })).toBe(rows);
  });

  it("sorts by days to expiry both ways without mutating the input", () => {
    const before = rows.map((r) => r.symbol);
    expect(sortGreeksPositions(rows, { field: "dte", dir: "asc" }).map((r) => r.symbol)).toEqual(["b", "c", "a"]);
    expect(sortGreeksPositions(rows, { field: "dte", dir: "desc" }).map((r) => r.symbol)).toEqual(["a", "c", "b"]);
    expect(rows.map((r) => r.symbol)).toEqual(before);
  });

  it("puts a row with no value last in either direction", () => {
    expect(sortGreeksPositions(rows, { field: "delta", dir: "asc" }).map((r) => r.symbol)).toEqual(["b", "a", "c"]);
    expect(sortGreeksPositions(rows, { field: "delta", dir: "desc" }).map((r) => r.symbol)).toEqual(["a", "b", "c"]);
    expect(sortGreeksPositions(rows, { field: "option", dir: "asc" }).map((r) => r.symbol)).toEqual(["a", "b", "c"]);
  });
});

describe("OptionsGreeksCard source pins", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "app/dashboard/components/OptionsGreeksCard.tsx"), "utf8");

  it("the IV cell renders through ivCellDisplay and turns amber when flagged", () => {
    anchorIndex(src, "const ivCell = ivCellDisplay(p);");
    anchorIndex(src, '${ivCell.flagged ? "text-gold-ink" : "text-ink-dim"}');
    anchorIndex(src, "title={ivCell.title}");
    // The old unconditional print is gone.
    expect(src).not.toContain("`${(iv * 100).toFixed(0)}%`");
  });

  it("the fallback mark also rides on the always-visible Delta cell", () => {
    anchorIndex(src, "{delta != null && ivCell.mark && (");
  });

  it("every header is a SortableHeader and sort state lives in the URL", () => {
    anchorIndex(src, 'useSortParam<GreeksSortField>("greeks", null, "desc")');
    const head = sliceBetween(src, "<thead>", "</thead>");
    expect(head.match(/<SortableHeader /g)?.length).toBe(9);
    expect(head).not.toMatch(/<th[\s>]/);
    anchorIndex(src, "{rows.map((p) => {");
  });

  it("coverage counts and the rows behind them mask under privacy", () => {
    const detail = sliceBetween(src, "{/* Coverage detail.", "</details>");
    expect(detail).toContain("<Count value={unpricedCount} />");
    expect(detail).toContain("<Count value={fallbackVolCount} />");
    expect(detail).toContain("<Count value={expiredCount} />");
    // No raw count interpolated into the summary.
    expect(detail).not.toMatch(/(?<!value=)\{(unpricedCount|fallbackVolCount|expiredCount|data\.diagnostics\.length)\}/);
    expect(src).not.toContain("{data.diagnostics.length} position");

    const group = sliceBetween(src, "function FootnoteGroup(", "// ─── Sorting");
    const open = anchorIndex(group, "<PrivateText>");
    const close = anchorIndex(group, "</PrivateText>", open);
    expect(group.slice(open, close)).toContain("{r.symbol}");
    expect(group.slice(open, close)).toContain("{r.label}");
  });

  it("the three counts come from the compute's own fields", () => {
    anchorIndex(src, "data.fallbackVolPositions");
    anchorIndex(src, "data.unpricedPositions");
    anchorIndex(src, "data.expiredPositions");
  });

  it("an expired-only scope withholds the tiles instead of printing zeros", () => {
    anchorIndex(src, "const allExpired = data.totalPositions === 0;");
    const tiles = anchorIndex(src, '<div className="grid grid-cols-2 sm:grid-cols-4 gap-3">');
    const guard = src.lastIndexOf("{!allExpired && (", tiles);
    expect(guard).toBeGreaterThan(-1);
    expect(tiles - guard).toBeLessThan(40);
  });
});

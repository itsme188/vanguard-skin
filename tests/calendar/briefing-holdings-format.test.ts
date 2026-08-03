import { describe, it, expect } from "vitest";
import {
  formatHoldingsList,
  type BriefingHolding,
} from "@/lib/calendar/briefing";

const PRICES = new Map([
  ["MSFT", { close: 410.5, date: "2026-05-09" }],
  ["AAPL", { close: 195.0, date: "2026-05-09" }],
  ["GOOG", { close: 168.25, date: "2026-05-09" }],
]);

describe("formatHoldingsList (A7 short-aware portfolio context)", () => {
  it("renders a long-only position in the compact original shape", () => {
    const holdings: BriefingHolding[] = [
      {
        symbol: "AAPL",
        name: "Apple Inc",
        security_type: "Stock",
        sector: "Tech",
        net_qty: 100,
      },
    ];
    const out = formatHoldingsList(holdings, PRICES);
    expect(out).toBe("AAPL (Apple Inc, Tech) — last $195.00 (2026-05-09)");
    expect(out).not.toContain("NET SHORT");
  });

  it("surfaces NET SHORT when cross-account net is negative (A7 fix)", () => {
    // MSFT: long 41.9 in Vanguard + short 45 in IBKR → net -3.1
    const holdings: BriefingHolding[] = [
      {
        symbol: "MSFT",
        name: "Microsoft Corp",
        security_type: "Stock",
        sector: "Tech",
        net_qty: -3.1,
      },
    ];
    const out = formatHoldingsList(holdings, PRICES);
    expect(out).toContain("NET SHORT");
    // 2026-08-02: the net quantity itself no longer renders (count × public
    // price reconstructs $ exposure in a cc'd email).
    expect(out).not.toContain("3.1");
    expect(out).toContain("cross-account net");
    expect(out).toContain("last $410.50 (2026-05-09)");
  });

  it("does not flag a position that nets to zero (e.g. fully closed short hedge)", () => {
    // Net zero shouldn't render as short; either way, the row shouldn't
    // appear at all because the SQL filters quantity != 0 → SUM = 0 still
    // passes through. Defensive: confirm the formatter doesn't lie.
    const holdings: BriefingHolding[] = [
      {
        symbol: "GOOG",
        name: "Alphabet Inc",
        security_type: "Stock",
        sector: "Tech",
        net_qty: 0,
      },
    ];
    const out = formatHoldingsList(holdings, PRICES);
    expect(out).not.toContain("NET SHORT");
  });

  it("preserves price-missing language when no quote exists", () => {
    const holdings: BriefingHolding[] = [
      {
        symbol: "ZZZ",
        name: "Test Co",
        security_type: "Stock",
        sector: null,
        net_qty: -50,
      },
    ];
    const out = formatHoldingsList(holdings, PRICES);
    // 2026-08-02: direction flag only — the share count is reconstructable
    // exposure (count × public price) and no longer renders.
    expect(out).toContain("NET SHORT (cross-account net)");
    expect(out).not.toContain("50");
    expect(out).toContain("no recent price");
    expect(out).toContain("N/A");
  });

  it("joins multiple rows with newlines, mixed long + short", () => {
    const holdings: BriefingHolding[] = [
      {
        symbol: "AAPL",
        name: "Apple Inc",
        security_type: "Stock",
        sector: "Tech",
        net_qty: 100,
      },
      {
        symbol: "MSFT",
        name: "Microsoft Corp",
        security_type: "Stock",
        sector: "Tech",
        net_qty: -45,
      },
    ];
    const out = formatHoldingsList(holdings, PRICES);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^AAPL.*195\.00/);
    expect(lines[1]).toMatch(/^MSFT.*NET SHORT \(cross-account net\)/);
    expect(lines[1]).not.toContain("45");
  });
});

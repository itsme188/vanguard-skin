import { describe, it, expect } from "vitest";
import {
  parseFinnhubFigure,
  formatFinnhubFigure,
  formatFinnhubFigureCompact,
  mergeFinnhubActual,
} from "@/lib/format/finnhub-figure";

describe("parseFinnhubFigure", () => {
  it("extracts EPS + revenue from canonical Finnhub format", () => {
    const r = parseFinnhubFigure("EPS 0.70 · Rev 4305870107");
    expect(r.eps).toBe(0.7);
    expect(r.revenue).toBe(4_305_870_107);
  });

  it("handles EPS-only input", () => {
    expect(parseFinnhubFigure("EPS 0.91")).toEqual({ eps: 0.91, revenue: null });
  });

  it("handles negative EPS", () => {
    expect(parseFinnhubFigure("EPS -0.45 · Rev 1200000000")).toEqual({
      eps: -0.45,
      revenue: 1_200_000_000,
    });
  });

  it("strips commas in revenue", () => {
    expect(parseFinnhubFigure("EPS 0.5 · Rev 4,305,870,107")).toEqual({
      eps: 0.5,
      revenue: 4_305_870_107,
    });
  });

  it("returns nulls on null input", () => {
    expect(parseFinnhubFigure(null)).toEqual({ eps: null, revenue: null });
  });
});

describe("formatFinnhubFigure", () => {
  it("formats both fields when present", () => {
    const r = formatFinnhubFigure("EPS 0.91 · Rev 4345870107");
    expect(r.eps).toBe("$0.91");
    expect(r.revenue).toBe("$4.35B");
    expect(r.fallback).toBe(null);
  });

  it("falls back to raw input when neither parsed", () => {
    const r = formatFinnhubFigure("Pre-announcement only");
    expect(r.eps).toBe(null);
    expect(r.revenue).toBe(null);
    expect(r.fallback).toBe("Pre-announcement only");
  });

  it("renders compact form joined", () => {
    expect(formatFinnhubFigureCompact("EPS 0.91 · Rev 4345870107")).toBe("$0.91 · $4.35B");
    expect(formatFinnhubFigureCompact("EPS 0.91")).toBe("$0.91");
    expect(formatFinnhubFigureCompact(null)).toBe("");
  });
});

// QA finding today-earnings--zero-revenue-consensus-renders-dollar-zero:
// Finnhub emits a literal "Rev 0" as a placeholder for "no revenue consensus
// published" — it is not a real $0 print. formatFinnhubFigure /
// formatFinnhubFigureCompact must treat that the same way they already treat
// a genuinely absent revenue (null field / omitted from the compact join),
// never as "$0.00". EPS of exactly 0 is a real, legitimate value and must be
// untouched.
describe("formatFinnhubFigure / formatFinnhubFigureCompact — zero revenue is absent", () => {
  it("treats a literal zero revenue as absent, not $0.00", () => {
    const r = formatFinnhubFigure("EPS -0.14 · Rev 0");
    expect(r.eps).toBe("-$0.14");
    expect(r.revenue).toBeNull();
  });

  it("compact form omits the zero revenue entirely — no separator, no $0.00", () => {
    expect(formatFinnhubFigureCompact("EPS -0.14 · Rev 0")).toBe("-$0.14");
    expect(formatFinnhubFigureCompact("EPS 1.20 · Rev 0")).toBe("$1.20");
  });

  it("a real (nonzero) revenue still renders normally", () => {
    expect(formatFinnhubFigureCompact("EPS -0.14 · Rev 190000")).toBe("-$0.14 · $190,000");
    const r = formatFinnhubFigure("EPS -0.14 · Rev 190000");
    expect(r.revenue).toBe("$190,000");
  });

  it("EPS of exactly 0 is a real value, not absent", () => {
    const r = formatFinnhubFigure("EPS 0 · Rev 4345870107");
    expect(r.eps).toBe("$0.00");
    expect(r.revenue).toBe("$4.35B");
    expect(formatFinnhubFigureCompact("EPS 0 · Rev 0")).toBe("$0.00");
  });
});

describe("mergeFinnhubActual (B18 — manual override must not wipe the other field)", () => {
  it("EPS-only save preserves stored revenue", () => {
    expect(mergeFinnhubActual("EPS 1.10 · Rev 4340000000", { eps: 1.23 })).toBe(
      "EPS 1.23 · Rev 4340000000"
    );
  });

  it("revenue-only save preserves stored EPS", () => {
    expect(mergeFinnhubActual("EPS 1.10 · Rev 4340000000", { revenue: 5_000_000_000 })).toBe(
      "EPS 1.10 · Rev 5000000000"
    );
  });

  it("both provided replaces both", () => {
    expect(
      mergeFinnhubActual("EPS 1.10 · Rev 4340000000", { eps: -0.05, revenue: 1000 })
    ).toBe("EPS -0.05 · Rev 1000");
  });

  it("no existing value + one field yields a single-part string", () => {
    expect(mergeFinnhubActual(null, { eps: 2.5 })).toBe("EPS 2.50");
    expect(mergeFinnhubActual(null, { revenue: 900 })).toBe("Rev 900");
  });

  it("nothing provided and nothing stored returns null", () => {
    expect(mergeFinnhubActual(null, {})).toBeNull();
    expect(mergeFinnhubActual("garbage with no figures", {})).toBeNull();
  });
});

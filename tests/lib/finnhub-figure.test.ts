import { describe, it, expect } from "vitest";
import {
  parseFinnhubFigure,
  formatFinnhubFigure,
  formatFinnhubFigureCompact,
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

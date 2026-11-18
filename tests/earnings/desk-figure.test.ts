import { describe, expect, it } from "vitest";
import { formatDeskFigure, readDeskFigure, type DeskFigureKind } from "@/lib/earnings/desk-figure";

const v = (raw: string, kind: DeskFigureKind) => readDeskFigure(raw, kind).value;

describe("readDeskFigure", () => {
  it("reads_desk_wording", () => {
    expect(v("~$3.35B", "usd")).toBe(3.35e9);
    for (const raw of ["3.35bn", "$3.35 billion", "3,350M", "3350 mm"]) {
      expect(v(raw, "usd")).toBe(3.35e9);
    }
    expect(v("US$ 850m", "usd")).toBe(8.5e8);
    expect(v("$108.5B+", "usd")).toBe(1.085e11);
    expect(v("(0.12)", "per_share")).toBe(-0.12);
    expect(v("$1.07", "per_share")).toBe(1.07);
    for (const raw of ["c. 28%", "28 pct", "~28"]) expect(v(raw, "pct")).toBe(28);
    expect(v(".5", "count")).toBe(0.5);
    expect(v("1.2k", "count")).toBe(1200);
  });

  it("flags approximate wording", () => {
    expect(readDeskFigure("108.5B+", "usd").approximate).toBe(true);
    expect(readDeskFigure("about 5", "count").approximate).toBe(true);
    expect(readDeskFigure("5", "count").approximate).toBe(false);
  });

  it("refuses_ranges", () => {
    for (const raw of ["3.3-3.4B", "3.3–3.4B", "3.3 to 3.4B"]) {
      const r = readDeskFigure(raw, "usd");
      expect(r.value).toBeNull();
      expect(r.error).toBe("That looks like a range (3.3B to 3.4B). Enter one number.");
    }
    const p = readDeskFigure("28-29%", "pct");
    expect(p.value).toBeNull();
    expect(p.error).toContain("range");
  });

  it("refuses_scale_on_per_share and pct", () => {
    expect(readDeskFigure("1.07B", "per_share").value).toBeNull();
    expect(readDeskFigure("1.07B", "per_share").error).toMatch(/scale word/);
    expect(readDeskFigure("5M", "pct").error).toMatch(/scale word/);
  });

  it("refuses_bps", () => {
    const r = readDeskFigure("25 bps", "pct");
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/Basis points/);
  });

  it("refuses_words", () => {
    const r = readDeskFigure("strong", "usd");
    expect(r.value).toBeNull();
    expect(r.error).toBe("Couldn't read “strong” as a dollar figure like 3.35B or $3,350M.");
    expect(readDeskFigure("x", "per_share").error).toContain("a per-share figure like 1.07");
    expect(readDeskFigure("x", "pct").error).toContain("a percent like 28 or 28%");
    expect(readDeskFigure("x", "count").error).toContain("a number like 1200");
  });

  it("blank_is_null", () => {
    expect(readDeskFigure("", "usd")).toEqual({ value: null, error: null, approximate: false });
    expect(readDeskFigure("   ", "pct")).toEqual({ value: null, error: null, approximate: false });
  });

  it("reads plus-minus and plus on pct", () => {
    expect(v("±6%", "pct")).toBe(6);
    expect(v("+/-6%", "pct")).toBe(6);
    expect(v("+6", "pct")).toBe(6);
    expect(v("-6%", "pct")).toBe(-6);
  });

  it("keeps comma behaviour and refuses exponent, huge and empty mantissa", () => {
    // Changed after review w1 #2: a comma must group thousands, or "3,35B"
    // (a decimal comma) would read as 335B.
    expect(v("1,2,3", "count")).toBeNull();
    expect(v("3,35B", "usd")).toBeNull();
    expect(v(",5", "count")).toBeNull();
    expect(v("5,", "count")).toBeNull();
    expect(v("1,234,567.5", "usd")).toBe(1234567.5);
    expect(v("3,350M", "usd")).toBe(3350000000);
    // A doubled sign is refused, never read as positive (review w1 #1).
    expect(v("(-0.12)", "per_share")).toBeNull();
    expect(v("(-3)", "per_share")).toBeNull();
    expect(v("+-6", "pct")).toBeNull();
    expect(v("±-6", "pct")).toBeNull();
    expect(readDeskFigure("1e3", "count").value).toBeNull();
    expect(readDeskFigure("1e3", "count").error).not.toBeNull();
    const huge = readDeskFigure("9".repeat(400), "count");
    expect(huge.value).toBeNull();
    expect(huge.error).not.toBeNull();
    expect(readDeskFigure("$,,,", "usd").value).toBeNull();
    expect(readDeskFigure("$,,,", "usd").error).not.toBeNull();
  });

  it("refuses a dollar sign on a percent", () => {
    expect(readDeskFigure("$5", "pct").value).toBeNull();
  });
});

describe("formatDeskFigure", () => {
  it("writes the shortest scaled text for usd", () => {
    expect(formatDeskFigure(3350000000, "usd")).toBe("3.35B");
    expect(formatDeskFigure(850000000, "usd")).toBe("850M");
    expect(formatDeskFigure(1200, "usd")).toBe("1.2K");
    expect(formatDeskFigure(3350001234, "usd")).toBe("3350001234");
    expect(formatDeskFigure(0.46, "usd")).toBe("0.46");
  });

  it("format_round_trips", () => {
    const values = [
      0, 0.46, 1.07, -0.12, 850000000, 3350000000, 3350001234, 108500000000, 27.5, 28, 1200,
      -3350000000, 1e12, 2.5e12, 1e-7, 123456789.123,
    ];
    const kinds: DeskFigureKind[] = ["usd", "per_share", "pct", "count"];
    for (const x of values) {
      for (const k of kinds) {
        const text = formatDeskFigure(x, k);
        expect(text).not.toMatch(/e/i);
        expect(readDeskFigure(text, k).value, `${k} ${x} via ${text}`).toBe(x);
      }
    }
  });
});

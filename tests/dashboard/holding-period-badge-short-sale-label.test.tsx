/**
 * QA finding: tax-lots-closed-sales--days-column-prints-short-beside-short-term
 * (owner decision, option 2 — a wording stopgap, label only).
 *
 * The Closed Sales table printed the bare word "short" in the DAYS cell (a
 * SHORT POSITION) right beside the TERM chip "Short" (a SHORT-TERM holding
 * period). Two different facts, one word, no tooltip, and the day count was
 * never shown.
 *
 * Pinned here:
 *  - a negative (short-lifecycle) day count renders "short sale · covered +Nd"
 *    with a title that explains the sign;
 *  - the chip never renders the bare word "short";
 *  - a non-negative count is unchanged ("Nd", no chip, no title);
 *  - the component stays label-only: it reads nothing but the day count and
 *    never decides long-term vs short-term (that is the engine's
 *    `isLongTermHolding`).
 *
 * This repo has no DOM test harness, so the component is rendered with
 * renderToStaticMarkup (it has no hooks). All figures are synthetic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  HoldingPeriodBadge,
  shortSaleCoverLabel,
  shortSaleCoverTitle,
} from "@/app/dashboard/components/HoldingPeriodBadge";

/** Text content of the rendered markup, tags stripped. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("HoldingPeriodBadge — a short sale is not worded like a short-term hold", () => {
  it("renders a covered short as 'short sale · covered +Nd'", () => {
    const html = renderToStaticMarkup(<HoldingPeriodBadge days={-3} />);
    expect(textOf(html)).toBe("short sale · covered +3d");
  });

  it("never renders the bare word that collides with the Term chip", () => {
    for (const days of [-1, -3, -55, -400]) {
      const text = textOf(renderToStaticMarkup(<HoldingPeriodBadge days={days} />));
      expect(text.toLowerCase()).not.toBe("short");
      expect(text).toContain(`+${-days}d`);
    }
  });

  it("carries a title that explains the sign and the two meanings", () => {
    const html = renderToStaticMarkup(<HoldingPeriodBadge days={-3} />);
    expect(html).toContain(`title="${shortSaleCoverTitle(-3)}"`);
    expect(shortSaleCoverTitle(-3)).toBe(
      "Short sale: sold first, bought back (covered) 3 days later. This is the direction of the position, not the short-term or long-term tax holding period.",
    );
    expect(shortSaleCoverTitle(-1)).toContain("1 day later");
  });

  it("leaves a normal holding period unchanged — plain text, no chip, no title", () => {
    for (const days of [0, 1, 365, 366]) {
      const html = renderToStaticMarkup(<HoldingPeriodBadge days={days} />);
      expect(html).toBe(`${days}d`);
    }
  });

  it("forwards className to the chip only", () => {
    expect(renderToStaticMarkup(<HoldingPeriodBadge days={-2} className="font-sans" />)).toContain(
      "font-sans",
    );
    expect(renderToStaticMarkup(<HoldingPeriodBadge days={2} className="font-sans" />)).toBe("2d");
  });

  it("keeps the label on one line in a narrow numeric column", () => {
    expect(renderToStaticMarkup(<HoldingPeriodBadge days={-2} />)).toContain("whitespace-nowrap");
  });

  it("the pure label helper uses the magnitude of the signed count", () => {
    expect(shortSaleCoverLabel(-1)).toBe("short sale · covered +1d");
    expect(shortSaleCoverLabel(-42)).toBe("short sale · covered +42d");
  });

  it("stays label-only: no term decision, no lot lineage read in the component", () => {
    const src = readFileSync("app/dashboard/components/HoldingPeriodBadge.tsx", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/isLongTerm|is_long_term|365|366|acquisition|is_short/);
  });
});

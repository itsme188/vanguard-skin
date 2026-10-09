import { GOLD_FILL_TEXT } from "./chip-tone-text";

/** Segment fill of the trade review grades bar, per grade. */
export const GRADE_BAR_FILL: Record<string, string> = {
  A: "bg-up",
  B: "bg-up/60",
  C: "bg-gold",
  D: "bg-down/60",
  F: "bg-down",
};

/**
 * Letter colour on each segment: whichever of canvas or ink text reads
 * better on that fill, per theme (the old `text-canvas/80` measured 2.1 to
 * 3.8:1 in the light theme). Lowest ratio over canvas, panel and raised:
 *
 *   A  canvas          4.96 light,  8.69 dark
 *   B  ink             7.41 light,  4.11 dark  (canvas would be 3.68; neither reaches 4.5)
 *   C  ink / canvas    6.08 light, 11.52 dark  (the solid gold fill pair)
 *   D  ink             6.80 light,  6.04 dark
 *   F  canvas          5.12 light,  5.26 dark
 *
 * tests/repo/no-faded-small-status-text.test.ts pins the table.
 */
export const GRADE_BAR_TEXT: Record<string, string> = {
  A: "text-canvas",
  B: "text-ink",
  C: GOLD_FILL_TEXT,
  D: "text-ink",
  F: "text-canvas",
};

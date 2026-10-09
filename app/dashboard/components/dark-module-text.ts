/**
 * Dim text inside the always-dark modules (the chart panel on a security
 * page, the Factor Profile card, the terminal sections). These modules paint
 * their own near-black surface (#0a0a0a to #0d0d0d) in BOTH page themes, so
 * their greys are written as hex, not as theme tokens.
 *
 * #8a8a8a is the dimmest grey allowed for small text there: 5.73:1 on
 * #0a0a0a, 5.70:1 on #0b0b0b, 5.63:1 on #0d0d0d. The greys it replaced
 * measured 2.6:1 (#555), 3.4:1 (#666) and 4.3 to 4.4:1 (#777).
 * tests/repo/no-dim-grey-on-dark-module.test.ts pins the numbers and fails
 * on a new darker inline grey in these files.
 */
export const DARK_MODULE_DIM_TEXT = "#8a8a8a";

/**
 * Text colour of a grey control on those modules while the pointer is over
 * it: 13.4:1 or better on every dark-module surface. The same value the
 * chart's own chrome buttons take on hover (`.dark-module-chart
 * button.chart-chrome:hover` in app/globals.css). A hex, not a theme token:
 * `hover:text-ink` would turn near-black on a light page.
 */
export const DARK_MODULE_HOVER_TEXT = "#d4d4d4";

/** Border of an outlined grey control there while the pointer is over it. */
export const DARK_MODULE_HOVER_BORDER = "#666";

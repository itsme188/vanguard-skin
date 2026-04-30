/**
 * Today design preview — converged on a single direction:
 *   palette + shadow:  amber-moss-glow-roomy (confirmed)
 *   layout:            strip header (no Hero card)
 *   density:           medium (halfway between default and compact)
 *
 * The "Roomy (reference)" option is kept so we can still see the
 * starting point for comparison. "Roomy · Final" is the version
 * that should port to production.
 */

export type OptionId =
  | "amber-moss-glow-roomy"
  | "amber-roomy-final";

export type LayoutDensity = "default" | "medium" | "compact";
export type LayoutHeader = "hero" | "strip";

export interface OptionLayout {
  /** Which `[data-preview="..."]` scope to apply for palette + shadow tokens. */
  paletteScope: string;
  density: LayoutDensity;
  header: LayoutHeader;
}

export interface OptionMeta {
  id: OptionId;
  name: string;
  tagline: string;
  description: string;
  swatches: { hex: string; label: string }[];
  layout: OptionLayout;
}

export const OPTIONS: OptionMeta[] = [
  {
    id: "amber-moss-glow-roomy",
    name: "Roomy (reference)",
    tagline: "Original pick. Hero card, default density. Reference point.",
    description:
      "What you committed to before the layout discussion. Hero card up top with the portfolio total, default 20-24px card padding, roomy gaps. Use this to see the delta against the final variant.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss shadow" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
    layout: {
      paletteScope: "amber-moss-glow-roomy",
      density: "default",
      header: "hero",
    },
  },
  {
    id: "amber-roomy-final",
    name: "Roomy · Final",
    tagline: "Strip header (no Hero) + medium density (halfway tighter).",
    description:
      "The committed direction after layout iteration. Portfolio total moves to a slim horizontal strip at the top of the page (no card chrome) — peer-weight cards below. Card padding goes from 20-24px to 16-20px (halfway tighter than the compact extreme). Row gaps and section spacing follow the same halfway tier. Font sizes unchanged. This is what should port to production.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss shadow" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
    layout: {
      paletteScope: "amber-moss-glow-roomy",
      density: "medium",
      header: "strip",
    },
  },
];

export function getOption(id: string): OptionMeta | null {
  return OPTIONS.find((o) => o.id === id) ?? null;
}

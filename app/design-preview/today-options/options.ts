/**
 * Today design preview — current focus is layout/density variations on
 * top of the confirmed amber-moss-glow-roomy palette + shadow direction.
 *
 * Each option overrides design tokens within a `[data-preview="<scope>"]`
 * scope (see options.css). The `layout` field controls the actual
 * TodayPreview component shape (density of padding/spacing + whether
 * the page leads with a Hero card or a slim portfolio strip).
 */

export type OptionId =
  | "amber-moss-glow-roomy"
  | "amber-roomy-compact"
  | "amber-roomy-strip";

export type LayoutDensity = "default" | "compact";
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
    name: "Roomy (current pick)",
    tagline: "Confirmed direction. Hero card up top, default density.",
    description:
      "What you committed to last round. Amber base, no border, moss-tinted shadow extending past the cards. Default padding inside cards. Hero portfolio card sits above secondary cards. Use this as the reference for the two layout variants below.",
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
    id: "amber-roomy-compact",
    name: "Roomy · Compact density",
    tagline: "Same Hero. Tighter padding inside every card. Same fonts.",
    description:
      "Same arrangement and Hero card, but card padding goes from 20-24px to 12-14px and row gaps tighten. Font sizes are unchanged. Less wasted space; you don't have to lean forward as much. Smallest delta from your current pick — answers 'is the density problem solved by tightening alone?'",
    swatches: [
      { hex: "#3a4a3f", label: "Moss shadow" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
    layout: {
      paletteScope: "amber-moss-glow-roomy",
      density: "compact",
      header: "hero",
    },
  },
  {
    id: "amber-roomy-strip",
    name: "Roomy · Strip header (no Hero)",
    tagline: "Portfolio total moves to a slim header strip. All other cards equal-weight.",
    description:
      "Drops the Hero card entirely. Portfolio total / change / accounts move to a slim horizontal strip at the top of the page (no card chrome — just a row with a hairline bottom border). Below it, every card is peer-weight: TodayReleases, Alerts, Levels, Holdings, Week-Ahead all sit at the same visual altitude. Card density is also tightened. Matches the 'scan this page, no single Hero' mental model — your portfolio total stays visible without dominating.",
    swatches: [
      { hex: "#3a4a3f", label: "Moss shadow" },
      { hex: "#b8860b", label: "Brand amber" },
      { hex: "#ffffff", label: "White cards" },
      { hex: "#fafaf3", label: "Canvas" },
    ],
    layout: {
      paletteScope: "amber-moss-glow-roomy",
      density: "compact",
      header: "strip",
    },
  },
];

export function getOption(id: string): OptionMeta | null {
  return OPTIONS.find((o) => o.id === id) ?? null;
}
